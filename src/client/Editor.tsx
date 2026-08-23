import type { Dispatch, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { api } from "./api";
import { navigate } from "./App";
import type { EditLayer } from "./canvas/Scene";
import { Scene } from "./canvas/Scene";
import { Inspector } from "./Inspector";
import { ChatPanel } from "./ChatPanel";
import type { Op } from "../shared/apply";
import type { PlanHistory, PlanRevision } from "../shared/history";
import type {
  Entity,
  Mech,
  Mechanic,
  Plan,
  PlanRole,
  PlayerEntity,
  PropBag,
  Step,
  User,
} from "../shared/schema";
import {
  entitiesForStep,
  hydratePlan,
  mechLabel,
  MECH_COLORS,
  mechColor,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  variantColor,
  variantLabel,
} from "../shared/schema";
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
import {
  makeSymmetricAdds,
  symmetricUpdates,
  symmetryIds,
  type SymmetryCount,
  type SymmetryKind,
} from "./symmetry";

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
  const [symmetryCount, setSymmetryCount] = useState<SymmetryCount>(1);
  const [symmetryKind, setSymmetryKind] = useState<SymmetryKind>("mirror");
  /**
   * Which reading of each mechanic is on screen, by mechanic id. Purely what
   * you are looking at — nobody else's plan changes because you flipped to
   * "Far first" — so it lives here and is never written to the document. It
   * decides what the canvas draws, because a shared step can hold a different
   * set of positions in each reading.
   */
  const [shown, setShown] = useState<Record<string, string>>({});
  /**
   * Bumped on every keyboard walk of the fight. A click means "show me that",
   * and shows it; a keypress means "and then this happens", so the canvas walks
   * into it. Only the counter changing says a move was asked for by hand.
   */
  const [glide, setGlide] = useState(0);
  /** Whether that walk is forwards through the fight — S, rather than W or a reading. */
  const [onward, setOnward] = useState(true);
  /**
   * Waymarks are the floor the fight is played on, not part of any one step, so
   * they are frozen until you come up to their layer on purpose.
   */
  const [layer, setLayer] = useState<EditLayer>("step");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState<PlanHistory | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  /** What is in the hand mid-drag, purely so the drop targets can light up. */
  const [carrying, setCarrying] = useState<PaletteKind | null>(null);
  const [hover, setHover] = useState<GroupId | null>(null);
  /**
   * A whole group picked up by its card, on its way to somewhere on the floor.
   * "G1 goes north" is a thing you say about a fight and, until now, eight
   * drags to draw. Letting go makes a fresh tight stack rather than carrying
   * whatever scattered formation the members happened to start in.
   */
  const [carryGroup, setCarryGroup] = useState<GroupId | null>(null);
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
  const pendingResize = useRef<{ ids: string[]; factor: number; what: "size" | "opacity" } | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const historyRefreshTimer = useRef<number | null>(null);
  /** Stable for this browser tab, so edits are automatically grouped as one work session. */
  const editSession = useRef("");
  if (!editSession.current) {
    const key = `raidplan:work-session:${planId}`;
    editSession.current = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, editSession.current);
  }

  useAgent({
    agent: "plan-agent",
    name: planId,
    onStateUpdate: (state: Plan) => {
      if (state?.id) {
        setPlan(hydratePlan(state));
        // The broadcast can arrive just before its revision metadata is stored.
        if (historyRefreshTimer.current !== null) window.clearTimeout(historyRefreshTimer.current);
        historyRefreshTimer.current = window.setTimeout(() => {
          void api.history(planId).then(setHistory).catch(() => undefined);
        }, 80);
      }
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
        return api.history(planId);
      })
      .then(setHistory)
      .catch((e) => setError(e.message));
  }, [planId]);

  useEffect(
    () => () => {
      if (historyRefreshTimer.current !== null) window.clearTimeout(historyRefreshTimer.current);
    },
    []
  );

  const editable = role !== "viewer";
  const step = plan?.steps[Math.min(stepIndex, (plan?.steps.length ?? 1) - 1)];

  const run = useCallback(
    async (ops: Op | Op[]) => {
      try {
        const current = planRef.current;
        const symmetricCount = symmetryCount === 2 ? 2 : 4;
        const expanded = (Array.isArray(ops) ? ops : [ops]).flatMap((op): Op[] => {
          if (
            op.op === "add_entity" &&
            symmetryCount > 1 &&
            typeof op.spec.x === "number" &&
            typeof op.spec.y === "number" &&
            !op.spec.anchor &&
            !op.spec.bond &&
            op.spec.type !== "tether"
          )
            return makeSymmetricAdds(op.spec, symmetryKind, symmetricCount);
          if (op.op === "update_entity" && current && symmetryCount > 1)
            return symmetricUpdates(
              current,
              op,
              symmetryKind,
              symmetricCount,
              entitiesForStep(current, step?.id, undefined, shown)
            );
          if (op.op === "delete_entities" && current && symmetryCount > 1)
            return [{ ...op, ids: symmetryIds(current, op.ids) }];
          if (op.op === "assign_mech" && current && symmetryCount > 1)
            return [{ ...op, ids: symmetryIds(current, op.ids) }];
          return [op];
        });
        const res = await api.ops(planId, expanded, editSession.current);
        setPlan(hydratePlan(res.plan));
        setHistory(res.history);
        return res;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    },
    [planId, symmetryCount, symmetryKind, shown, step?.id]
  );

  const travelHistory = useCallback(
    async (direction: "undo" | "redo" | "revert", revisionId?: string) => {
      if (historyBusy) return;
      setHistoryBusy(true);
      try {
        const res =
          direction === "undo"
            ? await api.undo(planId)
            : direction === "redo"
              ? await api.redo(planId)
              : await api.revert(planId, revisionId!, editSession.current);
        setPlan(hydratePlan(res.plan));
        setHistory(res.history);
        setSelected(null);
        setNote(
          direction === "undo"
            ? "Undid last change"
            : direction === "redo"
              ? "Redid change"
              : "Restored an earlier revision"
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setHistoryBusy(false);
      }
    },
    [historyBusy, planId]
  );

  /** Canvas authoring modes: 1/2/3 choose the coverage; Q changes the transform. */
  useEffect(() => {
    if (!editable) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "1" || ev.key === "2" || ev.key === "3") {
        ev.preventDefault();
        setSymmetryCount(ev.key === "1" ? 1 : ev.key === "2" ? 2 : 4);
      } else if (ev.key.toLowerCase() === "q") {
        ev.preventDefault();
        setSymmetryKind((kind) => (kind === "mirror" ? "rotate" : "mirror"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable]);

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
      const key = ev.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        ev.preventDefault();
        const redo = key === "y" || (key === "z" && ev.shiftKey);
        void travelHistory(redo ? "redo" : "undo");
        return;
      }
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
  }, [editable, selected, plan, run, travelHistory]);

  /**
   * Walking the fight from the keyboard, on the rail's own two axes: W and S
   * are the steps in order, A and D the readings of the mechanic you are in.
   * Looking is not editing, so a viewer walks the plan too.
   */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!plan?.steps.length) return;
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const key = ev.key.toLowerCase();
      if (!"wasd".includes(key) || key.length !== 1) return;
      const here = Math.min(stepIndex, plan.steps.length - 1);
      if (key === "w" || key === "s") {
        ev.preventDefault();
        setGlide((n) => n + 1);
        setOnward(key === "s");
        // The whole fight in order, not one section of it: walking off the end
        // of a mechanic is walking into the next one, which is what it is.
        setStepIndex(Math.max(0, Math.min(plan.steps.length - 1, here + (key === "s" ? 1 : -1))));
        return;
      }
      // Sideways is the readings of the mechanic this step belongs to. Its
      // steps are shared by all of them, so you stay on the step you are on
      // and watch it go the other way.
      const mechanic = plan.mechanics.find((m) => m.id === plan.steps[here].mechanic);
      if (!mechanic || mechanic.variants.length < 2) return;
      ev.preventDefault();
      setGlide((n) => n + 1);
      // Sideways is not the fight going on: the other reading is the same
      // moment, so nothing in this one resolves.
      setOnward(false);
      setShown((was) => {
        const at = mechanic.variants.findIndex((v) => v.id === was[mechanic.id]);
        const from = at < 0 ? 0 : at;
        const n = mechanic.variants.length;
        const to = (from + (key === "d" ? 1 : n - 1)) % n;
        return { ...was, [mechanic.id]: mechanic.variants[to].id };
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plan, stepIndex]);

  if (error && !plan) return <div className="p-8 text-red-400">{error}</div>;
  if (!plan || !step) return <div className="p-8 text-ink-400">Loading plan…</div>;

  const selectedEntity = plan.entities.find((e) => e.id === selected) ?? null;
  /** The mech slot currently open, if the one that was open still exists. */
  const openMech = plan.mechs.find((m) => m.id === mech) ?? null;

  /**
   * The reading of this step's mechanic that is being played, if it goes more
   * than one way. It is what the canvas resolves positions through, and where
   * a drag on this step lands.
   */
  const stepMechanic = plan.mechanics.find((m) => m.id === step.mechanic) ?? null;
  const playing = stepMechanic?.variants.length
    ? (stepMechanic.variants.find((v) => v.id === shown[stepMechanic.id]) ?? stepMechanic.variants[0])
        .id
    : undefined;

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
    return entitiesForStep(plan!, step!.id, undefined, shown).find(
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
    return entitiesForStep(plan!, step!.id, undefined, shown).filter((e): e is PlayerEntity => {
      if (e.type !== "player") return false;
      if (group === "party") return true;
      // The light parties, read off the callout names a static already uses:
      // MT H1 M1 R1 against OT H2 M2 R2. Anyone named otherwise is in neither,
      // which is honest — the plan has not said which side they are on.
      if (group === "g1" || group === "g2") {
        const name = (e.name ?? "").trim().toUpperCase();
        const side = name === "MT" ? "g1" : name === "OT" ? "g2" : /1$/.test(name) ? "g1" : /2$/.test(name) ? "g2" : null;
        return side === group;
      }
      const r = roleOf(e.job) === "any" ? roleOf(e.name ?? "") : roleOf(e.job);
      if (group === "tanks") return r === "tank";
      if (group === "healers") return r === "healer";
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
  function resize(id: string, factor: number, what: "size" | "opacity" = "size") {
    const current = planRef.current;
    const target = current?.entities.find((e) => e.id === id);
    if (!current || !target) return;
    const ids = target.bond
      ? current.entities.filter((e) => e.bond?.id === target.bond!.id).map((e) => e.id)
      : [id];
    // Pointing somewhere else mid-spin: land what is owed before starting again.
    if (
      pendingResize.current &&
      (pendingResize.current.ids[0] !== ids[0] || pendingResize.current.what !== what)
    )
      flushResize();
    const carried = pendingResize.current?.factor ?? 1;
    pendingResize.current = { ids, factor: carried * factor, what };
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
      // Opacity is one number on everything; size is whatever dimensions the
      // shape has. Either way the wheel says "by this much", never "to this".
      const patch =
        job.what === "opacity"
          ? { opacity: Math.min(1, Math.max(0.05, Math.round(e.opacity * job.factor * 100) / 100)) }
          : resizeSpec(e, job.factor);
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
    stack8: "stack",
    stack4: "stack",
    stack2: "stack",
    linestack: "linestack",
    flare: "flare",
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

  /** Put a whole group into a tight stack centred where its card was dropped. */
  async function moveGroup(group: GroupId, pt: { x: number; y: number }) {
    const people = membersOf(group);
    if (!people.length) return;
    // Keep just enough offset to make every token visible and selectable. Even
    // an eight-person party fits inside one default 60-unit player token; G1/G2
    // span 40 units, and a healer pair spans 28.
    const radius = people.length < 2 ? 0 : Math.min(20, 8 + people.length * 3);
    await run(
      people.map((e, i) => {
        const angle = -Math.PI / 2 + (i * Math.PI * 2) / people.length;
        return {
          op: "update_entity" as const,
          id: e.id,
          patch: {
            x: Math.round(pt.x + Math.cos(angle) * radius),
            y: Math.round(pt.y + Math.sin(angle) * radius),
          },
          // The same bargain as dragging one person: a move belongs to the step
          // you are on, and to the reading you are looking at.
          stepId: scope === "step" ? step!.id : undefined,
          variant: scope === "step" ? playing : undefined,
        };
      })
    );
  }

  /** Reads the payload of a drop; ignores drags that did not start in the palette. */
  function kindOf(ev: React.DragEvent): PaletteKind | null {
    const k = ev.dataTransfer.getData("text/plain") as PaletteKind;
    return (PALETTE as readonly string[]).includes(k) ? k : null;
  }

  return (
    <div className="relative flex h-full flex-col">
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
        {editable && (
          <div className="flex items-center gap-1" aria-label="Edit history controls">
            <button
              className="btn"
              disabled={historyBusy || !history?.canUndo}
              title="Undo (Ctrl+Z)"
              onClick={() => void travelHistory("undo")}
            >
              ↶
            </button>
            <button
              className="btn"
              disabled={historyBusy || !history?.canRedo}
              title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
              onClick={() => void travelHistory("redo")}
            >
              ↷
            </button>
            <button
              className={`btn ${historyOpen ? "border-blue-400 text-blue-200" : ""}`}
              title="Revision history and work sessions"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              History
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <>
              <div className="flex items-center gap-1" aria-label="Symmetry controls">
                {([1, 2, 4] as const).map((count, index) => (
                  <button
                    key={count}
                    className={`btn ${symmetryCount === count ? "border-blue-400 text-blue-200" : ""}`}
                    title={`${count === 1 ? "Normal editing" : `${count}-way symmetry`} (${index + 1})`}
                    aria-pressed={symmetryCount === count}
                    onClick={() => setSymmetryCount(count)}
                  >
                    {index + 1}: {count === 1 ? "normal" : `${count}-way`}
                  </button>
                ))}
                <button
                  className={`btn ${symmetryCount > 1 ? "border-violet-400 text-violet-200" : ""}`}
                  title="Toggle mirror / rotational symmetry (Q)"
                  onClick={() => setSymmetryKind((kind) => (kind === "mirror" ? "rotate" : "mirror"))}
                >
                  Q: {symmetryKind === "mirror" ? "mirror" : "rotate"}
                </button>
              </div>
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
          me={user?.id ?? null}
          openMech={openMech}
          shown={shown}
          onShow={setShown}
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
                if ((!carrying && !carryGroup) || layer === "markers") return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = carryGroup ? "move" : "copy";
              }}
              onDrop={(ev) => {
                const payload = ev.dataTransfer.getData("text/plain");
                const pt = arenaPoint(ev);
                // A group carried onto the floor goes there; a palette shape is
                // made there. Same gesture, different sentence.
                if (payload.startsWith("group:")) {
                  ev.preventDefault();
                  const g = payload.slice(6) as GroupId;
                  if ((GROUPS as readonly string[]).includes(g)) void moveGroup(g, pt);
                  setCarryGroup(null);
                  return;
                }
                const kind = kindOf(ev);
                if (!kind) return;
                ev.preventDefault();
                const on = anchorAt(pt);
                void drop(kind, pt, on ? { at: "anchor", id: on } : { at: "free" });
                setCarrying(null);
                setHover(null);
              }}
            >
              {openMech && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-10 px-2 py-1 text-center text-xs text-white"
                  style={{ background: tint(mechColor(plan, openMech), 0.35) }}
                >
                  Filling “{mechLabel(plan, openMech)}” — what you drop goes in it
                </div>
              )}
              <Scene
                plan={plan}
                stepId={step.id}
                shown={shown}
                size={size}
                selected={selected}
                editable={editable}
                layer={layer}
                highlight={highlight}
                glide={glide}
                onward={onward}
                onSelect={setSelected}
                onResize={resize}
                onMove={(id, x, y) =>
                  run({
                    op: "update_entity",
                    id,
                    patch: { x, y },
                    stepId: scope === "step" ? step.id : undefined,
                    // In a mechanic that goes two ways, a move belongs to the
                    // reading you are playing. Nothing has to be said about it:
                    // you moved somebody while looking at this reading.
                    variant: scope === "step" ? playing : undefined,
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
                  draggable={editable && layer === "step" && people > 0}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData("text/plain", "group:" + g);
                    ev.dataTransfer.effectAllowed = "move";
                    setCarryGroup(g);
                  }}
                  onDragEnd={() => setCarryGroup(null)}
                  title={
                    people > 0
                      ? `Drag this onto the floor to stack the ${GROUP_LABEL[g]} tightly there. Drop a mechanic here to give one to each of them`
                      : `Drop a mechanic here to give one to each of the ${g}`
                  }
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
                    editable && layer === "step" && people > 0 ? "cursor-grab active:cursor-grabbing" : ""
                  } ${
                    carryGroup === g
                      ? "border-blue-400 bg-blue-500/20"
                      : hover === g
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
            variant={playing}
            shown={shown}
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

      {historyOpen && history && (
        <HistoryPanel
          history={history}
          busy={historyBusy}
          editable={editable}
          onClose={() => setHistoryOpen(false)}
          onUndo={() => void travelHistory("undo")}
          onRedo={() => void travelHistory("redo")}
          onRevert={(id) => void travelHistory("revert", id)}
        />
      )}

      {user && <ChatPanel planId={planId} />}
    </div>
  );
}

function HistoryPanel({
  history,
  busy,
  editable,
  onClose,
  onUndo,
  onRedo,
  onRevert,
}: {
  history: PlanHistory;
  busy: boolean;
  editable: boolean;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRevert: (id: string) => void;
}) {
  const sessions: { id: string; startedAt: number; actor: string; revisions: PlanRevision[] }[] = [];
  for (const revision of history.revisions) {
    const last = sessions[sessions.length - 1];
    if (last?.id === revision.sessionId) last.revisions.push(revision);
    else
      sessions.push({
        id: revision.sessionId,
        startedAt: revision.sessionStartedAt,
        actor: revision.actorName,
        revisions: [revision],
      });
  }
  const when = (time: number) =>
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(time);

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[360px] flex-col border-l border-ink-600 bg-ink-900 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-ink-700 p-3">
        <div>
          <h2 className="font-semibold text-ink-100">Revision history</h2>
          <p className="text-xs text-ink-400">Automatic snapshots, grouped by work session</p>
        </div>
        <button className="btn ml-auto" onClick={onClose} aria-label="Close history">✕</button>
      </div>
      <div className="flex gap-1 border-b border-ink-700 p-2">
        <button className="btn flex-1" disabled={busy || !history.canUndo} onClick={onUndo}>↶ Undo</button>
        <button className="btn flex-1" disabled={busy || !history.canRedo} onClick={onRedo}>↷ Redo</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sessions.map((session) => (
          <section key={session.id} className="mb-4">
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-xs font-semibold text-ink-200">{session.actor}</span>
              <time className="text-[11px] text-ink-400">{when(session.startedAt)}</time>
            </div>
            <div className="overflow-hidden rounded-lg border border-ink-700">
              {session.revisions.map((revision) => {
                const current = revision.id === history.currentId;
                return (
                  <div
                    key={revision.id}
                    className={`group flex items-center gap-2 border-b border-ink-700 px-3 py-2 last:border-b-0 ${
                      current ? "bg-blue-500/15" : "bg-ink-800"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink-200">{revision.summary}</div>
                      <div className="text-[11px] text-ink-400">
                        {when(revision.createdAt)} · rev {revision.rev}{current ? " · current" : ""}
                      </div>
                    </div>
                    {editable && !current && revision.summary !== "History started" && (
                      <button
                        className="btn opacity-0 group-hover:opacity-100 focus:opacity-100"
                        disabled={busy}
                        title={`Restore revision ${revision.rev} as a new revision`}
                        onClick={() => onRevert(revision.id)}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
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
  /** Row indices within the section the box is drawn in, not step numbers. */
  lo: number;
  hi: number;
  /** Where it started, so every move is measured from the same place. */
  from: [number, number];
  /**
   * Carried onto the row of readings: the one it would belong to if you let go,
   * `to` unset meaning both of them. Set only while the pointer is on a pill,
   * so a plain up-and-down drag never puts a cast anywhere.
   */
  gate?: { to?: string };
  moved: boolean;
}

/** A row or heading being carried to another slot in its list. */
interface Slide {
  id: string;
  /** The slot it is over right now — where it would land if you let go. */
  at: number;
  moved: boolean;
}

/** A list with one item lifted out and put back at `at`: the drag, previewed. */
function reordered<T extends { id: string }>(list: T[], id: string, at: number): T[] {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return list;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, at)), 0, item);
  return out;
}

/**
 * The outline of the encounter: Encounter → Mechanic → (Variant) → Steps.
 *
 * A mechanic is a section of the fight — "Witch Hunt", "Electrope Edge 1" —
 * owning a run of steps, and one of them may be played two ways, each variant
 * with steps of its own. Exactly one section is open, and which one is not a
 * thing to remember: it is the section holding the step you have selected, so
 * clicking a heading opens it by selecting into it. Every step is in a
 * section — a plan written before any of this existed is hydrated into one
 * mechanic holding the whole fight — so the rail is one list of headings.
 *
 * Inside a section the mechs run alongside the steps exactly as before: a box
 * spanning the rows it is on the floor for, so the fight reads down the page.
 */
function StepRail({
  plan,
  index,
  editable,
  me,
  openMech,
  shown,
  onShow,
  onSelect,
  run,
  setIndex,
  onOpenMech,
  onHighlight,
}: {
  plan: Plan;
  index: number;
  editable: boolean;
  /** Who is looking, so a reading can say whether it is yours. */
  me: string | null;
  openMech: Mech | null;
  shown: Record<string, string>;
  onShow: Dispatch<SetStateAction<Record<string, string>>>;
  onSelect(i: number): void;
  run(ops: Op | Op[]): Promise<{ values: unknown[]; plan: Plan }>;
  setIndex(i: number): void;
  onOpenMech(id: string | null): void;
  onHighlight(id: string | null): void;
}) {
  // Deleting the last step leaves the parent's index pointing past the end for
  // one render; the rail must not blow up in that gap.
  const at = Math.min(index, plan.steps.length - 1);
  const current = plan.steps[at];

  const [drag, setDrag] = useState<Drag | null>(null);
  /**
   * A row or a heading on its way somewhere: what is being dragged and which
   * slot it is currently over. Where a step or a section sits *is* what it
   * says, so dragging it is how you say it — there is nothing else to edit.
   */
  const [rowDrag, setRowDrag] = useState<Slide | null>(null);
  const [sectionDrag, setSectionDrag] = useState<Slide | null>(null);
  /** A drag that moved ends in a click too; this is how that click is ignored. */
  const dragged = useRef(false);
  /** The step, mech, mechanic or variant whose name is a field right now. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const setShown = onShow;

  // Where the step rows are on screen, so a box being dragged can say which row
  // the pointer is over. The rows are the ruler; nothing else measures.
  const rowRefs = useRef(new Map<string, HTMLElement | null>());
  const rowAt = (clientY: number, visible: Step[]) => {
    let best = 0;
    let closest = Infinity;
    visible.forEach((s, i) => {
      const r = rowRefs.current.get(s.id)?.getBoundingClientRect();
      if (!r) return;
      const d = Math.abs(clientY - (r.top + r.height / 2));
      if (d < closest) {
        closest = d;
        best = i;
      }
    });
    return best;
  };

  /**
   * The same ruler for the headings — but measured once, when the drag starts.
   * Sections are not all the same height, so previewing a swap moves the very
   * headings you are aiming at; a ruler that moves under the pointer makes the
   * preview flicker between two answers. The rows do not have that problem:
   * they are all one height, so their ladder is the same before and after.
   */
  const headerRefs = useRef(new Map<string, HTMLElement | null>());
  const headerRuler = useRef<number[]>([]);
  const slotAt = (clientY: number, centres: number[]) => {
    let best = 0;
    let closest = Infinity;
    centres.forEach((c, i) => {
      const d = Math.abs(clientY - c);
      if (d < closest) {
        closest = d;
        best = i;
      }
    });
    return best;
  };

  /** The section that is open: the one the selected step is in. */
  const openId = current?.mechanic ?? null;
  const shownIn = (m: Mechanic) =>
    m.variants.some((v) => v.id === shown[m.id]) ? shown[m.id] : m.variants[0]?.id;
  // A mechanic's steps are its steps, whichever way it goes: the readings do
  // not own them.
  const stepsIn = (m: Mechanic) => mechanicSteps(plan, m.id);

  /** The steps the selected one shares its section with — what ↑ and ↓ walk. */
  const openMechanic = plan.mechanics.find((m) => m.id === openId) ?? null;
  const siblings = openMechanic ? stepsIn(openMechanic) : [];

  /**
   * Where the mech boxes go in one section: a box belongs to the section its
   * snapshot is in, and a cast reaching past the end of that section is drawn
   * to the end of it. Boxes that overlap take the first free lane.
   *
   * A mechanic that goes two ways splits the rail into areas — what happens
   * either way first, then one area per reading — so which area a box sits in
   * is the plan saying who the cast is for. The areas stand even while empty:
   * a reading with no casts of its own is a fact about the fight, not a gap.
   */
  function layout(visible: Step[], mechanic: Mechanic | null) {
    const row = new Map(visible.map((s, i) => [s.id, i]));
    const areas: (string | undefined)[] = [undefined, ...(mechanic?.variants.map((v) => v.id) ?? [])];
    const split = areas.length > 1;
    type Placed = { mech: Mech; lo: number; hi: number; lane: number };
    /** The rows a cast covers as the plan has it — the drag is not in this. */
    const span = (mech: Mech): [number, number] | undefined => {
      const rows = mechSpan(plan, mech)
        .map((id) => row.get(id))
        .filter((i): i is number => i !== undefined);
      return rows.length ? [Math.min(...rows), Math.max(...rows)] : undefined;
    };

    // The widths are read off the plan, never off the drag: a box in the hand
    // keeps its old area's lane, so no column moves while you carry it. A rail
    // that reflowed under the pointer would slide the area you were aiming at
    // out from under it.
    const lanesOf: Placed[][] = [];
    const groups: { variant?: string; from: number; lanes: number }[] = [];
    let from = 0;
    for (const area of areas) {
      const mine: Placed[] = [];
      for (const mech of plan.mechs) {
        if (!row.has(mech.snap)) continue;
        if ((mech.variant ?? undefined) !== area) continue;
        const rows = span(mech);
        if (!rows) continue;
        const [lo, hi] = rows;
        let lane = 0;
        while (mine.some((p) => p.lane === lane && p.lo <= hi && p.hi >= lo)) lane++;
        mine.push({ mech, lo, hi, lane });
      }
      const lanes = Math.max(
        split ? 1 : 0,
        mine.reduce((n, p) => Math.max(n, p.lane + 1), 0)
      );
      lanesOf.push(mine);
      groups.push({ variant: area, from, lanes });
      from += lanes;
    }

    // The box in the hand is then drawn where the pointer has it — the area it
    // would land in, over the rows it would cover — inside the lanes its target
    // area already has. The drag is the edit, previewed.
    if (drag) {
      const held = plan.mechs.find((m) => m.id === drag.id);
      const to = held && (drag.gate ? drag.gate.to : (held.variant ?? undefined));
      const at = held ? areas.findIndex((a) => a === to) : -1;
      if (held && at >= 0) {
        for (const mine of lanesOf) {
          const i = mine.findIndex((p) => p.mech.id === held.id);
          if (i >= 0) mine.splice(i, 1);
        }
        const mine = lanesOf[at];
        const [lo, hi] = [drag.lo, drag.hi];
        let lane = 0;
        while (
          lane < groups[at].lanes - 1 &&
          mine.some((p) => p.lane === lane && p.lo <= hi && p.hi >= lo)
        )
          lane++;
        mine.push({ mech: held, lo, hi, lane });
      }
    }

    const placed: Placed[] = [];
    lanesOf.forEach((mine, i) =>
      mine.forEach((p) => placed.push({ ...p, lane: groups[i].from + p.lane }))
    );
    // Always in the plan's own order, whatever the drag is doing: the grid says
    // where a box sits, so the list never has to be resorted — and a box that
    // kept its place in the list keeps the pointer, which is the drag itself.
    placed.sort((a, b) => plan.mechs.indexOf(a.mech) - plan.mechs.indexOf(b.mech));
    return { placed, lanes: from, groups };
  }

  /**
   * The open section's rows as the pointer currently has them, and the mech
   * boxes laid out against *that* order: a cast's span is read off the step
   * order, so it has to re-lay itself out while you carry a row past it.
   */
  const visibleRows = rowDrag ? reordered(siblings, rowDrag.id, rowDrag.at) : siblings;
  // Only the open section draws rows, so only it can want lanes.
  const laid = openMechanic
    ? layout(visibleRows, openMechanic)
    : { placed: [], lanes: 0, groups: [] as { variant?: string; from: number; lanes: number }[] };
  /** The sections in the order the pointer has them, same bargain. */
  const sections = sectionDrag
    ? reordered(plan.mechanics, sectionDrag.id, sectionDrag.at)
    : plan.mechanics;

  /**
   * The pills that say which reading is playing are also where you put a cast:
   * carrying its box onto one is how a cast becomes that reading's, and onto
   * "both" is how it goes back to happening either way.
   */
  const pillRefs = useRef(new Map<string, HTMLElement | null>());
  /**
   * The areas themselves are the other way of saying it, and the plain one:
   * carry a box left or right into an area and the cast is that reading's.
   */
  const areaRefs = useRef(new Map<string, HTMLElement | null>());
  const areaAt = (clientX: number): { to?: string } | undefined => {
    // The gaps between areas, and the reach past the last one, belong to the
    // area nearest them: a 4px gutter is not the pointer saying "shared".
    let best: { to?: string } | undefined;
    let near = 40;
    for (const [id, el] of areaRefs.current) {
      const r = el?.getBoundingClientRect();
      if (!r) continue;
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      if (d <= near) [best, near] = [{ to: id || undefined }, d];
    }
    return best;
  };
  const pillAt = (clientX: number, clientY: number): { to?: string } | undefined => {
    for (const [id, el] of pillRefs.current) {
      const r = el?.getBoundingClientRect();
      if (r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom)
        return { to: id || undefined };
    }
    return undefined;
  };

  /** Let go of a row: the slot it was dropped on, or a plain click if it never moved. */
  function endRowDrag() {
    const settled = rowDrag;
    setRowDrag(null);
    if (!settled?.moved) return;
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    const landing = siblings[Math.max(0, Math.min(siblings.length - 1, settled.at))];
    const to = plan.steps.indexOf(landing);
    void run({ op: "move_step", stepId: settled.id, index: to });
    setIndex(to);
  }

  /** The same for a heading: the whole section goes where you put it. */
  function endSectionDrag() {
    const settled = sectionDrag;
    setSectionDrag(null);
    if (!settled?.moved) return;
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    // The selection is a place in `plan.steps`, and moving a block of them
    // changes what is at that place: hold on to the step itself instead, or
    // the open section changes under you.
    const keep = current?.id;
    void run({ op: "move_mechanic", mechanicId: settled.id, index: settled.at }).then((res) => {
      const i = res.plan.steps.findIndex((s) => s.id === keep);
      if (i >= 0) setIndex(i);
    });
  }

  /**
   * A slide is followed on the window rather than through pointer capture: the
   * thing being carried is the thing being reordered, and the browser drops the
   * capture the moment React moves that node to its new slot in the list.
   */
  useEffect(() => {
    if (!rowDrag) return;
    const move = (ev: PointerEvent) => {
      const to = rowAt(ev.clientY, visibleRows);
      setRowDrag((d) => (d && d.at !== to ? { ...d, at: to, moved: true } : d));
    };
    const up = () => endRowDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  useEffect(() => {
    if (!sectionDrag) return;
    const move = (ev: PointerEvent) => {
      const to = slotAt(ev.clientY, headerRuler.current);
      setSectionDrag((d) => (d && d.at !== to ? { ...d, at: to, moved: true } : d));
    };
    const up = () => endSectionDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  // F2 renames what you are working on, where it sits: the heading you have
  // your keyboard on, else the mech you have open, else the step you are
  // looking at. Double-click does the same, wherever you click.
  const renameTarget = openMech?.id ?? current?.id ?? null;
  useEffect(() => {
    if (!editable) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "F2") return;
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      ev.preventDefault();
      // Asked of the DOM rather than remembered: a heading that renames itself
      // is replaced by the field, and a remembered focus would never come back.
      // A variant pill is the narrower thing, so it wins over its mechanic.
      const pill = el?.closest?.("[data-variant]")?.getAttribute("data-variant");
      const heading = el?.closest?.("[data-mechanic]")?.getAttribute("data-mechanic");
      setRenaming(pill ?? heading ?? renameTarget);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, renameTarget]);

  /**
   * Let go of a box: the reading it was carried onto, the span it was dropped
   * on, or a plain click if it never moved.
   */
  function endDrag(mech: Mech, lo: number, hi: number, visible: Step[]) {
    const settled = drag;
    setDrag(null);
    if (!settled) return;
    if (!settled.moved) return onOpenMech(openMech?.id === mech.id ? null : mech.id);
    // One drag can say both: which reading it is for, and when it happens.
    const [wasLo, wasHi] = settled.from;
    void (async () => {
      if (settled.gate && (mech.variant ?? undefined) !== settled.gate.to)
        await run({ op: "gate_mech", mechId: mech.id, variant: settled.gate.to });
      if (lo !== wasLo || hi !== wasHi)
        await run({
          op: "update_mech",
          mechId: mech.id,
          patch: { snap: visible[lo].id, boom: visible[hi].id },
        });
    })();
  }

  /** Select a step by its place in the whole plan, which is what the canvas follows. */
  const go = (step: Step | undefined) => {
    if (step) onSelect(plan.steps.indexOf(step));
  };

  /** Show one reading of a mechanic, and step into it so the canvas follows. */
  function showVariant(mechanic: Mechanic, variantId: string) {
    setShown((s) => ({ ...s, [mechanic.id]: variantId }));
    go(mechanicSteps(plan, mechanic.id)[0]);
  }

  /** Compact actions that live beside the step they act on. */
  function stepActions(s: Step) {
    if (!editable || s.id !== current?.id) return null;
    const stepAt = plan.steps.indexOf(s);
    const action = "grid h-6 w-6 shrink-0 place-items-center rounded text-xs text-ink-300 hover:bg-ink-600 hover:text-white disabled:opacity-30";
    return (
      <div className="flex shrink-0 items-center gap-0.5" aria-label="Step actions">
        <button
          className={action}
          aria-label="Duplicate step"
          title="Duplicate step"
          onClick={async () => {
            await run({ op: "duplicate_step", stepId: s.id });
            setIndex(stepAt + 1);
          }}
        >
          D
        </button>
        <button
          className={action}
          aria-label="Add step after this one"
          title="Add step after this one"
          onClick={async () => {
            await run({ op: "add_step", index: stepAt + 1 });
            setIndex(stepAt + 1);
          }}
        >
          +
        </button>
        <button
          className={`${action} hover:text-red-300`}
          aria-label="Delete step"
          title="Delete step"
          disabled={plan.steps.length < 2}
          onClick={async () => {
            await run({ op: "delete_step", stepId: s.id });
            setIndex(Math.max(0, stepAt - 1));
          }}
        >
          ×
        </button>
      </div>
    );
  }

  /** The steps of one section, with the mechs running alongside them. */
  function grid(mechanic: Mechanic, visible: Step[], l: ReturnType<typeof layout>) {
    const showing = shownIn(mechanic);
    // The areas are labelled only when there is more than one of them: with a
    // single reading the rail is just the casts, as it always was.
    const split = l.groups.length > 1;
    const head = split ? 1 : 0;
    const end = visible.length + head + 1;
    return (
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${l.lanes}, 66px)` }}
      >
        {split &&
          l.groups.map((g) => {
            const color = g.variant ? variantColor(mechanic, g.variant) : "#8b93a7";
            const name = g.variant ? variantLabel(mechanic, g.variant) : "Shared";
            return (
              <Fragment key={g.variant ?? "shared"}>
                {/* The area itself, standing behind its lanes for the whole
                    section — so an empty reading still reads as a place. */}
                <div
                  aria-hidden
                  ref={(el) => {
                    areaRefs.current.set(g.variant ?? "", el);
                  }}
                  className="pointer-events-none rounded"
                  style={{
                    gridColumn: `${g.from + 2} / span ${g.lanes}`,
                    gridRow: `1 / ${end}`,
                    background: tint(color, 0.08),
                  }}
                />
                <div
                  data-area={g.variant ?? ""}
                  className="truncate text-center text-[9px] uppercase tracking-wide"
                  style={{ gridColumn: `${g.from + 2} / span ${g.lanes}`, gridRow: 1, color }}
                  title={
                    g.variant
                      ? `Casts that only happen in ${name}`
                      : "Casts that happen whichever way it goes"
                  }
                >
                  {name}
                </div>
              </Fragment>
            );
          })}
        {visible.map((s, i) =>
          renaming === s.id ? (
            <div
              key={s.id}
              ref={(el) => {
                rowRefs.current.set(s.id, el);
              }}
              style={{ gridColumn: 1, gridRow: i + 1 + head }}
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
            <div
              key={s.id}
              ref={(el) => {
                rowRefs.current.set(s.id, el);
              }}
              style={{ gridColumn: 1, gridRow: i + 1 + head }}
              className={`flex min-w-0 items-center gap-0.5 rounded ${
                s.id === current?.id ? "bg-ink-600 text-white" : "hover:bg-ink-700"
              } ${rowDrag?.id === s.id ? "ring-1 ring-blue-300" : ""}`}
            >
              <button
                data-step={s.id}
                aria-current={s.id === current?.id ? "step" : undefined}
                className={`min-w-0 flex-1 touch-none truncate px-2 py-1 text-left text-sm ${
                  editable ? "cursor-grab active:cursor-grabbing" : ""
                }`}
                // The row is where the step is in the fight, so carrying it is the
                // whole edit. It cannot leave the section: these are its rows.
                onPointerDown={() => editable && setRowDrag({ id: s.id, at: i, moved: false })}
                onClick={() => !dragged.current && go(s)}
                onDoubleClick={() => editable && setRenaming(s.id)}
                title={
                  editable
                    ? "Drag to move it in the sequence. W and S walk the steps. Double-click or F2 to rename"
                    : "W and S walk the steps"
                }
              >
                {i + 1}. {s.name || "untitled"}
              </button>
              {stepActions(s)}
            </div>
          )
        )}
        {l.placed.map(({ mech, lo, hi, lane }) => {
          const active = openMech?.id === mech.id;
          const label = mechLabel(plan, mech);
          const shapes = plan.entities.filter((e) => e.mech === mech.id).length;
          const box = { gridColumn: lane + 2, gridRow: `${lo + 1 + head} / ${hi + 2 + head}` };
          const color = mechColor(plan, mech);
          // Mid-drag the box says what letting go would do, reading and all.
          const gate = drag?.id === mech.id && drag.gate ? drag.gate.to : mech.variant;
          const skipped = !!gate && gate !== showing;
          if (renaming === mech.id)
            return (
              <div
                key={mech.id}
                style={{ ...box, borderTopColor: color, background: tint(color, 0.25) }}
                className="flex items-center rounded border-t-2 px-1 py-1"
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
              data-mech={mech.id}
              style={{ ...box, borderTopColor: color, background: tint(color, active ? 0.4 : 0.18) }}
              title={`${label} — snapshots in step ${lo + 1}, goes off in step ${hi + 1}${
                gate ? `, only in ${variantLabel(mechanic, gate)}` : ""
              }. ${
                editable
                  ? "Drag its top half to move the snapshot, its bottom half to move the explosion, or carry it sideways into a reading's area to say it only happens that way. Click to fill it."
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
                  grabbed: rowAt(e.clientY, visible),
                  lo,
                  hi,
                  from: [lo, hi],
                  moved: false,
                });
              }}
              onPointerMove={(e) => {
                if (drag?.id !== mech.id) return;
                // The pointer says both things at once: the area it is over is
                // which reading the cast is for, the row it is on is when it
                // happens. Carried up onto a reading pill counts as the area.
                const onPill = mechanic.variants.length
                  ? pillAt(e.clientX, e.clientY)
                  : undefined;
                const gate = mechanic.variants.length
                  ? (onPill ?? areaAt(e.clientX) ?? drag.gate)
                  : undefined;
                const row = rowAt(e.clientY, visible);
                const [wasLo, wasHi] = drag.from;
                // The end you are holding cannot cross the other one: a cast
                // goes off no sooner than it snapshots. Held over the pills the
                // span stays put — up there no row is meant.
                const next: [number, number] = onPill
                  ? [drag.lo, drag.hi]
                  : drag.mode === "top"
                    ? [Math.min(row, wasHi), wasHi]
                    : [wasLo, Math.max(row, wasLo)];
                // "No gate yet" and "gated to both" are different states, and
                // both read as undefined: compare the gate itself, not its id.
                const same =
                  next[0] === drag.lo &&
                  next[1] === drag.hi &&
                  !!gate === !!drag.gate &&
                  gate?.to === drag.gate?.to;
                if (same) return;
                setDrag({ ...drag, gate, lo: next[0], hi: next[1], moved: true });
              }}
              onPointerUp={() => endDrag(mech, lo, hi, visible)}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={() => editable && setRenaming(mech.id)}
              className={`flex touch-none flex-col items-center overflow-hidden rounded border-t-2 px-1 py-1 text-[11px] leading-tight ${
                editable ? "cursor-grab active:cursor-grabbing" : ""
              } ${active ? "text-white" : "text-ink-200"} ${
                drag?.id === mech.id ? "ring-1 ring-white/70" : ""
              } ${skipped ? "opacity-60" : ""}`}
            >
              {/* Which reading a cast is for is the area it sits in, so the box
                  itself does not repeat it. */}
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
    );
  }

  /**
   * Details for the step you are on. Its compact actions live on the row itself.
   */
  function controls() {
    return (
      <>
        <MechBox plan={plan} open={openMech} stepId={current.id} run={run} onOpen={onOpenMech} />
        <div className="mt-4">
          <div className="label mb-1">Step notes</div>
          {/* Uncontrolled + keyed: local typing stays smooth, remote edits reset it. */}
          <textarea
            key={`${current.id}:${current.notes}`}
            className="field h-32 resize-none"
            disabled={!editable}
            defaultValue={current.notes}
            onBlur={(e) =>
              run({ op: "update_step", stepId: current.id, patch: { notes: e.target.value } })
            }
          />
        </div>
      </>
    );
  }

  /**
   * The pills that choose which reading of a mechanic you are looking at.
   * A mechanic that goes one way has no pills — only the "+" that would give
   * it a second way, and nothing at all until you open the section.
   */
  function variantRow(mechanic: Mechanic) {
    const showing = shownIn(mechanic);
    return (
      <div className="mb-1 flex flex-wrap items-center gap-1 px-1">
        {mechanic.variants.length > 0 && <span className="label">Playing</span>}
        {mechanic.variants.map((v) =>
          renaming === v.id ? (
            <Rename
              key={v.id}
              title="Rename variant"
              value={v.name}
              placeholder={variantLabel(mechanic, v.id)}
              onDone={(name) => {
                setRenaming(null);
                if (name !== v.name)
                  void run({
                    op: "update_variant",
                    mechanicId: mechanic.id,
                    variantId: v.id,
                    patch: { name },
                  });
              }}
            />
          ) : (
            <Fragment key={v.id}>
              <button
                ref={(el) => {
                  pillRefs.current.set(v.id, el);
                }}
                className={`rounded px-2 py-0.5 text-xs ${
                  v.id === showing ? "text-white" : "text-ink-200 hover:bg-ink-700"
                } ${drag?.gate?.to === v.id ? "ring-1 ring-white/80" : ""}`}
                style={{
                  background:
                    v.id === showing || drag?.gate?.to === v.id
                      ? tint(variantColor(mechanic, v.id), 0.5)
                      : undefined,
                }}
                data-variant={v.id}
                data-owner={v.ownerId ?? ""}
                aria-pressed={v.id === showing}
                title={`${
                  v.ownerId
                    ? v.ownerId === me
                      ? "Your reading — yours to change, and nobody else's. "
                      : `${v.ownerName || v.ownerId}'s reading — theirs to change; add your own to say it differently. `
                    : "The plan's own reading, open to anyone who can edit it. "
                }The reading on screen — what the canvas draws, and where a cast dropped on it belongs. A and D move between readings. Double-click or F2 to rename`}
                onClick={() => showVariant(mechanic, v.id)}
                onDoubleClick={() => editable && setRenaming(v.id)}
              >
                {variantLabel(mechanic, v.id)}
                {/* Whose answer to the mechanic this is, when it is somebody's. */}
                {v.ownerId && v.ownerId !== me && (
                  <span className="ml-1 text-[10px] text-ink-400">
                    {(v.ownerName || v.ownerId).split(/[:\s]/).pop()}
                  </span>
                )}
              </button>
              {v.id === showing && editable && (
                <button
                  className="px-0.5 text-ink-400 hover:text-red-300"
                  title="Delete this reading and the casts only it has"
                  onClick={async () => {
                    const res = await run({
                      op: "delete_variant",
                      mechanicId: mechanic.id,
                      variantId: v.id,
                    });
                    const i = res.plan.steps.findIndex((s) => s.mechanic === mechanic.id);
                    setIndex(Math.max(0, i));
                  }}
                >
                  ✕
                </button>
              )}
            </Fragment>
          )
        )}
        {/* While a cast is in the hand the readings are drop targets, and this
            is the one that means "it happens either way". */}
        {drag && mechanic.variants.length > 0 && (
          <button
            ref={(el) => {
              pillRefs.current.set("", el);
            }}
            className={`rounded px-2 py-0.5 text-xs text-ink-200 ${
              drag.gate && !drag.gate.to ? "bg-ink-600 ring-1 ring-white/80" : "bg-ink-800"
            }`}
            title="Drop a cast here and it goes off whichever way the mechanic goes"
          >
            both
          </button>
        )}
        {editable && (
          <button
            className="rounded bg-ink-800 px-2 py-0.5 text-xs text-ink-200 hover:bg-ink-700"
            title="Another way this mechanic goes. The steps are the same either way — what changes is which casts land and where the party stands"
            onClick={() => addVariant(mechanic)}
          >
            {mechanic.variants.length ? "+" : "+ variant"}
          </button>
        )}
      </div>
    );
  }

  /**
   * Another reading of a mechanic. Nothing is copied: the steps stay one run,
   * shared until you gate some of them. The first "+" makes two readings, since
   * one reading is not a choice, and leaves you looking at the first.
   */
  async function addVariant(mechanic: Mechanic) {
    const res = await run({ op: "add_variant", mechanicId: mechanic.id });
    const made = res.values[0] as { id: string } | null;
    if (!made) return;
    setShown((s) => ({ ...s, [mechanic.id]: made.id }));
  }

  return (
    <nav
      className="panel shrink-0 overflow-y-auto border-y-0 border-l-0 p-2"
      style={{ width: 236 + laid.lanes * 70 }}
    >
      <div className="label">Encounter</div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm text-ink-200">{plan.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-ink-400">
          {plan.mechanics.length} {plan.mechanics.length === 1 ? "mechanic" : "mechanics"}
        </span>
      </div>

      {sections.map((mechanic, index_) => {
        const open = mechanic.id === openId;
        const visible = stepsIn(mechanic);
        return (
          <div
            key={mechanic.id}
            className={`mt-1 rounded ${open ? "bg-ink-700 p-1" : ""}`}
          >
            {renaming === mechanic.id ? (
              <div className="flex items-center gap-1 px-1 py-1">
                <Chevron open={open} />
                <Rename
                  title="Rename mechanic"
                  value={mechanic.name}
                  placeholder={mechanicLabel(plan, mechanic)}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== mechanic.name)
                      void run({ op: "update_mechanic", mechanicId: mechanic.id, patch: { name } });
                  }}
                />
              </div>
            ) : (
              <div className="flex items-center">
                <button
                  data-mechanic={mechanic.id}
                  ref={(el) => {
                    headerRefs.current.set(mechanic.id, el);
                  }}
                  className={`flex min-w-0 flex-1 touch-none items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-ink-600 ${
                    editable ? "cursor-grab active:cursor-grabbing" : ""
                  } ${sectionDrag?.id === mechanic.id ? "ring-1 ring-blue-300" : ""}`}
                  title={
                    editable
                      ? "Drag to move this mechanic in the fight — its steps go with it. Double-click or F2 to rename"
                      : `${visible.length} steps`
                  }
                  // A heading carries its whole block of steps: the order of the
                  // sections is the order of the fight, and nothing else says it.
                  onPointerDown={() => {
                    if (!editable) return;
                    headerRuler.current = plan.mechanics.map((m) => {
                      const r = headerRefs.current.get(m.id)?.getBoundingClientRect();
                      return r ? r.top + r.height / 2 : Infinity;
                    });
                    setSectionDrag({ id: mechanic.id, at: index_, moved: false });
                  }}
                  onClick={() => !dragged.current && go(visible[0])}
                  onDoubleClick={() => editable && setRenaming(mechanic.id)}
                >
                  <Chevron open={open} />
                  <span className="min-w-0 flex-1 truncate">{mechanicLabel(plan, mechanic)}</span>
                  {mechanic.variants.length > 0 && (
                    <span className="shrink-0 rounded bg-ink-600 px-1 text-[10px] text-ink-200">
                      {mechanic.variants.map((v) => variantLabel(mechanic, v.id)).join(" / ")}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-ink-400">{visible.length}</span>
                </button>
                {open && editable && (
                  <button
                    className="px-1 text-ink-400 hover:text-red-300"
                    title="Delete this mechanic and its steps"
                    onClick={async () => {
                      await run({ op: "delete_mechanic", mechanicId: mechanic.id });
                      setIndex(0);
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
            {open && (
              <>
                {(editable || mechanic.variants.length > 0) && variantRow(mechanic)}
                {grid(mechanic, visibleRows, laid)}
                {editable && controls()}
              </>
            )}
          </div>
        );
      })}

      {editable && (
        <button
          className="btn mt-3 w-full"
          title="A new section of the fight, with a step in it"
          onClick={async () => {
            const res = await run({ op: "add_mechanic" });
            const made = res.values[0] as { id: string } | null;
            const i = made ? res.plan.steps.findIndex((s) => s.mechanic === made.id) : -1;
            if (i >= 0) setIndex(i);
          }}
        >
          New mechanic
        </button>
      )}
    </nav>
  );
}

/** Open or closed, drawn rather than spelled with a character. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className="shrink-0 text-ink-400"
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * The controls for one mech: what it is called and which two steps it hangs
 * between. Only the open one is editable — the boxes in the grid are the
 * overview, this is the thing you are filling.
 */
/** A hex colour as a translucent CSS rgba, for tinting chrome with a mech's colour. */
function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

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
        <div
          className="mt-2 rounded border p-2 text-xs"
          style={{ borderColor: tint(mechColor(plan, open), 0.6), background: tint(mechColor(plan, open), 0.1) }}
        >
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
          {/* Its colour is what tells its shapes apart from the next cast's. */}
          <div className="mt-2 flex gap-1">
            {MECH_COLORS.map((c) => (
              <button
                key={c}
                className={`h-4 w-4 rounded-sm ${
                  mechColor(plan, open) === c ? "ring-2 ring-white" : "hover:ring-1 hover:ring-white/60"
                }`}
                style={{ background: c }}
                title={`Draw it in ${c}`}
                onClick={() => void run({ op: "update_mech", mechId: open.id, patch: { color: c } })}
              />
            ))}
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

const GROUPS = ["party", "g1", "g2", "supports", "damagers", "tanks", "healers"] as const;
type GroupId = (typeof GROUPS)[number];

const GROUP_LABEL: Record<GroupId, string> = {
  party: "Party",
  g1: "G1",
  g2: "G2",
  supports: "Supports",
  damagers: "Damagers",
  tanks: "Tanks",
  healers: "Healers",
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
      {(kind === "stack8" || kind === "stack4" || kind === "stack2") && (
        <g>
          <circle cx="15" cy="15" r="11" fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2" />
          <circle cx="15" cy="15" r="6" fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray="3 2" />
          <text x="15" y="19" textAnchor="middle" fontSize="11" fontWeight="700" fill="#e8edf5">
            {kind.slice(5)}
          </text>
        </g>
      )}
      {kind === "linestack" && (
        <g>
          <rect x="10" y="3" width="10" height="24" fill="rgba(255,112,67,0.35)" stroke={stroke} strokeWidth="2" />
          <path d="M12 11 l3 -3 l3 3 M12 17 l3 -3 l3 3 M12 23 l3 -3 l3 3" fill="none" stroke="#e8edf5" strokeWidth="1.5" />
        </g>
      )}
      {kind === "flare" && (
        <g stroke={stroke} strokeWidth="2" fill="none">
          <circle cx="15" cy="15" r="11" fill="rgba(255,112,67,0.35)" />
          <circle cx="15" cy="15" r="3" fill="#e8edf5" stroke="none" />
          <path d="M15 4v5 M15 21v5 M4 15h5 M21 15h5 M7.2 7.2l3.5 3.5 M19.3 19.3l3.5 3.5 M22.8 7.2l-3.5 3.5 M10.7 19.3l-3.5 3.5" />
        </g>
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
