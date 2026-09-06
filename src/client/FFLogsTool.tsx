import { useEffect, useMemo, useState } from "react";
import { navigate } from "./App";
import type { FFLogsDebuffDump } from "../shared/fflogs";
import type { FightLibraryEntry } from "../shared/fight-library";
import { api } from "./api";
import {
  beginFFLogsAuthorization,
  completeFFLogsAuthorization,
  disconnectFFLogs,
  dumpFFLogsDebuffsInBrowser,
  hasFFLogsToken,
} from "./fflogs-browser";

const EXAMPLE_URL = "https://www.fflogs.com/reports/bLHFCQWpGvyNz8J7?fight=24";

/**
 * Running a log is how the library learns a fight. Every pull is folded into
 * that fight's entry, so plans for the encounter pick the statuses up on their
 * own — nothing to download, nothing to hand around.
 */
export function FFLogsTool() {
  const [url, setUrl] = useState(EXAMPLE_URL);
  const [result, setResult] = useState<FFLogsDebuffDump | null>(null);
  const [imported, setImported] = useState<{ entry: FightLibraryEntry; added: number } | null>(null);
  const [library, setLibrary] = useState<FightLibraryEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(hasFFLogsToken());

  const refresh = () => api.debuffLibrary().then(setLibrary).catch(() => undefined);

  async function run(value: string) {
    setLoading(true);
    setError("");
    try {
      const dump = await dumpFFLogsDebuffsInBrowser(value);
      setImported(await api.importDebuffs(dump));
      setResult(dump);
      await refresh();
    } catch (caught) {
      setResult(null);
      setImported(null);
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function show(entry: FightLibraryEntry) {
    setError("");
    setImported(null);
    try {
      setResult(await api.debuffFight(entry.key));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
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

  return (
    <main className="mx-auto min-h-full max-w-5xl p-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <button className="mb-3 text-sm text-accent hover:underline" onClick={() => navigate("/")}>← Plans</button>
          <h1 className="text-2xl font-semibold text-white">Fight debuff library</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            Run a log and every party debuff in it joins that fight's library, tooltip and icon included —
            ready for any plan of the encounter. Weakness, Brink of Death, and Damage Down are omitted.
          </p>
        </div>
        <button
          className="btn whitespace-nowrap"
          onClick={() => {
            if (connected) {
              disconnectFFLogs();
              setConnected(false);
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
            {loading ? "Reading log…" : connected ? "Add to library" : "Connect & add"}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-400">The link must contain a numeric fight parameter, such as <code>?fight=24</code>.</p>
      </form>

      {error && <div className="mb-6 rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}

      {imported && (
        <div className="mb-6 rounded border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          {imported.entry.name} now holds {imported.entry.debuffs} statuses
          {imported.added > 0
            ? ` — ${imported.added} new from this pull`
            : " — nothing this pull had not already taught it"}.
        </div>
      )}

      <FightLibrary library={library} onShow={show} showing={result} />

      {result && (
        <section className="mt-6">
          <div className="mb-2">
            <h2 className="text-lg font-medium text-white">{result.fight.name}</h2>
            <p className="text-sm text-ink-400">{result.debuffs.length} statuses, sorted by first application</p>
          </div>
          <ul className="grid gap-2 md:grid-cols-2">
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
        </section>
      )}
    </main>
  );
}

/** Every fight the library knows, newest log first. */
function FightLibrary({
  library,
  showing,
  onShow,
}: {
  library: FightLibraryEntry[];
  showing: FFLogsDebuffDump | null;
  onShow(entry: FightLibraryEntry): void;
}) {
  const when = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }), []);
  return (
    <section>
      <h2 className="label mb-2">Fights in the library</h2>
      {library.length === 0 ? (
        <p className="panel rounded p-3 text-sm text-ink-400">
          Nothing yet. Run a log above and its fight lands here.
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {library.map((entry) => (
            <li key={entry.key}>
              <button
                className={`panel w-full rounded p-3 text-left hover:border-accent ${
                  showing?.fight.name === entry.name ? "border-accent" : ""
                }`}
                onClick={() => onShow(entry)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-white">{entry.name}</strong>
                  <span className="text-xs text-ink-400">{entry.debuffs} statuses</span>
                </div>
                <div className="mt-1 text-xs text-ink-400">
                  last log {when.format(entry.updatedAt)}
                  {entry.aliases.length ? ` · also called ${entry.aliases.join(", ")}` : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
