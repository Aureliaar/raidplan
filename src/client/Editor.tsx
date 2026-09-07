import type { Dispatch, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { api } from "./api";
import { navigate } from "./App";
import type { EditLayer } from "./canvas/Scene";
import { Scene, viewScale } from "./canvas/Scene";
import { Inspector } from "./Inspector";
import { ChatPanel } from "./ChatPanel";
import { applyOp, type Op } from "../shared/apply";
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
  EntitySchema,
  authoredEntitiesForStep,
  beatVariantContentEdited,
  beatVariantLabel,
  beatVariantMovement,
  composeBeatVariantEntities,
  defaultBeatVariantSelections,
  entitiesForStep,
  isFanCopy,
  hydratePlan,
  isActor,
  mechLabel,
  MECH_COLORS,
  mechColor,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  resolveEntity,
  variantColor,
  variantLabel,
  VARIANT_COLORS,
  yalmsToArenaUnits,
} from "../shared/schema";
import {
  activeStepVariants,
  boxedBeatIds,
  composeStepVariantEntities,
  defaultStepVariantSelections,
  stepVariantLabel,
  stepVariantOwner,
  stepVariantSetIncludes,
  stepVariants,
} from "../shared/step-variants";
import type { PaletteKind, PaletteMechanicKind, PaletteSourceKind } from "../shared/ops";
import {
  PALETTE,
  PALETTE_HINT,
  PALETTE_LABEL,
  PALETTE_TETHER_RANGE_YALMS,
  isPaletteCosmetic,
  isPaletteSource,
  isPaletteTether,
  paletteBait,
  paletteNeedsSource,
  paletteSpec,
  resizeSpec,
} from "../shared/ops";
import { jobLabel, roleOf } from "../shared/jobs";
import { debuffDress } from "../shared/debuffs";
import { type FightLibraryEntry, fightForEncounter } from "../shared/fight-library";
import { DebuffPanel } from "./DebuffPanel";
import { assetUrl } from "../shared/assets";
import { arenaCalibration } from "../shared/arena-calibration";
import {
  makeSymmetricAdds,
  symmetricUpdates,
  symmetryIds,
  type SymmetryCount,
  type SymmetryKind,
} from "./symmetry";

type ClipboardEntity = PropBag & { type: Entity["type"] };
type EntityClipboard = {
  sourceId: string;
  root: ClipboardEntity;
  assigned: ClipboardEntity[];
};

/**
 * The editor. Plan state arrives over the PlanAgent WebSocket — which is also
 * how edits made by a model through MCP land on screen — and every local change
 * is posted as an op, so both paths run identical server code.
 */
