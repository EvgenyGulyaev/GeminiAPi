import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { controlContract } from "./contract.js";

type Status = { running: boolean; health: boolean; proxy: boolean };

function ControlPanel() {
  const rpc = useRpc<typeof controlContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("gemini.status", {}));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (method: "gemini.start" | "gemini.stop") => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await rpc.call(method, {}));
      // health lags start (init ~9s); poll a few times
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await rpc.call("gemini.status", {});
        setStatus(s);
        if (method === "gemini.start" ? s.health : !s.running) break;
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const badge = (label: string, ok: boolean) => (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 6,
        fontSize: 12,
        background: ok ? "rgba(34,197,94,.15)" : "rgba(148,163,184,.15)",
        color: ok ? "#22c55e" : "#94a3b8",
      }}
    >
      {label}: {ok ? "on" : "off"}
    </span>
  );

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>gemini-bridge control</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {badge("process", status?.running ?? false)}
        {badge("health", status?.health ?? false)}
        {badge("proxy", status?.proxy ?? false)}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={busy}
          onClick={() => void act("gemini.start")}
          style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}
        >
          {busy ? "…" : "Start"}
        </button>
        <button
          disabled={busy}
          onClick={() => void act("gemini.stop")}
          style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}
        >
          Stop
        </button>
        <button
          disabled={busy}
          onClick={() => void refresh()}
          style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        Auto-starts on request; auto-stops after idle (settings: idleStopMs).
      </div>
      {err && <div style={{ fontSize: 12, color: "#ef4444" }}>{err}</div>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gemini-bridge-control",
    title: "Gemini Bridge",
    icon: "Zap",
    component: ControlPanel,
  });
});