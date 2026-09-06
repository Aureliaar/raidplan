import { useEffect, useMemo, useState } from "react";
import type { Op } from "../shared/apply";
import type { FFLogsDebuffDump } from "../shared/fflogs";
import { assetUrl } from "../shared/assets";
import {
  debuffGroupMembers,
  debuffRef,
  pickerRows,
} from "../shared/debuffs";
import {
  type DebuffGroup,
  type DebuffMode,
  type DebuffRef,
  type Mech,
  type MechDebuffs,
  type Plan,
  mechLabel,
} from "../shared/schema";
import type { FightLibraryEntry } from "../shared/fight-library";
import { api } from "./api";

/** A plan whose encounter the library has not been taught, remembered here. */
const pickedKey = (planId: string) => `raidplan.debuffs.${planId}`;

/**
 * The fight this plan reads its statuses from: whatever the debuff library
 * holds for the encounter the plan names, and the library itself so an author
 * can point at another fight when the name is one it has not seen before.
 */
function useFightDebuffs(plan: Plan) {
  const [library, setLibrary] = useState<FightLibraryEntry[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [dump, setDump] = useState<FFLogsDebuffDump | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void api
      .planDebuffs(plan.id)
      .then(async (found) => {
        if (!live) return;
        setLibrary(found.library);
        const remembered = localStorage.getItem(pickedKey(plan.id));
        const fallback = remembered && found.library.some((e) => e.key === remembered) ? remembered : null;
        setKey(found.key ?? fallback);
        setDump(found.dump ?? (fallback ? await api.debuffFight(fallback) : null));
      })
      .catch(() => undefined)
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [plan.id]);

  /** Choosing a fight teaches the library what this plan calls its encounter. */
  async function choose(next: string) {
    const chosen = await api.usePlanDebuffFight(plan.id, next);
    localStorage.setItem(pickedKey(plan.id), next);
    setKey(chosen.key);
    setDump(chosen.dump);
    setLibrary(await api.debuffLibrary());
  }

  return { library, key, dump, loading, choose };
}

const GROUP_META: Record<DebuffGroup, { label: string; color: string }> = {
  tanks: { label: "Tanks", color: "#3f6fd4" },
  healers: { label: "Healers", color: "#3fae6a" },
  damagers: { label: "DPS", color: "#c0553f" },
  supports: { label: "Supports", color: "#4fa39a" },
};

/** The token-mode choices, each shown as the art the arena will actually use. */
const MODES: { mode: DebuffMode; label: string; icon: string; hint: string }[] = [
  { mode: "normal", label: "Jobs", icon: "actor/WAR", hint: "Tokens keep their job art; the status rides as a badge" },
  { mode: "thd", label: "T/H/D", icon: "actor/tank", hint: "Tokens become tank / healer / dps role icons" },
  { mode: "sd", label: "S/D", icon: "actor/support", hint: "Tokens become support / dps icons" },
  { mode: "generic", label: "Generic", icon: "actor/any", hint: "Every token becomes the generic player icon" },
];

const EMPTY: MechDebuffs = { mode: "normal", pools: {} };

