/**
 * Client for the gemini-bridge OpenAI-compatible endpoint.
 * Consumes the SSE chat stream, forwarding text deltas and accumulating
 * tool_calls (the bridge parses Gemini's fenced tool_call blocks into native
 * OpenAI tool_calls at end of stream).
 */

/**
 * @param {object} o
 * @param {string} o.bridgeUrl  e.g. http://127.0.0.1:8787/v1
 * @param {string} o.model
 * @param {Array} o.messages    OpenAI messages
 * @param {Array} [o.tools]     OpenAI tool defs
 * @param {AbortSignal} [o.signal]
 * @param {(delta: string) => void} [o.onText]
 * @returns {Promise<{text: string, toolCalls: Array, finishReason: string}>}
 */
export async function streamChat({ bridgeUrl, model, messages, tools, signal, onText }) {
  const body = { model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${bridgeUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`bridge HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  let text = "";
  let finishReason = "stop";
  /** @type {Map<number, {id:string, name:string, arguments:string}>} */
  const calls = new Map();
  let streamError = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj.error) {
          streamError = obj.error.message || "bridge stream error";
          continue;
        }
        const choice = obj.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onText?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            const cur = calls.get(i) || { id: "", name: "", arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            calls.set(i, cur);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  if (streamError && !text && calls.size === 0) throw new Error(streamError);

  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c) => {
      let args = {};
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        args = {};
      }
      return { id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.name, arguments: args };
    });

  return { text, toolCalls, finishReason };
}

/** Fetch the bridge model catalog (ids). Falls back to [] on error. */
export async function listModels(bridgeUrl) {
  try {
    const res = await fetch(`${bridgeUrl}/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}