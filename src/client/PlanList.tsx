import { useEffect, useState } from "react";
import { api } from "./api";
import { navigate } from "./App";
import type { PlanSummary, User } from "../shared/schema";

export function PlanList({ user }: { user: User }) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [showTokens, setShowTokens] = useState(false);

  const refresh = () => api.listPlans().then(setPlans).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { id } = await api.createPlan({ name: name || "Untitled plan" });
      navigate(`/p/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">raidplan</h1>
          <p className="text-sm text-ink-400">Signed in as {user.name}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setShowTokens((v) => !v)}>
            MCP access
          </button>
          <a className="btn" href="/auth/logout">
            Sign out
          </a>
        </div>
      </header>

      {showTokens && <TokenPanel />}

      <form className="mb-6 flex gap-2" onSubmit={create}>
        <input
          className="field"
          placeholder="New plan name — e.g. M5S enrage positions"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary whitespace-nowrap" type="submit">
          New plan
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      <ul className="space-y-2">
        {plans.map((p) => (
          <li key={p.id} className="panel flex items-center justify-between rounded p-3">
            <button className="text-left" onClick={() => navigate(`/p/${p.id}`)}>
              <div className="font-medium text-white">{p.name}</div>
              <div className="text-xs text-ink-400">
                {p.encounter ? `${p.encounter} · ` : ""}
                {p.role} · {new Date(p.updatedAt).toLocaleString()} · {p.id}
              </div>
            </button>
            {p.role === "owner" && (
              <button
                className="btn text-xs"
                onClick={async () => {
                  if (!confirm(`Delete "${p.name}"?`)) return;
                  await api.deletePlan(p.id);
                  refresh();
                }}
              >
                Delete
              </button>
            )}
          </li>
        ))}
        {!plans.length && <p className="text-sm text-ink-400">No plans yet.</p>}
      </ul>
    </div>
  );
}

/** API tokens double as MCP credentials, so this panel also shows the config snippet. */
function TokenPanel() {
  const [tokens, setTokens] = useState<{ id: string; label: string; createdAt: number }[]>([]);
  const [fresh, setFresh] = useState<{ token: string; mcpUrl: string } | null>(null);
  const [label, setLabel] = useState("claude");

  const refresh = () => api.listTokens().then(setTokens);
  useEffect(() => {
    refresh();
  }, []);

  const url = fresh?.mcpUrl ?? `${location.origin}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        raidplan: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${fresh?.token ?? "rp_YOUR_TOKEN"}` },
        },
      },
    },
    null,
    2
  );

  return (
    <div className="panel mb-6 rounded p-4">
      <h2 className="mb-2 font-medium text-white">MCP access</h2>
      <p className="mb-3 text-sm text-ink-400">
        A token lets a model reach every plan you can, through the same tools the app uses.
      </p>
      <div className="mb-3 flex gap-2">
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button
          className="btn btn-primary whitespace-nowrap"
          onClick={async () => {
            setFresh(await api.createToken(label));
            refresh();
          }}
        >
          Create token
        </button>
      </div>
      {fresh && (
        <p className="mb-3 rounded bg-ink-900 p-2 font-mono text-xs break-all text-emerald-300">
          {fresh.token}
          <span className="ml-2 text-ink-400">— copy it now, it is not shown again</span>
        </p>
      )}
      <pre className="mb-3 overflow-x-auto rounded bg-ink-900 p-3 text-xs text-ink-200">{snippet}</pre>
      <p className="mb-2 text-xs text-ink-400">
        Or: <code>claude mcp add --transport http raidplan {url} --header "Authorization: Bearer rp_…"</code>
      </p>
      <ul className="space-y-1 text-xs text-ink-400">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between">
            <span>
              {t.label} · {new Date(t.createdAt).toLocaleDateString()}
            </span>
            <button
              className="btn"
              onClick={async () => {
                await api.revokeToken(t.id);
                refresh();
              }}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
