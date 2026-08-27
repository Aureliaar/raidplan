import { useEffect, useMemo, useState } from "react";
import { navigate } from "./App";
import type { FFLogsDebuffDump } from "../shared/fflogs";
import {
  beginFFLogsAuthorization,
  completeFFLogsAuthorization,
  disconnectFFLogs,
  dumpFFLogsDebuffsInBrowser,
  hasFFLogsToken,
} from "./fflogs-browser";

const EXAMPLE_URL = "https://www.fflogs.com/reports/bLHFCQWpGvyNz8J7?fight=24";

export function FFLogsTool() {
  const [url, setUrl] = useState(EXAMPLE_URL);
  const [result, setResult] = useState<FFLogsDebuffDump | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(hasFFLogsToken());
  const json = useMemo(() => result ? JSON.stringify(result, null, 2) : "", [result]);

  async function run(value: string) {
    setLoading(true);
    setError("");
    try {
      setResult(await dumpFFLogsDebuffsInBrowser(value));
    } catch (caught) {
      setResult(null);
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void completeFFLogsAuthorization()
      .then((pendingUrl) => {
        if (!hasFFLogsToken()) return;
        setConnected(true);
        if (pendingUrl) {
          setUrl(pendingUrl);
          void run(pendingUrl);
        }
      })
      .catch((caught) => setError((caught as Error).message));
  }, []);

  async function parse(event: React.FormEvent) {
    event.preventDefault();
    if (!hasFFLogsToken()) {
      await beginFFLogsAuthorization(url);
      return;
    }
    await run(url);
  }

  function download() {
    if (!result) return;
    const blob = new Blob([json], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${result.source.reportCode}-fight-${result.source.fightId}-debuffs.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <main className="mx-auto min-h-full max-w-5xl p-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <button className="mb-3 text-sm text-accent hover:underline" onClick={() => navigate("/")}>← Plans</button>
          <h1 className="text-2xl font-semibold text-white">FF Logs debuff dump</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            Extract every party debuff in one pull, enriched with its in-game tooltip and icon.
            Weakness, Brink of Death, and Damage Down are omitted.
          </p>
        </div>
        <button
          className="btn whitespace-nowrap"
          onClick={() => {
            if (connected) {
              disconnectFFLogs();
              setConnected(false);
              setResult(null);
            } else {
              void beginFFLogsAuthorization(url);
            }
          }}
        >
          {connected ? "Disconnect FF Logs" : "Connect FF Logs"}
        </button>
      </header>

      <form className="panel mb-6 rounded-lg p-4" onSubmit={parse}>
        <label className="label mb-2 block" htmlFor="fflogs-url">Numbered FF Logs fight URL</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="fflogs-url"
            className="field font-mono"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={EXAMPLE_URL}
          />
          <button className="btn btn-primary whitespace-nowrap px-4" type="submit" disabled={loading}>
            {loading ? "Parsing…" : connected ? "Dump debuffs" : "Connect & dump"}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-400">The link must contain a numeric fight parameter, such as <code>?fight=24</code>.</p>
      </form>

      {error && <div className="mb-6 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}

      {result && (
        <>
          <section className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium text-white">{result.fight.name}</h2>
              <p className="text-sm text-ink-400">Fight {result.fight.id} · {result.debuffs.length} debuffs · sorted by first application</p>
            </div>
            <div className="flex gap-2">
              <button className="btn" onClick={() => navigator.clipboard.writeText(json)}>Copy JSON</button>
              <button className="btn" onClick={download}>Download .json</button>
            </div>
          </section>

          <ul className="mb-6 grid gap-2 md:grid-cols-2">
            {result.debuffs.map((debuff) => (
              <li key={debuff.id} className="panel flex min-h-24 gap-3 rounded p-3">
                {debuff.icon ? (
                  <img className="h-10 w-10 shrink-0 rounded" src={debuff.icon.url} alt="" />
                ) : <div className="h-10 w-10 shrink-0 rounded bg-ink-700" />}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <strong className="text-white">{debuff.name}</strong>
                    <code className="text-xs text-accent">{debuff.firstApplied}</code>
                    <span className="text-xs text-ink-400">#{debuff.id}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-400">{debuff.tooltip || "No in-game tooltip available."}</p>
                </div>
              </li>
            ))}
          </ul>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="label">Machine-readable JSON</h2>
              <span className="text-xs text-ink-400">schemaVersion {result.schemaVersion}</span>
            </div>
            <pre className="max-h-[36rem] overflow-auto rounded-lg bg-black/30 p-4 text-xs leading-relaxed text-ink-200">{json}</pre>
          </section>
        </>
      )}
    </main>
  );
}