export function Editor({ planId, user }: { planId: string; user: User | null }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [role, setRole] = useState<PlanRole>("viewer");
  const [stepIndex, setStepIndex] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.at(-1) ?? null;
  const setSelected = (id: string | null) => setSelection(id ? [id] : []);
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
  /**
   * Chips beyond the selection: a leader and a chip in the margin for every
   * floor item of a kind. The party and everything else toggle separately, so
   * a mechanic can be read off its chips without eight player chips in the way.
   */
  const [chips, setChips] = useState({ party: false, others: false });
  /** Starts a selection sweep from beside the canvas; the Scene fills it in. */
  const sweep = useRef<((ev: MouseEvent) => void) | null>(null);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
      const key = ev.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      ev.preventDefault();
      setChips((on) => (key === "c" ? { ...on, others: !on.others } : { ...on, party: !on.party }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState<PlanHistory | null>(null);
  /** History metadata and snapshots already seen by this tab, for instant travel. */
  const historyRef = useRef<PlanHistory | null>(null);
  historyRef.current = history;
  const historyPlans = useRef(new Map<string, Plan>());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  /** What is in the hand mid-drag, purely so the drop targets can light up. */
  const [carrying, setCarrying] = useState<PaletteKind | null>(null);
  /** Full-size arena preview of a palette item before its drop is committed. */
  const [palettePreview, setPalettePreview] = useState<{
    kind: PaletteKind;
    x: number;
    y: number;
  } | null>(null);
  const paletteMoveRef = useRef<(kind: PaletteKind, clientX: number, clientY: number) => void>(() => {});
  const paletteDropRef = useRef<(kind: PaletteKind, clientX: number, clientY: number) => void>(() => {});
  /** First endpoint of a tether, waiting for the second entity pick. */
  const [pendingTether, setPendingTether] = useState<{
    kind: Extract<PaletteKind, "together" | "apart">;
    from: string;
  } | null>(null);
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
  /** Explicit edit destination inside the selected Beat; preview is separate. */
  const [editingBeatVariant, setEditingBeatVariant] = useState<string | null>(null);
  /** Last preview chip focused; A/D may use it without changing edit destination. */
  const [focusedBeat, setFocusedBeat] = useState<string | null>(null);
  /** The debuff mech whose deal is open in the popup, if any. */
  const [debuffFor, setDebuffFor] = useState<string | null>(null);
  /** The fights the debuff library holds, so the encounter field names one. */
  const [fightLibrary, setFightLibrary] = useState<FightLibraryEntry[]>([]);
  const stageBox = useRef<HTMLDivElement>(null);
  const clipboard = useRef<EntityClipboard | null>(null);
  /** The freshest plan, for handlers that fire faster than React re-renders. */
  const planRef = useRef<Plan | null>(null);
  planRef.current = plan;
  /** The last server-confirmed document, beneath any in-flight local edits. */
  const serverPlanRef = useRef<Plan | null>(null);
  /** A cached undo/redo destination held above late socket echoes until acked. */
  const pendingHistoryPlan = useRef<{ token: symbol; plan: Plan } | null>(null);
  const pendingEntityEdits = useRef<{ token: symbol; ops: Op[] }[]>([]);
  /** Preserve the order gestures were made in, even if fetches would race. */
  const mutationTail = useRef<Promise<void>>(Promise.resolve());
  /** Wheel notches land far faster than a round trip, so they are pooled. */
  const pendingResize = useRef<{
    ids: string[];
    factor: number;
    what: "size" | "opacity";
    /** The token the pointer was on, which the party's one size follows. */
    lead: string;
  } | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const historyRefreshTimer = useRef<number | null>(null);
  /** Stable for this browser tab, so edits are automatically grouped as one work session. */
  const editSession = useRef("");
  if (!editSession.current) {
    const key = `raidplan:work-session:${planId}`;
    editSession.current = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, editSession.current);
  }

  const showServerPlan = useCallback((state: Plan) => {
    const incoming = hydratePlan(state);
    // Fetch responses and socket broadcasts can cross in flight.
    if (!serverPlanRef.current || incoming.rev >= serverPlanRef.current.rev)
      serverPlanRef.current = incoming;
    let visible = serverPlanRef.current;
    if (pendingHistoryPlan.current) {
      visible = hydratePlan({
        ...pendingHistoryPlan.current.plan,
        rev: Math.max(pendingHistoryPlan.current.plan.rev, visible.rev + 1),
      });
    }
    // Optimistic operations contain no server-generated IDs, so they are safe
    // to replay over broadcasts until their own request is acknowledged.
    for (const pending of pendingEntityEdits.current) {
      for (const op of pending.ops) {
        try {
          // The operation's own socket broadcast can beat its HTTP response.
          // A client-ID add is already in that broadcast, so replay only the
          // still-missing optimistic copy instead of duplicating the entity.
          if (
            op.op === "add_entity" &&
            typeof op.spec.id === "string" &&
            (visible.entities.some((entity) => entity.id === op.spec.id) ||
              visible.steps.some((step) =>
                Object.values(step.variantScenes ?? {}).some((scene) =>
                  scene.some((entity) => entity.id === op.spec.id)
                ) || Object.values(step.beatVariantContent ?? {}).some((content) =>
                  content.parts.some((entity) => entity.id === op.spec.id)
                )
              ))
          ) continue;
          if (op.op === "add_mech" && op.id && visible.mechs.some((beat) => beat.id === op.id))
            continue;
          visible = applyOp(visible, op).plan;
        } catch {
          // A collaborator may have removed the target first. The request's
          // eventual response remains authoritative.
        }
      }
    }
    planRef.current = visible;
    setPlan(visible);
  }, []);

  useAgent({
    agent: "plan-agent",
    name: planId,
    onStateUpdate: (state: Plan) => {
      if (state?.id) {
        showServerPlan(state);
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
        showServerPlan(res.plan);
        setRole(res.role);
        setIsPublic(res.meta?.isPublic ?? false);
        return api.history(planId);
      })
      .then(setHistory)
      .catch((e) => setError(e.message));
  }, [planId, showServerPlan]);

  useEffect(
    () => () => {
      if (historyRefreshTimer.current !== null) window.clearTimeout(historyRefreshTimer.current);
    },
    []
  );

  const editable = role !== "viewer";
  const step = plan?.steps[Math.min(stepIndex, (plan?.steps.length ?? 1) - 1)];

  const run = useCallback(
    async (ops: Op | Op[], expandSymmetry = true) => {
      let optimisticToken: symbol | null = null;
      try {
        const current = planRef.current;
        const viewedStepId = step?.id;
        const viewedStep = viewedStepId
          ? current?.steps.find((candidate) => candidate.id === viewedStepId)
          : undefined;
        const viewedMechanic = viewedStep?.mechanic
          ? current?.mechanics.find((candidate) => candidate.id === viewedStep.mechanic)
          : undefined;
        const viewedBeat = current?.variantModel === "beat"
          ? current.mechs.find((candidate) => candidate.id === mech)
          : undefined;
        const beatEdit =
          viewedStepId &&
          viewedBeat?.variants.some((variant) => variant.id === editingBeatVariant) &&
          mechSpan(current!, viewedBeat).includes(viewedStepId)
            ? editingBeatVariant ?? undefined
            : undefined;
        const viewedVariant = current?.variantModel === "beat"
          ? beatEdit
          : viewedMechanic?.variants.length
            ? (viewedMechanic.variants.find((variant) => variant.id === shown[viewedMechanic.id]) ??
                viewedMechanic.variants[0]).id
            : undefined;
        // Beat Variant content is explicitly Step-scoped even if the shared
        // editor scope says every Step. Selecting the Beat tab edits Shared.
        const activeStepId =
          current?.variantModel === "beat" && viewedVariant
            ? viewedStepId
            : scope === "step"
              ? viewedStepId
              : undefined;
        const activeVariant =
          current?.variantModel === "beat"
            ? viewedVariant
            : scope === "step"
              ? viewedVariant
              : undefined;
        const sceneOps = new Set([
          "add_entity",
          "update_entity",
          "clear_override",
          "delete_entities",
          "duplicate_entity",
          "reorder_entity",
          "assign_mech",
          "arrange_party",
        ]);
        const markerIds = new Set(
          current?.entities.filter((entity) => entity.type === "marker").map((entity) => entity.id)
        );
        const baseIds = new Set(current?.entities.map((entity) => entity.id));
        const localOnlyIds = new Set(
          current && viewedStepId && viewedVariant
            ? (current.variantModel === "beat"
                ? composeBeatVariantEntities(
                    current,
                    viewedStepId,
                    viewedBeat ? { ...shown, [viewedBeat.id]: viewedVariant } : shown
                  ).entities
                : authoredEntitiesForStep(current, viewedStepId, viewedVariant))
                .filter((entity) => !baseIds.has(entity.id))
                .map((entity) => entity.id)
            : []
        );
        const contextual = (Array.isArray(ops) ? ops : [ops]).flatMap((op): Op[] => {
          if (!sceneOps.has(op.op)) return [op];
          // Waymarks are plan-wide even while the editor is in step scope.
          if (op.op === "add_entity" && op.spec.type === "marker") return [op];
          if (
            (op.op === "update_entity" ||
              op.op === "clear_override" ||
              op.op === "duplicate_entity" ||
              op.op === "reorder_entity") &&
            markerIds.has(op.id)
          ) return [op];
          const sceneStepId = activeStepId ?? viewedStepId;
          const sceneVariant = activeVariant ?? viewedVariant;
          const forceLocal = (id: string) =>
            !!sceneStepId && !!sceneVariant && localOnlyIds.has(id);
          if (op.op === "delete_entities" || op.op === "assign_mech") {
            const markers = op.ids.filter((id) => markerIds.has(id));
            const local = op.ids.filter(
              (id) => !markerIds.has(id) && (!!activeStepId || forceLocal(id))
            );
            const shared = op.ids.filter(
              (id) => !markerIds.has(id) && !local.includes(id)
            );
            return [
              ...(markers.length || shared.length ? [{ ...op, ids: [...markers, ...shared] }] : []),
              ...(local.length
                ? [{ ...op, ids: local, stepId: sceneStepId, variant: sceneVariant }]
                : []),
            ];
          }
          if (
            (op.op === "update_entity" ||
              op.op === "clear_override" ||
              op.op === "duplicate_entity" ||
              op.op === "reorder_entity") &&
            forceLocal(op.id)
          )
            return [{ ...op, stepId: sceneStepId, variant: sceneVariant } as Op];
          if (!activeStepId || !activeVariant) return [op];
          return [{ ...op, stepId: activeStepId, variant: activeVariant } as Op];
        });
        const contextualScene = contextual.find(
          (op) => "stepId" in op && "variant" in op && op.stepId && op.variant
        ) as (Op & { stepId: string; variant: string }) | undefined;
        const editPlan =
          current && contextualScene
            ? {
                ...current,
                entities:
                  current.variantModel === "beat"
                    ? composeBeatVariantEntities(current, contextualScene.stepId, shown).entities
                    : authoredEntitiesForStep(
                        current,
                        contextualScene.stepId,
                        contextualScene.variant
                      ),
              }
            : current;
        const currentRevision = historyRef.current?.currentId;
        if (serverPlanRef.current && currentRevision)
          historyPlans.current.set(currentRevision, hydratePlan(serverPlanRef.current));
        const symmetricCount = symmetryCount === 2 ? 2 : 4;
        const expanded = contextual.flatMap((op): Op[] => {
          if (
            op.op === "add_entity" &&
            expandSymmetry &&
            symmetryCount > 1 &&
            typeof op.spec.x === "number" &&
            typeof op.spec.y === "number" &&
            !op.spec.anchor &&
            !op.spec.bond &&
            op.spec.type !== "tether"
          )
            return makeSymmetricAdds(op.spec, symmetryKind, symmetricCount).map((made) => ({
              ...made,
              stepId: op.stepId,
              variant: op.variant,
            }));
          if (op.op === "update_entity" && editPlan && expandSymmetry && symmetryCount > 1)
            return symmetricUpdates(
              editPlan,
              op,
              symmetryKind,
              symmetricCount,
              entitiesForStep(editPlan, step?.id, undefined, shown)
            );
          if (op.op === "delete_entities" && editPlan && expandSymmetry && symmetryCount > 1)
            return [{ ...op, ids: symmetryIds(editPlan, op.ids) }];
          if (op.op === "assign_mech" && editPlan && expandSymmetry && symmetryCount > 1)
            return [{ ...op, ids: symmetryIds(editPlan, op.ids) }];
          return [op];
        }).map((op): Op =>
          op.op === "add_entity" && typeof op.spec.id !== "string"
            ? {
                ...op,
                // Caller-provided IDs make creation just as optimistic as a
                // move or delete. The preview can become the real entity in
                // the same paint instead of vanishing for a round trip.
                spec: { ...op.spec, id: `${op.spec.type}_${crypto.randomUUID()}` },
              }
            : op
        );
        // See OPTIMISTIC_OPS for the release contract these ops follow.
        const optimistic = expanded.every(
          (op) =>
            OPTIMISTIC_OPS.has(op.op) ||
            (op.op === "add_entity" && typeof op.spec.id === "string") ||
            (op.op === "add_mech" && typeof op.id === "string")
        );
        if (optimistic && current) {
          optimisticToken = Symbol("entity edit");
          pendingEntityEdits.current.push({ token: optimisticToken, ops: expanded });
          let visible = current;
          for (const op of expanded) visible = applyOp(visible, op).plan;
          planRef.current = visible;
          setPlan(visible);
        }
        const request = mutationTail.current.then(() =>
          api.ops(planId, expanded, editSession.current)
        );
        mutationTail.current = request.then(
          () => undefined,
          () => undefined
        );
        const res = await request;
        if (optimisticToken)
          pendingEntityEdits.current = pendingEntityEdits.current.filter(
            (edit) => edit.token !== optimisticToken
          );
        showServerPlan(res.plan);
        if (res.history.currentId)
          historyPlans.current.set(res.history.currentId, hydratePlan(res.plan));
        historyRef.current = res.history;
        setHistory(res.history);
        return res;
      } catch (e) {
        if (optimisticToken) {
          pendingEntityEdits.current = pendingEntityEdits.current.filter(
            (edit) => edit.token !== optimisticToken
          );
          if (serverPlanRef.current) showServerPlan(serverPlanRef.current);
        }
        setError((e as Error).message);
        throw e;
      }
    },
    [planId, scope, symmetryCount, symmetryKind, shown, step?.id, showServerPlan, mech, editingBeatVariant]
  );

  const travelHistory = useCallback(
    async (direction: "undo" | "redo" | "revert", revisionId?: string) => {
      if (historyBusy) return;
      setHistoryBusy(true);
      const before = planRef.current;
      const known = historyRef.current;
      const targetId =
        direction === "undo" ? known?.undoId : direction === "redo" ? known?.redoId : revisionId;
      const cached = targetId ? historyPlans.current.get(targetId) : undefined;
      const historyToken = cached ? Symbol("history travel") : null;
      if (before && cached) {
        // History snapshots keep their original revision number. Rebase the
        // cached contents over the current document so an in-flight socket
        // update cannot mistake this intentional transition for stale state.
        const optimistic = hydratePlan({ ...cached, rev: before.rev + 1 });
        pendingHistoryPlan.current = { token: historyToken!, plan: optimistic };
        planRef.current = optimistic;
        setPlan(optimistic);
      }
      try {
        const res =
          direction === "undo"
            ? await api.undo(planId)
            : direction === "redo"
              ? await api.redo(planId)
              : await api.revert(planId, revisionId!, editSession.current);
        if (historyToken && pendingHistoryPlan.current?.token === historyToken)
          pendingHistoryPlan.current = null;
        showServerPlan(res.plan);
        if (res.history.currentId)
          historyPlans.current.set(res.history.currentId, hydratePlan(res.plan));
        historyRef.current = res.history;
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
        if (historyToken && pendingHistoryPlan.current?.token === historyToken)
          pendingHistoryPlan.current = null;
        if (cached && serverPlanRef.current) showServerPlan(serverPlanRef.current);
        setError((e as Error).message);
      } finally {
        setHistoryBusy(false);
      }
    },
    [historyBusy, planId, showServerPlan]
  );

  /** Canvas authoring modes: 1/2/3 choose the coverage; Q changes the transform. */
  useEffect(() => {
    if (!editable) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.repeat) return;
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
   * Deleting one box of a split. A Step's boxes only ever come as a pair, so
   * dropping one is the same act as ending the branch: what the surviving box
   * authored becomes the Step's Shared reading, which is why the confirm names
   * both sides rather than only the doomed one.
   */
  const deleteStepVariantBox = useCallback(
    (variantId: string) => {
      const owner = plan?.variantModel === "step" ? stepVariantOwner(plan, variantId) : undefined;
      const sibling = owner
        ? stepVariants(owner.step).find((variant) => variant.id !== variantId)
        : undefined;
      if (!owner || !sibling) return;
      const beats = owner.variant.beats.length;
      if (
        !window.confirm(
          `Delete ${stepVariantLabel(owner.step, variantId)}${beats ? ` and the ${beats} Beat${beats === 1 ? "" : "s"} inside it` : ""}? ${stepVariantLabel(owner.step, sibling.id)} becomes Shared at every Step. This can be undone from history.`
        )
      )
        return;
      // The destination only falls back to Shared once the box is really gone.
      void run({ op: "collapse_step_variants", stepId: owner.step.id, variantId: sibling.id })
        .then(() => setEditingBeatVariant(null))
        .catch(() => undefined);
    },
    [plan, run]
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
      const key = ev.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        ev.preventDefault();
        const redo = key === "y" || (key === "z" && ev.shiftKey);
        void travelHistory(redo ? "redo" : "undo");
        return;
      }
      if (!mod && (ev.key === "Delete" || ev.key === "Backspace")) {
        if (selection.length) {
          ev.preventDefault();
          setSelected(null);
          void run({ op: "delete_entities", ids: selection });
          return;
        }
        // Nothing on the canvas is selected, so the key falls through to the
        // other thing a click can select: the Variant box being edited.
        if (plan?.variantModel !== "step" || !editingBeatVariant) return;
        ev.preventDefault();
        deleteStepVariantBox(editingBeatVariant);
        return;
      }
      // Escape steps back out to Shared, so the edit destination is never a
      // state you can only leave by clicking the right box again.
      if (!mod && ev.key === "Escape" && editingBeatVariant) {
        ev.preventDefault();
        setEditingBeatVariant(null);
        return;
      }
      if (mod && ev.key.toLowerCase() === "c") {
        const currentStep = plan && step ? plan.steps.find((candidate) => candidate.id === step.id) : undefined;
        const currentMechanic = currentStep?.mechanic
          ? plan?.mechanics.find((candidate) => candidate.id === currentStep.mechanic)
          : undefined;
        const currentVariant = plan?.variantModel === "beat"
          ? editingBeatVariant ?? undefined
          : currentMechanic?.variants.length
            ? (currentMechanic.variants.find((variant) => variant.id === shown[currentMechanic.id]) ??
                currentMechanic.variants[0]).id
            : undefined;
        const e = plan && step
          ? (plan.variantModel === "beat"
              ? composeBeatVariantEntities(plan, step.id, shown).entities
              : authoredEntitiesForStep(plan, step.id, currentVariant)
            ).find((entity) => entity.id === selected)
          : plan?.entities.find((entity) => entity.id === selected);
        if (!e) return;
        // Waymarks are encounter setup, while baits/tethers are relationships
        // owned by the thing they are assigned to. Neither is a sensible
        // standalone clipboard root.
        if (e.type === "marker" || e.anchor || e.type === "tether") {
          clipboard.current = null;
          setNote(
            e.type === "marker"
              ? "Floor markers cannot be copied"
              : "Copy a bait source or target to include its assigned baits"
          );
          return;
        }
        // Copy what is authored in the view the user is looking at. Reading the
        // raw entity here loses step/variant edits (most visibly its colour).
        // A displayed family/mech colour is materialized too, so moving the
        // twin into another mechanic does not silently repaint it.
        const displayed = new Map(
          entitiesForStep(plan!, step?.id, undefined, shown).map((candidate) => [candidate.id, candidate])
        );
        const snapshot = (candidate: Entity): ClipboardEntity => {
          const authored = resolveEntity(plan!, candidate, step?.id, playing);
          const {
            id: _id,
            overrides: _overrides,
            symmetry: _symmetry,
            bond: _bond,
            ...rest
          } = authored;
          return {
            ...rest,
            ...(displayed.get(candidate.id)?.color
              ? { color: displayed.get(candidate.id)!.color }
              : {}),
          } as ClipboardEntity;
        };
        const assigned = plan!.entities.filter(
          (candidate) =>
            candidate.id !== e.id &&
            ((candidate.anchor &&
              (candidate.anchor.to === e.id ||
                candidate.anchor.from === e.id ||
                candidate.anchor.near === e.id)) ||
              (candidate.type === "tether" &&
                (candidate.from === e.id || candidate.to === e.id)))
        );
        clipboard.current = {
          sourceId: e.id,
          root: snapshot(e),
          assigned: assigned.map(snapshot),
        };
        setNote(
          `Copied ${e.name || e.type}${assigned.length ? ` with ${assigned.length} assigned bait${assigned.length === 1 ? "" : "s"}` : ""}`
        );
        return;
      }
      if (mod && ev.key.toLowerCase() === "v") {
        const copied = clipboard.current;
        if (!copied) return;
        ev.preventDefault();
        void (async () => {
          const spec = copied.root;
          // A paste is the same authored object, nudged enough to reveal the
          // twin. Assigned baits keep their own anchor offsets and instead have
          // every reference to the clipboard root rewritten to the new root.
          const where = {
            x: (typeof spec.x === "number" ? spec.x : 0) + 60,
            y: (typeof spec.y === "number" ? spec.y : 0) + 60,
          };
          const freshId = (kind: string) => `${kind}_${crypto.randomUUID()}`;
          const rootId = freshId(spec.type);
          const remap = (child: ClipboardEntity): ClipboardEntity => {
            if (child.type === "tether")
              return {
                ...child,
                from: child.from === copied.sourceId ? rootId : child.from,
                to: child.to === copied.sourceId ? rootId : child.to,
              } as ClipboardEntity;
            if (!child.anchor) return child;
            return {
              ...child,
              anchor: {
                ...child.anchor,
                ...(child.anchor.to === copied.sourceId ? { to: rootId } : {}),
                ...(child.anchor.from === copied.sourceId ? { from: rootId } : {}),
                ...(child.anchor.near === copied.sourceId ? { near: rootId } : {}),
              },
            } as ClipboardEntity;
          };
          const stamp = (entity: ClipboardEntity, id: string) => ({
            ...entity,
            id,
            declaredIn: step!.id,
            ...(mech ? { mech } : {}),
          });
          await run(
            [
              { op: "add_entity", spec: stamp({ ...spec, ...where }, rootId) as never },
              ...copied.assigned.map((child) => ({
                op: "add_entity" as const,
                spec: stamp(remap(child), freshId(child.type)) as never,
              })),
            ],
            false
          );
          setSelected(rootId);
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    editable,
    selected,
    selection,
    plan,
    run,
    travelHistory,
    shown,
    editingBeatVariant,
    deleteStepVariantBox,
    step,
    mech,
  ]);

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
      const active = activeStepVariants(plan, plan.steps[here].id, shown);
      const target =
        active.find(({ step }) => stepVariants(step).some((variant) => variant.beats.includes(mech ?? "")))?.step ??
        active.find(({ ownerStepId }) => ownerStepId === focusedBeat)?.step ??
        (active.length === 1 ? active[0].step : undefined);
      if (!target) {
        if (active.length > 1) setNote("Choose a varying Beat before using A/D");
        return;
      }
      ev.preventDefault();
      setGlide((n) => n + 1);
      setOnward(false);
      setFocusedBeat(target.id);
      const variants = stepVariants(target);
      const currentSelection = active.find(({ ownerStepId }) => ownerStepId === target.id)?.variant.id;
      const at = variants.findIndex(
        (variant) => variant.id === (shown[target.id] ?? currentSelection)
      );
      const from = at < 0 ? 0 : at;
      const to =
        (from + (key === "d" ? 1 : -1) + variants.length) % variants.length;
      const next = variants[to].id;
      setShown((was) => ({ ...was, [target.id]: next }));
      // Once an author has selected this Beat, A/D means "select the other
      // exclusive box", not "preview elsewhere while edits stay behind".
      // With no selected Beat it remains a viewer-safe preview shortcut.
      setEditingBeatVariant(next);
      const selectedBeat = plan.mechs.find((beat) => beat.id === mech);
      if (selectedBeat && !variants[to].beats.includes(selectedBeat.id)) setMech(null);
      return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plan, stepIndex, shown, mech, focusedBeat]);

  /**
   * Filling only applies while the selected mech is on the current step. Its
   * existing snapshot-to-explosion span is inclusive, so either boundary stays
   * selected; walking beyond it finishes filling instead of filing new drops
   * into a mech that is no longer on screen.
   */
  const selectedMech = plan?.mechs.find((candidate) => candidate.id === mech) ?? null;
  const selectedMechIsHere = !!(
    plan &&
    step &&
    selectedMech &&
    mechSpan(plan, selectedMech).includes(step.id)
  );
  useEffect(() => {
    if (mech && plan && step && !selectedMechIsHere) {
      setMech(null);
      setEditingBeatVariant(null);
    }
  }, [mech, plan, step, selectedMechIsHere]);

  // The library is small and shared; one read per editor keeps the encounter
  // field able to say which fight it lands on.
  useEffect(() => {
    let live = true;
    void api
      .debuffLibrary()
      .then((entries) => live && setFightLibrary(entries))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** The library fight this plan's encounter name resolves to, if any. */
  const encounterFight = fightForEncounter(fightLibrary, plan?.encounter);

  if (error && !plan) return <div className="p-8 text-red-400">{error}</div>;
  if (!plan || !step) return <div className="p-8 text-ink-400">Loading plan…</div>;

  /** The mech slot currently open, if it exists and covers this step. */
  const openMech = selectedMechIsHere ? selectedMech : null;
  /** The debuff deal open in the popup, if that mech still exists. */
  const debuffMech = plan.mechs.find((m) => m.id === debuffFor) ?? null;
  /** What the party wears in this step, if a debuff mech is on the floor. */
  const dress = debuffDress(plan, step.id, shown);

  /**
   * The reading of this step's mechanic that is being played, if it goes more
   * than one way. It is what the canvas resolves positions through, and where
   * a drag on this step lands.
   */
  const authoredScene =
    plan.variantModel === "step"
      ? composeStepVariantEntities(plan, step.id, shown).entities
      : authoredEntitiesForStep(plan, step.id);
  // Legacy scene addressing is retired. Step Variant actor movement is routed
  // explicitly below rather than through the old whole-scene `variant` arg.
  const playing = undefined;
  const selectedEntity = authoredScene.find((entity) => entity.id === selected) ?? null;
  const activeStepPreviews = activeStepVariants(plan, step.id, shown);
  const movementConflicts =
    plan.variantModel === "step"
      ? composeStepVariantEntities(plan, step.id, shown).conflicts
      : [];
  const editingVariantOwner = editingBeatVariant
    ? stepVariantOwner(plan, editingBeatVariant)
    : undefined;
  // A Variant edit destination only holds on the Steps its split actually
  // reaches. Carried past them it would file an ordinary drag as that box's
  // movement, and a box counts as present wherever it owns movement — so the
  // stray pose then pins the actor there and swallows every later drag.
  const editingVariant =
    editingVariantOwner && stepVariantSetIncludes(plan, editingVariantOwner.step, step.id)
      ? editingVariantOwner.variant.id
      : undefined;

  /** Pointer position, in arena units, from a point over the stage. */
  function arenaPointAt(clientX: number, clientY: number): { x: number; y: number } {
    const box = stageBox.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const scale = viewScale(plan!.arena, box.width);
    return {
      x: Math.round((clientX - box.left - box.width / 2) / scale),
      y: Math.round((clientY - box.top - box.height / 2) / scale),
    };
  }

  const arenaPoint = (ev: React.DragEvent) => arenaPointAt(ev.clientX, ev.clientY);

  /** An enemy source under the drop point: boss, add, or bare bait anchor. */
  function sourceAt(pt: { x: number; y: number }): string | undefined {
    return entitiesForStep(plan!, step!.id, undefined, shown).find(
      (e) =>
        e.type === "enemy" &&
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
   * Scrolling over something resizes it (or changes a tether's range). The wheel outruns the server, so the
   * notches are multiplied together and sent as one edit a moment later — and
   * it is the real dimensions that change, not `scale`, so the plan keeps
   * saying how big the thing is.
   */
  function resize(requestedIds: string[], factor: number, what: "size" | "opacity" = "size") {
    const current = planRef.current;
    if (!current) return;
    const editableScene =
      scope === "step" && playing
        ? authoredEntitiesForStep(current, step!.id, playing)
        : current.entities;
    const requested = new Set(requestedIds);
    const bonds = new Set(
      editableScene
        .filter((entity) => requested.has(entity.id) && entity.bond)
        .map((entity) => entity.bond!.id)
    );
    // The party is drawn at one size: a token is a person, and one person
    // bigger than another says something the plan does not mean. So sizing any
    // player sizes them all, whichever one the pointer happened to be over.
    const party =
      what === "size" &&
      editableScene.some((entity) => entity.type === "player" && requested.has(entity.id));
    // Preserve bonded-set behavior inside a multi-selection. Scene order keeps
    // the pooled gesture key stable when the pointer crosses selected faces.
    const ids = editableScene
      .filter(
        (entity) =>
          requested.has(entity.id) ||
          (entity.bond && bonds.has(entity.bond.id)) ||
          (party && entity.type === "player")
      )
      .map((entity) => entity.id);
    if (!ids.length) return;
    // Pointing somewhere else mid-spin: land what is owed before starting again.
    if (
      pendingResize.current &&
      (pendingResize.current.ids[0] !== ids[0] || pendingResize.current.what !== what)
    )
      flushResize();
    const carried = pendingResize.current?.factor ?? 1;
    pendingResize.current = { ids, factor: carried * factor, what, lead: requestedIds[0] };
    if (resizeTimer.current === null) resizeTimer.current = window.setTimeout(flushResize, 90);
  }

  function flushResize() {
    if (resizeTimer.current !== null) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = null;
    const job = pendingResize.current;
    const current = planRef.current;
    pendingResize.current = null;
    if (!job || !current) return;
    const editableScene =
      scope === "step" && playing
        ? authoredEntitiesForStep(current, step!.id, playing)
        : current.entities;
    // What the party lands on: the wheeled token's new size, copied onto every
    // other player so the spin unifies them instead of scaling each one apart.
    const lead = editableScene.find((x) => x.id === job.lead);
    const partySize =
      job.what === "size" && lead?.type === "player"
        ? (resizeSpec(lead, job.factor).size as number | undefined)
        : undefined;
    const edits = job.ids.flatMap((id) => {
      const e = editableScene.find((x) => x.id === id);
      if (!e) return [];
      if (partySize !== undefined && e.type === "player")
        return e.size === partySize ? [] : [{ op: "update_entity" as const, id, patch: { size: partySize } }];
      // Opacity is one number on everything; size is whatever meaningful
      // dimension the entity has (the required range for a tether). Either way
      // the wheel says "by this much", never "to this".
      const patch =
        job.what === "opacity"
          ? { opacity: Math.min(1, Math.max(0.05, Math.round(e.opacity * job.factor * 100) / 100)) }
          : resizeSpec(e, job.factor);
      return Object.keys(patch).length ? [{ op: "update_entity" as const, id, patch }] : [];
    });
    if (edits.length) void run(edits);
  }

  /** The sets this group holds in the mechanic currently being filled. */
  function bondsOf(group: GroupId): { id: string; label: string; ids: string[] }[] {
    const out = new Map<string, { id: string; label: string; ids: string[] }>();
    for (const e of authoredScene) {
      // A group card is part of the current authoring context. Showing bonds
      // from other mechs here made their remove controls appear to belong to
      // whichever mech happened to be open.
      if (e.bond?.group !== group || e.mech !== openMech?.id) continue;
      const seen = out.get(e.bond.id) ?? { id: e.bond.id, label: e.bond.label ?? "set", ids: [] };
      seen.ids.push(e.id);
      out.set(e.bond.id, seen);
    }
    return [...out.values()];
  }

  async function placeSource(kind: PaletteSourceKind, x: number, y: number) {
    const matching = authoredScene.filter(
      (e) =>
        e.type === "enemy" &&
        (kind === "anchor"
          ? e.role === "anchor"
          : e.role !== "anchor" && e.icon === `actor/enemy_${kind === "boss" ? "large" : "medium"}`)
    ).length;
    const name = kind === "anchor" ? `anchor ${matching + 1}` : `${kind} ${matching + 1}`;
    // A boss and its adds are the cast: they are there all fight. An anchor is
    // not a creature but a place a mechanic fires from, so it is a Part and
    // lives in a Beat — left unnamed, because whatever is baited off it says
    // what the Beat is far better than "bait anchor" does.
    const beat = kind === "anchor" ? beatForDrop("") : undefined;
    const res = await run([
      ...(beat?.ops ?? []),
      {
        op: "add_entity",
        spec: paletteSpec(kind, { x, y, name, ...stamp(beat) }) as never,
      },
    ]);
    const created = res.values[beat?.ops.length ?? 0] as { id: string } | null;
    if (created) setSelected(created.id);
    return created?.id;
  }

  /**
   * What an aimed mechanic comes out of when you drop it on a group: the boss,
   * failing that any object already on the floor. Nothing at all means one has
   * to be made — a protean has to be thrown from somewhere.
   */
  function enemyForAimed(): Entity | undefined {
    const enemies = authoredScene.filter((e) => e.type === "enemy");
    return (
      enemies.filter((e) => e.role !== "anchor").sort((a, b) => b.size - a.size)[0] ?? enemies[0]
    );
  }

  /**
   * The source a drop fires from, as ops in the drop's own batch: an existing
   * object, an anchor placed in the middle when the floor is empty, or one
   * already there that nothing had claimed. Either way it ends up in the Beat
   * the shapes go into, so the thing they come out of is on the floor for
   * exactly as long as they are, and goes when the Beat goes.
   */
  function sourceInBeat(
    host: Entity | undefined,
    beat: { mech: string }
  ): { id: string; ops: Op[] } {
    if (host)
      return {
        id: host.id,
        ops:
          host.type === "enemy" && host.role === "anchor" && !host.mech
            ? [{ op: "assign_mech", ids: [host.id], mechId: beat.mech }]
            : [],
      };
    const id = `enemy_${crypto.randomUUID()}`;
    const matching = authoredScene.filter((e) => e.type === "enemy" && e.role === "anchor").length;
    return {
      id,
      ops: [
        {
          op: "add_entity",
          spec: paletteSpec("anchor", {
            id,
            x: 0,
            y: 0,
            name: `anchor ${matching + 1}`,
            ...stamp(beat),
          }) as never,
        },
      ],
    };
  }

  /**
   * Any drawable entity under a tether drop. Prefer the smallest hit so a
   * token or add remains reachable when it is standing inside a large AoE.
   * Existing tethers cannot be endpoints: their own x/y is only a schema
   * fallback, not a meaningful place on the floor.
   */
  function tetherEndAt(pt: { x: number; y: number }): string | undefined {
    return entitiesForStep(plan!, step!.id, undefined, shown)
      // A counted bait's extra shapes are drawn, not authored: a tether cannot
      // be tied to one of them, only to the bait itself.
      .filter((entity) => !isFanCopy(entity.id))
      .filter((entity) => entity.type !== "tether")
      .map((entity) => {
        const radius =
          entity.type === "zone"
            ? entity.shape === "rect" || entity.shape === "line" || entity.shape === "knockback" || entity.shape === "arrow"
              ? Math.max(entity.width, entity.length) / 2
              : entity.radius
            : entity.type === "text"
              ? entity.fontSize
              : entity.type === "path"
                ? Math.max(40, entity.width)
                : entity.type === "enemy"
                  ? entity.size
                  : entity.size / 2;
        const scaled = radius * entity.scale;
        return {
          id: entity.id,
          hit: Math.hypot(entity.x - pt.x, entity.y - pt.y) <= scaled,
          area: Math.PI * scaled * scaled,
        };
      })
      .filter((candidate) => candidate.hit)
      .sort((a, b) => a.area - b.area)[0]?.id;
  }

  /** Zone shape each mechanic tile lands as — used to count what a source has. */
  const SHAPE_OF: Record<PaletteMechanicKind, string> = {
    circle: "circle",
    donut: "donut",
    protean: "cone",
    beam: "rect",
    stack8: "stack",
    stack4: "stack",
    stack2: "stack",
    linestack: "linestack",
    flare: "flare",
    together: "tether",
    apart: "tether",
  };

  /**
   * Pair supports with damagers in party-list order. With the standard slots
   * this is MT-M1, OT-M2, H1-R1, H2-R2; custom parties still get a stable,
   * editable one-to-one assignment rather than a geometry-dependent one.
   */
  function crossRolePairs(): [PlayerEntity, PlayerEntity][] {
    const supports = membersOf("supports");
    const damagers = membersOf("damagers");
    return supports.slice(0, Math.min(supports.length, damagers.length)).map((support, i) => [support, damagers[i]]);
  }

  /**
   * A palette item let go over the arena. What it becomes is decided entirely by
   * what it landed on: bare floor makes a shape you move yourself, a group makes
   * one per person, and an enemy source makes a bait — a second of the same kind
   * on that source takes the second-closest player, and so on.
   */
  async function drop(kind: PaletteKind, pt: { x: number; y: number }, target: DropTarget) {
    if (isPaletteSource(kind)) {
      await placeSource(kind, pt.x, pt.y);
      return;
    }
    // Annotations never bind to what they land on: they just sit there.
    if (isPaletteCosmetic(kind)) {
      const beat = beatForDrop(PALETTE_LABEL[kind]);
      const res = await run([
        ...beat.ops,
        { op: "add_entity", spec: paletteSpec(kind, { x: pt.x, y: pt.y, ...stamp(beat) }) as never },
      ]);
      const created = res.values[beat.ops.length] as { id: string } | null;
      if (created) setSelected(created.id);
      return;
    }
    if (target.at === "group") {
      if (isPaletteTether(kind)) {
        if (target.group !== "supports" && target.group !== "damagers")
          return setError("Drop player tethers on Supports or Damagers");
        const pairs = crossRolePairs();
        if (!pairs.length) return setError("This step needs both supports and damagers to make tethers");
        const bond = {
          id: "bond_" + Math.random().toString(36).slice(2, 10),
          // Show the same set on both complementary group cards.
          group: target.group,
          label: PALETTE_LABEL[kind],
        };
        const beat = beatForDrop(PALETTE_LABEL[kind]);
        await run([
          ...beat.ops,
          ...pairs.map(([support, damager]) => ({
            op: "add_entity" as const,
            spec: {
              type: "tether" as const,
              from: support.id,
              to: damager.id,
              style: kind === "together" ? "close" as const : "far" as const,
              range: defaultTetherRange(kind),
              width: 8,
              name: `${PALETTE_LABEL[kind]}: ${support.name || jobLabel(support.job)} ↔ ${damager.name || jobLabel(damager.job)}`,
              bond,
              ...stamp(beat),
            },
          })),
        ]);
        setSelected(null);
        return;
      }
      const people = membersOf(target.group);
      if (!people.length) return setError(`No ${target.group} in this step to bind to`);
      // One drop, one thing — the eight shapes it draws are that thing's faces.
      const bond = {
        id: "bond_" + Math.random().toString(36).slice(2, 10),
        group: target.group,
        label: PALETTE_LABEL[kind],
      };
      const host = paletteNeedsSource(kind) ? enemyForAimed() : undefined;
      const beat = beatForDrop(PALETTE_LABEL[kind], host);
      const source = paletteNeedsSource(kind) ? sourceInBeat(host, beat) : undefined;
      const from = source?.id;
      await run([
        ...beat.ops,
        ...(source?.ops ?? []),
        ...people.map((p) => ({
          op: "add_entity" as const,
          spec: paletteBait(kind, p.id, from, {
            name: `${PALETTE_LABEL[kind]} on ${p.name || jobLabel(p.job)}`,
            bond,
            ...stamp(beat),
          }) as never,
        })),
      ]);
      setSelected(null);
      return;
    }
    if (target.at === "entity") {
      if (!isPaletteTether(kind)) return;
      setPendingTether({ kind, from: target.id });
      setSelected(target.id);
      setError("");
      return;
    }
    if (target.at === "source") {
      if (isPaletteTether(kind)) return setError("Drop this tether on its first object");
      // Two proteans off the same orb are one mechanic that hits two people, not
      // two mechanics each remembering its slot in the targeting. So a second
      // drop of the same kind on the same source raises that bait's count, and
      // you keep editing the one thing.
      const already = authoredScene.find(
        (e) =>
          e.type === "zone" &&
          e.shape === SHAPE_OF[kind] &&
          e.anchor?.pick &&
          (e.anchor.from === target.id || e.anchor.near === target.id)
      );
      if (already?.anchor) {
        if (already.anchor.count >= 8) return setError("A bait can cover at most eight targets");
        await run({
          op: "update_entity",
          id: already.id,
          patch: { anchor: { ...already.anchor, count: already.anchor.count + 1 } },
        });
        setSelected(already.id);
        return;
      }
      const host = authoredScene.find((e) => e.id === target.id);
      const beat = beatForDrop(PALETTE_LABEL[kind], host);
      const source = sourceInBeat(host, beat);
      const res = await run([
        ...beat.ops,
        ...source.ops,
        {
          op: "add_entity",
          spec: paletteBait(kind, { pick: "closest" }, source.id, {
            name: PALETTE_LABEL[kind],
            ...stamp(beat),
          }) as never,
        },
      ]);
      const created = res.values[beat.ops.length + source.ops.length] as { id: string } | null;
      if (created) setSelected(created.id);
      return;
    }
    if (isPaletteTether(kind)) return setError("Drop this tether on its first object");
    const beat = beatForDrop(PALETTE_LABEL[kind]);
    const res = await run([
      ...beat.ops,
      { op: "add_entity", spec: paletteSpec(kind, { x: pt.x, y: pt.y, ...stamp(beat) }) as never },
    ]);
    const created = res.values[beat.ops.length] as { id: string } | null;
    if (created) setSelected(created.id);
  }

  /** Finish the tether whose first endpoint was chosen by the palette drop. */
  async function finishTether(to: string) {
    const pending = pendingTether;
    if (!pending) return;
    const fromEntity = authoredScene.find((e) => e.id === pending.from && e.type !== "tether");
    const toEntity = authoredScene.find((e) => e.id === to && e.type !== "tether");
    if (!fromEntity || !toEntity) return setError("Choose an object for the other end of the tether");
    if (fromEntity.id === toEntity.id) return setError("Choose a different object for the other end");
    const endpointLabel = (entity: Entity) =>
      entity.name || (entity.type === "player" ? jobLabel(entity.job) : entity.type);
    setPendingTether(null);
    setError("");
    // The server accepts caller-provided entity IDs. Carrying one random ID in
    // both the optimistic and authoritative operation avoids remapping and
    // makes the tether visible without waiting for the network round trip.
    const id = `tether_${crypto.randomUUID()}`;
    setSelected(id);
    const beat = beatForDrop(PALETTE_LABEL[pending.kind]);
    const res = await run([
      ...beat.ops,
      {
        op: "add_entity",
        spec: {
          id,
          type: "tether",
          from: fromEntity.id,
          to: toEntity.id,
          style: pending.kind === "together" ? "close" : "far",
          range: defaultTetherRange(pending.kind),
          width: 8,
          name: `${PALETTE_LABEL[pending.kind]}: ${endpointLabel(fromEntity)} ↔ ${endpointLabel(toEntity)}`,
          ...stamp(beat),
        },
      },
    ]);
    const created = res.values[beat.ops.length] as { id: string } | null;
    if (created && created.id !== id) setSelected(created.id);
  }

  /** Palette tether thresholds are authored in yalms, whatever coordinates this plan stores. */
  function defaultTetherRange(kind: Extract<PaletteKind, "together" | "apart">): number {
    const calibration = arenaCalibration(plan!);
    return yalmsToArenaUnits(plan!.arena, PALETTE_TETHER_RANGE_YALMS[kind], calibration.widthYalms);
  }

  /**
   * The Beat a drop joins: the open one, or a new one made for it in this
   * step. Every Part lives in a Beat, and the Beat decides its timing, so a
   * drop with nothing open is one batch: the Beat, then what went into it.
   * The id is minted here so the batch is optimistic like any other add.
   */
  function beatForDrop(name: string, host?: Entity): { mech: string; ops: Op[] } {
    if (openMech) return { mech: openMech.id, ops: [] };
    // Dropped on an anchor that already lives in a Beat: the source and what
    // it throws are one mechanic, so they share one Beat and one timing rather
    // than drifting apart the moment either span is edited.
    if (host?.type === "enemy" && host.role === "anchor" && host.mech)
      return { mech: host.mech, ops: [] };
    const id = `mech_${crypto.randomUUID()}`;
    // Named after what went into it, so the rail reads "Circle", "Stack ×8".
    return { mech: id, ops: [{ op: "add_mech", id, name, snap: step!.id, plain: true }] };
  }

  /** What every drop carries: the step that declared it, and the Beat it joins. */
  function stamp(beat?: { mech: string }): PropBag {
    return { declaredIn: step!.id, ...(beat ? { mech: beat.mech } : {}) };
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
          variant:
            plan!.variantModel === "beat"
              ? editingVariant
              : scope === "step"
                ? playing
                : undefined,
        };
      })
    );
  }

  /** Reads the payload of a drop; ignores drags that did not start in the palette. */
  function kindOf(ev: React.DragEvent): PaletteKind | null {
    const k = ev.dataTransfer.getData("text/plain") as PaletteKind;
    return (PALETTE as readonly string[]).includes(k) ? k : null;
  }

  const previewEntities: Entity[] = (() => {
    if (!palettePreview || isPaletteTether(palettePreview.kind)) return [];
    const spec = paletteSpec(palettePreview.kind, {
      x: palettePreview.x,
      y: palettePreview.y,
      ...stamp(openMech ? { mech: openMech.id } : undefined),
    });
    const ops =
      symmetryCount > 1
        ? makeSymmetricAdds(
            spec,
            symmetryKind,
            symmetryCount as 2 | 4,
            "palette-preview"
          )
        : [{ op: "add_entity" as const, spec }];
    return ops.flatMap((op, index) => {
      if (!("spec" in op)) return [];
      const parsed = EntitySchema.safeParse({
        ...op.spec,
        id: `palette-preview-${index}`,
      });
      return parsed.success ? [parsed.data] : [];
    });
  })();

  /**
   * Palette gestures use pointer events instead of native HTML dragging. Native
   * dragging suppresses keydown in browsers, which made 1/2/3/Q unusable while
   * the preview was in hand. The refs keep a gesture started before a render
   * wired to the latest symmetry settings when it is finally released.
   */
  paletteMoveRef.current = (kind, clientX, clientY) => {
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const group = under?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup as GroupId | undefined;
    setHover(group && kind !== "anchor" && !isPaletteCosmetic(kind) ? group : null);
    const box = stageBox.current?.getBoundingClientRect();
    if (!box || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
      setPalettePreview(null);
      return;
    }
    const pt = arenaPointAt(clientX, clientY);
    setPalettePreview(sourceAt(pt) && !isPaletteCosmetic(kind) ? null : { kind, x: pt.x, y: pt.y });
  };

  paletteDropRef.current = (kind, clientX, clientY) => {
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const group = under?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup as GroupId | undefined;
    if (group && kind !== "anchor" && !isPaletteCosmetic(kind)) {
      void drop(kind, { x: 0, y: 0 }, { at: "group", group });
      return;
    }
    const box = stageBox.current?.getBoundingClientRect();
    if (!box || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return;
    const pt = arenaPointAt(clientX, clientY);
    const tetherEnd = isPaletteTether(kind) ? tetherEndAt(pt) : undefined;
    const on = sourceAt(pt);
    void drop(
      kind,
      pt,
      tetherEnd ? { at: "entity", id: tetherEnd } : on ? { at: "source", id: on } : { at: "free" }
    );
  };

  function beginPaletteDrag(kind: PaletteKind, ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0 || layer !== "step") return;
    ev.preventDefault();
    const { pointerId, clientX: startX, clientY: startY } = ev;
    let moved = false;
    setCarrying(kind);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) < 4) return;
      moved = true;
      paletteMoveRef.current(kind, next.clientX, next.clientY);
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      if (moved) paletteDropRef.current(kind, next.clientX, next.clientY);
      setCarrying(null);
      setPalettePreview(null);
      setHover(null);
    };
    const cancel = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setCarrying(null);
      setPalettePreview(null);
      setHover(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  return (
    <div className="relative flex h-full flex-col">
      <header className="panel flex flex-wrap items-center gap-3 border-x-0 border-t-0 px-3 py-2">
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
          list="encounter-fights"
          title={
            "The fight this plan is for — plans sharing it share their waymarks. " +
            (encounterFight
              ? `Statuses come from ${encounterFight.name}.`
              : "No fight in the debuff library answers to this name yet.")
          }
          value={plan.encounter}
          disabled={!editable}
          onChange={(e) => setPlan({ ...plan, encounter: e.target.value })}
          onBlur={(e) => run({ op: "set_meta", encounter: e.target.value })}
        />
        {/* The library's fights, so naming the encounter is also the act of
            choosing whose statuses the debuff Beats deal. */}
        <datalist id="encounter-fights">
          {fightLibrary.map((entry) => (
            <option key={entry.key} value={entry.name} />
          ))}
        </datalist>
        <span className="text-xs text-ink-400">
          rev {plan.rev} · {connected ? "live" : "offline"} · {role}
        </span>
        {editable && (
          <div className="flex shrink-0 items-center gap-1" aria-label="Edit history controls">
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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div
            className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-ink-600 bg-ink-900/70 p-0.5 shadow-inner"
            role="group"
            aria-label="Chips"
          >
            {(
              [
                {
                  which: "others" as const,
                  key: "C",
                  label: "Chips",
                  title:
                    "A leader and a chip in the margin for everything on the floor except the party. Click a chip to select it, shift-click to add (C)",
                },
                {
                  which: "party" as const,
                  key: "V",
                  label: "Party chips",
                  title:
                    "A leader and a chip in the margin for every party member. Click a chip to select it, shift-click to add (V)",
                },
              ]
            ).map((mode) => (
              <button
                key={mode.which}
                type="button"
                className={`flex items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-300 ${
                  chips[mode.which]
                    ? "bg-blue-500/25 font-semibold text-blue-100 shadow-sm"
                    : "text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                }`}
                title={mode.title}
                aria-pressed={chips[mode.which]}
                onClick={() => setChips((on) => ({ ...on, [mode.which]: !on[mode.which] }))}
              >
                <kbd className="text-[10px] font-normal text-ink-400">{mode.key}</kbd>
                <span>{mode.label}</span>
              </button>
            ))}
          </div>
          {editable && (
            <>
              <div
                className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-ink-600 bg-ink-900/70 p-0.5 shadow-inner"
                role="group"
                aria-label="Symmetry controls"
              >
                {([1, 2, 4] as const).map((count, index) => (
                  <button
                    key={count}
                    type="button"
                    className={`flex min-w-10 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-300 ${
                      symmetryCount === count
                        ? "bg-blue-500/25 font-semibold text-blue-100 shadow-sm"
                        : "text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                    }`}
                    title={`${count === 1 ? "Normal editing" : `${count}-way symmetry`} (${index + 1})`}
                    aria-label={`${index + 1}: ${count === 1 ? "normal" : `${count}-way`}`}
                    aria-pressed={symmetryCount === count}
                    onClick={() => setSymmetryCount(count)}
                  >
                    <kbd className="text-[10px] font-normal text-ink-400">{index + 1}</kbd>
                    <span>{count === 1 ? "Off" : `${count}×`}</span>
                  </button>
                ))}
                <span
                  className="ml-0.5 flex items-center border-l border-ink-600 pl-1.5 pr-1 text-[10px] text-ink-400"
                  aria-hidden="true"
                >
                  <kbd>Q</kbd>
                </span>
                {(
                  [
                    {
                      kind: "mirror" as const,
                      glyph: "↔",
                      label: symmetryCount > 1 ? "Mirror" : "Translate",
                      title:
                        symmetryCount > 1
                          ? "Mirrored symmetry — multi-select drags slide together (Q)"
                          : "Multi-select drags slide the whole selection (Q)",
                      on: "bg-sky-500/30 font-semibold text-sky-100 shadow-sm ring-1 ring-inset ring-sky-400/70",
                      focus: "focus-visible:outline-sky-300",
                    },
                    {
                      kind: "rotate" as const,
                      glyph: "↻",
                      label: "Rotate",
                      title:
                        symmetryCount > 1
                          ? "Rotational symmetry — multi-select drags orbit the arena centre (Q)"
                          : "Multi-select drags orbit the arena centre (Q)",
                      on: "bg-amber-500/30 font-semibold text-amber-100 shadow-sm ring-1 ring-inset ring-amber-400/70",
                      focus: "focus-visible:outline-amber-300",
                    },
                  ]
                ).map((mode) => (
                  <button
                    key={mode.kind}
                    type="button"
                    className={`flex min-w-[76px] items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${mode.focus} ${
                      symmetryKind === mode.kind
                        ? mode.on
                        : "text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                    }`}
                    title={mode.title}
                    aria-pressed={symmetryKind === mode.kind}
                    onClick={() => setSymmetryKind(mode.kind)}
                  >
                    <span aria-hidden="true">{mode.glyph}</span>
                    <span>{mode.label}</span>
                  </button>
                ))}
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
          <ShareButton
            planId={planId}
            canShare={role === "owner"}
            isPublic={isPublic}
            setIsPublic={setIsPublic}
          />
          {user && role !== "owner" && (
            <button
              className="btn"
              disabled={duplicating}
              onClick={async () => {
                setDuplicating(true);
                setError("");
                try {
                  const { id } = await api.duplicatePlan(planId);
                  navigate(`/p/${id}`);
                } catch (error) {
                  setError(error instanceof Error ? error.message : "Could not duplicate the plan");
                  setDuplicating(false);
                }
              }}
            >
              {duplicating ? "Duplicating…" : "Duplicate to My Plans"}
            </button>
          )}
          <span className="text-xs text-ink-400">
            {user ? user.name : <a href="/">sign in</a>}
          </span>
        </div>
      </header>

      {plan.variantModel === "step" && (
        <div className="panel flex flex-wrap items-center gap-2 border-x-0 border-t-0 px-3 py-1.5 text-xs">
          <span className="label">Preview</span>
          {activeStepPreviews.length ? (
            activeStepPreviews.map(({ step: ownerStep, ownerStepId, variant }) => (
              <label
                key={ownerStepId}
                className={`flex items-center gap-1 rounded border px-2 py-1 ${movementConflicts.some((conflict) => conflict.ownerStepIds.includes(ownerStepId)) ? "border-amber-400 bg-amber-950/50" : focusedBeat === ownerStepId ? "border-blue-400 bg-blue-950/40" : "border-ink-600 bg-ink-800"}`}
              >
                <span>{ownerStep.name || "Step"}:</span>
                <select
                  data-preview-step={ownerStepId}
                  className="bg-transparent text-blue-100 outline-none"
                  value={variant.id}
                  onFocus={() => setFocusedBeat(ownerStepId)}
                  onChange={(event) => {
                    setFocusedBeat(ownerStepId);
                    setShown((current) => ({ ...current, [ownerStepId]: event.target.value }));
                  }}
                >
                  {stepVariants(ownerStep).map((choice) => (
                    <option key={choice.id} value={choice.id} className="bg-ink-900">
                      {stepVariantLabel(ownerStep, choice.id)}
                    </option>
                  ))}
                </select>
                {movementConflicts.some((conflict) => conflict.ownerStepIds.includes(ownerStepId)) && (
                  <span className="text-amber-300" title="This preview has an explicit same-actor movement conflict">⚠</span>
                )}
              </label>
            ))
          ) : (
            <span className="text-ink-400">No Variant split active in this Step</span>
          )}
          <span className="ml-auto text-ink-300" data-edit-destination>
            {editable
              ? editingVariant && editingVariantOwner
                ? `Editing: ${editingVariantOwner.step.name || "Step"} › ${stepVariantLabel(editingVariantOwner.step, editingVariant)}${openMech ? ` › ${mechLabel(plan, openMech)}` : ""}`
                : openMech
                  ? `Editing: ${mechLabel(plan, openMech)} shared Parts`
                  : `Editing: ${step.name || "Step"} shared scene`
              : "Viewer preview"}
          </span>
          {editable && editingVariant && editingVariantOwner && (
            <>
              <button
                className="btn h-6 py-0 text-[10px]"
                data-delete-step-variant={editingVariant}
                title={`Delete this Variant box and the Beats inside it, leaving ${stepVariantLabel(
                  editingVariantOwner.step,
                  stepVariants(editingVariantOwner.step).find((variant) => variant.id !== editingVariant)?.id ?? editingVariant
                )} as Shared (Del)`}
                onClick={() => deleteStepVariantBox(editingVariant)}
              >
                Delete Variant
              </button>
              <button
                className="btn h-6 py-0 text-[10px]"
                title="Go back to editing Shared (Esc)"
                onClick={() => setEditingBeatVariant(null)}
              >
                Edit Shared
              </button>
            </>
          )}
        </div>
      )}

      {plan.variantModel === "step" && movementConflicts.length > 0 && (
        <div className="bg-amber-950 px-3 py-1.5 text-center text-xs text-amber-200" role="alert" data-movement-conflict>
          Movement conflict: {movementConflicts.map((conflict) => authoredScene.find((entity) => entity.id === conflict.actorId)?.name || conflict.actorId).join(", ")} is moved by more than one active Variant split. Shared Step positions are shown until the conflict is resolved.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <StepRail
          plan={plan}
          index={stepIndex}
          editable={editable}
          me={user?.id ?? null}
          openMech={openMech}
          editingBeatVariant={editingBeatVariant}
          shown={shown}
          onShow={setShown}
          onSelect={setStepIndex}
          run={run}
          setIndex={setStepIndex}
          onOpenMech={(id) => {
            if (id !== mech) setEditingBeatVariant(null);
            setMech(id);
            if (id) setFocusedBeat(id);
          }}
          onEditBeatVariant={setEditingBeatVariant}
          onFocusBeat={setFocusedBeat}
          onDebuffs={setDebuffFor}
          onHighlight={setHighlight}
        />

        <CanvasArea onMouseDown={(ev) => sweep.current?.(ev.nativeEvent)}>
          {(size) => (
            <div
              ref={stageBox}
              className="relative"
              style={{ width: size, height: size }}
              onDragOver={(ev) => {
                if ((!carrying && !carryGroup) || layer === "markers") return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = carryGroup ? "move" : "copy";
                if (carrying) {
                  const pt = arenaPoint(ev);
                  // A source changes a mechanic into an aimed bait, whose final
                  // pose is target-dependent. Preview only the free-floor shape
                  // where the pointer honestly represents the pending drop.
                  setPalettePreview(
                    sourceAt(pt) ? null : { kind: carrying, x: pt.x, y: pt.y }
                  );
                }
              }}
              onDragLeave={(ev) => {
                const next = ev.relatedTarget;
                if (!(next instanceof Node) || !ev.currentTarget.contains(next))
                  setPalettePreview(null);
              }}
              onDrop={(ev) => {
                setPalettePreview(null);
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
                const tetherEnd = isPaletteTether(kind) ? tetherEndAt(pt) : undefined;
                const on = sourceAt(pt);
                void drop(
                  kind,
                  pt,
                  tetherEnd ? { at: "entity", id: tetherEnd } : on ? { at: "source", id: on } : { at: "free" }
                );
                setCarrying(null);
                setHover(null);
              }}
            >
              {openMech && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-10 px-2 py-1 text-center text-xs text-white"
                  style={{ background: tint(mechColor(plan, openMech), 0.35) }}
                >
                  {plan.variantModel === "beat"
                    ? editingVariant
                      ? `Editing: ${mechLabel(plan, openMech)} › ${beatVariantLabel(openMech, editingVariant)} › ${step.name || "Step"}`
                      : `Editing: ${mechLabel(plan, openMech)} shared Parts`
                    : `Filling “${mechLabel(plan, openMech)}” — what you drop goes in it`}
                </div>
              )}
              {pendingTether && (
                <div className="absolute inset-x-2 bottom-2 z-20 flex items-center justify-center gap-2 rounded bg-blue-950/95 px-3 py-2 text-xs text-blue-100 shadow-lg">
                  Pick any other object for the other end of {PALETTE_LABEL[pendingTether.kind].toLowerCase()}.
                  <button className="underline" onClick={() => setPendingTether(null)}>Cancel</button>
                </div>
              )}
              <Scene
                plan={plan}
                preview={previewEntities}
                stepId={step.id}
                shown={shown}
                dress={dress}
                size={size}
                selected={selection}
                editable={editable}
                symmetryCount={symmetryCount}
                symmetryKind={symmetryKind}
                layer={layer}
                chips={chips}
                sweep={sweep}
                highlight={highlight}
                glide={glide}
                onward={onward}
                onPick={(id) => {
                  if (!pendingTether) return false;
                  const target = authoredScene.find((e) => e.id === id);
                  if (target && target.type !== "tether") void finishTether(target.id);
                  else setError("Choose an object for the other end of the tether");
                  return true;
                }}
                onSelect={setSelection}
                onResize={resize}
                onTransform={async (id, next) => {
                  const entity = authoredScene.find((candidate) => candidate.id === id);
                  if (!entity) return;
                  const sizePatch = {
                    ...(Math.abs(next.factor - 1) > 0.0005 ? resizeSpec(entity, next.factor) : {}),
                    // The donut-hole and cone-spread ticks land as the same
                    // kind of dimension edit as a uniform resize.
                    ...(next.innerRadius !== undefined &&
                    entity.type === "zone" &&
                    entity.shape === "donut" &&
                    Math.abs(next.innerRadius - entity.innerRadius) > 0.4
                      ? { innerRadius: next.innerRadius }
                      : {}),
                    ...(next.angle !== undefined &&
                    entity.type === "zone" &&
                    entity.shape === "cone" &&
                    Math.abs(next.angle - entity.angle) > 0.4
                      ? { angle: next.angle }
                      : {}),
                    ...(next.width !== undefined &&
                    entity.type === "zone" &&
                    "width" in entity &&
                    Math.abs(next.width - entity.width) > 0.4
                      ? { width: next.width }
                      : {}),
                    ...(next.length !== undefined &&
                    entity.type === "zone" &&
                    "length" in entity &&
                    Math.abs(next.length - entity.length) > 0.4
                      ? { length: next.length }
                      : {}),
                  };
                  const sizeChanged = Object.keys(sizePatch).length > 0;
                  const rotationChanged =
                    next.rotation !== undefined && Math.abs(next.rotation - entity.rotation) > 0.05;
                  if (!sizeChanged && !rotationChanged) return;

                  if (plan.variantModel === "step" && editingVariant && isActor(entity)) {
                    const ops: Op[] = [];
                    if (rotationChanged)
                      ops.push({
                        op: "set_step_variant_movement",
                        stepId: step.id,
                        variantId: editingVariant,
                        actorId: id,
                        pose: { x: entity.x, y: entity.y, rotation: next.rotation! },
                      });
                    if (sizeChanged)
                      ops.push({ op: "update_entity", id, patch: sizePatch });
                    if (ops.length) await run(ops, false);
                    return;
                  }

                  await run(
                    {
                      op: "update_entity",
                      id,
                      patch: {
                        ...sizePatch,
                        ...(rotationChanged ? { rotation: next.rotation } : {}),
                      },
                      stepId:
                        plan.variantModel === "beat" && editingVariant
                          ? step.id
                          : scope === "step"
                            ? step.id
                            : undefined,
                      variant:
                        plan.variantModel === "beat"
                          ? editingVariant
                          : scope === "step"
                            ? playing
                            : undefined,
                    },
                    false
                  );
                }}
                onMove={(moves) => {
                  if (plan.variantModel === "step" && editingVariant) {
                    const movementOps = moves.flatMap(({ id, x, y }): Op[] => {
                      const entity = authoredScene.find((candidate) => candidate.id === id);
                      return entity && isActor(entity)
                        ? [{
                            op: "set_step_variant_movement",
                            stepId: step.id,
                            variantId: editingVariant,
                            actorId: id,
                            pose: { x, y, rotation: entity.rotation },
                          }]
                        : [{ op: "update_entity", id, patch: { x, y } }];
                    });
                    if (movementOps.length) void run(movementOps, false);
                    return;
                  }
                  if (
                    plan.variantModel === "beat" &&
                    openMech &&
                    editingVariant &&
                    moves.some(({ id }) => !beatVariantMovement(plan, step.id, editingVariant)[id])
                  ) {
                    const first = moves.find(({ id }) =>
                      !beatVariantMovement(plan, step.id, editingVariant)[id]
                    );
                    const actor = authoredScene.find((entity) => entity.id === first?.id);
                    setNote(
                      `${actor?.name || first?.id || "Actor"}'s movement now belongs to ${mechLabel(plan, openMech)} › ${beatVariantLabel(openMech, editingVariant)} at ${step.name || "this Step"}. Undo`
                    );
                  }
                  void run(
                    moves.map(({ id, x, y }) => ({
                      op: "update_entity" as const,
                      id,
                      patch: { x, y },
                      stepId:
                        plan.variantModel === "beat" && editingVariant
                          ? step.id
                          : scope === "step"
                            ? step.id
                            : undefined,
                      // In a mechanic that goes two ways, a move belongs to the
                      // reading you are playing. Nothing has to be said about it:
                      // you moved somebody while looking at this reading.
                      variant:
                        plan.variantModel === "beat"
                          ? editingVariant
                          : scope === "step"
                            ? playing
                            : undefined,
                    })),
                    false
                  );
                }}
              />
              <NotesCard
                key={step.id}
                plan={plan}
                step={step}
                size={size}
                editable={editable}
                onMove={(pos) =>
                  run({ op: "update_step", stepId: step.id, patch: { notesPos: pos } }, false)
                }
                onEdit={(notes) => run({ op: "update_step", stepId: step.id, patch: { notes } })}
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
                  data-drop-group={g}
                  draggable={editable && layer === "step" && people > 0}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData("text/plain", "group:" + g);
                    ev.dataTransfer.effectAllowed = "move";
                    setCarryGroup(g);
                  }}
                  onDragEnd={() => setCarryGroup(null)}
                  // Clicking the chip is how you get hold of the group without
                  // moving it: the same people the drag would carry, selected.
                  onClick={() => {
                    const ids = membersOf(g).map((e) => e.id);
                    if (ids.length) setSelection(ids);
                  }}
                  title={
                    people > 0
                      ? `Click to select the ${GROUP_LABEL[g]}. Drag this onto the floor to stack them tightly there. Drop a mechanic here to give one to each of them`
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
                        onClick={(ev) => {
                          ev.stopPropagation();
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
        <aside
          className="panel w-[320px] shrink-0 overflow-y-auto border-y-0 border-r-0 p-3"
          data-panel={selectedEntity && layer !== "markers" ? "inspector" : "palette"}
        >
          {!selectedEntity || layer === "markers" ? (
          <>
          <h2 className="label mb-2">Add</h2>
          <p className="mb-2 text-xs text-ink-400">
            Drag onto the floor to place one, onto a group to give everybody one, or onto a boss,
            add, or bait anchor to have it thrown at whoever stands nearest. Drop a tether on any object,
            then pick any other object. Scroll over anything on the arena to size it — shift for fine steps.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-1">
            {PALETTE.map((k) => (
              <div
                key={k}
                draggable={false}
                title={PALETTE_HINT[k]}
                onPointerDown={(ev) => beginPaletteDrag(k, ev)}
                className={`flex touch-none cursor-grab select-none flex-col items-center gap-1 rounded border px-2 py-2 text-xs active:cursor-grabbing ${
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
                run({
                  op: "arrange_party",
                  stepId: scope === "step" ? step.id : undefined,
                  variant:
                    plan.variantModel === "beat"
                      ? editingVariant
                      : scope === "step"
                        ? playing
                        : undefined,
                })
              }
            >
              PF positions
            </button>
            <button
              className="btn"
              disabled={!editable}
              title="Restore missing party members and align the party to PF clock positions"
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
                if (r) showServerPlan(r.plan);
              }}
            >
              use saved
            </button>
            {note && <span className="text-xs text-ink-400">{note}</span>}
          </div>

          {/* With no floor object selected the sidebar is the palette, but it
              is also the only place ArenaFields can be reached. Keep the
              arena inspector mounted here so backdrop presets and uploads do
              not disappear behind the object-inspector routing. */}
          <Inspector
            plan={plan}
            entity={null}
            stepId={step.id}
            scope={scope}
            variant={editingVariant ?? playing}
            shown={shown}
            editable={editable}
            run={run}
            onDeselect={() => setSelected(null)}
          />
          </>
          ) : (
          <Inspector
            plan={plan}
            entity={selectedEntity}
            stepId={step.id}
            scope={scope}
            variant={editingVariant ?? playing}
            shown={shown}
            editable={editable}
            run={run}
            onDeselect={() => setSelected(null)}
          />
          )}
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

      {debuffMech && (
        <DebuffPanel
          plan={plan}
          mech={debuffMech}
          stepId={step.id}
          shown={shown}
          run={run}
          onClose={() => setDebuffFor(null)}
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
function CanvasArea({
  children,
  onMouseDown,
}: {
  children: (size: number) => React.ReactNode;
  /** A mouse-down on the bare area beside the canvas. */
  onMouseDown?(ev: React.MouseEvent<HTMLDivElement>): void;
}) {
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
    <div
      ref={ref}
      className="flex min-w-0 flex-1 items-center justify-center"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onMouseDown?.(ev);
      }}
    >
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
/**
 * The release contract for every direct-manipulation gesture (Beat, chip,
 * Variant edge, row and section drags):
 *
 * 1. Batch the whole gesture into ONE `run()` call.
 * 2. Ops in this set are pure transforms of state the client already holds,
 *    so `run()` applies them locally in the same paint; the server response
 *    stays authoritative.
 * 3. The preview state (`drag`, `variantDrag`, …) is cleared in the run's
 *    `finally`, never before — so however the ops are applied, no frame ever
 *    shows the old position between release and acknowledgement.
 *
 * NEW ops are born client-authoritative and join this set at birth: the
 * client mints their ids and sends their context, so their result is fully
 * predictable locally (see AGENTS.md). Only legacy ops with server-minted
 * ids or server-side reads stay off the list, wait-for-ack.
 */
const OPTIMISTIC_OPS = new Set<string>([
  "set_arena",
  "update_entity",
  "update_step",
  "delete_entities",
  "update_mech",
  "merge_mechs",
  "gate_mech",
  "assign_beats_to_step_variant",
  "move_step_variant_set",
  "move_step",
  "move_mechanic",
]);

interface Drag {
  /** Identifies this pointer gesture so an older acknowledgement cannot clear a newer one. */
  gesture: number;
  id: string;
  /** Whether this Beat was already open when the pointer went down. */
  wasOpen?: boolean;
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
  /**
   * The Variant half the pointer is over right now, in a Step-Variant plan:
   * letting go there makes the Beat that Variant's. Unset with the pointer
   * clear of every box, so letting go outside pulls the Beat back to shared.
   */
  into?: { stepId: string; variantId: string };
  /**
   * Another Beat's box the pointer is over: letting go there folds the held
   * Beat into it. Carrying a Beat onto a Beat is how two become one.
   */
  mergeInto?: string;
  moved: boolean;
  /**
   * Released, waiting for the server: the preview holds its pose, the move
   * handlers leave it alone, and the run's settling clears it — unless a new
   * drag has replaced it first.
   */
  settling?: boolean;
}

/** A row or heading being carried to another slot in its list. */
interface Slide {
  /** Identifies this pointer gesture so an older acknowledgement cannot clear a newer one. */
  gesture: number;
  id: string;
  /** The slot it is over right now — where it would land if you let go. */
  at: number;
  moved: boolean;
  /** Released, waiting for the server — see Drag.settling. */
  settling?: boolean;
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
  editingBeatVariant,
  shown,
  onShow,
  onSelect,
  run,
  setIndex,
  onOpenMech,
  onEditBeatVariant,
  onFocusBeat,
  onDebuffs,
  onHighlight,
}: {
  plan: Plan;
  index: number;
  editable: boolean;
  /** Who is looking, so a reading can say whether it is yours. */
  me: string | null;
  openMech: Mech | null;
  editingBeatVariant: string | null;
  shown: Record<string, string>;
  onShow: Dispatch<SetStateAction<Record<string, string>>>;
  onSelect(i: number): void;
  run(ops: Op | Op[]): Promise<{ values: unknown[]; plan: Plan }>;
  setIndex(i: number): void;
  onOpenMech(id: string | null): void;
  onEditBeatVariant(id: string | null): void;
  onFocusBeat(id: string): void;
  onDebuffs(id: string): void;
  onHighlight(id: string | null): void;
}) {
  // Deleting the last step leaves the parent's index pointing past the end for
  // one render; the rail must not blow up in that gap.
  const at = Math.min(index, plan.steps.length - 1);
  const current = plan.steps[at];

  const [drag, setDrag] = useState<Drag | null>(null);
  const [variantDrag, setVariantDrag] = useState<Drag | null>(null);
  /**
   * A row or a heading on its way somewhere: what is being dragged and which
   * slot it is currently over. Where a step or a section sits *is* what it
   * says, so dragging it is how you say it — there is nothing else to edit.
   */
  const [rowDrag, setRowDrag] = useState<Slide | null>(null);
  const [sectionDrag, setSectionDrag] = useState<Slide | null>(null);
  const nextGesture = useRef(0);
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
    const areas: (string | undefined)[] = [undefined];
    const boxed = boxedBeatIds(plan);
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
        if (boxed.has(mech.id)) continue;
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
        // Held over a Variant half, the Beat is that half's: the half says so
        // with its ring and a chip preview, and no lane box doubles it. A
        // loose Beat still keeps its lane box mounted — invisible — because
        // it holds the pointer capture, and an unmounted element drops the
        // release on the floor. A chip needs no double: the chip itself stays
        // mounted in its half. Clear of every box the lane preview is the
        // edit, as it always was.
        if (!drag.into || !boxed.has(held.id)) {
          const mine = lanesOf[at];
          const [lo, hi] = [drag.lo, drag.hi];
          // A chip pulled out of its box needs somewhere to be: rather than
          // land on a box already there, it may open a lane of its own. The
          // pointer is out over the rows by then, so nothing it is aiming at
          // slides away. The legacy split keeps its no-reflow bargain.
          const cap = plan.variantModel === "step" ? Infinity : groups[at].lanes - 1;
          let lane = 0;
          while (lane < cap && mine.some((p) => p.lane === lane && p.lo <= hi && p.hi >= lo))
            lane++;
          mine.push({ mech: held, lo, hi, lane });
          if (lane >= groups[at].lanes) {
            const grew = lane + 1 - groups[at].lanes;
            groups[at].lanes = lane + 1;
            for (let g = at + 1; g < groups.length; g++) groups[g].from += grew;
            from += grew;
          }
        }
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
    const boxes = visible.flatMap((owner) => {
      const variants = stepVariants(owner);
      if (variants.length < 2) return [];
      const own = row.get(owner.id) ?? 0;
      const end = row.get(owner.variantEnd || owner.id) ?? own;
      const moving = variantDrag?.id === owner.id ? variantDrag : undefined;
      const boxLo = moving?.lo ?? Math.min(own, end);
      const boxHi = moving?.hi ?? Math.max(own, end);
      // Each half packs its Beats the way the loose lanes do: two Beats over
      // the same rows sit side by side, and the half grows a sublane for it.
      const slots = new Map<string, { lo: number; hi: number; lane: number }>();
      const subs = variants.map((variant) => {
        const mine: { lo: number; hi: number; lane: number }[] = [];
        for (const id of variant.beats) {
          const mech = plan.mechs.find((beat) => beat.id === id);
          const rows = mech && span(mech);
          if (!rows) continue;
          const [bLo, bHi] = rows;
          let lane = 0;
          while (mine.some((p) => p.lane === lane && p.lo <= bHi && p.hi >= bLo)) lane++;
          const slot = { lo: bLo, hi: bHi, lane };
          mine.push(slot);
          slots.set(id, slot);
        }
        return Math.max(1, mine.reduce((n, p) => Math.max(n, p.lane + 1), 0));
      });
      const planLo = Math.min(own, end);
      const planHi = Math.max(own, end);
      return [{ owner, variants, lo: boxLo, hi: boxHi, planLo, planHi, lane: 0, subs, slots }];
    });
    // A Variant is one timeline container with sibling readings inside it.
    // Give every reading a timeline column per sublane, as the legacy split
    // did, while the shared colour strips and end handle span the container.
    // Boxes whose rows don't overlap share one run of columns, the way loose
    // casts share a lane — packed off the plan's rows, not the drag's, so no
    // column slides away under a box you are carrying.
    const laneWidths = Array(from).fill(66) as number[];
    const packs: (typeof boxes)[] = [];
    for (const box of boxes) {
      const pack = packs.find((mine) =>
        mine.every((p) => p.planHi < box.planLo || p.planLo > box.planHi)
      );
      if (pack) pack.push(box);
      else packs.push([box]);
    }
    for (const pack of packs) {
      // Each sublane must hold a normal 66px Beat card, plus the Variant
      // container's own border and breathing room; a shared column is as wide
      // as the widest sublane that lands in it.
      const widths: number[] = [];
      for (const box of pack) {
        box.lane = from;
        box.subs.forEach((n, i) => (widths[i] = Math.max(widths[i] ?? 0, n * 66 + 12)));
      }
      from += widths.length;
      laneWidths.push(...widths);
    }
    // The rail must never crowd the floor out: past a budget the lanes share
    // it, and a step with many Beats shows many narrow cards — which is the
    // cue to fold them into fewer Beats, not a reason to shrink the arena.
    const budget = 240;
    const total = laneWidths.reduce((sum, width) => sum + width, 0);
    if (total > budget) {
      const scale = budget / total;
      laneWidths.forEach((width, i) => (laneWidths[i] = Math.max(30, Math.floor(width * scale))));
    }
    return { placed, boxes, lanes: from, laneWidths, groups };
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
    : { placed: [], boxes: [], lanes: 0, laneWidths: [] as number[], groups: [] as { variant?: string; from: number; lanes: number }[] };
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

  /**
   * The Variant half under the pointer, asked of the DOM: a carried Beat is in
   * its own lane, so whatever the pointer is over besides it is the target.
   */
  const variantBoxAt = (
    clientX: number,
    clientY: number
  ): { stepId: string; variantId: string } | undefined => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const set = (el as HTMLElement).closest?.("[data-step-variant-set]");
      if (!set) continue;
      // Anywhere on the container means one of its halves: the dividers, the
      // colour strips and the end bar all belong to whichever is nearest, so
      // no drop on the box itself ever slips through to "outside".
      let best: Element | undefined;
      let near = Infinity;
      for (const half of set.querySelectorAll("[data-step-variant]")) {
        const r = half.getBoundingClientRect();
        const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
        if (d < near) [best, near] = [half, d];
      }
      if (best)
        return {
          stepId: set.getAttribute("data-step-variant-set")!,
          variantId: best.getAttribute("data-step-variant")!,
        };
    }
    return undefined;
  };

  /** Another Beat's box under the pointer: the one a carried Beat would merge into. */
  const beatCardAt = (clientX: number, clientY: number, held: string): string | undefined => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const id = (el as HTMLElement).closest?.("[data-mech]")?.getAttribute("data-mech");
      if (id && id !== held) return id;
    }
    return undefined;
  };

  /** The Variant box a Beat lives in, if it lives in one. */
  const beatHome = (beatId: string): { stepId: string; variantId: string } | undefined => {
    for (const step of plan.steps)
      for (const variant of stepVariants(step))
        if (variant.beats.includes(beatId)) return { stepId: step.id, variantId: variant.id };
    return undefined;
  };

  /** Let go of a row: the slot it was dropped on, or a plain click if it never moved. */
  function endRowDrag() {
    const settled = rowDrag;
    if (settled?.settling) return;
    if (!settled?.moved) return setRowDrag(null);
    setRowDrag({ ...settled, settling: true });
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    const landing = siblings[Math.max(0, Math.min(siblings.length - 1, settled.at))];
    const to = plan.steps.indexOf(landing);
    const done = () =>
      setRowDrag((held) =>
        held?.settling && held.gesture === settled.gesture ? null : held
      );
    void run({ op: "move_step", stepId: settled.id, index: to }).then(done, done);
    setIndex(to);
  }

  /** The same for a heading: the whole section goes where you put it. */
  function endSectionDrag() {
    const settled = sectionDrag;
    if (settled?.settling) return;
    if (!settled?.moved) return setSectionDrag(null);
    setSectionDrag({ ...settled, settling: true });
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    // The selection is a place in `plan.steps`, and moving a block of them
    // changes what is at that place: hold on to the step itself instead, or
    // the open section changes under you.
    const keep = current?.id;
    const done = () =>
      setSectionDrag((held) =>
        held?.settling && held.gesture === settled.gesture ? null : held
      );
    void run({ op: "move_mechanic", mechanicId: settled.id, index: settled.at })
      .then((res) => {
        const i = res.plan.steps.findIndex((s) => s.id === keep);
        if (i >= 0) setIndex(i);
      })
      .then(done, done);
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
      setRowDrag((d) => (d && !d.settling && d.at !== to ? { ...d, at: to, moved: true } : d));
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
      setSectionDrag((d) => (d && !d.settling && d.at !== to ? { ...d, at: to, moved: true } : d));
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
  function endDrag(
    mech: Mech,
    lo: number,
    hi: number,
    visible: Step[],
    at?: { clientX: number; clientY: number }
  ) {
    const settled = drag;
    if (!settled || settled.settling) return;
    if (!settled.moved) {
      setDrag(null);
      // A closed Beat opens on pointer-down so clicking feels immediate. Its
      // release only has work left when this was a click on an already-open
      // Beat, which preserves the old click-again-to-close behavior.
      if (settled.wasOpen) onOpenMech(null);
      return;
    }
    setDrag({ ...settled, settling: true });
    // Asked where the pointer let go rather than trusted to the last move
    // event: the settled state can be one frame stale, and whose the Beat is
    // must not depend on that race.
    const into =
      plan.variantModel === "step" && at
        ? variantBoxAt(at.clientX, at.clientY)
        : settled.into;
    // Let go on another Beat, the two are one: that is the whole edit.
    const mergeInto = at ? beatCardAt(at.clientX, at.clientY, mech.id) : settled.mergeInto;
    if (mergeInto) {
      const done = () =>
        setDrag((held) => (held?.settling && held.gesture === settled.gesture ? null : held));
      onOpenMech(mergeInto);
      void run({ op: "merge_mechs", into: mergeInto, mechIds: [mech.id] }).then(done, done);
      return;
    }
    // One drag can say both: which reading it is for, and when it happens.
    const [wasLo, wasHi] = settled.from;
    // One batch, applied optimistically in the same paint that clears the
    // preview: the release must never show frames of the old position while
    // the server thinks it over.
    const settle: Op[] = [];
    if (settled.gate && (mech.variant ?? undefined) !== settled.gate.to)
      settle.push({ op: "gate_mech", mechId: mech.id, variant: settled.gate.to });
    if (lo !== wasLo || hi !== wasHi)
      settle.push({
        op: "update_mech",
        mechId: mech.id,
        patch: { snap: visible[lo].id, boom: visible[hi].id },
      });
    // Where the Beat was let go is whose it is: on a Variant half it becomes
    // that Variant's, clear of every box it goes back to shared.
    if (plan.variantModel === "step") {
      const home = beatHome(mech.id);
      if (into && into.variantId !== home?.variantId)
        settle.push({
          op: "assign_beats_to_step_variant",
          stepId: into.stepId,
          beatIds: [mech.id],
          variantId: into.variantId,
        });
      else if (!into && home)
        settle.push({
          op: "assign_beats_to_step_variant",
          stepId: home.stepId,
          beatIds: [mech.id],
        });
    }
    // The preview outlives the request: it is dropped only once the round
    // trip settles (the optimistic apply makes that the same paint), and only
    // if no new drag has replaced it in the meantime.
    const done = () =>
      setDrag((held) =>
        held?.settling && held.gesture === settled.gesture ? null : held
      );
    if (settle.length) void run(settle).then(done, done);
    else done();
  }

  function endVariantDrag(owner: Step, visible: Step[]) {
    const settled = variantDrag;
    if (settled?.settling) return;
    if (!settled?.moved) return setVariantDrag(null);
    // A release that reaches the wrong box's handler must not move that box,
    // and a drag that came back to where it started has nothing to say: a
    // same-place move would still record a revision, and its ack would read
    // as the drag silently snapping back.
    if (settled.id !== owner.id) return setVariantDrag(null);
    if (settled.lo === settled.from[0] && settled.hi === settled.from[1])
      return setVariantDrag(null);
    setVariantDrag({ ...settled, settling: true });
    const done = () =>
      setVariantDrag((held) =>
        held?.settling && held.gesture === settled.gesture ? null : held
      );
    void run({
      op: "move_step_variant_set",
      stepId: owner.id,
      snap: visible[settled.lo].id,
      boom: visible[settled.hi].id,
    }).then(done, done);
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
        {stepVariants(s).length === 0 && (
          <button
            className={action}
            aria-label="Split this Step into Variants"
            title="Create two Step Variant boxes that can contain Beats"
            onClick={() => void run({ op: "add_step_variant", stepId: s.id })}
          >
            ◇
          </button>
        )}
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
        style={{ gridTemplateColumns: `minmax(0, 1fr) ${l.laneWidths.map((width) => `${width}px`).join(" ")}` }}
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
                onPointerDown={() =>
                  editable &&
                  setRowDrag({ gesture: ++nextGesture.current, id: s.id, at: i, moved: false })
                }
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
          const shapes = new Set([
            ...plan.entities.filter((entity) => entity.mech === mech.id).map((entity) => entity.id),
            ...plan.steps.flatMap((step) =>
              Object.values(step.variantScenes ?? {}).flatMap((scene) =>
                scene.filter((entity) => entity.mech === mech.id).map((entity) => entity.id)
              )
            ),
          ]).size;
          const box = { gridColumn: lane + 2, gridRow: `${lo + 1 + head} / ${hi + 2 + head}` };
          const color = mechColor(plan, mech);
          const beatPreview =
            plan.variantModel === "beat" && mech.variants.length
              ? (mech.variants.find(
                  (variant) =>
                    variant.id === (shown[mech.id] ?? defaultBeatVariantSelections(plan)[mech.id])
                ) ?? mech.variants[0])
              : undefined;
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
                  title="Rename Beat"
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
          const stepVariantState = current
            ? Object.fromEntries(
                mech.variants.map((variant) => [
                  variant.id,
                  {
                    content: !!current.beatVariantContent?.[variant.id],
                    parts: current.beatVariantContent?.[variant.id]?.active
                      ? current.beatVariantContent[variant.id].parts.length
                      : 0,
                    movement: Object.keys(current.beatVariantMovement?.[variant.id] ?? {}).length,
                  },
                ])
              )
            : {};
          return (
            <div
              key={mech.id}
              style={box}
              className="relative min-h-0"
            >
            <button
              data-mech={mech.id}
              style={{ borderTopColor: color, background: tint(color, active ? 0.4 : 0.18) }}
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
                if (plan.variantModel === "beat") onFocusBeat(mech.id);
                const wasOpen = openMech?.id === mech.id;
                if (!wasOpen) onOpenMech(mech.id);
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({
                  gesture: ++nextGesture.current,
                  id: mech.id,
                  wasOpen,
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
                if (drag?.id !== mech.id || drag.settling) return;
                // The pointer says both things at once: the area it is over is
                // which reading the cast is for, the row it is on is when it
                // happens. Carried up onto a reading pill counts as the area.
                const onPill = mechanic.variants.length
                  ? pillAt(e.clientX, e.clientY)
                  : undefined;
                const gate = mechanic.variants.length
                  ? (onPill ?? areaAt(e.clientX) ?? drag.gate)
                  : undefined;
                const into =
                  plan.variantModel === "step" ? variantBoxAt(e.clientX, e.clientY) : undefined;
                const mergeInto = beatCardAt(e.clientX, e.clientY, mech.id);
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
                  gate?.to === drag.gate?.to &&
                  into?.variantId === drag.into?.variantId &&
                  mergeInto === drag.mergeInto;
                if (same) return;
                setDrag({ ...drag, gate, into, mergeInto, lo: next[0], hi: next[1], moved: true });
              }}
              onPointerUp={(e) => endDrag(mech, lo, hi, visible, e)}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={() => editable && setRenaming(mech.id)}
              className={`flex h-full w-full touch-none flex-col items-center overflow-hidden rounded border-t-2 px-1 py-1 text-[11px] leading-tight ${
                editable ? "cursor-grab active:cursor-grabbing" : ""
              } ${active ? "text-white" : "text-ink-200"} ${
                drag?.id === mech.id ? "ring-1 ring-white/70" : ""
              } ${skipped ? "opacity-60" : ""} ${
                drag && drag.id !== mech.id && drag.mergeInto === mech.id
                  ? "ring-2 ring-white"
                  : ""
              } ${
                // Held over a Variant half the box goes invisible — the half's
                // chip preview is the Beat now — but stays mounted, keeping
                // the pointer capture that will deliver the release.
                drag?.id === mech.id && drag.into ? "opacity-0" : ""
              }`}
            >
              {/* Which reading a cast is for is the area it sits in, so the box
                  itself does not repeat it. */}
              <span className="w-full truncate text-center">{label}</span>
              {shapes > 0 && (
                <span className={mech.variants.length ? "text-[9px] text-ink-400" : "text-ink-400"}>
                  ×{shapes}
                </span>
              )}
              {/* The bottom edge is where it goes off, and says so. */}
              <span className="mt-auto -mb-1 w-full border-b-4 border-amber-400/80 pb-0.5 text-center text-[9px] uppercase tracking-wide text-amber-300/90">
                boom
              </span>
            </button>
            {mech.variants.length > 0 && (
              <div
                data-timeline-variants={mech.id}
                className="absolute inset-x-1 top-[29px] bottom-[17px] z-10 flex min-h-0 flex-col gap-0.5"
                aria-label={`${label} Variants`}
              >
                {mech.variants.map((variant) => {
                  const state = stepVariantState[variant.id] ?? { content: false, parts: 0, movement: 0 };
                  const previewing = beatPreview?.id === variant.id;
                  const editing = editingBeatVariant === variant.id;
                  const inherited = !state.content && state.movement === 0;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      data-timeline-variant={variant.id}
                      aria-pressed={previewing}
                      aria-label={`${beatVariantLabel(mech, variant.id)}, ${
                        inherited ? "Shared" : "edited independently"
                      }`}
                      className={`flex min-h-[14px] flex-1 items-center gap-0.5 overflow-hidden rounded border px-1 text-left text-[8px] leading-none ${
                        previewing
                          ? "border-blue-200 bg-blue-500/40 text-white ring-1 ring-blue-300/40"
                          : editing
                            ? "border-amber-300/70 bg-amber-500/10 text-ink-100"
                            : "border-ink-500/80 bg-ink-900/65 text-ink-300 hover:border-ink-300"
                      }`}
                      title={`${beatVariantLabel(mech, variant.id)} — ${
                        inherited
                          ? "inheriting Shared at this Step"
                          : `${state.content ? "content detached" : "content inherited"}; ${
                              state.movement ? `${state.movement} movement override${state.movement === 1 ? "" : "s"}` : "movement inherited"
                            }`
                      }. Click to preview and edit this Variant.`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setShown((choices) => ({ ...choices, [mech.id]: variant.id }));
                        onFocusBeat(mech.id);
                        onEditBeatVariant(variant.id);
                      }}
                    >
                      <span aria-hidden className={`w-2 shrink-0 ${previewing ? "text-blue-100" : ""}`}>
                        {previewing ? "▶" : editing ? "✎" : ""}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{beatVariantLabel(mech, variant.id)}</span>
                      {inherited ? (
                        <span className="shrink-0 text-emerald-300" title="Following Shared">↳</span>
                      ) : (
                        <span className="shrink-0 text-amber-200">
                          {`${state.content ? `×${state.parts}` : ""}${state.movement ? ` M${state.movement}` : ""}`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            </div>
          );
        })}
        {l.boxes.map(({ owner, variants, lo, hi, lane, subs, slots }) => {
          const selectedId =
            shown[owner.id] ?? defaultStepVariantSelections(plan)[owner.id] ?? variants[0]?.id;
          return (
            <div
              key={`step-variants:${owner.id}`}
              data-step-variant-set={owner.id}
              style={{
                gridColumn: `${lane + 2} / span ${variants.length}`,
                gridRow: `${lo + 1 + head} / ${hi + 2 + head}`,
              }}
              // The container takes the gutters the Beat boxes leave alone, so
              // for the same rows it reads a size bigger than they do.
              className="-my-1 -ml-0.5 flex min-h-0 flex-col overflow-hidden rounded border border-ink-500/70 bg-ink-900/70"
              onClick={() => onFocusBeat(owner.id)}
            >
              <div
                className="grid min-h-0 flex-1 divide-x divide-ink-600/60"
                style={{ gridTemplateColumns: subs.map((n) => `${n}fr`).join(" ") }}
              >
              {variants.map((variant, at) => {
                const previewing = variant.id === selectedId;
                const editing = variant.id === editingBeatVariant;
                const color = VARIANT_COLORS[at % VARIANT_COLORS.length];
                const beats = variant.beats
                  .map((id) => plan.mechs.find((beat) => beat.id === id))
                  .filter((beat): beat is Mech => !!beat);
                const arriving =
                  !!drag &&
                  drag.into?.stepId === owner.id &&
                  drag.into.variantId === variant.id &&
                  !variant.beats.includes(drag.id);
                return (
                  <div
                    key={variant.id}
                    data-step-variant={variant.id}
                    className={`group/half flex min-h-0 flex-col overflow-hidden text-left ${
                      previewing ? "text-white" : "text-ink-300 opacity-60"
                    } ${
                      drag?.into?.variantId === variant.id ? "ring-1 ring-inset ring-white/70" : ""
                    }`}
                    style={{ background: previewing ? tint(color, 0.12) : undefined }}
                    title={`${stepVariantLabel(owner, variant.id)} — ${beats.length} Beat${beats.length === 1 ? "" : "s"}. Click to preview and edit this Step Variant.`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setShown((choices) => ({ ...choices, [owner.id]: variant.id }));
                      onFocusBeat(owner.id);
                      onEditBeatVariant(variant.id);
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      if (!editable) return;
                      const name = window.prompt("Variant name", stepVariantLabel(owner, variant.id));
                      if (name !== null)
                        void run({ op: "update_step_variant", stepId: owner.id, variantId: variant.id, patch: { name } });
                    }}
                  >
                    <button
                      type="button"
                      aria-pressed={previewing}
                      aria-label={stepVariantLabel(owner, variant.id)}
                      // The Variant's whole caption is this strip of its colour;
                      // it is still the handle for the split's start Step.
                      className={`h-1 shrink-0 touch-none ${editable ? "cursor-grab active:cursor-grabbing" : ""} ${
                        editing && !previewing ? "outline outline-1 -outline-offset-1 outline-amber-300/80" : ""
                      }`}
                      style={{ background: color }}
                      title={`${stepVariantLabel(owner, variant.id)} — click to preview and edit it; drag this edge to move the Variant split's start Step`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if (!editable) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setVariantDrag({
                          gesture: ++nextGesture.current,
                          id: owner.id,
                          mode: "top",
                          grabbed: rowAt(event.clientY, visible),
                          lo,
                          hi,
                          from: [lo, hi],
                          moved: false,
                        });
                      }}
                      onPointerMove={(event) => {
                        if (variantDrag?.id !== owner.id || variantDrag.settling) return;
                        const row = rowAt(event.clientY, visible);
                        const [wasLo, wasHi] = variantDrag.from;
                        const next: [number, number] = [Math.min(row, wasHi), wasHi];
                        if (next[0] !== variantDrag.lo || next[1] !== variantDrag.hi)
                          setVariantDrag({ ...variantDrag, lo: next[0], hi: next[1], moved: true });
                      }}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        endVariantDrag(owner, visible);
                      }}
                      onPointerCancel={() => setVariantDrag(null)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setShown((choices) => ({ ...choices, [owner.id]: variant.id }));
                        onFocusBeat(owner.id);
                        onEditBeatVariant(variant.id);
                      }}
                    />
                    <div
                      className="grid min-h-0 flex-1 gap-0.5 overflow-hidden p-0.5 text-[8px] leading-none text-ink-200"
                      // The rows in here are the Steps themselves, so a chip
                      // sits level with the rows it covers — and the side not
                      // playing goes grey, contents and all. Only the
                      // contents: the strip above keeps the Variant's colour,
                      // dimmed, so the box stays colour-coded.
                      style={{
                        gridTemplateRows: `repeat(${hi - lo + 1}, minmax(0, 1fr))`,
                        gridTemplateColumns: `repeat(${subs[at]}, minmax(0, 1fr))`,
                        ...(previewing ? {} : { filter: "saturate(0.15)" }),
                      }}
                    >
                      {beats.map((beat) => {
                        const rows = mechSpan(plan, beat)
                          .map((id) => visible.findIndex((step) => step.id === id))
                          .filter((index) => index >= 0);
                        const baseLo = rows.length ? Math.min(...rows) : lo;
                        const baseHi = rows.length ? Math.max(...rows) : baseLo;
                        const moving = drag?.id === beat.id ? drag : undefined;
                        const beatLo = moving?.lo ?? baseLo;
                        const beatHi = moving?.hi ?? baseHi;
                        const slot = slots.get(beat.id);
                        const rowLo = Math.min(hi, Math.max(lo, beatLo));
                        const rowHi = Math.max(rowLo, Math.min(hi, beatHi));
                        return (
                          <span
                            key={beat.id}
                            data-variant-beat={beat.id}
                            className={`flex min-h-0 touch-none select-none flex-col items-center overflow-hidden rounded border-t-2 px-1 py-1 text-[11px] leading-tight ${
                              editable ? "cursor-grab active:cursor-grabbing" : ""
                            } ${drag?.id === beat.id ? "ring-1 ring-white/70" : ""} ${
                              // Mid-pull the lane preview is the Beat; the chip
                              // left behind only ghosts until it is let go.
                              drag?.id === beat.id && !drag.into ? "opacity-30" : ""
                            }`}
                            style={{
                              borderTopColor: mechColor(plan, beat),
                              background: tint(mechColor(plan, beat), 0.18),
                              gridRow: `${rowLo - lo + 1} / ${rowHi - lo + 2}`,
                              gridColumn: (slot?.lane ?? 0) + 1,
                            }}
                            title={`${mechLabel(plan, beat)} — Beat inside ${stepVariantLabel(owner, variant.id)}. Drag its top/bottom half to move its timing; click to edit its Parts.`}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              if (!editable) return;
                              const wasOpen = openMech?.id === beat.id;
                              if (!wasOpen) onOpenMech(beat.id);
                              const rect = event.currentTarget.getBoundingClientRect();
                              event.currentTarget.setPointerCapture(event.pointerId);
                              setDrag({
                                gesture: ++nextGesture.current,
                                id: beat.id,
                                wasOpen,
                                mode: event.clientY - rect.top < rect.height / 2 ? "top" : "bottom",
                                grabbed: rowAt(event.clientY, visible),
                                lo: beatLo,
                                hi: beatHi,
                                from: [baseLo, baseHi],
                                // It starts at home: only carrying it clear of
                                // the box, or into the other half, moves it.
                                into: { stepId: owner.id, variantId: variant.id },
                                moved: false,
                              });
                            }}
                            onPointerMove={(event) => {
                              if (drag?.id !== beat.id || drag.settling) return;
                              const into = variantBoxAt(event.clientX, event.clientY);
                              const row = rowAt(event.clientY, visible);
                              const [wasLo, wasHi] = drag.from;
                              const next: [number, number] = drag.mode === "top"
                                ? [Math.min(row, wasHi), wasHi]
                                : [wasLo, Math.max(row, wasLo)];
                              if (
                                next[0] !== drag.lo ||
                                next[1] !== drag.hi ||
                                into?.variantId !== drag.into?.variantId
                              )
                                setDrag({ ...drag, into, lo: next[0], hi: next[1], moved: true });
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              endDrag(beat, beatLo, beatHi, visible, event);
                            }}
                            onPointerCancel={() => setDrag(null)}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span className="w-full truncate text-center">{mechLabel(plan, beat)}</span>
                            {/* The amber edge is the caption: in here "when it
                                goes off" needs no word for it. */}
                            <span aria-hidden className="mt-auto -mb-1 w-full border-b-4 border-amber-400/80" />
                          </span>
                        );
                      })}
                      {!beats.length && !arriving && (
                        // The empty box explains itself only when asked: the
                        // hint waits for the pointer instead of shouting — and
                        // steps aside for an arriving Beat, or its grid-filling
                        // cell would squeeze the preview into half the width.
                        <span
                          className="place-self-center text-center text-ink-400 opacity-0 transition-opacity group-hover/half:opacity-100"
                          style={{ gridRow: "1 / -1", gridColumn: "1 / -1" }}
                        >
                          Drop Beats here
                        </span>
                      )}
                      {arriving &&
                        (() => {
                          // The Beat in the hand, previewed where letting go
                          // would put it: in this half, over its rows.
                          const held = drag && plan.mechs.find((m) => m.id === drag.id);
                          if (!drag || !held) return null;
                          const rowLo = Math.min(hi, Math.max(lo, drag.lo));
                          const rowHi = Math.max(rowLo, Math.min(hi, drag.hi));
                          return (
                            <span
                              aria-hidden
                              className="pointer-events-none flex min-h-0 select-none flex-col items-center overflow-hidden rounded border-t-2 px-1 py-1 text-[11px] leading-tight opacity-80 ring-1 ring-white/70"
                              style={{
                                borderTopColor: mechColor(plan, held),
                                background: tint(mechColor(plan, held), 0.18),
                                gridRow: `${rowLo - lo + 1} / ${rowHi - lo + 2}`,
                              }}
                            >
                              <span className="w-full truncate text-center">{mechLabel(plan, held)}</span>
                              <span aria-hidden className="mt-auto -mb-1 w-full border-b-4 border-amber-400/80" />
                            </span>
                          );
                        })()}
                    </div>
                  </div>
                );
              })}
              </div>
              <button
                type="button"
                aria-label="Drag the Variant container's end Step"
                // The container ends the way a Beat does: an amber edge, no
                // caption. It is still the handle for the split's end Step.
                // Raised above the next container: boxes sharing a lane sit
                // flush, and each container leans -my-1 into the seam, so a
                // later sibling's colour strip would otherwise cover this
                // handle and a grab meant for this box would drag that one.
                className={`relative z-10 h-1 shrink-0 touch-none border-t border-ink-600/60 bg-amber-400/70 ${editable ? "cursor-grab active:cursor-grabbing" : ""}`}
                title="Drag the Variant container's end Step"
                onPointerDown={(event) => {
                  if (!editable) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setVariantDrag({
                    gesture: ++nextGesture.current,
                    id: owner.id,
                    mode: "bottom",
                    grabbed: rowAt(event.clientY, visible),
                    lo,
                    hi,
                    from: [lo, hi],
                    moved: false,
                  });
                }}
                onPointerMove={(event) => {
                  if (variantDrag?.id !== owner.id || variantDrag.settling) return;
                  const row = rowAt(event.clientY, visible);
                  const lo = variantDrag.from[0];
                  const hi = Math.max(row, lo);
                  if (hi !== variantDrag.hi)
                    setVariantDrag({ ...variantDrag, lo, hi, moved: true });
                }}
                onPointerUp={() => endVariantDrag(owner, visible)}
                onPointerCancel={() => setVariantDrag(null)}
              />
            </div>
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
        <MechBox
          plan={plan}
          open={openMech}
          stepId={current.id}
          shown={shown}
          editingVariant={editingBeatVariant}
          run={run}
          onOpen={onOpenMech}
          onShow={setShown}
          onEditVariant={onEditBeatVariant}
          onFocusBeat={onFocusBeat}
          onDebuffs={onDebuffs}
        />
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

  return (
    <nav
      className="panel shrink-0 overflow-y-auto border-y-0 border-l-0 p-2"
      style={{ width: 236 + laid.laneWidths.reduce((total, width) => total + width + 4, 0) }}
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
                    setSectionDrag({
                      gesture: ++nextGesture.current,
                      id: mechanic.id,
                      at: index_,
                      moved: false,
                    });
                  }}
                  onClick={() => !dragged.current && go(visible[0])}
                  onDoubleClick={() => editable && setRenaming(mechanic.id)}
                >
                  <Chevron open={open} />
                  <span className="min-w-0 flex-1 truncate">{mechanicLabel(plan, mechanic)}</span>
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
  shown,
  editingVariant,
  run,
  onOpen,
  onShow,
  onEditVariant,
  onFocusBeat,
  onDebuffs,
}: {
  plan: Plan;
  open: Mech | null;
  stepId: string;
  shown: Record<string, string>;
  editingVariant: string | null;
  run(ops: Op | Op[]): Promise<{ values: unknown[]; plan: Plan }>;
  onOpen(id: string | null): void;
  onShow: Dispatch<SetStateAction<Record<string, string>>>;
  onEditVariant(id: string | null): void;
  onFocusBeat(id: string): void;
  onDebuffs(id: string): void;
}) {
  const stepVariantDestination =
    editingVariant && plan.variantModel === "step"
      ? stepVariantOwner(plan, editingVariant)
      : undefined;
  const beatLocation = open
    ? plan.steps.flatMap((ownerStep) =>
        stepVariants(ownerStep).flatMap((variant) =>
          variant.beats.includes(open.id) ? [{ ownerStep, variant }] : []
        )
      )[0]
    : undefined;
  const addBeatHere = async (debuff = false) => {
    // Minted here so the Beat is on the rail in the same paint as the click.
    const id = `mech_${crypto.randomUUID()}`;
    await run([
      { op: "add_mech", id, snap: stepId },
      ...(stepVariantDestination
        ? [
            {
              op: "assign_beats_to_step_variant" as const,
              stepId: stepVariantDestination.step.id,
              variantId: stepVariantDestination.variant.id,
              beatIds: [id],
            },
          ]
        : []),
    ]);
    onOpen(id);
    if (debuff) onDebuffs(id);
  };
  const previewed = open?.variants.length
    ? (open.variants.find(
        (variant) =>
          variant.id === (shown[open.id] ?? defaultBeatVariantSelections(plan)[open.id])
      ) ?? open.variants[0])
    : undefined;
  const editing = open?.variants.find((variant) => variant.id === editingVariant);
  const contentEdited = !!(editing && beatVariantContentEdited(plan, stepId, editing.id));
  const movement = editing ? beatVariantMovement(plan, stepId, editing.id) : {};
  const conflicts = open
    ? composeBeatVariantEntities(plan, stepId, shown).conflicts.filter((conflict) =>
        conflict.beatIds.includes(open.id)
      )
    : [];
  return (
    <div className="mt-2">
      <button
        className="btn w-full"
        title="A new Beat snapshotting in the Step you are on. Say where it resolves, then drop its Parts in."
        onClick={() => void addBeatHere()}
      >
        New Beat {stepVariantDestination ? `in ${stepVariantLabel(stepVariantDestination.step, stepVariantDestination.variant.id)}` : "here"}
      </button>
      <button
        className="btn mt-1 w-full"
        title="A Beat that deals the fight's debuffs onto role pools. While it is active, the party's tokens wear the deal."
        onClick={() => void addBeatHere(true)}
      >
        New debuff Beat here
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
              title="Delete this Beat and everything in it"
              onClick={() => {
                onOpen(null);
                void run({ op: "delete_mech", mechId: open.id });
              }}
            >
              ✕
            </button>
          </div>
          {plan.variantModel === "step" && (
            <div className="mt-2 border-t border-ink-600 pt-2">
            <label className="block">
              <span className="label mb-1 block">Location</span>
              <select
                className="field h-7 w-full py-0 text-xs"
                value={beatLocation ? `${beatLocation.ownerStep.id}:${beatLocation.variant.id}` : "shared"}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "shared") {
                    void run({
                      op: "assign_beats_to_step_variant",
                      stepId: beatLocation?.ownerStep.id ?? stepId,
                      beatIds: [open.id],
                    });
                    return;
                  }
                  const separator = value.indexOf(":");
                  const ownerStepId = value.slice(0, separator);
                  const variantId = value.slice(separator + 1);
                  onShow((current) => ({ ...current, [ownerStepId]: variantId }));
                  onFocusBeat(ownerStepId);
                  onEditVariant(variantId);
                  void run({
                    op: "assign_beats_to_step_variant",
                    stepId: ownerStepId,
                    variantId,
                    beatIds: [open.id],
                  });
                }}
              >
                <option value="shared">Shared</option>
                {plan.steps.flatMap((ownerStep) =>
                  stepVariants(ownerStep).map((variant) => (
                    <option key={variant.id} value={`${ownerStep.id}:${variant.id}`}>
                      {ownerStep.name || "Step"} › {stepVariantLabel(ownerStep, variant.id)}
                    </option>
                  ))
                )}
              </select>
              <span className="mt-1 block text-[10px] text-ink-400">
                Shared Beats sit outside the split. Boxed Beats appear only in that exclusive Variant.
              </span>
            </label>
            {stepVariantDestination && (() => {
              const movement = plan.steps.find((candidate) => candidate.id === stepId)
                ?.stepVariantMovement?.[stepVariantDestination.variant.id] ?? {};
              const count = Object.keys(movement).length;
              return (
                <div className="mt-2 flex items-center gap-2 rounded bg-ink-900/50 px-2 py-1.5 text-[11px]">
                  <span className={count ? "text-blue-200" : "text-ink-400"}>
                    Movement: {count ? `${count} actor${count === 1 ? "" : "s"} initialized` : "Following Shared"}
                  </span>
                  {count > 0 && (
                    <button
                      className="btn ml-auto h-6 py-0 text-[10px]"
                      title="Discard this box's movement at the current Step and follow Shared again"
                      onClick={() => void run({
                        op: "clear_step_variant_movement",
                        stepId,
                        variantId: stepVariantDestination.variant.id,
                      })}
                    >
                      Resync
                    </button>
                  )}
                </div>
              );
            })()}
            </div>
          )}
          {plan.variantModel === "beat" && (
            <div className="mt-2 border-t border-ink-600 pt-2" data-beat-variants={open.id}>
              <div className="label mb-1">Variants</div>
              <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${mechLabel(plan, open)} edit destination`}>
                <button
                  className={`rounded px-2 py-1 text-[11px] ${!editing ? "bg-blue-500/30 text-blue-100" : "bg-ink-800 text-ink-300"}`}
                  role="tab"
                  aria-selected={!editing}
                  onClick={() => {
                    onFocusBeat(open.id);
                    onEditVariant(null);
                  }}
                >
                  Beat
                </button>
                {open.variants.map((variant) => (
                  <button
                    key={variant.id}
                    data-beat-variant={variant.id}
                    className={`rounded px-2 py-1 text-[11px] ${editing?.id === variant.id ? "bg-blue-500/30 text-blue-100" : previewed?.id === variant.id ? "bg-ink-600 text-white" : "bg-ink-800 text-ink-300"}`}
                    role="tab"
                    aria-selected={editing?.id === variant.id}
                    title="Preview this mutually exclusive Variant and make it the explicit edit destination"
                    onClick={() => {
                      onFocusBeat(open.id);
                      onShow((current) => ({ ...current, [open.id]: variant.id }));
                      onEditVariant(variant.id);
                    }}
                  >
                    {beatVariantLabel(open, variant.id)}
                  </button>
                ))}
                <button
                  className="rounded bg-ink-800 px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-700"
                  title="Variants change only this Beat. Content and player movement remain shared until you edit them."
                  onClick={async () => {
                    const result = await run({ op: "add_beat_variant", beatId: open.id });
                    const made = result.values[0] as { id: string } | null;
                    if (!made) return;
                    onShow((current) => ({ ...current, [open.id]: made.id }));
                    onEditVariant(made.id);
                  }}
                >
                  {open.variants.length ? "+" : "+ Variant"}
                </button>
              </div>
              <div className="mt-2 space-y-1 rounded bg-ink-900/50 p-2 text-[11px]">
                <div>
                  <span className="text-ink-400">Previewing:</span>{" "}
                  {previewed ? beatVariantLabel(open, previewed.id) : "Beat only"}
                </div>
                <div>
                  <span className="text-ink-400">Editing:</span>{" "}
                  {editing ? `${mechLabel(plan, open)} › ${beatVariantLabel(open, editing.id)} › ${plan.steps.find((step) => step.id === stepId)?.name || "Step"}` : `${mechLabel(plan, open)} shared Parts`}
                </div>
                {editing && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-400">Content</span>
                      <span>{contentEdited ? "Edited independently" : "Following shared"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-ink-400">Movement</span>
                      <span className={conflicts.length ? "text-amber-300" : undefined}>
                        {conflicts.length
                          ? "Movement conflict"
                          : Object.keys(movement).length
                            ? `Overrides ${Object.keys(movement).length === 1 ? authoredEntitiesForStep(plan, stepId).find((entity) => entity.id === Object.keys(movement)[0])?.name || "1 actor" : `${Object.keys(movement).length} actors`}`
                            : "Uses Step positions"}
                      </span>
                    </div>
                    {contentEdited && (
                      <button
                        className="btn h-6 w-full py-0 text-[11px]"
                        title="Your content edits on this Step will be discarded."
                        onClick={() => {
                          if (window.confirm("Your content edits on this Step will be discarded."))
                            void run({ op: "resume_beat_variant_content", stepId, variantId: editing.id });
                        }}
                      >
                        Resume shared content
                      </button>
                    )}
                    {!!Object.keys(movement).length && (
                      <button
                        className="btn h-6 w-full py-0 text-[11px]"
                        title="Player movement owned by this Variant on this Step will be discarded."
                        onClick={() => {
                          if (window.confirm("Player movement owned by this Variant on this Step will be discarded."))
                            void run({ op: "clear_beat_variant_movement", stepId, variantId: editing.id });
                        }}
                      >
                        Clear Variant movement
                      </button>
                    )}
                    {(contentEdited || Object.keys(movement).length > 0) && (
                      <button
                        className="btn h-6 w-full py-0 text-[11px]"
                        onClick={() => {
                          if (window.confirm("Reset both content and movement for this Variant Step?"))
                            void run({ op: "reset_beat_variant_step", stepId, variantId: editing.id });
                        }}
                      >
                        Reset this Variant Step…
                      </button>
                    )}
                    <div className="flex gap-1">
                      <button
                        className="btn h-6 flex-1 py-0 text-[10px]"
                        onClick={() => {
                          const name = window.prompt("Variant name", editing.name);
                          if (name !== null)
                            void run({ op: "update_beat_variant", beatId: open.id, variantId: editing.id, patch: { name } });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="btn h-6 flex-1 py-0 text-[10px]"
                        onClick={async () => {
                          const result = await run({ op: "duplicate_beat_variant", beatId: open.id, variantId: editing.id });
                          const made = result.values[0] as { id: string } | null;
                          if (made) {
                            onShow((current) => ({ ...current, [open.id]: made.id }));
                            onEditVariant(made.id);
                          }
                        }}
                      >
                        Duplicate
                      </button>
                      <button
                        className="btn h-6 flex-1 py-0 text-[10px]"
                        disabled={open.variants.length <= 2}
                        title={open.variants.length <= 2 ? "Use the deliberate Collapse Variants flow for the final pair" : "Delete this Variant"}
                        onClick={() => void run({ op: "delete_beat_variant", beatId: open.id, variantId: editing.id })}
                      >
                        Delete
                      </button>
                    </div>
                    {open.variants.length >= 2 && (
                      <button
                        className="btn h-6 w-full py-0 text-[10px] text-amber-200"
                        title="End branching for this Beat and make this Variant the new Shared content and movement"
                        onClick={async () => {
                          const label = beatVariantLabel(open, editing.id);
                          if (
                            !window.confirm(
                              `Collapse all ${mechLabel(plan, open)} Variants? ${label} will become Shared at every Step. The other branches will be removed. This can be undone from history.`
                            )
                          )
                            return;
                          await run({
                            op: "collapse_beat_variants",
                            beatId: open.id,
                            variantId: editing.id,
                          });
                          onEditVariant(null);
                          onShow((current) => {
                            const next = { ...current };
                            delete next[open.id];
                            return next;
                          });
                        }}
                      >
                        Collapse Variants to {beatVariantLabel(open, editing.id)}…
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {/* Its colour is what tells its shapes apart from the next cast's. */}
          <div className="mt-2 flex gap-1">
            {MECH_COLORS.map((c) => (
              <button
                key={c}
                className={`h-4 w-4 rounded-sm ${
                  mechColor(plan, open) === c ? "ring-2 ring-white" : "hover:ring-1 hover:ring-white/60"
                }`}
                style={{ background: c }}
                title={`Draw this Beat in ${c}`}
                onClick={() =>
                  void run(
                    plan.variantModel === "beat" && editing
                      ? { op: "update_beat_variant_content", stepId, variantId: editing.id, patch: { color: c } }
                      : { op: "update_mech", mechId: open.id, patch: { color: c } }
                  )
                }
              />
            ))}
          </div>
          <p className="mt-1 text-ink-400">
            Drag the top half of its Beat card beside the Steps to move the snapshot, the bottom
            half to move where it resolves. F2 renames it.
          </p>
          <button
            className="btn mt-2 h-6 w-full py-0 text-[11px]"
            title="Deal the fight's debuffs onto role pools for this Beat"
            onClick={() => onDebuffs(open.id)}
          >
            {open.debuffs ? "edit the debuff deal" : "deal debuffs…"}
          </button>
          <button className="btn mt-1 h-6 w-full py-0 text-[11px]" onClick={() => onOpen(null)}>
            done editing Beat
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

function ShareButton({
  planId,
  canShare,
  isPublic,
  setIsPublic,
}: {
  planId: string;
  canShare: boolean;
  isPublic: boolean;
  setIsPublic: (isPublic: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const shareRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!shareRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!canShare) return null;

  const shareLink = new URL(`/p/${encodeURIComponent(planId)}`, window.location.origin).href;

  async function copyViewOnlyLink() {
    setBusy(true);
    setFeedback("");
    try {
      if (!isPublic) {
        await api.setPublic(planId, true);
        setIsPublic(true);
      }
      await navigator.clipboard.writeText(shareLink);
      setFeedback("View-only link copied");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not copy the link");
    } finally {
      setBusy(false);
      setOpen(true);
    }
  }

  async function copyEditLink() {
    setBusy(true);
    setFeedback("");
    try {
      const { url } = await api.createEditLink(planId);
      await navigator.clipboard.writeText(url);
      setFeedback("Edit-enabled link copied");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not create the edit link");
    } finally {
      setBusy(false);
      setOpen(true);
    }
  }

  return (
    <div ref={shareRef} className="relative flex">
      <button
        className="btn"
        disabled={busy}
        aria-label="Sharing options"
        aria-expanded={open}
        title="Share this plan"
        onClick={() => {
          setFeedback("");
          setOpen((value) => !value);
        }}
      >
        {busy ? "Sharing…" : "Share"}
      </button>
      {open && (
        <div
          className="panel absolute right-0 z-10 mt-1 w-[280px] rounded p-3"
          role="dialog"
          aria-label="Sharing options"
        >
          <button
            className="btn absolute right-2 top-2 px-2"
            aria-label="Close sharing options"
            title="Close"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
          {feedback && <p className="mb-2 text-xs text-ink-400">{feedback}</p>}
          <label className="mb-3 mr-8 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={async (e) => {
                const next = e.target.checked;
                setIsPublic(next);
                setFeedback("");
                try {
                  await api.setPublic(planId, next);
                } catch (error) {
                  setIsPublic(!next);
                  setFeedback(error instanceof Error ? error.message : "Could not update sharing");
                }
              }}
            />
            Anyone with the link can view
          </label>
          <div className="grid gap-2">
            <button className="btn w-full" disabled={busy} onClick={() => void copyViewOnlyLink()}>
              Copy view-only link
            </button>
            <button className="btn w-full" disabled={busy} onClick={() => void copyEditLink()}>
              Copy edit-enabled link
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Anyone with an edit-enabled link can change this plan. No sign-in required.
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
type DropTarget =
  | { at: "free" }
  | { at: "group"; group: GroupId }
  | { at: "source"; id: string }
  | { at: "entity"; id: string };

/** A glyph, so the palette reads as shapes rather than as four words. */
/**
 * The step's notes, on the floor itself: a card you drag to wherever this
 * step's story is happening. Its position is the step's own — every step can
 * park its notes somewhere else. Double-click to edit in place.
 */
function NotesCard({
  plan,
  step,
  size,
  editable,
  onMove,
  onEdit,
}: {
  plan: Plan;
  step: Step;
  size: number;
  editable: boolean;
  onMove(pos: { x: number; y: number }): Promise<unknown>;
  onEdit(notes: string): void;
}) {
  const scale = viewScale(plan.arena, size);
  const home = step.notesPos ?? {
    x: -plan.arena.width / 2 + 20,
    y: -plan.arena.height / 2 + 20,
  };
  /**
   * Uncommitted drag position, in arena units, so the card tracks the pointer.
   * The gesture token lets an older acknowledgement settle without clearing a
   * newer drag that started in the meantime.
   */
  const [held, setHeld] = useState<{
    x: number;
    y: number;
    gesture: number;
    settling?: boolean;
  } | null>(null);
  const nextGesture = useRef(0);
  const [editing, setEditing] = useState(false);
  const pos = held ?? home;
  if (!step.notes && !editing) return null;

  function beginDrag(ev: React.PointerEvent<HTMLDivElement>) {
    if (!editable || editing || ev.button !== 0) return;
    ev.preventDefault();
    const gesture = ++nextGesture.current;
    const { pointerId, clientX: startX, clientY: startY } = ev;
    // A fresh grab may replace a released gesture while its request settles.
    // Begin exactly where the card is painted, not at an older server pose.
    const from = held ?? home;
    let last = from;
    setHeld({ x: from.x, y: from.y, gesture });
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId || gesture !== nextGesture.current) return;
      last = {
        x: Math.round(from.x + (next.clientX - startX) / scale),
        y: Math.round(from.y + (next.clientY - startY) / scale),
      };
      setHeld({ ...last, gesture });
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId || gesture !== nextGesture.current) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (last.x === from.x && last.y === from.y) {
        setHeld((current) => (current?.gesture === gesture ? null : current));
        return;
      }
      // Keep the released preview mounted until the optimistic update and its
      // authoritative round trip have settled. Clearing it here would expose
      // the old notesPos for a frame on a slow connection.
      setHeld({ ...last, gesture, settling: true });
      const done = () =>
        setHeld((current) =>
          current?.gesture === gesture && current.settling ? null : current
        );
      void onMove(last).then(done, done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  return (
    <div
      data-step-notes={step.id}
      data-drag-settling={held?.settling || undefined}
      className={`absolute z-10 max-w-[45%] select-none rounded border border-ink-600/70 bg-ink-900/85 p-2 text-xs text-ink-100 shadow ${
        editable && !editing ? "cursor-grab touch-none active:cursor-grabbing" : ""
      }`}
      style={{ left: size / 2 + pos.x * scale, top: size / 2 + pos.y * scale }}
      title={editable ? "Drag to move. Double-click to edit" : undefined}
      onPointerDown={beginDrag}
      onDoubleClick={() => editable && setEditing(true)}
    >
      {editing ? (
        <textarea
          autoFocus
          className="field h-24 w-56 resize-none text-xs"
          defaultValue={step.notes}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== step.notes) onEdit(e.target.value);
          }}
        />
      ) : (
        <div className="whitespace-pre-wrap">{step.notes}</div>
      )}
    </div>
  );
}

function PaletteGlyph({ kind }: { kind: PaletteKind }) {
  const stroke = "#7aa2f7";
  return (
    <svg data-palette-glyph width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      {(kind === "boss" || kind === "add") && (
        <image
          href={assetUrl(kind === "boss" ? "actor/boss" : "actor/enemy")}
          x="1"
          y="1"
          width="28"
          height="28"
          preserveAspectRatio="xMidYMid meet"
        />
      )}
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
      {(kind === "together" || kind === "apart") && (
        <g fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 15 H27" />
          {kind === "together" ? (
            <>
              <path d="M7 10 l5 5 l-5 5 M23 10 l-5 5 l5 5" />
            </>
          ) : (
            <>
              <path d="M12 10 l-5 5 l5 5 M18 10 l5 5 l-5 5" />
            </>
          )}
        </g>
      )}
      {kind === "text" && (
        <text x="15" y="21" textAnchor="middle" fontSize="17" fontWeight="700" fill="#e8edf5">
          T
        </text>
      )}
      {kind === "arrow" && (
        <g fill="none" stroke="#e8edf5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 26 V6 M9 12 L15 5 L21 12" />
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
