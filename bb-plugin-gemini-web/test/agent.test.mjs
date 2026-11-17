import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamChat } from "../src/bridge-client.mjs";
import { executeTool } from "../src/tools.mjs";

function sseServer(frames) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

test("streamChat accumulates content deltas and tool_calls", async () => {
  const { server, url } = await sseServer([
    { choices: [{ delta: { content: "Hello " } }] },
    { choices: [{ delta: { content: "world" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const chunks = [];
  try {
    const out = await streamChat({ bridgeUrl: url, model: "m", messages: [], onText: (d) => chunks.push(d) });
    assert.equal(out.text, "Hello world");
    assert.deepEqual(chunks, ["Hello ", "world"]);
    assert.equal(out.finishReason, "tool_calls");
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, "bash");
    assert.deepEqual(out.toolCalls[0].arguments, { command: "ls" });
  } finally {
    server.close();
  }
});

test("streamChat plain text finish stop", async () => {
  const { server, url } = await sseServer([
    { choices: [{ delta: { content: "OK" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  try {
    const out = await streamChat({ bridgeUrl: url, model: "m", messages: [] });
    assert.equal(out.text, "OK");
    assert.equal(out.toolCalls.length, 0);
    assert.equal(out.finishReason, "stop");
  } finally {
    server.close();
  }
});

function mockConnection() {
  const updates = [];
  return {
    updates,
    async sessionUpdate(p) {
      updates.push(p.update);
    },
    async requestPermission() {
      return { outcome: { outcome: "selected", optionId: "allow" } };
    },
  };
}

test("executeTool edit requires unique match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-acp-"));
  const p = join(dir, "f.txt");
  await writeFile(p, "alpha\nbeta\nalpha\n", "utf8");
  const conn = mockConnection();
  const dup = await executeTool({
    toolCall: { id: "c1", name: "edit", arguments: { path: p, oldText: "alpha", newText: "x" } },
    cwd: dir, connection: conn, sessionId: "s",
  });
  assert.match(dup, /matches 2 times/);
  const ok = await executeTool({
    toolCall: { id: "c2", name: "edit", arguments: { path: p, oldText: "beta", newText: "BETA" } },
    cwd: dir, connection: conn, sessionId: "s",
  });
  assert.match(ok, /edited/);
  assert.equal(await readFile(p, "utf8"), "alpha\nBETA\nalpha\n");
  assert.ok(conn.updates.some((u) => u.sessionUpdate === "tool_call" && u.status === "pending"));
  assert.ok(conn.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
});

test("executeTool read offset/limit and write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-acp-"));
  const conn = mockConnection();
  await executeTool({
    toolCall: { id: "w", name: "write", arguments: { path: join(dir, "a.txt"), content: "l1\nl2\nl3\n" } },
    cwd: dir, connection: conn, sessionId: "s",
  });
  const out = await executeTool({
    toolCall: { id: "r", name: "read", arguments: { path: join(dir, "a.txt"), offset: 2, limit: 1 } },
    cwd: dir, connection: conn, sessionId: "s",
  });
  assert.equal(out, "l2");
});