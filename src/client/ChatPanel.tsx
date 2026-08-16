import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Msg = { role: "user" | "assistant"; content: string; trace?: { tool: string; result: string }[] };

/**
 * "Vibe" editing: describe what you want and the model rearranges the plan
 * through the same tools the MCP server exposes. Only users with the `chat`
 * flag can reach it, so the shared model key stays under control.
 */
export function ChatPanel({ planId }: { planId: string }) {
  const [config, setConfig] = useState<{ enabled: boolean; allowed: boolean; model: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  if (!config?.enabled || !config.allowed) return null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await api.chat(
        planId,
        next.map((m) => ({ role: m.role, content: m.content }))
      );
      setMessages([...next, { role: "assistant", content: res.reply, trace: res.trace }]);
    } catch (err) {
      setMessages([...next, { role: "assistant", content: `⚠ ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-primary fixed right-4 bottom-4 shadow-lg" onClick={() => setOpen(true)}>
        Ask the model
      </button>
    );
  }

  return (
    <div className="panel fixed right-4 bottom-4 flex h-[420px] w-[380px] flex-col rounded-lg shadow-2xl">
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <span className="text-sm font-medium text-white">{config.model}</span>
        <button className="btn text-xs" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {!messages.length && (
          <p className="text-ink-400">
            Try: “put the tanks north and the healers south, then add a 15y donut on the boss for step 2”.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            <div className={m.role === "user" ? "text-white" : "text-ink-200"}>
              <span className="label mr-2">{m.role}</span>
              {m.content}
            </div>
            {m.trace?.length ? (
              <ul className="mt-1 space-y-0.5 text-[11px] text-ink-400">
                {m.trace.map((t, j) => (
                  <li key={j}>
                    · {t.tool}: {t.result.slice(0, 90)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {busy && <p className="text-ink-400">thinking…</p>}
      </div>
      <form className="flex gap-1 border-t border-ink-700 p-2" onSubmit={send}>
        <input
          className="field"
          placeholder="Describe the change…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy}>
          Send
        </button>
      </form>
    </div>
  );
}