export function DebuffPanel({
  plan,
  mech,
  stepId,
  shown,
  run,
  onClose,
}: {
  plan: Plan;
  mech: Mech;
  stepId: string;
  shown: Record<string, string>;
  run(ops: Op | Op[]): Promise<{ values: unknown[] }>;
  onClose(): void;
}) {
  const fight = useFightDebuffs(plan);
  const { dump } = fight;
  const rows = useMemo(() => (dump ? pickerRows(dump) : []), [dump]);
  const deal = mech.debuffs ?? EMPTY;
  const pooled = (deal.pools.supports?.length ?? 0) > 0;
  const [over, setOver] = useState<DebuffGroup | null>(null);

  const capacity = (group: DebuffGroup) => debuffGroupMembers(plan, stepId, group, shown).length;
  const pool = (group: DebuffGroup) => deal.pools[group] ?? [];

  const save = (next: MechDebuffs) =>
    void run({ op: "update_mech", mechId: mech.id, patch: { debuffs: next } });

  /** The dragged status, stashed at dragstart — dataTransfer is opaque during dragover. */
  const [carrying, setCarrying] = useState<DebuffRef | null>(null);

  function give(group: DebuffGroup) {
    setOver(null);
    if (!carrying) return;
    if (group === "supports") {
      // Folding: whatever the tanks and healers already hold moves into the
      // shared pool, and the arena flips to S/D art — the whole point of
      // playing them as one interchangeable four. Still overridable above.
      const merged = [...pool("supports"), ...pool("tanks"), ...pool("healers")];
      if (merged.length >= capacity("supports")) return;
      save({
        mode: "sd",
        pools: { ...deal.pools, supports: [...merged, carrying], tanks: [], healers: [] },
      });
      return;
    }
    if (pool(group).length >= capacity(group)) return;
    save({ ...deal, pools: { ...deal.pools, [group]: [...pool(group), carrying] } });
  }

  function take(group: DebuffGroup, index: number) {
    save({ ...deal, pools: { ...deal.pools, [group]: pool(group).filter((_, i) => i !== index) } });
  }

  /** "Supports take Burn ×2. DPS take Freeze ×4. The dps are 2 short." */
  const sentence = useMemo(() => {
    const active: DebuffGroup[] = pooled ? ["supports", "damagers"] : ["tanks", "healers", "damagers"];
    const parts: string[] = [];
    const short: string[] = [];
    for (const g of active) {
      const held = pool(g);
      if (!held.length) continue;
      const counts = new Map<string, number>();
      for (const d of held) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
      const list = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
      parts.push(`${GROUP_META[g].label} take ${list}.`);
      const missing = capacity(g) - held.length;
      if (missing > 0) short.push(`The ${GROUP_META[g].label.toLowerCase()} are ${missing} short.`);
    }
    return parts.length ? [...parts, ...short].join(" ") : "Nothing dealt yet — drag a status onto a role.";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal, pooled, plan, stepId]);

  function card(group: Exclude<DebuffGroup, "supports">) {
    const meta = GROUP_META[group];
    const cap = capacity(group);
    return (
      <div
        key={group}
        className="rounded border p-2"
        style={{
          borderColor: over === group ? meta.color : "var(--color-ink-600)",
          background: over === group ? `${meta.color}22` : "var(--color-ink-800)",
        }}
        onDragOver={(e) => {
          // The tank and healer cards live inside the Supports drop zone;
          // a drop on them must not also be a drop on the wrapper.
          e.preventDefault();
          e.stopPropagation();
          setOver(group);
        }}
        onDragLeave={() => setOver((o) => (o === group ? null : o))}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          give(group);
        }}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
          {meta.label}
        </div>
        {slots(group, cap)}
      </div>
    );
  }

  function slots(group: DebuffGroup, cap: number) {
    const held = pool(group);
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {Array.from({ length: cap }, (_, i) =>
          held[i] ? (
            <button
              key={i}
              className="flex h-9 w-9 items-center justify-center rounded border border-ink-600 bg-ink-900 hover:border-red-400"
              title={`${held[i].name} — click to take it back`}
              onClick={() => take(group, i)}
            >
              {held[i].icon ? (
                <img src={held[i].icon} alt={held[i].name} className="h-7 w-7" draggable={false} />
              ) : (
                <span className="text-[10px]">{held[i].name.slice(0, 3)}</span>
              )}
            </button>
          ) : (
            <div key={i} className="h-9 w-9 rounded border border-dashed border-ink-600" />
          ),
        )}
        {cap === 0 && <div className="text-xs text-ink-400">nobody in this step</div>}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="panel max-h-[90vh] w-[640px] overflow-y-auto rounded-lg p-4 shadow-2xl">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Deal the fight's statuses — {mechLabel(plan, mech)}</div>
            <div className="text-xs text-ink-400">
              Drag a status from the timeline onto a role. While this mech is on the floor, the party wears the deal.
            </div>
          </div>
          <button
            className="btn"
            title="Empty every pool"
            onClick={() => save({ ...deal, pools: {} })}
          >
            Clear
          </button>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        {/* Token art while the mech is active — the icon is the choice. */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-ink-400">Tokens</span>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className={`flex flex-col items-center gap-0.5 rounded border px-2 py-1 ${
                  deal.mode === m.mode
                    ? "border-accent bg-ink-600"
                    : "border-ink-600 bg-ink-700 hover:bg-ink-600"
                }`}
                title={m.hint}
                onClick={() => save({ ...deal, mode: m.mode })}
              >
                <img src={assetUrl(m.icon)} alt="" className="h-6 w-6" draggable={false} />
                <span className="text-[10px]">{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* The pools. Supports wraps the two it can fold. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div
            className="rounded border border-dashed p-2"
            style={{
              borderColor: over === "supports" ? GROUP_META.supports.color : "var(--color-ink-600)",
              background: over === "supports" ? `${GROUP_META.supports.color}22` : "transparent",
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver("supports");
            }}
            onDragLeave={() => setOver((o) => (o === "supports" ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              give("supports");
            }}
          >
            <div
              className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: GROUP_META.supports.color }}
            >
              Supports
            </div>
            {pooled ? (
              slots("supports", capacity("supports"))
            ) : (
              <div className="mt-1 grid gap-2">
                {card("tanks")}
                {card("healers")}
                <div className="text-[10px] text-ink-400">
                  Drop here instead to play them as one pool of {capacity("supports")}
                </div>
              </div>
            )}
          </div>
          <div className="grid content-start gap-2">
            {card("damagers")}
            <div className="rounded border border-ink-700 bg-ink-900 p-2 text-xs italic text-ink-400">{sentence}</div>
          </div>
        </div>

        {/* The fight's statuses, in first-appearance rows. */}
        <div className="panel mt-3 rounded p-2">
          <div className="flex items-center gap-2">
            <div className="text-[11px] uppercase tracking-wide text-ink-400">
              {dump
                ? `${dump.fight.name} — statuses by first appearance`
                : fight.loading
                  ? "Reading the library…"
                  : fight.library.length
                    ? "Which fight is this?"
                    : "No fight in the library yet — import a log from the FF Logs page"}
            </div>
            {fight.library.length > 1 || (!dump && fight.library.length > 0) ? (
              <select
                className="field ml-auto w-auto py-0.5 text-xs"
                value={fight.key ?? ""}
                onChange={(e) => void fight.choose(e.target.value)}
              >
                <option value="" disabled>
                  Pick the fight
                </option>
                {fight.library.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.name} ({entry.debuffs})
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="mt-1 grid gap-1">
            {rows.map((row) => (
              <div key={row.atMs} className="flex items-start gap-2">
                <span className="mt-1.5 w-10 shrink-0 text-right font-mono text-[11px] text-ink-400">{row.at}</span>
                <div className="flex flex-1 flex-wrap gap-1">
                  {row.debuffs.map((d) => (
                    <div
                      key={d.id}
                      className="flex cursor-grab items-center gap-1 rounded border border-ink-600 bg-ink-700 px-1.5 py-0.5 hover:border-accent"
                      draggable
                      title={d.tooltip}
                      onDragStart={(e) => {
                        setCarrying(debuffRef(d));
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => setCarrying(null)}
                    >
                      {d.icon && <img src={d.icon.url} alt="" className="h-6 w-6" draggable={false} />}
                      <span className="text-xs">{d.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
