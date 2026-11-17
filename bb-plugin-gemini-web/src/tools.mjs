/**
 * Tool definitions (OpenAI format for the bridge) and execution.
 * The adapter executes tools itself (Node child_process / fs) in the session
 * cwd, gating writes/commands through ACP requestPermission, and reports
 * tool_call / tool_call_update so BB renders them.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the project directory. Returns stdout+stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file. Optional offset (1-indexed line) and limit (line count).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or overwrite a text file with the given content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "Replace an exact, unique oldText snippet with newText in a file. oldText must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
];

const WRITE_TOOLS = new Set(["bash", "write", "edit"]);
const KIND = { bash: "execute", read: "read", write: "edit", edit: "edit" };

function abs(cwd, p) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function runBash(command, cwd, signal) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, cwd, env: process.env, signal });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise(`error: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(`${out}${out && !out.endsWith("\n") ? "\n" : ""}[exit ${code}]`);
    });
  });
}

async function execRaw(name, args, cwd, signal) {
  if (name === "bash") return runBash(String(args.command ?? ""), cwd, signal);
  if (name === "read") {
    const text = await readFile(abs(cwd, String(args.path)), "utf8");
    const lines = text.split("\n");
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Number(args.limit) || lines.length;
    return lines.slice(offset - 1, offset - 1 + limit).join("\n");
  }
  if (name === "write") {
    const p = abs(cwd, String(args.path));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, String(args.content ?? ""), "utf8");
    return `wrote ${p}`;
  }
  if (name === "edit") {
    const p = abs(cwd, String(args.path));
    const text = await readFile(p, "utf8");
    const oldText = String(args.oldText ?? "");
    const count = text.split(oldText).length - 1;
    if (count === 0) return `error: oldText not found in ${p}`;
    if (count > 1) return `error: oldText matches ${count} times; must be unique`;
    await writeFile(p, text.replace(oldText, String(args.newText ?? "")), "utf8");
    return `edited ${p}`;
  }
  return `error: unknown tool ${name}`;
}

/**
 * Execute one tool call, reporting ACP updates and gating writes via permission.
 * @returns {Promise<string>} result text to feed back to the model
 */
export async function executeTool({ toolCall, cwd, connection, sessionId, signal }) {
  const { id, name, arguments: args } = toolCall;
  const kind = KIND[name] ?? "other";
  const title = name === "bash" ? String(args.command ?? "bash") : `${name} ${args.path ?? ""}`;

  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title,
      kind,
      status: "pending",
      rawInput: args,
    },
  });

  if (WRITE_TOOLS.has(name)) {
    const resp = await connection.requestPermission({
      sessionId,
      toolCall: { toolCallId: id, kind, title, rawInput: args },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = resp?.outcome?.outcome === "selected" && resp.outcome.optionId === "allow";
    if (!allowed) {
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" },
      });
      return "Permission denied by user.";
    }
  }

  await connection.sessionUpdate({
    sessionId,
    update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" },
  });

  let result;
  let failed = false;
  try {
    result = await execRaw(name, args, cwd, signal);
    if (typeof result === "string" && result.startsWith("error:")) failed = true;
  } catch (e) {
    result = `error: ${e.message}`;
    failed = true;
  }

  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: failed ? "failed" : "completed",
      rawOutput: result,
      content: [{ type: "content", content: { type: "text", text: String(result).slice(0, 8000) } }],
    },
  });

  return String(result);
}