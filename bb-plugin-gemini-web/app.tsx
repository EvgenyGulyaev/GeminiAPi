import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import { controlContract } from "./contract.js";

type Status = { running: boolean; health: boolean; proxy: boolean };
type Chat = { cid: string; title: string; pinned: boolean; timestamp: number };
type Turn = { role: string; text: string };

const card: React.CSSProperties = {
  background: "rgba(148,163,184,.06)",
  border: "1px solid rgba(148,163,184,.12)",
  borderRadius: 12,
  padding: 14,
};
const btnBase: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: 8,
  border: "1px solid rgba(148,163,184,.2)",
  background: "rgba(148,163,184,.08)",
  color: "inherit",
  fontSize: 13,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: "linear-gradient(135deg,#1A73E8,#8AB4F8)",
  border: "none",
  color: "#fff",
  fontWeight: 600,
};

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: ok ? "#22c55e" : "#64748b",
        boxShadow: ok ? "0 0 6px rgba(34,197,94,.6)" : "none",
        display: "inline-block",
      }}
    />
  );
}

function ControlPanel() {
  const rpc = useRpc<typeof controlContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [openCid, setOpenCid] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("gemini.status", {}));
    } catch (e) {
      setErr(String(e));
    }
  }, [rpc]);

  const loadChats = useCallback(async () => {
    setErr(null);
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
    setOpenCid(cid === openCid ? null : cid);
    setTurns(null);
    if (cid === openCid) return;
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
    setNotice(null);
    try {
      const r = await rpc.call("gemini.continueChat", { cid: chat.cid, title: chat.title });
      if (r.error) setErr(r.error);
      else setNotice(`Тред создан: ${chat.title}. Открой его и выбери провайдер Gemini Web.`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusRow = (label: string, ok: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <Dot ok={ok} />
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ marginLeft: "auto", color: ok ? "#22c55e" : "#64748b", fontWeight: 600 }}>
        {ok ? "вкл" : "выкл"}
      </span>
    </div>
  );

  return (
    <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <span style={{ fontSize: 18 }}>✦</span>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Gemini Bridge</span>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10, flex: "0 1 300px", minWidth: 260 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: .5 }}>
          Состояние моста
        </div>
        {statusRow("Процесс", status?.running ?? false)}
        {statusRow("Сервис отвечает", status?.health ?? false)}
        {statusRow("Прокси", status?.proxy ?? false)}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          <button disabled={busy} onClick={() => void act("gemini.start")} style={btnPrimary}>
            {busy ? "…" : "Запустить"}
          </button>
          <button disabled={busy} onClick={() => void act("gemini.stop")} style={btnBase}>Остановить</button>
          <button disabled={busy} onClick={() => void refresh()} style={btnBase}>Обновить</button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b" }}>
          Автозапуск при запросе · автоостановка после простоя
        </div>
      </div>

      <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10, flex: "1 1 420px", minWidth: 320 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: .5 }}>
            Диалоги Gemini
          </span>
          <button onClick={() => void loadChats()} style={btnBase}>Загрузить</button>
        </div>
        {chats.length === 0 && (
          <div style={{ fontSize: 13, color: "#64748b" }}>Нажми «Загрузить» чтобы увидеть свои диалоги.</div>
        )}
        {chats.map((c) => (
          <div key={c.cid} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={() => void openHistory(c.cid)}
                style={{ ...btnBase, flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={c.title}
              >
                {c.pinned ? "📌 " : "💬 "}{c.title || c.cid}
              </button>
              <button disabled={busy} onClick={() => void continueChat(c)} style={btnPrimary}>Продолжить</button>
            </div>
            {openCid === c.cid && turns && (
              <div style={{ maxHeight: 420, overflow: "auto", fontSize: 13, background: "rgba(0,0,0,.2)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                {turns.map((t, i) => (
                  <div key={i} style={{ lineHeight: 1.5 }}>
                    <b style={{ color: t.role === "user" ? "#8ab4f8" : "#22c55e" }}>
                      {t.role === "user" ? "Вы" : "Gemini"}:
                    </b>{" "}
                    {t.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {notice && <div style={{ fontSize: 12, color: "#22c55e", width: "100%" }}>{notice}</div>}
      {err && <div style={{ fontSize: 12, color: "#ef4444", wordBreak: "break-word", width: "100%" }}>{err}</div>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gemini-bridge-control",
    title: "Gemini Bridge",
    icon: "Sparkles",
    path: "gemini-bridge",
    component: ControlPanel,
  });
});