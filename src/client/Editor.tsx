import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { api } from "./api";
import { navigate } from "./App";
import type { EditLayer } from "./canvas/Scene";
import { Scene } from "./canvas/Scene";
import { Inspector } from "./Inspector";
import { ChatPanel } from "./ChatPanel";
import type { Op } from "../shared/apply";
import type { Entity, Mech, Plan, PlanRole, PlayerEntity, PropBag, User } from "../shared/schema";
import { entitiesForStep, hydratePlan, mechLabel, mechSpan } from "../shared/schema";
import type { PaletteKind } from "../shared/ops";
import {
  PALETTE,
  PALETTE_HINT,
  PALETTE_LABEL,
  paletteBait,
  paletteNeedsSource,
  paletteSpec,
  resizeSpec,
} from "../shared/ops";
import { jobLabel, roleOf } from "../shared/jobs";

/**
 * The editor. Plan state arrives over the PlanAgent WebSocket — which is also
 * how edits made by a model through MCP land on screen — and every local change
 * is posted as an op, so both paths run identical server code.
 */
export function Editor({ planId, user }: { planId: string; user: User | null }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [role, setRole] = useState<PlanRole>("viewer");
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"step" | "all">("step");
  /**
   * Waymarks are the floor the fight is played on, not part of any one step, so
   * they are frozen until you come up to their layer on purpose.
   */
  const [layer, setLayer] = useState<EditLayer>("step");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [connected, setConnected] = useState(false);
  /** What is in the hand mid-drag, purely so the drop targets can light up. */
  const [carrying, setCarrying] = useState<PaletteKind | null>(null);
  const [hover, setHover] = useState<GroupId | null>(null);
  /** A bond whose members should ring on the canvas while you point at its row. */
  const [highlight, setHighlight] = useState<string | null>(null);
  /**
   * The mech slot being filled. Everything dropped while one is open joins it,
   * which is what makes a mech a thing you author rather than a thing you tag.
   */
  const [mech, setMech] = useState<string | null>(null);
  const stageBox = useRef<HTMLDivElement>(null);
  /** Last pointer position over the arena, so a paste lands under the cursor. */
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const clipboard = useRef<PropBag | null>(null);
  /** The freshest plan, for handlers that fire faster than React re-renders. */
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  /** Wheel notches land far faster than a round trip, so they are pooled. */
  const pendingResize = useRef<{ ids: string[]; factor: number } | null>(null);
  const resizeTimer = useRef<number | null>(null);

  useAgent({
    agent: "plan-agent",
    name: planId,
    onStateUpdate: (state: Plan) => {
      if (state?.id) setPlan(hydratePlan(state));
    },
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  useEffect(() => {
    api
      .getPlan(planId)
      .then((res) => {
        setPlan(hydratePlan(res.plan));
        setRole(res.role);
      })
      .catch((e) => setError(e.message));
  }, [planId]);

  const editable = role !== "viewer";
  const step = plan?.steps[Math.min(stepIndex, (plan?.steps.length ?? 1) - 1)];

  const run = useCallback(
    async (ops: Op | Op[]) => {
      try {
        const res = await api.ops(planId, ops);
        setPlan(hydratePlan(res.plan));
        return res;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    },
    [planId]
  );

  /**
   * The two gestures every editor has. Deliberately not bound while a field has
   * focus: Backspace in the plan-name box must delete a letter, not the boss.
   */
  useEffect(() => {
    if (!editable) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod && (ev.key === "Delete" || ev.key === "Backspace")) {
        if (!selected) return;
        ev.preventDefault();
        setSelected(null);
        void run({ op: "delete_entities", ids: [selected] });
        return;
      }
      if (mod && ev.key.toLowerCase() === "c") {
        const e = plan?.entities.find((x) => x.id === selected);
        if (!e) return;
        const { id: _id, overrides: _o, ...rest } = e;
        clipboard.current = rest;
        setNote(`Copied ${e.name || e.type}`);
        return;
      }
      if (mod && ev.key.toLowerCase() === "v") {
        const spec = clipboard.current;
        if (!spec) return;
        ev.preventDefault();
        void (async () => {
          // A copy of an anchored thing keeps following its target, so the paste
          // point would be meaningless: only free shapes land under the cursor.
          const where = spec.anchor ? {} : { x: pointer.current.x, y: pointer.current.y };
          // A copy is declared here and now, whatever step the original came from.
          const res = await run({
            op: "add_entity",
            spec: { ...spec, ...where, declaredIn: step!.id, ...(mech ? { mech } : {}) } as never,
          });
          const created = res.values[0] as { id: string } | null;
          if (created) setSelected(created.id);
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, selected, plan, run]);

  if (error && !plan) return <div className="p-8 text-red-400">{error}</div>;
  if (!plan || !step) return <div className="p-8 text-ink-400">Loading plan…</div>;

  const selectedEntity = plan.entities.find((e) => e.id === selected) ?? null;
  /** The mech slot currently open, if the one that was open still exists. */
  const openMech = plan.mechs.find((m) => m.id === mech) ?? null;

  /** Pointer position, in arena units, from a drag event over the stage. */
  function arenaPoint(ev: React.DragEvent): { x: number; y: number } {
    const box = stageBox.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const scale = box.width / Math.max(plan!.arena.width, plan!.arena.height);
    return {
      x: Math.round((ev.clientX - box.left - box.width / 2) / scale),
      y: Math.round((ev.clientY - box.top - box.height / 2) / scale),
    };
  }

  /** A bait anchor under the drop point, if the drop landed on one. */
  function anchorAt(pt: { x: number; y: number }): string | undefined {
    return entitiesForStep(plan!, step!.id).find(
      (e) =>
        e.type === "enemy" &&
        e.role === "anchor" &&
        Math.hypot(e.x - pt.x, e.y - pt.y) <= e.size * 0.9 * e.scale
    )?.id;
  }

  /** Who is in a group, this step. Party slots count when the job does not. */
  /** Switching layers drops the selection: what was selected is now frozen. */
  function toLayer(next: EditLayer) {
    setLayer(next);
    setSelected(null);
    setCarrying(null);
    setHover(null);
  }

  function membersOf(group: GroupId): PlayerEntity[] {
    return entitiesForStep(plan!, step!.id).filter((e): e is PlayerEntity => {
      if (e.type !== "player") return false;
      if (group === "party") return true;
      const r = roleOf(e.job) === "any" ? roleOf(e.name ?? "") : roleOf(e.job);
      const support = r === "tank" || r === "healer";
      return group === "supports" ? support : !support;
    });
  }

  /**
   * Scrolling over something resizes it. The wheel outruns the server, so the
   * notches are multiplied together and sent as one edit a moment later — and
   * it is the real dimensions that change, not `scale`, so the plan keeps
   * saying how big the thing is.
   */
  function resize(id: string, factor: number) {
    const current = planRef.current;
    const target = current?.entities.find((e) => e.id === id);
    if (!current || !target) return;
    const ids = target.bond
      ? current.entities.filter((e) => e.bond?.id === target.bond!.id).map((e) => e.id)
      : [id];
    // Pointing somewhere else mid-spin: land what is owed before starting again.
    if (pendingResize.current && pendingResize.current.ids[0] !== ids[0]) flushResize();
    const carried = pendingResize.current?.factor ?? 1;
    pendingResize.current = { ids, factor: carried * factor };
    if (resizeTimer.current === null) resizeTimer.current = window.setTimeout(flushResize, 90);
  }

  function flushResize() {
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = null;
    const job = pendingResize.current;
    const current = planRef.current;
    pendingResize.current = null;
    if (!job || !current) return;
    const edits = job.ids.flatMap((id) => {
      const e = current.entities.find((x) => x.id === id);
      if (!e) return [];
      const patch = resizeSpec(e, job.factor);
      return Object.keys(patch).length ? [{ op: "update_entity" as const, id, patch }] : [];
    });
    if (edits.length) void run(edits);
  }

  /** The sets a group holds, in the order they were dropped. */
  function bondsOf(group: GroupId): { id: string; label: string; ids: string[] }[] {
    const out = new Map<string, { id: string; label: string; ids: string[] }>();
    for (const e of plan!.entities) {
      if (e.bond?.group !== group) continue;
      const seen = out.get(e.bond.id) ?? { id: e.bond.id, label: e.bond.label ?? "set", ids: [] };
      seen.ids.push(e.id);
      out.set(e.bond.id, seen);
    }
    return [...out.values()];
  }

  async function placeAnchor(x: number, y: number) {
    const n = plan!.entities.filter((e) => e.type === "enemy" && e.role === "anchor").length + 1;
    const res = await run({
      op: "add_entity",
      spec: paletteSpec("anchor", { x, y, name: `anchor ${n}`, ...stamp() }) as never,
    });
    const created = res.values[0] as { id: string } | null;
    if (created) setSelected(created.id);
    return created?.id;
  }

  /**
   * What an aimed mechanic comes out of when you drop it on a group: the boss,
   * failing that any object already on the floor, failing that an anchor placed
   * in the middle — a protean has to be thrown from somewhere.
   */
  async function sourceForAimed() {
    const enemies = plan!.entities.filter((e) => e.type === "enemy");
    const boss = enemies.find((e) => e.role !== "anchor") ?? enemies[0];
    return boss ? boss.id : await placeAnchor(0, 0);
  }

  /** Zone shape each palette kind lands as — used to count what an anchor has. */
  const SHAPE_OF: Record<Exclude<PaletteKind, "anchor">, string> = {
    circle: "circle",
    donut: "donut",
    protean: "cone",
    beam: "rect",
  };

  /**
   * A palette item let go over the arena. What it becomes is decided entirely by
   * what it landed on: bare floor makes a shape you move yourself, a group makes
   * one per person, and an anchor makes a bait — a second of the same kind on
   * the same anchor takes the second-closest player, and so on.
   */
  async function drop(kind: PaletteKind, pt: { x: number; y: number }, target: DropTarget) {
    if (kind === "anchor") {
      await placeAnchor(pt.x, pt.y);
      return;
    }
    if (target.at === "group") {
      const people = membersOf(target.group);
      if (!people.length) return setError(`No ${target.group} in this step to bind to`);
      const from = paletteNeedsSource(kind) ? await sourceForAimed() : undefined;
      // One drop, one thing — the eight shapes it draws are that thing's faces.
      const bond = {
        id: "bond_" + Math.random().toString(36).slice(2, 10),
        group: target.group,
        label: PALETTE_LABEL[kind],
      };
      await run(
        people.map((p) => ({
          op: "add_entity" as const,
          spec: paletteBait(kind, p.id, from, {
            name: `${PALETTE_LABEL[kind]} on ${p.name || jobLabel(p.job)}`,
            bond,
            ...stamp(),
          }) as never,
        }))
      );
      setSelected(null);
      return;
    }
    if (target.at === "anchor") {
      const taken = plan!.entities.filter(
        (e) =>
          e.type === "zone" &&
          e.shape === SHAPE_OF[kind] &&
          e.anchor &&
          (e.anchor.from === target.id || e.anchor.near === target.id)
      ).length;
      const rank = Math.min(8, taken + 1);
      const res = await run({
        op: "add_entity",
        spec: paletteBait(kind, { pick: "closest", rank }, target.id, {
          name: `${PALETTE_LABEL[kind]} ${rank}`,
          ...stamp(),
        }) as never,
      });
      const created = res.values[0] as { id: string } | null;
      if (created) setSelected(created.id);
      return;
    }
    const res = await run({
      op: "add_entity",
      spec: paletteSpec(kind, { x: pt.x, y: pt.y, ...stamp() }) as never,
    });
    const created = res.values[0] as { id: string } | null;
    if (created) setSelected(created.id);
  }

  /** What every drop carries: the step that declared it, and the slot it joins. */
  function stamp(): PropBag {
    return { declaredIn: step!.id, ...(openMech ? { mech: openMech.id } : {}) };
  }

  /** Reads the payload of a drop; ignores drags that did not start in the palette. */
  function kindOf(ev: React.DragEvent): PaletteKind | null {
    const k = ev.dataTransfer.getData("text/plain") as PaletteKind;
    return (PALETTE as readonly string[]).includes(k) ? k : null;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="panel flex items-center gap-3 border-x-0 border-t-0 px-3 py-2">
        <button className="btn" onClick={() => navigate("/")}>
          ← Plans
        </button>
        <input
          className="field max-w-[280px]"
          value={plan.name}
          disabled={!editable}
          onChange={(e) => setPlan({ ...plan, name: e.target.value })}
          onBlur={(e) => run({ op: "set_meta", name: e.target.value })}
        />
        <input
          className="field max-w-[180px]"
          placeholder="encounter"
          title="The fight this plan is for — plans sharing it share their waymarks"
          value={plan.encounter}
          disabled={!editable}
          onChange={(e) => setPlan({ ...plan, encounter: e.target.value })}
          onBlur={(e) => run({ op: "set_meta", encounter: e.target.value })}
        />
        <span className="text-xs text-ink-400">
          rev {plan.rev} · {connected ? "live" : "offline"} · {role}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <>
              <span className="label">Drag moves</span>
              <select
                className="field w-auto"
                value={scope}
                onChange={(e) => setScope(e.target.value as "step" | "all")}
              >
                <option value="step">this step only</option>
                <option value="all">every step</option>
              </select>
            </>
          )}
          <ShareButton planId={planId} canShare={role === "owner"} />
          <span className="text-xs text-ink-400">
            {user ? user.name : <a href="/">sign in</a>}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <StepRail
          plan={plan}
          index={stepIndex}
          editable={editable}
          openMech={openMech}
          onSelect={setStepIndex}
          run={run}
          setIndex={setStepIndex}
          onOpenMech={setMech}
          onHighlight={setHighlight}
        />

        <CanvasArea>
          {(size) => (
            <div
              ref={stageBox}
              className="relative"
              style={{ width: size, height: size }}
              onMouseMove={(ev) => {
                const box = stageBox.current?.getBoundingClientRect();
                if (!box) return;
                const s = box.width / Math.max(plan.arena.width, plan.arena.height);
                pointer.current = {
                  x: Math.round((ev.clientX - box.left - box.width / 2) / s),
                  y: Math.round((ev.clientY - box.top - box.height / 2) / s),
                };
              }}
              onDragOver={(ev) => {
                if (!carrying || layer === "markers") return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(ev) => {
                const kind = kindOf(ev);
                if (!kind) return;
                ev.preventDefault();
                const pt = arenaPoint(ev);
                const on = anchorAt(pt);
                void drop(kind, pt, on ? { at: "anchor", id: on } : { at: "free" });
                setCarrying(null);
                setHover(null);
              }}
            >
              {openMech && (
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-blue-500/20 px-2 py-1 text-center text-xs text-blue-100">
                  Filling “{mechLabel(plan, openMech)}” — what you drop goes in it
                </div>
              )}
              <Scene
                plan={plan}
                stepId={step.id}
                size={size}
                selected={selected}
                editable={editable}
                layer={layer}
                highlight={highlight}
                onSelect={setSelected}
                onResize={resize}
                onMove={(id, x, y) =>
                  run({
                    op: "update_entity",
                    id,
                    patch: { x, y },
                    stepId: scope === "step" ? step.id : undefined,
                  })
                }
              />
            </div>
          )}
        </CanvasArea>

        {/* "Everyone gets one of these" as a place you drop things, off the
            arena so it never covers the plan and can be big enough to hit. */}
        {editable && (
          <div
            className={`flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto p-2 ${
              // Kept in place on the waymark layer rather than unmounted: the
              // arena must not change size under you when you switch layers.
              layer === "markers" ? "pointer-events-none opacity-40" : ""
            }`}
          >
            {GROUPS.map((g) => {
              const people = membersOf(g).length;
              const sets = bondsOf(g);
              return (
                <div
                  key={g}
                  title={`Drop a mechanic here to give one to each of the ${g}`}
                  onDragOver={(ev) => {
                    if (!carrying || carrying === "anchor") return;
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "copy";
                    setHover(g);
                  }}
                  onDragLeave={() => setHover((h) => (h === g ? null : h))}
                  onDrop={(ev) => {
                    const kind = kindOf(ev);
                    if (!kind || kind === "anchor") return;
                    ev.preventDefault();
                    void drop(kind, { x: 0, y: 0 }, { at: "group", group: g });
                    setCarrying(null);
                    setHover(null);
                  }}
                  className={`rounded-lg border-2 border-dashed p-3 transition ${
                    hover === g
                      ? "border-blue-400 bg-blue-500/25"
                      : carrying && carrying !== "anchor"
                        ? "border-blue-500/60 bg-ink-800/80"
                        : "border-ink-600 bg-ink-800/50"
                  }`}
                >
                  <div className="text-center text-base font-semibold text-ink-100">
                    {GROUP_LABEL[g]}
                  </div>
                  <div className="mb-1 text-center text-[11px] text-ink-400">
                    {people} {people === 1 ? "player" : "players"}
                  </div>
                  {/* The set is the object: its shapes are frozen on the canvas,
                      so this row is how you find it and how you take it away. */}
                  {sets.map((b) => (
                    <div
                      key={b.id}
                      onMouseEnter={() => setHighlight(b.id)}
                      onMouseLeave={() => setHighlight((h) => (h === b.id ? null : h))}
                      className="mt-1 flex items-center gap-1 rounded bg-ink-900/70 px-2 py-1 text-xs"
                    >
                      <span className="truncate">
                        {b.label} ×{b.ids.length}
                      </span>
                      <button
                        className="ml-auto text-ink-400 hover:text-red-300"
                        title={`Remove this ${b.label.toLowerCase()} from the ${g}`}
                        onClick={() => {
                          setHighlight(null);
                          void run({ op: "delete_entities", ids: b.ids });
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* A shared link opens read-only, often signed out: showing a wall of
            greyed-out editing controls just reads as a broken app. */}
        {!editable ? (
          <aside className="panel w-[240px] shrink-0 border-y-0 border-r-0 p-3 text-xs text-ink-400">
            Read-only. {user ? "You have viewer access to this plan." : "Sign in to edit plans of your own."}
          </aside>
        ) : (
        <aside className="panel w-[320px] shrink-0 overflow-y-auto border-y-0 border-r-0 p-3">
          <h2 className="label mb-2">Add</h2>
          <p className="mb-2 text-xs text-ink-400">
            Drag onto the floor to place one, onto a group to give everybody one, onto a bait
            anchor to have it thrown at whoever stands nearest. Scroll over anything on the
            arena to size it — shift for fine steps.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-1">
            {PALETTE.map((k) => (
              <div
                key={k}
                draggable={editable && layer === "step"}
                title={PALETTE_HINT[k]}
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("text/plain", k);
                  ev.dataTransfer.effectAllowed = "copy";
                  setCarrying(k);
                }}
                onDragEnd={() => {
                  setCarrying(null);
                  setHover(null);
                }}
                className={`flex cursor-grab select-none flex-col items-center gap-1 rounded border px-2 py-2 text-xs active:cursor-grabbing ${
                  carrying === k ? "border-blue-400 bg-ink-700" : "border-ink-600 bg-ink-800"
                } ${layer === "markers" ? "cursor-not-allowed opacity-40" : ""}`}
              >
                <PaletteGlyph kind={k} />
                {PALETTE_LABEL[k]}
              </div>
            ))}
          </div>

          <h2 className="label mb-2">Layout</h2>
          <div className="mb-4 flex flex-wrap gap-1">
            {[8, 4, 2].map((spokes) => (
              <button
                key={spokes}
                className="btn"
                disabled={!editable}
                title={`Radial grid, ${spokes} ways`}
                onClick={() =>
                  run({
                    op: "set_arena",
                    patch: { grid: { ...plan.arena.grid, type: "radial", spokes, rings: 1 } },
                  })
                }
              >
                {spokes}-radial
              </button>
            ))}
            <button
              className="btn"
              disabled={!editable}
              title="Grid off"
              onClick={() =>
                run({ op: "set_arena", patch: { grid: { ...plan.arena.grid, type: "none" } } })
              }
            >
              no grid
            </button>
            <button
              className="btn"
              disabled={!editable}
              title="A north, 2 NE, B east, 3 SE, C south, 4 SW, D west, 1 NW"
              onClick={() => run({ op: "add_waymarks" })}
            >
              standard markers
            </button>
            <button
              className="btn"
              disabled={!editable}
              title="Out at waymark spread: MT north, R2 NE, H2 east, M2 SE, OT south, M1 SW, H1 west, R1 NW"
              onClick={() =>
                run({ op: "arrange_party", stepId: scope === "step" ? step.id : undefined })
              }
            >
              PF positions
            </button>
            <button
              className="btn"
              disabled={!editable}
              title="Eight players, standard composition"
              onClick={() => run({ op: "add_party" })}
            >
              add party
            </button>
          </div>

          <h2 className="label mb-2">Encounter markers</h2>
          {/* Waymarks belong to the fight, not to one plan: decide them once and
              every plan for the encounter picks up the same set. */}
          <div className="mb-4 flex flex-wrap items-center gap-1">
            <button
              className={`btn ${layer === "markers" ? "border-amber-400 text-amber-200" : ""}`}
              disabled={!editable}
              title="Waymarks do not move once the pull starts, so they are frozen until you come here"
              onClick={() => toLayer(layer === "markers" ? "step" : "markers")}
            >
              {layer === "markers" ? "done with waymarks" : "move waymarks"}
            </button>
            <button
              className="btn"
              disabled={!editable || !plan.encounter}
              title={
                plan.encounter
                  ? `Remember these waymarks and this arena for ${plan.encounter}`
                  : "Name the encounter first (field in the header)"
              }
              onClick={async () => {
                const r = await api.saveEncounter(planId).catch((e: Error) => setError(e.message));
                if (r) setNote(`Saved ${r.markers} waymarks for ${r.encounter}`);
              }}
            >
              save for fight
            </button>
            <button
              className="btn"
              disabled={!editable || !plan.encounter}
              title="Put the saved waymarks and arena back"
              onClick={async () => {
                const r = await api.applyEncounter(planId).catch((e: Error) => setError(e.message));
                if (r) setPlan(hydratePlan(r.plan));
              }}
            >
              use saved
            </button>
            {note && <span className="text-xs text-ink-400">{note}</span>}
          </div>

          <Inspector
            plan={plan}
            entity={selectedEntity}
            stepId={step.id}
            scope={scope}
            editable={editable}
            run={run}
            onDeselect={() => setSelected(null)}
          />
        </aside>
        )}
      </div>

      {error && (
        <div className="bg-red-950 px-3 py-1 text-xs text-red-300" onClick={() => setError("")}>
          {error} (click to dismiss)
        </div>
      )}

      {user && <ChatPanel planId={planId} />}
    </div>
  );
}

/** Measures its box and hands the child a square canvas size. */
function CanvasArea({ children }: { children: (size: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize(Math.max(200, Math.min(el.clientWidth, el.clientHeight) - 24));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="flex min-w-0 flex-1 items-center justify-center">
      {children(size)}
    </div>
  );
}

/**
 * A mech box under the pointer.
 *
 * A mech never *moves*: it is two moments in the fight, and dragging it is
 * saying the cast reaches further back or resolves later. Which end you are
 * holding is whichever half of the box you took hold of; from there it follows
 * the pointer in both directions, so the same grab stretches and shortens.
 */
interface Drag {
  id: string;
  mode: "top" | "bottom";
  grabbed: number;
  lo: number;
  hi: number;
  /** Where it started, so every move is measured from the same place. */
  from: [number, number];
  moved: boolean;
}

/**
 * The steps, and the mechanics running alongside them.
 *
 * A mech is a box spanning the steps it is on the floor for — from the one it
 * snapshots in to the one it goes off in — laid out in the same grid rows as the
 * step list, so the fight reads down the page: this cast is in the air here, it
 * lands there, and these two overlap.
 */
function StepRail({
  plan,
  index,
  editable,
  openMech,
  onSelect,
  run,
  setIndex,
  onOpenMech,
  onHighlight,
}: {
  plan: Plan;
  index: number;
  editable: boolean;
  openMech: Mech | null;
  onSelect(i: number): void;
  run(ops: Op | Op[]): Promise<{ values: unknown[] }>;
  setIndex(i: number): void;
  onOpenMech(id: string | null): void;
  onHighlight(id: string | null): void;
}) {
  // Deleting the last step leaves the parent's index pointing past the end for
  // one render; the rail must not blow up in that gap.
  const at = Math.min(index, plan.steps.length - 1);
  const current = plan.steps[at];

  // Where the step rows are on screen, so a box being dragged can say which step
  // the pointer is over. The rows are the ruler; nothing else measures.
  const rows = useRef<(HTMLElement | null)[]>([]);
  const rowAt = (clientY: number) => {
    let best = 0;
    let closest = Infinity;
    plan.steps.forEach((_, i) => {
      const r = rows.current[i]?.getBoundingClientRect();
      if (!r) return;
      const d = Math.abs(clientY - (r.top + r.height / 2));
      if (d < closest) {
        closest = d;
        best = i;
      }
    });
    return best;
  };
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The step or mech whose name is currently a field in the rail. */
  const [renaming, setRenaming] = useState<string | null>(null);

  // Mechs that overlap cannot share a column, so each takes the first free one —
  // the plainest thing that keeps two casts in the air at once both readable.
  const placed: { mech: Mech; lo: number; hi: number; lane: number }[] = [];
  for (const mech of plan.mechs) {
    const span = mechSpan(plan, mech);
    if (!span.length) continue;
    let lo = plan.steps.findIndex((s) => s.id === span[0]);
    let hi = lo + span.length - 1;
    // A box being dragged is laid out where the pointer has it, not where the
    // plan still says it is: the drag is the edit, previewed.
    if (drag?.id === mech.id) [lo, hi] = [drag.lo, drag.hi];
    let lane = 0;
    while (placed.some((p) => p.lane === lane && p.lo <= hi && p.hi >= lo)) lane++;
    placed.push({ mech, lo, hi, lane });
  }
  const lanes = placed.reduce((n, p) => Math.max(n, p.lane + 1), 0);

  // F2 renames what you are working on, where it sits: the mech you have open,
  // or failing that the step you are looking at. Double-click does the same.
  const renameTarget = openMech?.id ?? current.id;
  useEffect(() => {
    if (!editable) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "F2") return;
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      ev.preventDefault();
      setRenaming(renameTarget);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, renameTarget]);

  /** Let go of a box: the span it was dropped on, or a plain click if it never moved. */
  function endDrag(mech: Mech, lo: number, hi: number) {
    const settled = drag;
    setDrag(null);
    if (!settled) return;
    if (!settled.moved) return onOpenMech(openMech?.id === mech.id ? null : mech.id);
    void run({
      op: "update_mech",
      mechId: mech.id,
      patch: { snap: plan.steps[lo].id, boom: plan.steps[hi].id },
    });
  }

  return (
    <nav
      className="panel shrink-0 overflow-y-auto border-y-0 border-l-0 p-2"
      style={{ width: 224 + lanes * 70 }}
    >
      <div className="label mb-2">Steps{lanes ? " and mechs" : ""}</div>
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${lanes}, 66px)` }}
      >
        {plan.steps.map((s, i) =>
          renaming === s.id ? (
            <div
              key={s.id}
              ref={(el) => {
                rows.current[i] = el;
              }}
              style={{ gridColumn: 1, gridRow: i + 1 }}
              className="flex items-center gap-1 text-sm"
            >
              <span className="text-ink-400">{i + 1}.</span>
              <Rename
                title="Rename step"
                value={s.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name !== s.name) void run({ op: "update_step", stepId: s.id, patch: { name } });
                }}
              />
            </div>
          ) : (
            <button
              key={s.id}
              ref={(el) => {
                rows.current[i] = el;
              }}
              style={{ gridColumn: 1, gridRow: i + 1 }}
              className={`rounded px-2 py-1 text-left text-sm ${
                i === at ? "bg-ink-600 text-white" : "hover:bg-ink-700"
              }`}
              onClick={() => onSelect(i)}
              onDoubleClick={() => editable && setRenaming(s.id)}
              title={editable ? "Double-click or F2 to rename" : undefined}
            >
              {i + 1}. {s.name || "untitled"}
            </button>
          )
        )}
        {placed.map(({ mech, lo, hi, lane }) => {
          const active = openMech?.id === mech.id;
          const label = mechLabel(plan, mech);
          const shapes = plan.entities.filter((e) => e.mech === mech.id).length;
          const box = { gridColumn: lane + 2, gridRow: `${lo + 1} / ${hi + 2}` };
          if (renaming === mech.id)
            return (
              <div
                key={mech.id}
                style={box}
                className="flex items-center rounded border-t-2 border-t-blue-300 bg-blue-500/20 px-1 py-1"
              >
                <Rename
                  title="Rename mech"
                  value={mech.name}
                  placeholder={label}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== mech.name)
                      void run({ op: "update_mech", mechId: mech.id, patch: { name } });
                  }}
                />
              </div>
            );
          return (
            <button
              key={mech.id}
              style={box}
              title={`${label} — snapshots in step ${lo + 1}, goes off in step ${hi + 1}. ${
                editable
                  ? "Drag its top half to move the snapshot, its bottom half to move the explosion. Click to fill it."
                  : ""
              }`}
              onMouseEnter={() => onHighlight(mech.id)}
              onMouseLeave={() => onHighlight(null)}
              // The box is the control: its top edge is the snapshot and its
              // bottom edge is where it goes off, so dragging them is saying so.
              onPointerDown={(e) => {
                if (!editable) return;
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({
                  id: mech.id,
                  // The half you grabbed is the end you are holding.
                  mode: e.clientY - r.top < r.height / 2 ? "top" : "bottom",
                  grabbed: rowAt(e.clientY),
                  lo,
                  hi,
                  from: [lo, hi],
                  moved: false,
                });
              }}
              onPointerMove={(e) => {
                if (drag?.id !== mech.id) return;
                const row = rowAt(e.clientY);
                const [wasLo, wasHi] = drag.from;
                // The end you are holding cannot cross the other one: a cast
                // goes off no sooner than it snapshots.
                const next: [number, number] =
                  drag.mode === "top" ? [Math.min(row, wasHi), wasHi] : [wasLo, Math.max(row, wasLo)];
                if (next[0] === drag.lo && next[1] === drag.hi) return;
                setDrag({ ...drag, lo: next[0], hi: next[1], moved: true });
              }}
              onPointerUp={() => endDrag(mech, lo, hi)}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={() => editable && setRenaming(mech.id)}
              className={`flex touch-none flex-col items-center overflow-hidden rounded border-t-2 px-1 py-1 text-[11px] leading-tight ${
                editable ? "cursor-grab active:cursor-grabbing" : ""
              } ${
                active
                  ? "border-t-blue-300 bg-blue-500/30 text-blue-50"
                  : "border-t-ink-300 bg-ink-700/60 text-ink-200 hover:bg-ink-600/70"
              } ${drag?.id === mech.id ? "ring-1 ring-blue-300" : ""}`}
            >
              <span className="w-full truncate text-center">{label}</span>
              {shapes > 0 && <span className="text-ink-400">×{shapes}</span>}
              {/* The bottom edge is where it goes off, and says so. */}
              <span className="mt-auto -mb-1 w-full border-b-4 border-amber-400/80 pb-0.5 text-center text-[9px] uppercase tracking-wide text-amber-300/90">
                boom
              </span>
            </button>
          );
        })}
      </div>
      {editable && <MechBox plan={plan} open={openMech} stepId={current.id} run={run} onOpen={onOpenMech} />}
      {editable && (
        <div className="mt-3 space-y-1">
          <div className="flex gap-1">
            <button
              className="btn flex-1"
              disabled={at === 0}
              title="Move this step earlier"
              onClick={async () => {
                await run({ op: "move_step", stepId: current.id, index: at - 1 });
                setIndex(at - 1);
              }}
            >
              ↑
            </button>
            <button
              className="btn flex-1"
              disabled={at === plan.steps.length - 1}
              title="Move this step later"
              onClick={async () => {
                await run({ op: "move_step", stepId: current.id, index: at + 1 });
                setIndex(at + 1);
              }}
            >
              ↓
            </button>
          </div>
          <button
            className="btn w-full"
            onClick={async () => {
              await run({ op: "duplicate_step", stepId: current.id });
              setIndex(at + 1);
            }}
          >
            Duplicate step
          </button>
          <button
            className="btn w-full"
            onClick={async () => {
              await run({ op: "add_step" });
              setIndex(plan.steps.length);
            }}
          >
            Blank step
          </button>
          <button
            className="btn w-full"
            disabled={plan.steps.length < 2}
            onClick={async () => {
              await run({ op: "delete_step", stepId: current.id });
              setIndex(Math.max(0, at - 1));
            }}
          >
            Delete step
          </button>
        </div>
      )}
      <div className="mt-4">
        <div className="label mb-1">Step notes</div>
        {/* Uncontrolled + keyed: local typing stays smooth, remote edits reset it. */}
        <textarea
          key={`${current.id}:${current.notes}`}
          className="field h-32 resize-none"
          disabled={!editable}
          defaultValue={current.notes}
          onBlur={(e) => run({ op: "update_step", stepId: current.id, patch: { notes: e.target.value } })}
        />
      </div>
    </nav>
  );
}

/**
 * The controls for one mech: what it is called and which two steps it hangs
 * between. Only the open one is editable — the boxes in the grid are the
 * overview, this is the thing you are filling.
 */
function MechBox({
  plan,
  open,
  stepId,
  run,
  onOpen,
}: {
  plan: Plan;
  open: Mech | null;
  stepId: string;
  run(ops: Op | Op[]): Promise<{ values: unknown[] }>;
  onOpen(id: string | null): void;
}) {
  return (
    <div className="mt-2">
      <button
        className="btn w-full"
        title="A new mech snapshotting in the step you are on. Say where it goes off, then drop its shapes in."
        onClick={async () => {
          const res = await run({ op: "add_mech", snap: stepId });
          const made = res.values[0] as { id: string } | null;
          if (made) onOpen(made.id);
        }}
      >
        New mech here
      </button>
      {open && (
        <div className="mt-2 rounded border border-blue-400/60 bg-blue-500/10 p-2 text-xs">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-semibold">{mechLabel(plan, open)}</span>
            <button
              className="text-ink-400 hover:text-red-300"
              title="Delete this mech and everything in it"
              onClick={() => {
                onOpen(null);
                void run({ op: "delete_mech", mechId: open.id });
              }}
            >
              ✕
            </button>
          </div>
          <p className="mt-1 text-ink-400">
            Drag the top half of its box beside the steps to move the snapshot, the bottom
            half to move where it goes off. F2 renames it.
          </p>
          <button className="btn mt-2 h-6 w-full py-0 text-[11px]" onClick={() => onOpen(null)}>
            done filling
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A name, edited where it sits. Escape puts it back; Enter or clicking away
 * keeps it — the same bargain every file manager makes.
 */
function Rename({
  value,
  title,
  placeholder,
  onDone,
}: {
  value: string;
  title: string;
  placeholder?: string;
  onDone(name: string): void;
}) {
  return (
    <input
      className="field h-6 min-w-0 flex-1 px-1 py-0 text-xs"
      title={title}
      placeholder={placeholder}
      defaultValue={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = value;
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={(e) => onDone(e.target.value)}
    />
  );
}

function ShareButton({ planId, canShare }: { planId: string; canShare: boolean }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  if (!canShare) return null;
  return (
    <div className="relative">
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        Share
      </button>
      {open && (
        <div className="panel absolute right-0 z-10 mt-1 w-[280px] rounded p-3">
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={async (e) => {
                setIsPublic(e.target.checked);
                await api.setPublic(planId, e.target.checked);
              }}
            />
            Anyone with the link can view
          </label>
          <div className="flex gap-1">
            <input
              className="field"
              placeholder="discord:123456789…"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <button
              className="btn"
              onClick={async () => {
                await api.share(planId, userId, "editor");
                setUserId("");
              }}
            >
              Add
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Ask the person for their Discord user id; they must have signed in once.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ drag and drop */

const GROUPS = ["party", "supports", "damagers"] as const;
type GroupId = (typeof GROUPS)[number];

const GROUP_LABEL: Record<GroupId, string> = {
  party: "Party",
  supports: "Supports",
  damagers: "Damagers",
};

/** Where a palette item was let go, which is the whole of what it means. */
type DropTarget = { at: "free" } | { at: "group"; group: GroupId } | { at: "anchor"; id: string };

/** A glyph, so the palette reads as shapes rather than as four words. */
function PaletteGlyph({ kind }: { kind: PaletteKind }) {
  const stroke = "#7aa2f7";
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      {kind === "circle" && (
        <circle cx="15" cy="15" r="9" fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2" />
      )}
      {kind === "donut" && (
        <g fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2">
          <path
            d="M15 4a11 11 0 1 0 0.01 0z M15 10a5 5 0 1 1-0.01 0z"
            fillRule="evenodd"
          />
        </g>
      )}
      {kind === "protean" && (
        <path d="M15 26 L9 5 L21 5 Z" fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2" />
      )}
      {kind === "beam" && (
        <rect x="11" y="3" width="8" height="24" fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2" />
      )}
      {kind === "anchor" && (
        <g stroke="#e0b152" strokeWidth="2" fill="none">
          <circle cx="15" cy="15" r="7" strokeDasharray="4 3" />
          <circle cx="15" cy="15" r="2" fill="#e0b152" />
          <path d="M15 2 v5 M15 23 v5 M2 15 h5 M23 15 h5" />
        </g>
      )}
    </svg>
  );
}
