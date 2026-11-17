#!/usr/bin/env node
/**
 * ACP agent for Gemini Web.
 *
 * Speaks the Agent Client Protocol on stdio and drives the gemini-bridge
 * OpenAI-compatible endpoint underneath (a local server over gemini.google.com
 * web RPC). Runs an agentic tool loop: the bridge emulates Gemini tool calls as
 * OpenAI tool_calls; this adapter executes them (bash/read/write/edit) and feeds
 * results back, streaming text and tool updates to BB.
 */
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { streamChat, listModels } from "../src/bridge-client.mjs";
import { TOOL_DEFS, executeTool } from "../src/tools.mjs";
import { ensureBridge, stopBridge } from "../src/bridge-manager.mjs";

const VERSION = "0.1.0";
const BRIDGE_URL = (process.env.GEMINI_BRIDGE_URL ?? "http://127.0.0.1:8787/v1").replace(/\/$/, "");
const MAX_TURNS = 30;
const DEFAULT_MODEL = "gemini-4-argon";
// repo root = bin/../.. ; bridge auto-starts on demand and stops after idle.
const REPO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IDLE_STOP_MS = Number(process.env.GEMINI_IDLE_STOP_MS ?? 180000); // 3 min
const ACTIVITY_FILE = join(REPO_PATH, ".bridge-activity");

let idleTimer = null;
function touchActivity() {
  try {
    writeFileSync(ACTIVITY_FILE, String(Date.now()));
  } catch {}
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
function scheduleIdleStop() {
  if (IDLE_STOP_MS <= 0) return; // 0 disables auto-stop
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    let last = 0;
    try {
      last = Number(readFileSync(ACTIVITY_FILE, "utf8")) || 0;
    } catch {}
    // only stop if no activity across all threads during the idle window
    if (Date.now() - last >= IDLE_STOP_MS) stopBridge();
  }, IDLE_STOP_MS);
  idleTimer.unref?.();
}

/** Flatten ACP prompt content blocks into plain text. */
function flattenPrompt(prompt) {
  const parts = [];
  for (const block of prompt ?? []) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource" && block.resource?.text) parts.push(block.resource.text);
    else if (block.type === "resource_link") parts.push(`[resource: ${block.name ?? block.uri}]`);
  }
  return parts.join("\n");
}

class GeminiAgent {
  #connection;
  /** @type {Map<string, {cwd:string, model:string, messages:Array}>} */
  #sessions = new Map();
  /** @type {Map<string, AbortController>} */
  #running = new Map();
  #catalog = null;

  constructor(connection) {
    this.#connection = connection;
  }

  initialize(params) {
    return {
      protocolVersion: params?.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: false, audio: false },
      },
      authMethods: [],
      agentInfo: { name: "gemini-acp", version: VERSION },
    };
  }

  authenticate() {
    return {};
  }

  async #models() {
    if (!this.#catalog) {
      const ids = await listModels(BRIDGE_URL);
      this.#catalog = ids.length ? ids : [DEFAULT_MODEL, "gemini-4-hydrogen", "gemini-web"];
    }
    return this.#catalog;
  }

  async #configOptions(record) {
    const models = await this.#models();
    const current = record.model && models.includes(record.model) ? record.model : models[0];
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: current,
        options: models.map((id) => ({ value: id, name: id })),
      },
    ];
  }

  async newSession(params) {
    const sessionId = randomUUID();
    const models = await this.#models();
    const record = {
      cwd: params?.cwd ?? process.cwd(),
      model: models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0],
      messages: [],
    };
    this.#sessions.set(sessionId, record);
    return { sessionId, configOptions: await this.#configOptions(record) };
  }

  async loadSession(params) {
    let record = this.#sessions.get(params.sessionId);
    if (!record) {
      const models = await this.#models();
      record = { cwd: params?.cwd ?? process.cwd(), model: models[0], messages: [] };
      this.#sessions.set(params.sessionId, record);
    }
    return { configOptions: await this.#configOptions(record) };
  }

  async setSessionConfigOption(params) {
    const record = this.#sessions.get(params.sessionId) ?? { cwd: process.cwd(), messages: [] };
    if (params.configId === "model") record.model = String(params.value);
    this.#sessions.set(params.sessionId, record);
    return { configOptions: await this.#configOptions(record) };
  }

  async prompt(params) {
    const { sessionId } = params;
    const record = this.#sessions.get(sessionId) ?? {
      cwd: params.cwd ?? process.cwd(),
      model: DEFAULT_MODEL,
      messages: [],
    };
    this.#sessions.set(sessionId, record);
    const cwd = params.cwd ?? record.cwd;
    const controller = new AbortController();
    this.#running.set(sessionId, controller);

    const userText = flattenPrompt(params.prompt);
    if (userText) record.messages.push({ role: "user", content: userText });

    const emitText = (delta) => {
      void this.#connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } },
      });
    };

    // on-demand: start the bridge if down (~9s), mark activity, cancel idle-stop
    touchActivity();
    const up = await ensureBridge(REPO_PATH, BRIDGE_URL);
    if (!up) {
      emitText("[gemini-acp: bridge failed to start — check cookies/proxy]");
      return { stopReason: "end_turn" };
    }

    try {
      let turns = 0;
      while (turns < MAX_TURNS) {
        turns += 1;
        const { text, toolCalls } = await streamChat({
          bridgeUrl: BRIDGE_URL,
          model: record.model,
          messages: record.messages,
          tools: TOOL_DEFS,
          signal: controller.signal,
          onText: emitText,
        });

        const assistant = { role: "assistant", content: text };
        if (toolCalls.length) {
          assistant.tool_calls = toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
        }
        record.messages.push(assistant);

        if (!toolCalls.length) return { stopReason: "end_turn" };

        for (const call of toolCalls) {
          if (controller.signal.aborted) return { stopReason: "cancelled" };
          const result = await executeTool({
            toolCall: call,
            cwd,
            connection: this.#connection,
            sessionId,
            signal: controller.signal,
          });
          record.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: result,
          });
        }
      }
      return { stopReason: "max_turn_requests" };
    } catch (e) {
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      emitText(`\n\n[gemini-acp error: ${e.message}]`);
      return { stopReason: "end_turn" };
    } finally {
      this.#running.delete(sessionId);
      touchActivity();
      scheduleIdleStop();
    }
  }

  cancel(params) {
    this.#running.get(params?.sessionId)?.abort();
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new GeminiAgent(connection), stream);