"""Tool-call text protocol + OpenAI messages -> single prompt flattening.

Gemini web RPC has no native function calling. We instruct the model to emit
fenced ```tool_call blocks and parse them back into OpenAI tool_calls.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

FENCE = "```tool_call"
_BLOCK_RE = re.compile(r"```tool_call[ \t]*\n(.*?)\n?```", re.DOTALL)


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass
class ParsedReply:
    text: str
    calls: list[ToolCall] = field(default_factory=list)


def tool_instructions(tools: list[dict]) -> str:
    """Protocol preamble injected into the prompt when tools are present."""
    lines = [
        "# TOOL USE PROTOCOL",
        "You are an agent with access to tools. To call a tool, output a fenced block:",
        FENCE,
        '{"name": "<tool name>", "arguments": { ... }}',
        "```",
        "Rules:",
        "- One block per call; several blocks per reply are allowed.",
        "- JSON inside a block must be complete and valid; arguments must match the tool schema.",
        "- Text outside blocks is shown to the user; keep it brief.",
        "- Tool results arrive as [TOOL RESULT ...] sections; continue from them.",
        "- Never nest tool_call blocks inside other code fences.",
        "",
        "Available tools:",
    ]
    for t in tools:
        fn = t.get("function", t)
        name = fn.get("name", "?")
        desc = fn.get("description", "")
        schema = json.dumps(fn.get("parameters", {}), ensure_ascii=False)
        lines.append(f"## {name}\n{desc}\nparameters JSON Schema: {schema}")
    return "\n".join(lines)


def parse_reply(text: str) -> ParsedReply:
    """Extract tool_call blocks. Malformed blocks stay in text (no data loss)."""
    calls: list[ToolCall] = []

    def _sub(m: re.Match) -> str:
        try:
            obj = json.loads(m.group(1))
            name = obj["name"]
            args = obj.get("arguments", {})
            if not isinstance(name, str) or not isinstance(args, dict):
                raise ValueError("bad shape")
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            return m.group(0)  # keep malformed block as visible text
        calls.append(ToolCall(name=name, arguments=args))
        return ""

    clean = _BLOCK_RE.sub(_sub, text)
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    return ParsedReply(text=clean, calls=calls)


def holdback_end(text: str) -> int:
    """How much of `text` is safe to stream as content.

    Everything from the first tool_call fence opener is withheld; a trailing
    partial opener (e.g. '``') is also withheld until more text arrives.
    """
    idx = text.find(FENCE)
    if idx != -1:
        return idx
    for n in range(len(FENCE) - 1, 0, -1):
        if text.endswith(FENCE[:n]):
            return len(text) - n
    return len(text)


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for p in content:  # OpenAI multimodal array
        if isinstance(p, dict) and p.get("type") == "text":
            parts.append(p.get("text", ""))
        elif isinstance(p, dict) and p.get("type") == "image_url":
            parts.append("[image omitted: web bridge is text-only]")
    return "\n".join(parts)


def flatten_messages(messages: list[dict]) -> str:
    """OpenAI transcript -> one prompt. Stateless: full history every request.

    ponytail: re-sends whole context each turn; upgrade path = ChatSession
    delta mapping if web context limits ever bite.
    """
    sections: list[str] = []
    for m in messages:
        role = m.get("role")
        text = _content_to_text(m.get("content"))
        if role == "system":
            sections.append(f"# SYSTEM\n{text}")
        elif role == "user":
            sections.append(f"# USER\n{text}")
        elif role == "assistant":
            body = text
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                block = json.dumps(
                    {"name": fn.get("name", ""), "arguments": args},
                    ensure_ascii=False,
                )
                body += f"\n{FENCE}\n{block}\n```"
            sections.append(f"# ASSISTANT\n{body.strip()}")
        elif role == "tool":
            sections.append(
                f"[TOOL RESULT name={m.get('name', '?')} call_id={m.get('tool_call_id', '?')}]\n{text}"
            )
    return "\n\n".join(sections)