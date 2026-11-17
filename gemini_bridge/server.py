"""OpenAI-compatible bridge over gemini.google.com web RPC (gemini-webapi).

Run: uv run python -m gemini_bridge.server
Pi connects via models.json (api: openai-completions, baseUrl http://127.0.0.1:8787/v1).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from gemini_webapi import GeminiClient
from gemini_webapi.exceptions import (
    APIError,
    AuthError,
    GeminiError,
    TemporarilyBlockedError,
    TimeoutError,
    UsageLimitExceededError,
)

from .protocol import flatten_messages, holdback_end, parse_reply, tool_instructions

COOKIE_FILE = Path(os.environ.get("GEMINI_COOKIE_FILE", "cookies.json"))
PORT = int(os.environ.get("GEMINI_BRIDGE_PORT", "8787"))
# Optional proxy to route Gemini RPC through a clean (residential) exit IP.
# Hosting/datacenter IPs get LOCATION_REJECTED by Gemini web; residential works.
# Format: http://[user:pass@]host:port | socks5[h]://[user:pass@]host:port
PROXY = os.environ.get("GEMINI_PROXY") or None
GEN_TIMEOUT = int(os.environ.get("GEMINI_GEN_TIMEOUT", "150"))
DEFAULT_MODEL = "gemini-web"
ARGON_MODEL = "gemini-4-argon"
MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb"
# Picker category numbers (empty hex id selects by category). Verified: argon=8.
CATEGORY_MAP = {
    "gemini-4-hydrogen": 1,
    "gemini-pro": 3,
    "gemini-flash-lite": 6,
}
# Full web-UI Argon header (literal "argon" selector at idx4 + idx24, cat 8 at
# idx14). The library appends thinking+sessionid after it; Google reads idx24.
ARGON_HEADER = (
    '[1,null,null,null,"argon",null,"en",null,[4,33,22,5,6,8,16,19,20,38],'
    'null,null,null,null,null,8,1,"gemini-bridge",'
    '["boq_gemini-web-uiserver_20261116.12_p0"],null,null,null,null,null,null,"argon"]'
)

_client: GeminiClient | None = None
# ponytail: one global lock — web client is a single session (reqid counter).
# Upgrade path: pool of clients if parallel agent threads ever matter.
_lock = asyncio.Lock()


def _load_cookies() -> tuple[str, str | None]:
    psid = os.environ.get("GEMINI_1PSID")
    psidts = os.environ.get("GEMINI_1PSIDTS")
    if not psid and COOKIE_FILE.exists():
        data = json.loads(COOKIE_FILE.read_text())
        psid = data.get("__Secure-1PSID")
        psidts = data.get("__Secure-1PSIDTS")
    if not psid:
        raise RuntimeError(
            "No cookies: set GEMINI_1PSID (+GEMINI_1PSIDTS) or create cookies.json "
            '{"__Secure-1PSID": "...", "__Secure-1PSIDTS": "..."}'
        )
    return psid, psidts


def _save_cookies() -> None:
    if _client is None:
        return
    jar = dict(_client.cookies)
    COOKIE_FILE.write_text(
        json.dumps(
            {
                "__Secure-1PSID": jar.get("__Secure-1PSID", ""),
                "__Secure-1PSIDTS": jar.get("__Secure-1PSIDTS", ""),
            },
            indent=2,
        )
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    psid, psidts = _load_cookies()
    _client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts, proxy=PROXY)
    await _client.init(auto_refresh=True)
    print(f"gemini-bridge: proxy={'on' if PROXY else 'off (direct)'}", flush=True)
    _save_cookies()  # persist rotated 1PSIDTS for next restart
    yield
    _save_cookies()
    await _client.close()


app = FastAPI(title="gemini-bridge", lifespan=lifespan)


def _error(status: int, message: str, kind: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": kind, "code": kind}},
    )


def _map_exception(e: Exception) -> JSONResponse:
    if isinstance(e, AuthError):
        return _error(401, str(e), "invalid_api_key")
    if isinstance(e, (UsageLimitExceededError, TemporarilyBlockedError)):
        return _error(429, str(e), "rate_limit_exceeded")
    if isinstance(e, TimeoutError):
        return _error(504, str(e), "timeout")
    if isinstance(e, (APIError, GeminiError)):
        return _error(502, str(e), "upstream_error")
    return _error(500, str(e), "internal_error")


def _account_capacity() -> tuple[int, int]:
    try:
        for m in _client.list_models() or []:
            return m.capacity, m.capacity_field
    except Exception:
        pass
    return 2, 12  # Pro-tier fallback


def _resolve_model(model_id: str):
    """Bridge model id -> (generate_content model arg, extended_thinking).

    Known web models are selected by picker category number with an empty hex
    id (custom header), bypassing the account model registry — this works even
    when the registry is degraded (e.g. UNAUTHENTICATED session via proxy IP).
    Unknown ids fall back to registry name resolution.
    """
    thinking = model_id.endswith("-thinking")
    base = model_id[: -len("-thinking")] if thinking else model_id
    if base == DEFAULT_MODEL:
        return None, thinking
    if base == ARGON_MODEL:
        # Argon needs the full web-UI header format: literal "argon" at idx4 and
        # idx24 (the model selector), category 8 at idx14. The simple empty-hex
        # category header stalls in authenticated sessions (routes to locked
        # Carbon). Captured from the real UI StreamGenerate request.
        cap, cap_field = _account_capacity()
        return {
            "model_name": ARGON_MODEL,
            "model_header": {MODEL_HEADER_KEY: ARGON_HEADER},
            "capacity": cap,
            "capacity_field": cap_field,
        }, thinking
    if base in CATEGORY_MAP:
        cap, cap_field = _account_capacity()
        tail = f"null,{cap}" if cap_field == 13 else str(cap)
        cat = CATEGORY_MAP[base]
        header = f'[1,null,null,null,"",null,null,0,[4,5,6,8],null,null,{tail},null,null,{cat}]'
        return {
            "model_name": base,
            "model_header": {MODEL_HEADER_KEY: header},
            "capacity": cap,
            "capacity_field": cap_field,
        }, thinking
    return base, thinking


def _usage(prompt: str, text: str) -> dict:
    # ponytail: web RPC exposes no token counts; ~4 chars/token estimate.
    i, o = len(prompt) // 4, len(text) // 4
    return {"prompt_tokens": i, "completion_tokens": o, "total_tokens": i + o}


def _tool_calls_payload(calls) -> list[dict]:
    return [
        {
            "id": f"call_{uuid.uuid4().hex[:24]}",
            "type": "function",
            "function": {"name": c.name, "arguments": json.dumps(c.arguments, ensure_ascii=False)},
        }
        for c in calls
    ]


@app.get("/v1/models")
async def list_models():
    data = [{"id": DEFAULT_MODEL, "object": "model", "owned_by": "google-web"}]
    data.append(
        {"id": ARGON_MODEL, "object": "model", "owned_by": "google-web",
         "display_name": "Code & analysis", "model_number": 8}
    )
    try:
        for m in _client.list_models() or []:
            data.append(
                {
                    "id": m.model_name,
                    "object": "model",
                    "owned_by": "google-web",
                    "display_name": m.display_name,
                    "aliases": list(m.aliases),
                    "model_id": m.model_id,
                    "capacity": m.capacity,
                    "capacity_field": m.capacity_field,
                    "model_number": m.model_number,
                    "model_header": m.model_header,
                }
            )
    except Exception:
        pass  # dynamic catalog unavailable -> default model still works
    return {"object": "list", "data": data}


@app.get("/health")
async def health():
    return {"ok": _client is not None}


@app.get("/v1/chats")
async def list_chats():
    """List the account's Gemini web conversations (for import into BB)."""
    async with _lock:
        try:
            await _client._fetch_recent_chats()
        except Exception:
            pass
        chats = _client.list_chats() or []
    return {
        "data": [
            {"cid": c.cid, "title": c.title, "pinned": c.is_pinned, "timestamp": c.timestamp}
            for c in chats
        ]
    }


