import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { bridgeHealth, isRunning, readProxy, startBridge, stopBridge } from "./src/bridge-manager.mjs";
import { controlContract } from "./contract.js";

/**
 * Gemini Web runs as an ACP agent (gemini-acp) that drives the gemini-bridge
 * OpenAI-compatible endpoint (a local server over gemini.google.com web RPC).
 * The adapter advertises Hydrogen/Argon models as ACP session config options,
 * so no modelCli is set and BB discovers them from the adapter.
 */
function buildLaunchSpec(bridgeUrl: string, idleStopMs: number): JsonValue {
  return {
    displayName: "Gemini Web",
    command: "gemini-acp",
    args: [],
    env: { GEMINI_BRIDGE_URL: bridgeUrl, GEMINI_IDLE_STOP_MS: String(idleStopMs) },
  } satisfies JsonValue;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    bridgeUrl: {
      type: "string",
      default: "http://127.0.0.1:8787/v1",
      label: "gemini-bridge URL",
      description:
        "Base URL of the running gemini-bridge OpenAI endpoint (uv run python -m gemini_bridge).",
    },
    repoPath: {
      type: "string",
      default: "/Users/evgeny/Work/gemini",
      label: "Bridge repo path",
      description: "Path to the gemini-bridge repo (for start/stop control).",
    },
    idleStopMs: {
      type: "number",
      default: 180000,
      label: "Idle auto-stop (ms)",
      description: "Stop the bridge after this many ms without requests (0 = never).",
    },
  });

  const status = async () => {
    const v = await settings.get();
    const url = String(v.bridgeUrl ?? "http://127.0.0.1:8787/v1");
    const repo = String(v.repoPath ?? "/Users/evgeny/Work/gemini");
    return {
      running: isRunning(),
      health: await bridgeHealth(url),
      proxy: Boolean(readProxy(repo)),
    };
  };

  const bridgeBase = async () => {
    const v = await settings.get();
    return String(v.bridgeUrl ?? "http://127.0.0.1:8787/v1").replace(/\/v1\/?$/, "");
  };
  const bridgeGet = async (path: string) => {
    const r = await fetch(`${await bridgeBase()}${path}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    return r.json();
  };

  bb.rpc.register(
    controlContract,
    {
      "gemini.status": async () => status(),
      "gemini.start": async () => {
        const v = await settings.get();
        const repo = String(v.repoPath ?? "/Users/evgeny/Work/gemini");
        if (!isRunning()) startBridge(repo, readProxy(repo));
        return status();
      },
      "gemini.stop": async () => {
        stopBridge();
        return status();
      },
      "gemini.chats": async () => bridgeGet("/v1/chats"),
      "gemini.chatHistory": async ({ cid }) => bridgeGet(`/v1/chats/${encodeURIComponent(cid)}?limit=40`),
      "gemini.continueChat": async ({ cid, title }) => {
        try {
          const hist = await bridgeGet(`/v1/chats/${encodeURIComponent(cid)}?limit=40`);
          const turns = (hist.turns ?? []) as { role: string; text: string }[];
          const transcript = turns
            .map((t) => `${t.role === "user" ? "User" : "Gemini"}: ${t.text}`)
            .join("\n\n");
          const seed =
            `Продолжи этот диалог из Gemini (контекст ниже). Ответь на последнее сообщение пользователя, сохраняя контекст.\n\n` +
            `--- История диалога ---\n${transcript}\n--- Конец истории ---`;
          const projects = await bb.sdk.projects.list();
          const personal = projects.find((p) => /personal|личн/i.test(p.name ?? "")) ?? projects[0];
          const hosts = await bb.sdk.hosts.list();
          const hostId = hosts[0]?.id;
          const thread = await bb.sdk.threads.spawn({
            ...(personal?.id ? { projectId: personal.id, environment: { type: "project-default" } } : { environment: { type: "personal" } }),
            ...(hostId ? { hostId } : {}),
            prompt: seed,
            title: title ? `Gemini: ${title}` : "Gemini chat continuation",
          });
          return { threadId: thread?.id ?? thread?.threadId ?? null, error: null };
        } catch (e) {
          return { threadId: null, error: String(e) };
        }
      },
    },
    { experimental_discoverable: true },
  );

  bb.providers.register({
    id: "gemini-web",
    displayName: "Gemini Web",
    family: "acp",
    icon: "./assets/icon.svg",
    strings: {
      signInHint:
        "Start gemini-bridge (uv run python -m gemini_bridge) with valid Gemini cookies on the machine.",
      expiredHint:
        "Gemini cookies expired or IP flagged. Re-extract cookies (scripts/extract_cookies.py) and restart gemini-bridge.",
      installUrl: "https://github.com/EvgenyGulyaev/GeminiAPi",
      iconTint: { light: "#1A73E8", dark: "#8AB4F8" },
    },
    experimental_visibility: "always",
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    models: { fallback: [], scope: "host" },
    composerActions: [],
    experimental_bridgeOptions: {
      acpDialect: "acp",
      parameterizedModelPicker: true,
      acpLaunchSpec: buildLaunchSpec("http://127.0.0.1:8787/v1", 180000),
    },
    deriveProviderOptions(ctx) {
      const bridgeUrl = String(ctx.settings.bridgeUrl ?? "http://127.0.0.1:8787/v1").trim();
      const idleStopMs = Number(ctx.settings.idleStopMs ?? 180000);
      return {
        acpDialect: "acp",
        parameterizedModelPicker: true,
        acpLaunchSpec: buildLaunchSpec(bridgeUrl, idleStopMs),
      };
    },
  });

  void settings.get().then((values) => {
    bb.log.info(`Gemini Web provider registered (bridge ${values.bridgeUrl})`);
  });
}