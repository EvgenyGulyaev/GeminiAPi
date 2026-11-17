import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { controlContract } from "./contract.js";

type Status = { running: boolean; health: boolean; proxy: boolean };
type Chat = { cid: string; title: string; pinned: boolean; timestamp: number };
type Turn = { role: string; text: string };

const btn = { padding: "6px 14px", borderRadius: 6, cursor: "pointer" } as const;

function ControlPanel() {
  const rpc = useRpc<typeof controlContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [openCid, setOpenCid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("gemini.status", {}));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [rpc]);

  const loadChats = useCallback(async () => {
    try {
      const r = await rpc.call("gemini.chats", {});
      setChats(r.data ?? []);
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

  const openHistory = async (cid: string) => {
    setOpenCid(cid);
    setTurns(null);
    try {
      const r = await rpc.call("gemini.chatHistory", { cid });
      setTurns(r.turns ?? []);
    } catch (e) {
      setErr(String(e));
    }
  };

  const continueChat = async (chat: Chat) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await rpc.call("gemini.continueChat", { cid: chat.cid, title: chat.title });
      if (r.error) setErr(r.error);
      else setErr(null);
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
        <button disabled={busy} onClick={() => void act("gemini.start")} style={btn}>
          {busy ? "…" : "Start"}
        </button>
        <button disabled={busy} onClick={() => void act("gemini.stop")} style={btn}>Stop</button>
        <button disabled={busy} onClick={() => void refresh()} style={btn}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>
        Auto-starts on request; auto-stops after idle (settings: idleStopMs).
      </div>

      <div style={{ borderTop: "1px solid rgba(148,163,184,.2)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Gemini web chats</div>
          <button onClick={() => void loadChats()} style={btn}>Load chats</button>
        </div>
        {chats.map((c) => (
          <div key={c.cid} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <button
              onClick={() => void openHistory(c.cid)}
              style={{ ...btn, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={c.title}
            >
              {c.pinned ? "📌 " : ""}{c.title || c.cid}
            </button>
            <button disabled={busy} onClick={() => void continueChat(c)} style={btn}>Continue</button>
          </div>
        ))}
        {openCid && turns && (
          <div style={{ maxHeight: 260, overflow: "auto", fontSize: 12, background: "rgba(148,163,184,.08)", borderRadius: 6, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {turns.map((t, i) => (
              <div key={i}>
                <b style={{ color: t.role === "user" ? "#8ab4f8" : "#22c55e" }}>{t.role}:</b>{" "}
                {t.text.slice(0, 300)}{t.text.length > 300 ? "…" : ""}
              </div>
            ))}
          </div>
        )}
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