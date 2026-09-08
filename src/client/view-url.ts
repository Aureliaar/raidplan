/**
 * The part of the editor view that lives in the address bar: which Step you are
 * looking at, which Beat is open, and which reading of each Variant split is on
 * screen. None of it belongs to the document — two people can read the same
 * plan differently — but all of it is what you mean by "look at this", so a
 * reload keeps it and a pasted link hands someone else the same frame.
 */
export type ViewParams = {
  /** Step id rather than index, so an inserted Step ahead of it cannot shift it. */
  step: string | null;
  /** The open Beat, by id. */
  mech: string | null;
  /** Chosen reading per Variant split, keyed by the Step that owns it. */
  shown: Record<string, string>;
};

const SHOWN = "v";

export function readViewParams(search: string = location.search): ViewParams {
  const params = new URLSearchParams(search);
  const shown: Record<string, string> = {};
  for (const pair of (params.get(SHOWN) ?? "").split(",")) {
    const at = pair.indexOf(":");
    if (at > 0) shown[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return {
    step: params.get("step"),
    mech: params.get("mech"),
    shown,
  };
}

/**
 * Replaces, never pushes: walking the fight is not browser history, and every
 * keypress leaving an entry to back out of would make Back useless.
 */
export function writeViewParams(view: ViewParams) {
  const params = new URLSearchParams(location.search);
  const set = (key: string, value: string | null) =>
    value ? params.set(key, value) : params.delete(key);
  set("step", view.step);
  set("mech", view.mech);
  const shown = Object.entries(view.shown)
    .map(([owner, variant]) => `${owner}:${variant}`)
    .join(",");
  set(SHOWN, shown || null);
  const query = params.toString();
  const next = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`)
    history.replaceState(history.state, "", next);
}