@app.get("/v1/chats/{cid}")
async def chat_history(cid: str, limit: int = 30):
    """Read a conversation's turns (chronological order) for context import."""
    async with _lock:
        try:
            hist = await _client.read_chat(cid, limit=limit)
        except Exception as e:  # noqa: BLE001
            return _error(502, str(e), "upstream_error")
    if hist is None:
        return _error(404, f"chat {cid} not found", "not_found")
    turns = [{"role": t.role, "text": t.text} for t in reversed(hist.turns)]
    return {"cid": cid, "turns": turns}


@app.get("/debug/raw-models")
async def raw_models():
    """Raw GET_USER_STATUS model list (part_body[15]) — discovery debugging."""
    from gemini_webapi.constants import GRPC
    from gemini_webapi.types import RPCData
    from gemini_webapi.utils.parsing import get_nested_value

    async with _lock:
        resp = await _client._batch_execute([RPCData(rpcid=GRPC.GET_USER_STATUS, payload="[]")])
    out = []
    for part_body in _client._parse_rpc_results(resp.text, GRPC.GET_USER_STATUS):
        out.append(part_body)
    return {"raw": out}


@app.get("/debug/rpc")
async def debug_rpc(rpcid: str, payload: str = "[]"):
    """Raw batchexecute call for discovery debugging (localhost only)."""
    from gemini_webapi.types import RPCData

    async with _lock:
        resp = await _client._batch_execute(
            [RPCData.model_construct(rpcid=rpcid, payload=payload, identifier="generic")]
        )
    return {"text": resp.text[:200000]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, payload: dict = Body(...)):
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return _error(400, "messages must be a non-empty list", "invalid_request_error")

    model_id = payload.get("model", DEFAULT_MODEL)
    web_model, thinking = _resolve_model(model_id)
    tools = payload.get("tools") or []
    if payload.get("tool_choice") == "none":
        tools = []

    prompt = flatten_messages(messages)
    if tools:
        prompt = tool_instructions(tools) + "\n\n" + prompt

    stream = bool(payload.get("stream"))
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    if not stream:
        async with _lock:
            try:
                out = await asyncio.wait_for(
                    _client.generate_content(
                        prompt, model=web_model, temporary=True, extended_thinking=thinking
                    ),
                    timeout=GEN_TIMEOUT,
                )
            except asyncio.TimeoutError:
                return _error(504, f"generation timed out after {GEN_TIMEOUT}s", "timeout")
            except Exception as e:  # noqa: BLE001 — mapped to OpenAI error shape
                return _map_exception(e)
        parsed = parse_reply(out.text)
        message: dict[str, Any] = {"role": "assistant", "content": parsed.text}
        finish = "stop"
        if parsed.calls:
            message["tool_calls"] = _tool_calls_payload(parsed.calls)
            finish = "tool_calls"
        return {
            "id": cid,
            "object": "chat.completion",
            "created": created,
            "model": model_id,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": _usage(prompt, out.text),
        }
    return _stream(request, prompt, web_model, thinking, cid, created, model_id, bool(tools))


def _stream(request, prompt, web_model, thinking, cid, created, model_id, has_tools):
    def chunk(delta: dict, finish: str | None = None) -> str:
        return "data: " + json.dumps(
            {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_id,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            },
            ensure_ascii=False,
        ) + "\n\n"

    async def gen():
        # lock lives inside the generator: response body runs after the handler returns
        async with _lock:
            emitted = 0
            full = ""
            try:
                async for out in _client.generate_content_stream(
                    prompt, model=web_model, temporary=True, extended_thinking=thinking
                ):
                    if await request.is_disconnected():
                        break
                    full = out.text
                    if has_tools:
                        safe = holdback_end(full)
                        if safe > emitted:
                            yield chunk({"content": full[emitted:safe]})
                            emitted = safe
                    elif out.text_delta:
                        yield chunk({"content": out.text_delta})
            except Exception as e:  # noqa: BLE001
                yield "data: " + json.dumps({"error": {"message": str(e), "type": "upstream_error"}}) + "\n\n"
                yield "data: [DONE]\n\n"
                return

            if has_tools:
                # prefix before first fence already streamed; parse only the tail
                parsed = parse_reply(full[emitted:])
                if parsed.text:
                    yield chunk({"content": parsed.text})
                if parsed.calls:
                    for i, tc in enumerate(_tool_calls_payload(parsed.calls)):
                        yield chunk({"tool_calls": [{"index": i, **tc}]})
                    yield chunk({}, finish="tool_calls")
                else:
                    yield chunk({}, finish="stop")
            else:
                yield chunk({}, finish="stop")
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main() -> None:
    host = os.environ.get("GEMINI_BRIDGE_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=PORT, log_level="info")


if __name__ == "__main__":
    main()