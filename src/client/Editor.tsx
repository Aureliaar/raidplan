import type { Dispatch, MouseEvent as ReactMouseEvent, ReactNode, SetStateAction } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "agents/react";
import { api } from "./api";
import { navigate } from "./App";
import type { EditLayer, SceneContextTarget } from "./canvas/Scene";
import { Scene, VIEW_MARGIN, viewScale } from "./canvas/Scene";
import type { MenuItem } from "./ContextMenu";
import { ContextMenuHost, openContextMenu } from "./ContextMenu";
import { Inspector } from "./Inspector";
import { ChatPanel } from "./ChatPanel";
import { TimelineStrip } from "./TimelineStrip";
import {
  FORCED_COLLAPSE,
  TimelineModeSwitch,
  defaultTimelineMode,
  loadTimelineMode,
  saveTimelineMode,
  useViewportWidth,
  type TimelineMode,
} from "./timelineMode";
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
  BAIT_RULES,
  EntitySchema,
  MARKER_IDS,
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
  isLocked,
  mechLabel,
  MECH_COLORS,
  mechColor,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  resolveEntity,
  tetherEnds,
  tetherRide,
  variantColor,
  variantStepEdited,
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
  paletteGroups,
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
import { readViewParams, writeViewParams } from "./view-url";
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
  /**
   * What the link said to look at. Read once: from here on the address bar
   * follows the editor, not the other way round.
   */
  const [initialView] = useState(readViewParams);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [role, setRole] = useState<PlanRole>("viewer");
  /**
   * How much of the timeline is on screen. A preference of this browser, so it
   * is remembered and never written to the plan; the only thing that moves it
   * after load is a window too narrow to hold a rail at all.
   */
  const [storedMode] = useState(loadTimelineMode);
  const [chosenMode, setChosenMode] = useState<TimelineMode>(
    () => storedMode ?? defaultTimelineMode({ editable: true, width: window.innerWidth })
  );
  /** Whether this browser has ever said which size it wants. */
  const hasStoredMode = useRef(storedMode !== null);
  const modeSettled = useRef(false);
  const viewportWidth = useViewportWidth();
  const setMode = (next: TimelineMode) => {
    hasStoredMode.current = true;
    saveTimelineMode(next);
    setChosenMode(next);
  };
  const [stepIndex, setStepIndex] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.at(-1) ?? null;
  const setSelected = (id: string | null) => setSelection(id ? [id] : []);
  /**
   * Which side panel is up. Selecting something still asks for Details, so a
   * click and a drop both read as "and here it is" — but the tab is yours from
   * then on: Add comes back while the selection stands, which is what lets you
   * read a zone's numbers and then reach the palette without having to drop the
   * selection first. The next thing you select asks again.
   */
  const [panelTab, setPanelTab] = useState<"add" | "details">("add");
  /** A pick on the floor: it opens Details even when it lands on what was already selected. */
  const pick = (ids: string[]) => {
    setSelection(ids);
    // Letting the floor go puts the choice back to Add rather than leaving
    // Details remembered and waiting to spring back at the next selection.
    setPanelTab(ids.length ? "details" : "add");
  };
  /**
   * The last thing selected by opening a Beat. Opening one is also how you
   * fill it, so the panel stays where it was — the Parts come up selected and
   * Details is one Tab away, rather than the palette being taken off you.
   */
  const beatPick = useRef<string | null>(null);
  // Whatever put a new thing under the selection — a click, a drop, a paste,
  // a right-click on its way to the menu — says what it is. Everything after
  // that is the tab you last chose.
  useEffect(() => {
    if (selected && selected !== beatPick.current) setPanelTab("details");
  }, [selected]);
  const [symmetryCount, setSymmetryCount] = useState<SymmetryCount>(1);
  const [symmetryKind, setSymmetryKind] = useState<SymmetryKind>("mirror");
  /**
   * Which reading of each mechanic is on screen, by mechanic id. Purely what
   * you are looking at — nobody else's plan changes because you flipped to
   * "Far first" — so it lives here and is never written to the document. It
   * decides what the canvas draws, because a shared step can hold a different
   * set of positions in each reading.
   */
  const [shown, setShown] = useState<Record<string, string>>(initialView.shown);
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
  /**
   * The editing aids that decide for you, each switchable when it is in the
   * way: snapping (radial spokes and rings, round rotations and spreads, an
   * offset dropped home), and a palette drop binding to whatever it lands on.
   */
  const [assists, setAssists] = useState({ snap: true, bind: true });
  /** Starts a selection sweep from beside the canvas; the Scene fills it in. */
  const sweep = useRef<((ev: MouseEvent) => void) | null>(null);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
      const key = ev.key.toLowerCase();
      if (key === "e" || key === "r") {
        ev.preventDefault();
        setAssists((on) => (key === "e" ? { ...on, snap: !on.snap } : { ...on, bind: !on.bind }));
        return;
      }
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
    /** Held over a player: it will sit on them, so no mirrored copies. */
    bound?: boolean;
  } | null>(null);
  /** What letting go right here would do, said next to the pointer. */
  const [dropHint, setDropHint] = useState<{
    intent: DropIntent;
    clientX: number;
    clientY: number;
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
  const [mech, setMech] = useState<string | null>(initialView.mech);
  /** Explicit edit destination inside the selected Beat; preview is separate. */
  const [editingBeatVariant, setEditingBeatVariant] = useState<string | null>(null);
  /** Last preview chip focused; A/D may use it without changing edit destination. */
  const [focusedBeat, setFocusedBeat] = useState<string | null>(null);
  /** How wide the arena came out, so the strip under it is the arena's width. */
  const [arenaSize, setArenaSize] = useState(600);
  /** The debuff mech whose deal is open in the popup, if any. */
  const [debuffFor, setDebuffFor] = useState<string | null>(null);
  /** The fights the debuff library holds, so the encounter field names one. */
  const [fightLibrary, setFightLibrary] = useState<FightLibraryEntry[]>([]);
  /**
   * Which header name is a field right now. The title and the encounter read
   * as text until you click them, so the top row stays one line of reading
   * rather than two boxes asking to be filled in.
   */
  const [headerEditing, setHeaderEditing] = useState<"name" | "encounter" | null>(null);
  /** The value the field opened with, so Escape can put it back. */
  const headerBefore = useRef("");
  /** Set by Escape so the unmount's blur does not commit the abandoned text. */
  const headerCancelled = useRef(false);
  /** One-shot: the link decides the first Step, and after that the editor does. */
  const viewRestored = useRef(false);
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
    // The linked Step is resolved with the first plan that arrives, in the same
    // batch as it, so nothing ever renders — or reacts — at Step 1 first.
    if (!viewRestored.current) {
      viewRestored.current = true;
      const at = visible.steps.findIndex((s) => s.id === initialView.step);
      if (at >= 0) setStepIndex(at);
    }
    setPlan(visible);
  }, [initialView]);

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
  // The default is decided once, when the plan arrives and says whether you may
  // edit it. From then on only the switch moves it.
  useEffect(() => {
    if (modeSettled.current || !plan) return;
    modeSettled.current = true;
    if (!hasStoredMode.current)
      setChosenMode(defaultTimelineMode({ editable, width: window.innerWidth }));
  }, [plan, editable]);
  /** A window this narrow has no room for a rail, whatever the preference says. */
  const timelineMode: TimelineMode =
    viewportWidth < FORCED_COLLAPSE ? "collapsed" : chosenMode;
  const collapsed = timelineMode === "collapsed";
  /**
   * Collapsed is a mode for reading, not a permission: the plan is as editable
   * as it ever was, but this view of it puts every tool away. Everything that
   * would change the document asks this rather than `editable`, so switching
   * back to Normal hands the tools straight back.
   */
  const canEdit = editable && !collapsed;
  const narrow = viewportWidth < FORCED_COLLAPSE;
  const step = plan?.steps[Math.min(stepIndex, (plan?.steps.length ?? 1) - 1)];

  /**
   * The address bar mirrors where you are looking, so F5 lands back on this
   * frame and the link hands it to someone else. Readings of Variant splits
   * that no longer exist are dropped rather than carried along.
   */
  useEffect(() => {
    if (!plan) return;
    const owners = new Map(
      plan.steps.map((owner) => [owner.id, new Set(stepVariants(owner).map((v) => v.id))])
    );
    const shownNow = Object.fromEntries(
      Object.entries(shown).filter(([owner, variant]) => owners.get(owner)?.has(variant))
    );
    writeViewParams({ step: step?.id ?? null, mech, shown: shownNow });
  }, [plan, step?.id, mech, shown]);

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
        const activeStepId = viewedStepId;
        const activeVariant = viewedVariant;
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
          // Waymarks are plan-wide even while the editor edits one step.
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
    [planId, symmetryCount, symmetryKind, shown, step?.id, showServerPlan, mech, editingBeatVariant]
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
    if (!canEdit) return;
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
  }, [canEdit]);

  /**
   * Tab swaps the side panel, \ steps through the Variant boxes of the split
   * you are previewing. Both are "show me the other one", and neither writes
   * anything: what you are looking at is yours, not the plan's.
   */
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "Tab") {
        // With nothing selected there is no Details to switch to, so Tab stays
        // out of the way and goes on walking the focus ring.
        if (!selection.length || layer === "markers") return;
        ev.preventDefault();
        setPanelTab((tab) => (tab === "add" ? "details" : "add"));
        return;
      }
      if (ev.key !== "\\" || !plan || !step) return;
      // The split you last touched is the one that walks; with none focused it
      // is the first one on screen, which is the only one when there is one.
      const previews = activeStepVariants(plan, step.id, shown);
      const target = previews.find((p) => p.ownerStepId === focusedBeat) ?? previews[0];
      if (!target) return;
      const boxes = stepVariants(target.step);
      if (boxes.length < 2) return;
      ev.preventDefault();
      const at = boxes.findIndex((box) => box.id === target.variant.id);
      setFocusedBeat(target.ownerStepId);
      setShown((current) => ({
        ...current,
        [target.ownerStepId]: boxes[(at + 1) % boxes.length].id,
      }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, selection.length, layer, plan, step, shown, focusedBeat]);

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
    if (!canEdit) return;
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
          // A locked thing is only in the selection because it was right-clicked,
          // and a stray key is exactly the touch the lock is there to stop.
          const drawn = plan ? entitiesForStep(plan, step?.id, undefined, shown) : [];
          const loose = selection.filter((id) => {
            const e = drawn.find((candidate) => candidate.id === id);
            return !e || !isLocked(plan!, e);
          });
          if (loose.length !== selection.length) setNote("Locked — right-click it to unlock");
          if (!loose.length) return;
          setSelected(null);
          void run({ op: "delete_entities", ids: loose });
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
    canEdit,
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
  /**
   * Details only ever has a floor object to talk about — waymarks are moved,
   * not edited — so with nothing selected the tab is out and Add is what shows,
   * without the chosen tab having to be reset behind your back.
   */
  const detailsReady = !!selectedEntity && layer !== "markers";
  const sideTab = detailsReady && panelTab === "details" ? "details" : "add";
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
  /**
   * The player whose token is under a point. A mechanic let go exactly on
   * somebody is theirs: it binds to them instead of landing on the floor.
   */
  function playerAt(pt: { x: number; y: number }): PlayerEntity | undefined {
    return entitiesForStep(plan!, step!.id, undefined, shown)
      .filter(
        (e): e is PlayerEntity =>
          e.type === "player" && Math.hypot(e.x - pt.x, e.y - pt.y) <= (e.size / 2) * e.scale
      )
      .sort((a, b) => Math.hypot(a.x - pt.x, a.y - pt.y) - Math.hypot(b.x - pt.x, b.y - pt.y))[0];
  }

  /** Where a palette item let go at this point means to go, short of a group chip. */
  function floorTarget(kind: PaletteKind, pt: { x: number; y: number }): DropTarget {
    const tetherEnd = isPaletteTether(kind) ? tetherEndAt(pt) : undefined;
    if (tetherEnd) return { at: "entity", id: tetherEnd };
    // A tether is nothing without its ends, so only the rest can be told to
    // land where they are let go.
    if (!assists.bind) return { at: "free" };
    const player = !isPaletteTether(kind) ? playerAt(pt) : undefined;
    if (player) return { at: "actors", ids: [player.id] };
    const on = sourceAt(pt);
    if (on) return { at: "source", id: on };
    const rode = ridesTethers(kind) ? tetherAt(pt) : undefined;
    return rode ? { at: "tether", id: rode } : { at: "free" };
  }

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
      playing ? authoredEntitiesForStep(current, step!.id, playing) : current.entities;
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
      playing ? authoredEntitiesForStep(current, step!.id, playing) : current.entities;
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
            ? entity.shape === "rect" || entity.shape === "line" || entity.shape === "knockback" || entity.shape === "arrow" || entity.shape === "cross"
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

  /** The tether a shape was let go on: the nearest whose line passes within reach. */
  function tetherAt(pt: { x: number; y: number }): string | undefined {
    const reach = 30;
    const scene = entitiesForStep(plan!, step!.id, undefined, shown);
    const byId = new Map(scene.map((e) => [e.id, e]));
    let best: { id: string; d: number } | undefined;
    for (const e of scene) {
      if (e.type !== "tether") continue;
      const ends = tetherEnds(e, byId);
      if (!ends) continue;
      const dx = ends.to.x - ends.from.x;
      const dy = ends.to.y - ends.from.y;
      const len2 = dx * dx + dy * dy;
      const t = len2
        ? Math.max(0, Math.min(1, ((pt.x - ends.from.x) * dx + (pt.y - ends.from.y) * dy) / len2))
        : 0;
      const d = Math.hypot(ends.from.x + t * dx - pt.x, ends.from.y + t * dy - pt.y);
      if (d <= reach && (!best || d < best.d)) best = { id: e.id, d };
    }
    return best?.id;
  }

  /** Zone shape each mechanic tile lands as — used to count what a source has. */
  const SHAPE_OF: Record<PaletteMechanicKind, string> = {
    circle: "circle",
    donut: "donut",
    plus: "cross",
    x: "cross",
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
    // One on each of the people you picked. They are not a group's set, so
    // there is no bond: each one stands alone, the way a bait added from the
    // inspector does, and is edited on its own.
    if (target.at === "actors") {
      const people = authoredScene.filter(
        (e) => target.ids.includes(e.id) && (e.type === "player" || e.type === "enemy")
      );
      const named = (p: (typeof people)[number]) =>
        p.name || (p.type === "player" ? jobLabel(p.job) : "the enemy");
      if (isPaletteTether(kind)) {
        // A tether is a relationship: two people selected are its two ends.
        if (people.length !== 2) return setError("Select the two ends of the tether");
        const beat = beatForDrop(PALETTE_LABEL[kind]);
        const res = await run([
          ...beat.ops,
          {
            op: "add_entity",
            spec: {
              type: "tether",
              from: people[0].id,
              to: people[1].id,
              style: kind === "together" ? "close" : "far",
              range: defaultTetherRange(kind),
              width: 8,
              name: `${PALETTE_LABEL[kind]}: ${named(people[0])} ↔ ${named(people[1])}`,
              ...stamp(beat),
            } as never,
          },
        ]);
        const tied = res.values[beat.ops.length] as { id: string } | null;
        setSelected(tied?.id ?? null);
        return;
      }
      if (!people.length) return setError("Select who this should be on");
      const host = paletteNeedsSource(kind) ? enemyForAimed() : undefined;
      const beat = beatForDrop(PALETTE_LABEL[kind], host);
      const source = paletteNeedsSource(kind) ? sourceInBeat(host, beat) : undefined;
      const res = await run([
        ...beat.ops,
        ...(source?.ops ?? []),
        ...people.map((p) => ({
          op: "add_entity" as const,
          spec: paletteBait(kind, p.id, source?.id, {
            name: `${PALETTE_LABEL[kind]} on ${named(p)}`,
            ...stamp(beat),
          }) as never,
        })),
      ]);
      const first = res.values[beat.ops.length + (source?.ops.length ?? 0)] as { id: string } | null;
      setSelected(people.length === 1 ? (first?.id ?? null) : null);
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
    if (target.at === "tether") {
      await rideTethers(kind, [target.id]);
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

  /**
   * An aimed shape riding each of these tethers: fired from one end through the
   * other (see `tetherRide`), and following the tether when it is re-paired.
   * Each goes into its tether's own Beat, so the two share one timing and hold
   * the same pose once the Beat freezes.
   */
  async function rideTethers(kind: PaletteMechanicKind, ids: string[]) {
    const byId = new Map(entitiesForStep(plan!, step!.id, undefined, shown).map((e) => [e.id, e]));
    const rides = ids.flatMap((id) => {
      const ride = tetherRide(id, byId);
      return ride ? [ride] : [];
    });
    if (!rides.length) return setError("Pick a tether with something on the floor at both ends");
    const loose = rides.some((ride) => !ride.tether.mech) ? beatForDrop(PALETTE_LABEL[kind]) : undefined;
    const label = (e: Entity) => e.name || (e.type === "player" ? jobLabel(e.job) : e.type);
    const made = rides.map((ride) => {
      const spec = paletteBait(kind, ride.to.id, ride.from.id, {
        name: `${PALETTE_LABEL[kind]}: ${label(ride.from)} → ${label(ride.to)}`,
        declaredIn: step!.id,
        mech: ride.tether.mech ?? loose!.mech,
      });
      // The tether is the whole binding. Named ends of its own would go stale
      // when it is re-paired, and take it down with a player who left.
      const { extend } = spec.anchor as { extend?: boolean };
      return { ...spec, id: `zone_${crypto.randomUUID()}`, anchor: { along: ride.tether.id, extend } };
    });
    await run([
      ...(loose?.ops ?? []),
      ...made.map((spec) => ({ op: "add_entity" as const, spec: spec as never })),
    ]);
    setSelected(made.length === 1 ? made[0].id : null);
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

  /**
   * The same bargain for an add made from the sidebar rather than the floor.
   * A panel has no drop point but it still makes a Part, so it gets the Beat
   * and the stamp from here instead of inventing a Beat-less shape.
   */
  function beatForPart(name: string, host?: Entity): { ops: Op[]; stamp: PropBag } {
    const beat = beatForDrop(name, host);
    return { ops: beat.ops, stamp: stamp(beat) };
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
          stepId: step!.id,
          variant: plan!.variantModel === "beat" ? editingVariant : playing,
        };
      })
    );
  }

  /**
   * Opening a Beat points at everything in it: the card *is* the set, so its
   * Parts on this step come up selected and can be restyled, carried or
   * deleted in one go. Closing it leaves the selection where it is.
   */
  function openBeat(id: string | null) {
    if (id !== mech) setEditingBeatVariant(null);
    setMech(id);
    if (!id) return;
    setFocusedBeat(id);
    selectBeatParts(id);
  }

  /** Everything this Beat has on the floor in this step, under the selection. */
  function selectBeatParts(id: string) {
    const parts = authoredScene.filter((entity) => entity.mech === id);
    beatPick.current = parts.at(-1)?.id ?? null;
    setSelection(parts.map((part) => part.id));
  }

  /* -------------------------------------------------- the right-click menu */

  /**
   * A right-click anywhere on the floor. The menu is built from the plan as it
   * stands right now, not from React state that has yet to re-render: the Scene
   * has already told us what is under the pointer and whether it kept a
   * multi-selection, so the reading here has to match that same instant.
   *
   * Every mutating row is one `run()` call and nothing else, so it takes the
   * same optimistic path — and the same release contract — as a drag.
   */
  function onCanvasContextMenu(target: SceneContextTarget) {
    if (!canEdit) return;
    const items =
      target.kind === "floor"
        ? floorMenuItems(target.arenaPoint)
        : entityMenuItems(target.id);
    openContextMenu(target.point, items);
  }

  /** A Beat minted here so a Part can be moved into one that does not exist yet. */
  function newBeatForStep(): { mech: string; ops: Op[] } {
    const id = `mech_${crypto.randomUUID()}`;
    return { mech: id, ops: [{ op: "add_mech", id, snap: step!.id, plain: true }] };
  }

  /** The Beats on the floor in this step, minus the one the set is already in. */
  function moveToBeatItem(partIds: string[]): MenuItem {
    const inBeats = new Set(
      partIds.map((id) => authoredScene.find((e) => e.id === id)?.mech).filter(Boolean)
    );
    const others = plan!.mechs.filter(
      (m) => mechSpan(plan!, m).includes(step!.id) && !(inBeats.size === 1 && inBeats.has(m.id))
    );
    return {
      label: "Move to Beat…",
      disabled: !partIds.length,
      children: [
        ...others.map((m) => ({
          label: mechLabel(plan!, m),
          onSelect: () => void run({ op: "assign_mech", ids: partIds, mechId: m.id }),
        })),
        ...(others.length ? [{ separator: true } as MenuItem] : []),
        {
          label: "New Beat",
          onSelect: () => {
            const beat = newBeatForStep();
            void run([...beat.ops, { op: "assign_mech", ids: partIds, mechId: beat.mech }]);
          },
        },
      ],
    };
  }

  /** One aimed shape riding each of these tethers, in whichever kind is picked. */
  const anchorToTethersItem = (tetherIds: string[], label: string): MenuItem => ({
    label,
    disabled: !tetherIds.length,
    children: RIDERS.map((kind) => ({
      label: PALETTE_LABEL[kind],
      onSelect: () => void rideTethers(kind, tetherIds),
    })),
  });

  const reorderItems = (id: string): MenuItem[] => [
    { label: "Send to back", onSelect: () => void run({ op: "reorder_entity", id, where: "back" }) },
    { label: "Bring to front", onSelect: () => void run({ op: "reorder_entity", id, where: "front" }) },
  ];

  /**
   * The one way back from a lock. A Part of a locked Beat is let go by
   * unlocking the Beat, since that is what is holding it.
   */
  function lockItem(entity: Entity): MenuItem {
    if (entity.locked)
      return {
        label: "Unlock",
        onSelect: () => void run({ op: "update_entity", id: entity.id, patch: { locked: false } }),
      };
    const beat = entity.mech ? plan!.mechs.find((m) => m.id === entity.mech) : undefined;
    if (beat?.locked)
      return {
        label: "Unlock Beat",
        onSelect: () => void run({ op: "update_mech", mechId: beat.id, patch: { locked: false } }),
      };
    return {
      label: "Lock",
      onSelect: () => {
        setSelected(null);
        void run({ op: "update_entity", id: entity.id, patch: { locked: true } });
      },
    };
  }

  const deleteItem = (ids: string[]): MenuItem => ({
    label: "Delete",
    danger: true,
    onSelect: () => {
      setSelected(null);
      void run({ op: "delete_entities", ids });
    },
  });

  function entityMenuItems(id: string): MenuItem[] {
    // The Scene keeps a multi-selection when the right-click landed inside it,
    // and otherwise has just made this the selection.
    const ids = selection.includes(id) && selection.length > 1 ? selection : [id];
    if (ids.length > 1) return multiMenuItems(ids);
    const entity =
      authoredScene.find((e) => e.id === id) ?? plan!.entities.find((e) => e.id === id);
    if (!entity) return [];
    if (entity.type === "marker")
      return [
        { heading: "Waymark" },
        lockItem(entity),
        { label: "Duplicate", onSelect: () => void run({ op: "duplicate_entity", id }) },
        ...reorderItems(id),
        { separator: true },
        deleteItem([id]),
      ];
    if (isActor(entity)) {
      const base = plan!.entities.find((e) => e.id === id);
      const overridden =
        !!base?.overrides?.[step!.id] ||
        (!!editingVariant && variantStepEdited(plan!, step!.id, editingVariant));
      return [
        { heading: entity.type === "player" ? "Player" : "Enemy" },
        lockItem(entity),
        {
          label: "Clear override on this step",
          disabled: !overridden,
          onSelect: () =>
            void run({
              op: "clear_override",
              id,
              stepId: step!.id,
              variant: editingVariant ?? playing,
            }),
        },
        {
          label: "Duplicate",
          // A player is one person in the party; there is no second of them.
          disabled: entity.type === "player",
          onSelect: () => void run({ op: "duplicate_entity", id }),
        },
        ...reorderItems(id),
        { separator: true },
        deleteItem([id]),
      ];
    }
    const anchor = entity.anchor;
    const players = authoredScene.filter((e) => e.type === "player");
    const ride = anchor?.along
      ? tetherRide(anchor.along, new Map(entitiesForStep(plan!, step!.id, undefined, shown).map((e) => [e.id, e])))
      : undefined;
    // Choosing a target for a shape that rides a tether cuts it loose: it keeps
    // firing from the end it fired from, at whoever is chosen now.
    const retarget = (next: Partial<NonNullable<Entity["anchor"]>>) =>
      void run({
        op: "update_entity",
        id,
        patch: {
          anchor: { ...anchor, ...(anchor?.along ? { along: undefined, from: ride?.from.id } : {}), ...next },
        },
      });
    return [
      { heading: "Part" },
      lockItem(entity),
      moveToBeatItem([id]),
      ...(entity.type === "tether" ? [anchorToTethersItem([id], "Anchor to tether")] : []),
      ...(anchor
        ? [
            {
              label: "Target",
              children: [
                ...(anchor.along ? [{ label: "Along its tether", checked: true, disabled: true }] : []),
                ...BAIT_RULES.map((rule) => ({
                  label: rule === "closest" ? "Closest" : "Farthest",
                  checked: !anchor.along && anchor.pick === rule,
                  onSelect: () => retarget({ pick: rule }),
                })),
                ...(players.length ? [{ separator: true } as MenuItem] : []),
                ...players.map((p) => ({
                  label: (p.name || (p.type === "player" ? jobLabel(p.job) : p.type)) as string,
                  checked: !anchor.along && !anchor.pick && anchor.to === p.id,
                  onSelect: () => retarget({ pick: undefined, to: p.id }),
                })),
              ],
            } as MenuItem,
          ]
        : []),
      { label: "Duplicate", onSelect: () => void run({ op: "duplicate_entity", id }) },
      ...reorderItems(id),
      { separator: true },
      deleteItem([id]),
    ];
  }

  function multiMenuItems(ids: string[]): MenuItem[] {
    const chosen = ids.flatMap((id) => {
      const found = authoredScene.find((candidate) => candidate.id === id);
      return found ? [found] : [];
    });
    const parts = chosen.filter((e) => e.type !== "marker" && !isActor(e)).map((e) => e.id);
    // A player is one person in the party; duplicating the set skips them.
    const copyable = chosen.filter((e) => e.type !== "player").map((e) => e.id);
    const drawn = entitiesForStep(plan!, step!.id, undefined, shown);
    const tethers = ids.filter((id) => drawn.some((e) => e.id === id && e.type === "tether"));
    return [
      { heading: `${ids.length} selected` },
      {
        label: "Lock",
        onSelect: () => {
          setSelected(null);
          void run(ids.map((id) => ({ op: "update_entity" as const, id, patch: { locked: true } })));
        },
      },
      moveToBeatItem(parts),
      anchorToTethersItem(tethers, "Anchor to each tether"),
      {
        label: "Duplicate",
        disabled: !copyable.length,
        onSelect: () =>
          void run(copyable.map((id) => ({ op: "duplicate_entity" as const, id }))),
      },
      { separator: true },
      deleteItem(ids),
    ];
  }

  /** Bare floor: what can be made right there, and the one party-wide arrangement. */
  function floorMenuItems(pt: { x: number; y: number }): MenuItem[] {
    const made = (label: string, kind: PaletteKind): MenuItem => ({
      label,
      onSelect: () => void drop(kind, pt, { at: "free" }),
    });
    return [
      { heading: "Floor" },
      {
        label: "Add here…",
        children: [
          made("Zone", "circle"),
          made("Bait", "stack4"),
          made("Text", "text"),
          {
            label: "Icon",
            onSelect: () => {
              const beat = beatForDrop("Icon");
              void run([
                ...beat.ops,
                {
                  op: "add_entity",
                  spec: {
                    type: "icon",
                    src: "marker/attack1",
                    size: 80,
                    x: pt.x,
                    y: pt.y,
                    ...stamp(beat),
                  } as never,
                },
              ]);
            },
          },
          {
            // A waymark belongs to the whole plan, not to a Beat: it is the
            // floor's own label, so it is made bare and lettered in order.
            label: "Marker",
            onSelect: () => {
              const used = new Set(
                plan!.entities.flatMap((e) => (e.type === "marker" ? [e.marker] : []))
              );
              const next = MARKER_IDS.find((m) => !used.has(m)) ?? "A";
              void run({
                op: "add_entity",
                spec: { type: "marker", marker: next, x: pt.x, y: pt.y },
              });
            },
          },
        ],
      },
      { separator: true },
      {
        label: "Arrange party",
        onSelect: () =>
          void run({
            op: "arrange_party",
            stepId: step!.id,
            variant: plan!.variantModel === "beat" ? editingVariant : playing,
          }),
      },
    ];
  }

  /**
   * A palette chip's menu. Dragging is still how you say *where*, so this is
   * for the two drops the hand is bad at: straight to the middle of the arena,
   * and onto a whole group without hunting for its card on the drop rail.
   * Both are the same call the drop makes, so a chip can never do more here
   * than it can do by hand.
   */
  function paletteChipItems(kind: PaletteKind): MenuItem[] {
    const frozen = layer !== "step";
    // A tether is two ends: there is nothing to put in the middle of the floor.
    const placeable = !isPaletteTether(kind);
    // Cosmetics sit where they are put, and sources are the thing a bait comes
    // out of rather than something bound to people.
    const binds = !isPaletteCosmetic(kind) && !isPaletteSource(kind);
    const people = authoredScene.filter(
      (e) => selection.includes(e.id) && (e.type === "player" || e.type === "enemy")
    );
    // The row says who it means, so a greyed one reads as "nobody is picked"
    // rather than leaving you to guess what "selected" covers.
    const who =
      people.length === 1
        ? people[0].name ||
          (people[0].type === "player" ? jobLabel(people[0].job) : "the enemy")
        : people.length
          ? `${people.length} selected`
          : "selected";
    return [
      { heading: PALETTE_LABEL[kind] },
      {
        label: "Add at the centre",
        disabled: frozen || !placeable,
        onSelect: () => void drop(kind, { x: 0, y: 0 }, { at: "free" }),
      },
      ...(binds
        ? [
            {
              label: `Add on ${who}`,
              // A tether is the one thing that needs exactly two: it is the
              // relationship between them, not a copy on each.
              disabled:
                frozen ||
                (isPaletteTether(kind) ? people.length !== 2 : !people.length),
              onSelect: () =>
                void drop(kind, { x: 0, y: 0 }, { at: "actors", ids: people.map((p) => p.id) }),
            } as MenuItem,
          ]
        : []),
    ];
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
      symmetryCount > 1 && !palettePreview.bound
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
  /**
   * The full-size preview for a palette item held at a point. Over a player it
   * sits on them, as it will once let go; bound to a source or a tether its
   * final pose depends on the target, so only the free-floor shape is shown.
   */
  function previewAt(kind: PaletteKind, pt: { x: number; y: number }): typeof palettePreview {
    if (isPaletteCosmetic(kind) || isPaletteSource(kind)) return { kind, x: pt.x, y: pt.y };
    const target = floorTarget(kind, pt);
    if (target.at === "free") return { kind, x: pt.x, y: pt.y };
    if (target.at !== "actors" || paletteNeedsSource(kind)) return null;
    const player = playerAt(pt)!;
    return { kind, x: player.x, y: player.y, bound: true };
  }

  /**
   * Which of the three a drop onto this target is. On an enemy or a bait
   * anchor a mechanic is baited: whoever the game would pick gets it, and it
   * re-picks as the party moves. On a player, or everyone in a group, it is
   * anchored: that person has it wherever they go. Anywhere else, neither.
   */
  function dropIntent(kind: PaletteKind, target: DropTarget): DropIntent {
    const scene = entitiesForStep(plan!, step!.id, undefined, shown);
    const named = (id: string) => {
      const e = scene.find((candidate) => candidate.id === id);
      if (!e) return "it";
      if (e.type === "player") return e.name || jobLabel(e.job);
      if (e.type === "enemy") return e.name || (e.role === "anchor" ? "the bait anchor" : "the enemy");
      return e.name || e.type;
    };
    const ring = (id: string): DropIntent["ring"] => {
      const e = scene.find((candidate) => candidate.id === id);
      if (!e || !("size" in e)) return undefined;
      const r = e.type === "enemy" ? e.size * 0.9 * e.scale : (e.size / 2) * e.scale + 12;
      return { x: e.x, y: e.y, r };
    };
    // An aimed shape still has to come out of something: the biggest enemy
    // there is, or a bait anchor put in the middle for it.
    const aimedFrom = () => {
      if (!paletteNeedsSource(kind)) return "";
      const host = enemyForAimed();
      return `, fired from ${host ? named(host.id) : "a new bait anchor"}`;
    };
    const none = (detail: string, blocked = false): DropIntent => ({ mode: "none", detail, blocked });
    if (isPaletteSource(kind) || isPaletteCosmetic(kind)) return none("on the floor");
    switch (target.at) {
      case "free":
        if (isPaletteTether(kind)) return none("a tether needs an object to start from", true);
        return none(
          `${symmetryCount > 1 ? `on the floor, mirrored ×${symmetryCount}` : "on the floor"}${
            assists.bind ? "" : " · baiting & anchoring off (R)"
          }`
        );
      case "actors":
        return { mode: "anchor", detail: `to ${named(target.ids[0])}${aimedFrom()}`, ring: ring(target.ids[0]) };
      case "group": {
        if (isPaletteTether(kind)) {
          if (target.group !== "supports" && target.group !== "damagers")
            return none("player tethers go on Supports or Damagers", true);
          return { mode: "anchor", detail: "each support tethered to a damager" };
        }
        const people = membersOf(target.group).length;
        if (!people) return none(`no ${GROUP_LABEL[target.group]} in this step`, true);
        return { mode: "anchor", detail: `one each to ${GROUP_LABEL[target.group]} (${people})${aimedFrom()}` };
      }
      case "source": {
        if (isPaletteTether(kind))
          return { mode: "anchor", detail: `tethered to ${named(target.id)}, then pick the other end`, ring: ring(target.id) };
        const already = authoredScene.find(
          (e) =>
            e.type === "zone" &&
            e.shape === SHAPE_OF[kind] &&
            e.anchor?.pick &&
            (e.anchor.from === target.id || e.anchor.near === target.id)
        );
        const count = (already?.anchor?.count ?? 0) + 1;
        if (count > 8) return { ...none("one bait covers at most eight", true), ring: ring(target.id) };
        return {
          mode: "bait",
          detail:
            count > 1
              ? `widens to the ${count} closest to ${named(target.id)}`
              : `on whoever is closest to ${named(target.id)}`,
          ring: ring(target.id),
        };
      }
      case "tether":
        return { mode: "bait", detail: `down ${named(target.id)}, on whoever it holds` };
      case "entity":
        return { mode: "anchor", detail: `tethered to ${named(target.id)}, then pick the other end`, ring: ring(target.id) };
    }
  }

  paletteMoveRef.current = (kind, clientX, clientY) => {
    const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const group = under?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup as GroupId | undefined;
    const onGroup = !!group && kind !== "anchor" && !isPaletteCosmetic(kind);
    setHover(onGroup ? group! : null);
    // The rail hangs over the arena, so "everyone gets one" and "one lands
    // here" are the same pixels. Over the rail it is the group that is meant.
    if (onGroup) {
      setPalettePreview(null);
      setDropHint({ intent: dropIntent(kind, { at: "group", group: group! }), clientX, clientY });
      return;
    }
    const box = stageBox.current?.getBoundingClientRect();
    if (!box || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
      setPalettePreview(null);
      setDropHint(null);
      return;
    }
    const pt = arenaPointAt(clientX, clientY);
    setPalettePreview(previewAt(kind, pt));
    const target: DropTarget = isPaletteCosmetic(kind) ? { at: "free" } : floorTarget(kind, pt);
    setDropHint({ intent: dropIntent(kind, target), clientX, clientY });
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
    void drop(kind, pt, isPaletteCosmetic(kind) ? { at: "free" } : floorTarget(kind, pt));
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
      setDropHint(null);
      setHover(null);
    };
    const cancel = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setCarrying(null);
      setPalettePreview(null);
      setDropHint(null);
      setHover(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }

  /**
   * Which reading is on the floor, and where an edit lands. It rides at the
   * top of the rail, beside the Beats it talks about, and shows up only when
   * there is a choice being made or a destination other than the plain step.
   */
  const previewStrip =
    plan.variantModel === "step" &&
    (activeStepPreviews.length > 0 || !!editingVariant) ? (
      <div className="mb-2 rounded border border-ink-700 bg-ink-800/60 px-2 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label shrink-0" title="\ walks the split you last touched">
            Preview
          </span>
          {activeStepPreviews.map(({ step: ownerStep, ownerStepId, variant }) => (
            <label
              key={ownerStepId}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${movementConflicts.some((conflict) => conflict.ownerStepIds.includes(ownerStepId)) ? "border-amber-400 bg-amber-950/50" : focusedBeat === ownerStepId ? "border-blue-400 bg-blue-950/40" : "border-ink-600 bg-ink-800"}`}
            >
              <span className="text-ink-400">{ownerStep.name || "Step"}:</span>
              <select
                data-preview-step={ownerStepId}
                className="max-w-[120px] bg-transparent text-blue-100 outline-none"
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
                <span className="text-amber-300" title="This preview has an explicit same-actor movement conflict">&#9888;</span>
              )}
            </label>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="min-w-0 truncate text-ink-300" data-edit-destination>
            {editable
              ? editingVariant && editingVariantOwner
                ? `Editing: ${editingVariantOwner.step.name || "Step"} \u203a ${stepVariantLabel(editingVariantOwner.step, editingVariant)}${openMech ? ` \u203a ${mechLabel(plan, openMech)}` : ""}`
                : openMech
                  ? `Editing: ${mechLabel(plan, openMech)} shared Parts`
                  : `Editing: ${step.name || "Step"} shared scene`
              : "Viewer preview"}
          </span>
          {editable && editingVariant && editingVariantOwner && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
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
            </span>
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className="relative flex h-full flex-col">
      <header className="panel flex h-12 flex-nowrap items-center gap-3 overflow-hidden border-x-0 border-t-0 px-3 py-0">
        <button className="btn shrink-0" onClick={() => navigate("/")}>
          ← Plans
        </button>
        {/* The plan's identity reads as a line of text; a click turns the word
            you aimed at into the field that renames it. */}
        <div className="flex min-w-0 shrink flex-col justify-center gap-0.5 leading-tight">
          <div className="flex min-w-0 items-baseline gap-2">
            {editable && headerEditing === "name" ? (
              <input
                className="field h-6 max-w-[280px] py-0 text-sm"
                aria-label="Plan name"
                autoFocus
                value={plan.name}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setPlan({ ...plan, name: e.target.value })}
                onBlur={(e) => {
                  setHeaderEditing(null);
                  if (headerCancelled.current) {
                    headerCancelled.current = false;
                    return;
                  }
                  void run({ op: "set_meta", name: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    headerCancelled.current = true;
                    setPlan({ ...plan, name: headerBefore.current });
                    setHeaderEditing(null);
                  }
                }}
              />
            ) : editable ? (
              <button
                type="button"
                data-plan-name={plan.name}
                aria-label="Plan name"
                title="Rename"
                className="min-w-0 truncate rounded px-1 text-left text-sm font-semibold text-ink-100 hover:bg-ink-700 hover:underline"
                onClick={() => {
                  headerBefore.current = plan.name;
                  headerCancelled.current = false;
                  setHeaderEditing("name");
                }}
              >
                {plan.name || "Untitled plan"}
              </button>
            ) : (
              <span
                data-plan-name={plan.name}
                className="min-w-0 truncate px-1 text-sm font-semibold text-ink-100"
              >
                {plan.name}
              </span>
            )}
            {narrow ? null : editable && headerEditing === "encounter" ? (
              <input
                className="field h-6 max-w-[180px] py-0 text-xs"
                placeholder="encounter"
                aria-label="Encounter"
                list="encounter-fights"
                autoFocus
                title={
                  "The fight this plan is for — plans sharing it share their waymarks. " +
                  (encounterFight
                    ? `Statuses come from ${encounterFight.name}.`
                    : "No fight in the debuff library answers to this name yet.")
                }
                value={plan.encounter}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setPlan({ ...plan, encounter: e.target.value })}
                onBlur={(e) => {
                  setHeaderEditing(null);
                  if (headerCancelled.current) {
                    headerCancelled.current = false;
                    return;
                  }
                  void run({ op: "set_meta", encounter: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    headerCancelled.current = true;
                    setPlan({ ...plan, encounter: headerBefore.current });
                    setHeaderEditing(null);
                  }
                }}
              />
            ) : editable ? (
              <button
                type="button"
                data-encounter-name={plan.encounter}
                aria-label="Encounter"
                title={
                  "The fight this plan is for — plans sharing it share their waymarks. " +
                  (encounterFight
                    ? `Statuses come from ${encounterFight.name}.`
                    : "No fight in the debuff library answers to this name yet.") +
                  " Rename"
                }
                className={`min-w-0 shrink-0 truncate rounded px-1 text-left text-xs hover:bg-ink-700 hover:underline ${plan.encounter ? "text-ink-400" : "text-ink-600"}`}
                onClick={() => {
                  headerBefore.current = plan.encounter;
                  headerCancelled.current = false;
                  setHeaderEditing("encounter");
                }}
              >
                {plan.encounter || "name the fight"}
              </button>
            ) : (
              plan.encounter && (
                <span
                  data-encounter-name={plan.encounter}
                  className="min-w-0 shrink-0 truncate px-1 text-xs text-ink-400"
                >
                  {plan.encounter}
                </span>
              )
            )}
          </div>
          {!narrow && (
            <span className="truncate px-1 text-[10px] text-ink-400">
              rev {plan.rev} · {connected ? "live" : "offline"} · {role}
            </span>
          )}
        </div>
        {/* The library's fights, so naming the encounter is also the act of
            choosing whose statuses the debuff Beats deal. */}
        <datalist id="encounter-fights">
          {fightLibrary.map((entry) => (
            <option key={entry.key} value={entry.name} />
          ))}
        </datalist>
        <div
          className={`min-w-0 items-center gap-2 overflow-hidden ${narrow ? "hidden" : "mx-auto flex"}`}
        >
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
          {canEdit && (
            <>
              <div
                className="flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border border-ink-600 bg-ink-900/70 p-0.5 shadow-inner"
                role="group"
                aria-label="Editing aids"
              >
                {(
                  [
                    {
                      which: "snap" as const,
                      key: "E",
                      label: "Snap",
                      title:
                        "Drags settle onto 45° spokes, other tokens' rings and waymarks; turns and cone spreads onto round angles; a bait offset let go near zero goes home. Alt skips it for one drag (E)",
                    },
                    {
                      which: "bind" as const,
                      key: "R",
                      label: "Bind",
                      title:
                        "A palette mechanic let go on a player is anchored to them, on an enemy or bait anchor it is baited, on a tether it rides it. Off, it lands on the floor where you let go (R)",
                    },
                  ]
                ).map((mode) => (
                  <button
                    key={mode.which}
                    type="button"
                    data-assist={mode.which}
                    className={`flex items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-300 ${
                      assists[mode.which]
                        ? "bg-blue-500/25 font-semibold text-blue-100 shadow-sm"
                        : "text-ink-400 hover:bg-ink-700 hover:text-ink-200"
                    }`}
                    title={mode.title}
                    aria-pressed={assists[mode.which]}
                    onClick={() => setAssists((on) => ({ ...on, [mode.which]: !on[mode.which] }))}
                  >
                    <kbd className="text-[10px] font-normal text-ink-400">{mode.key}</kbd>
                    <span>{mode.label}</span>
                  </button>
                ))}
              </div>
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
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editable && !narrow && (
            <div className="flex shrink-0 items-center gap-1" aria-label="Edit history controls">
              {canEdit && (
                <>
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
                </>
              )}
              <button
                className={`btn ${historyOpen ? "border-blue-400 text-blue-200" : ""}`}
                title="Revision history and work sessions"
                onClick={() => setHistoryOpen((open) => !open)}
              >
                History
              </button>
            </div>
          )}
          {/* Collapsed hides the rail, and with it the switch that lives in the
              rail's header — so it moves up here, beside the plan's name. */}
          {collapsed && !narrow && (
            <TimelineModeSwitch value={timelineMode} onChange={setMode} />
          )}
          <ShareButton
            planId={planId}
            canShare={role === "owner"}
            isPublic={isPublic}
            setIsPublic={setIsPublic}
          />
          {user && role !== "owner" && !narrow && (
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
          {!narrow && (
            <span className="text-xs text-ink-400">
              {user ? user.name : <a href="/">sign in</a>}
            </span>
          )}
        </div>
      </header>

      {plan.variantModel === "step" && movementConflicts.length > 0 && (
        <div className="bg-amber-950 px-3 py-1.5 text-center text-xs text-amber-200" role="alert" data-movement-conflict>
          Movement conflict: {movementConflicts.map((conflict) => authoredScene.find((entity) => entity.id === conflict.actorId)?.name || conflict.actorId).join(", ")} is moved by more than one active Variant split. Shared Step positions are shown until the conflict is resolved.
        </div>
      )}

      <div
        className={
          collapsed
            ? "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
            : "flex min-h-0 flex-1"
        }
      >
        {!collapsed && (
        <StepRail
          plan={plan}
          preview={previewStrip}
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
          onOpenMech={openBeat}
          onPickBeat={selectBeatParts}
          onEditBeatVariant={setEditingBeatVariant}
          onFocusBeat={setFocusedBeat}
          onDebuffs={setDebuffFor}
          onHighlight={setHighlight}
          mode={timelineMode === "expanded" ? "expanded" : "normal"}
          onMode={setMode}
        />
        )}

        <CanvasArea
          onMouseDown={(ev) => sweep.current?.(ev.nativeEvent)}
          onSize={collapsed ? setArenaSize : undefined}
          // On a phone the floor is the window's width less 16px either side,
          // and the page scrolls; anywhere else the square is as big as the
          // height left over once the strip under it has had its share.
          floor={collapsed && narrow ? Math.max(200, viewportWidth - 32) : undefined}
          pad={collapsed ? 0 : 24}
        >
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
                  setPalettePreview(previewAt(carrying, pt));
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
                void drop(kind, pt, isPaletteCosmetic(kind) ? { at: "free" } : floorTarget(kind, pt));
                setCarrying(null);
                setHover(null);
              }}
            >
              {canEdit && openMech && (
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
                editable={canEdit}
                symmetryCount={symmetryCount}
                symmetryKind={symmetryKind}
                layer={layer}
                chips={chips}
                snapping={assists.snap}
                sweep={sweep}
                highlight={highlight}
                glide={glide}
                onward={onward}
                picking={!!pendingTether}
                onPick={(id) => {
                  if (!pendingTether) return false;
                  const target = authoredScene.find((e) => e.id === id);
                  if (target && target.type !== "tether") void finishTether(target.id);
                  else setError("Choose an object for the other end of the tether");
                  return true;
                }}
                onSelect={pick}
                onContextMenu={onCanvasContextMenu}
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
                  // An edge or corner grip stretches one side and holds the
                  // other still, which moves the shape as surely as it resizes
                  // it: the pose travels with the dimension, in one op.
                  const posePatch =
                    next.x !== undefined && next.y !== undefined &&
                    (Math.abs(next.x - entity.x) > 0.4 || Math.abs(next.y - entity.y) > 0.4)
                      ? { x: next.x, y: next.y }
                      : {};
                  const sizeChanged = Object.keys(sizePatch).length > 0;
                  const poseChanged = Object.keys(posePatch).length > 0;
                  const rotationChanged =
                    next.rotation !== undefined && Math.abs(next.rotation - entity.rotation) > 0.05;
                  if (!sizeChanged && !rotationChanged && !poseChanged) return;

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
                        ...posePatch,
                        ...(rotationChanged ? { rotation: next.rotation } : {}),
                      },
                      stepId: step.id,
                      variant: plan.variantModel === "beat" ? editingVariant : playing,
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
                      stepId: step.id,
                      // In a mechanic that goes two ways, a move belongs to the
                      // reading you are playing. Nothing has to be said about it:
                      // you moved somebody while looking at this reading.
                      variant: plan.variantModel === "beat" ? editingVariant : playing,
                    })),
                    false
                  );
                }}
              />
              {dropHint?.intent.ring && (
                <div
                  data-drop-ring={dropHint.intent.mode}
                  className="pointer-events-none absolute z-20 rounded-full border-2 border-dashed"
                  style={{
                    borderColor: dropColor(dropHint.intent),
                    left: size / 2 + (dropHint.intent.ring.x - dropHint.intent.ring.r) * viewScale(plan.arena, size),
                    top: size / 2 + (dropHint.intent.ring.y - dropHint.intent.ring.r) * viewScale(plan.arena, size),
                    width: dropHint.intent.ring.r * 2 * viewScale(plan.arena, size),
                    height: dropHint.intent.ring.r * 2 * viewScale(plan.arena, size),
                  }}
                />
              )}
              {dropHint && <DropHintPill {...dropHint} />}
              {/* Collapsed reads the note off the strip instead: one card is
                  enough, and on a phone the arena has no margin to spare. */}
              {!collapsed && (
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
              )}
              {/* "Everyone here gets one of these" — seven places to let go of
                  what you are carrying. It pops out over the arena's margin
                  only while something is in hand, so the groups never sit on
                  screen competing with the plan for space. */}
              {canEdit &&
                layer === "step" &&
                carrying &&
                carrying !== "anchor" &&
                !isPaletteCosmetic(carrying) && (
                  <div className="drop-rail absolute right-2 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5">
                    {GROUPS.map((g) => {
                      const people = membersOf(g).length;
                      return (
                        <div
                          key={g}
                          data-drop-group={g}
                          title={`Drop a mechanic here to give one to each of the ${g}`}
                          onDragOver={(ev) => {
                            ev.preventDefault();
                            ev.dataTransfer.dropEffect = "copy";
                            setHover(g);
                          }}
                          onDragLeave={() => setHover((h) => (h === g ? null : h))}
                          onDrop={(ev) => {
                            const kind = kindOf(ev);
                            if (!kind || kind === "anchor") return;
                            ev.preventDefault();
                            ev.stopPropagation();
                            void drop(kind, { x: 0, y: 0 }, { at: "group", group: g });
                            setCarrying(null);
                            setHover(null);
                          }}
                          className={`rounded-lg border-2 border-dashed bg-ink-800/90 px-3 py-2 text-sm font-semibold text-ink-100 shadow-lg ${
                            hover === g ? "border-blue-400 bg-blue-500/25" : "border-blue-500/60"
                          }`}
                        >
                          <div>{GROUP_LABEL[g]}</div>
                          <div className="text-[11px] font-normal text-ink-400">
                            {people} {people === 1 ? "player" : "players"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>
          )}
        </CanvasArea>

        {collapsed && (
          <>
            <TimelineStrip
              plan={plan}
              index={stepIndex}
              width={arenaSize}
              shown={shown}
              openMech={mech}
              onSelect={setStepIndex}
              onOpenMech={openBeat}
              onFocusBeat={setFocusedBeat}
              onShow={setShown}
              onEditBeatVariant={setEditingBeatVariant}
            />
            {/* Only where there is no keyboard to walk the fight with. */}
            {narrow && (
              <div className="mx-auto flex shrink-0 gap-2" style={{ width: arenaSize }}>
                {([-1, 1] as const).map((delta) => {
                  const to = stepIndex + delta;
                  const target = plan.steps[to];
                  return (
                    <button
                      key={delta}
                      type="button"
                      data-strip-walk={delta < 0 ? "prev" : "next"}
                      disabled={!target}
                      className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-ink-700 text-sm text-ink-200 disabled:opacity-40"
                      onClick={() => target && setStepIndex(to)}
                    >
                      {delta < 0 ? "‹ " : ""}
                      {target ? `Step ${to + 1}` : delta < 0 ? "Start" : "End"}
                      {delta > 0 ? " ›" : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* A shared link opens read-only, often signed out: showing a wall of
            greyed-out editing controls just reads as a broken app. */}
        {collapsed ? null : !editable ? (
          <aside className="panel w-[240px] shrink-0 border-y-0 border-r-0 p-3 text-xs text-ink-400">
            Read-only. {user ? "You have viewer access to this plan." : "Sign in to edit plans of your own."}
          </aside>
        ) : (
        <aside
          className="panel flex w-[320px] shrink-0 flex-col border-y-0 border-r-0"
          data-panel={sideTab === "details" ? "inspector" : "palette"}
        >
          <div
            role="tablist"
            aria-label="Side panel"
            className="flex shrink-0 border-b border-ink-600"
          >
            {([
              { id: "add", label: "Add", title: "Place objects and set the arena up (Tab)" },
              {
                id: "details",
                label: "Details",
                title: detailsReady
                  ? `Edit ${selectedEntity?.name || "the selection"} (Tab)`
                  : layer === "markers"
                    ? "Waymarks are being moved — finish with them first"
                    : "Select something on the floor to edit it",
              },
            ] as const).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                data-side-tab={t.id}
                aria-selected={sideTab === t.id}
                disabled={t.id === "details" && !detailsReady}
                title={t.title}
                className={`flex-1 border-b-2 px-2 py-1.5 text-xs ${
                  sideTab === t.id
                    ? "border-blue-400 text-ink-100"
                    : "border-transparent text-ink-400 enabled:hover:text-ink-200 disabled:opacity-40"
                }`}
                onClick={() => setPanelTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {sideTab === "add" ? (
          <>
          <div className="mb-1 flex items-center gap-1.5">
            {/* The tab overhead says "Add"; this is just the how-to. */}
            <button
              type="button"
              className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border border-ink-600 text-[9px] leading-none text-ink-400"
              title={PALETTE_HELP}
              aria-label="How to use the palette"
            >
              ?
            </button>
            {/* The groups, kept out of the way until you ask for them: who is
                in each one, what sets they carry, and a handle to move them. */}
            <GroupsPopover
              rows={GROUPS.map((g) => ({
                id: g,
                label: GROUP_LABEL[g],
                people: membersOf(g).length,
                sets: bondsOf(g),
              }))}
              movable={layer === "step"}
              onSelect={(g) => {
                const ids = membersOf(g).map((e) => e.id);
                if (ids.length) pick(ids);
              }}
              onCarry={setCarryGroup}
              onHighlight={setHighlight}
              onDeleteSet={(ids) => void run({ op: "delete_entities", ids })}
            />
          </div>
          <p className="sr-only">{PALETTE_HELP}</p>
          <div className="mb-3">
            {paletteGroups().map((group) => (
              <Fragment key={group.caption}>
                <div className="mb-1 mt-2 text-[9px] uppercase tracking-wide text-ink-400/80 first:mt-0">
                  {group.caption}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {group.kinds.map((k) => (
                    <div
                      key={k}
                      data-palette-chip={k}
                      draggable={false}
                      title={PALETTE_HINT[k]}
                      onPointerDown={(ev) => beginPaletteDrag(k, ev)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        openContextMenu({ x: ev.clientX, y: ev.clientY }, paletteChipItems(k));
                      }}
                      className={`flex touch-none cursor-grab select-none flex-col items-center gap-1 rounded border px-1 py-1.5 text-[11px] leading-tight active:cursor-grabbing ${
                        carrying === k ? "border-blue-400 bg-ink-700" : "border-ink-600 bg-ink-800"
                      } ${layer === "markers" ? "cursor-not-allowed opacity-40" : ""}`}
                    >
                      <PaletteGlyph kind={k} size={22} />
                      {PALETTE_LABEL[k]}
                    </div>
                  ))}
                </div>
              </Fragment>
            ))}
          </div>

          <h2 className="label mb-2">Arena</h2>
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {[8, 4, 2].map((spokes) => (
              <button
                key={spokes}
                className="btn px-1.5 py-0.5 text-[11px]"
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
              className="btn px-1.5 py-0.5 text-[11px]"
              disabled={!editable}
              title="Grid off"
              onClick={() =>
                run({ op: "set_arena", patch: { grid: { ...plan.arena.grid, type: "none" } } })
              }
            >
              no grid
            </button>
            <button
              className="btn px-1.5 py-0.5 text-[11px]"
              disabled={!editable}
              title="A north, 2 NE, B east, 3 SE, C south, 4 SW, D west, 1 NW"
              onClick={() => run({ op: "add_waymarks" })}
            >
              standard markers
            </button>
            <button
              className="btn px-1.5 py-0.5 text-[11px]"
              disabled={!editable}
              title="Out at waymark spread: MT north, R2 NE, H2 east, M2 SE, OT south, M1 SW, H1 west, R1 NW"
              onClick={() =>
                run({
                  op: "arrange_party",
                  stepId: step.id,
                  variant: plan.variantModel === "beat" ? editingVariant : playing,
                })
              }
            >
              PF positions
            </button>
            <button
              className="btn px-1.5 py-0.5 text-[11px]"
              disabled={!editable}
              title="Restore missing party members and align the party to PF clock positions"
              onClick={() => run({ op: "add_party" })}
            >
              add party
            </button>
            {/* Waymarks belong to the fight, not to one plan: decide them once
                and every plan for the encounter picks up the same set. */}
            <button
              className={`btn px-1.5 py-0.5 text-[11px] ${layer === "markers" ? "border-amber-400 text-amber-200" : ""}`}
              disabled={!editable}
              title="Waymarks do not move once the pull starts, so they are frozen until you come here"
              onClick={() => toLayer(layer === "markers" ? "step" : "markers")}
            >
              {layer === "markers" ? "done with waymarks" : "move waymarks"}
            </button>
            <button
              className="btn px-1.5 py-0.5 text-[11px]"
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
              className="btn px-1.5 py-0.5 text-[11px]"
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
            variant={editingVariant ?? playing}
            shown={shown}
            editable={editable}
            run={run}
            beatForPart={beatForPart}
            onDeselect={() => setSelected(null)}
          />
          </>
          ) : (
          <Inspector
            plan={plan}
            entity={selectedEntity}
            stepId={step.id}
            variant={editingVariant ?? playing}
            shown={shown}
            editable={editable}
            run={run}
            beatForPart={beatForPart}
            onDeselect={() => {
              setSelected(null);
              setPanelTab("add");
            }}
          />
          )}
          </div>
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
      <ContextMenuHost />
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
  onSize,
  floor,
  pad = 24,
}: {
  children: (size: number) => React.ReactNode;
  /** A mouse-down on the bare area beside the canvas. */
  onMouseDown?(ev: React.MouseEvent<HTMLDivElement>): void;
  /** Told how big the arena came out, for chrome that must be its width. */
  onSize?(size: number): void;
  /**
   * A phone: the floor itself is this wide, edge to edge. The stage is drawn
   * larger — the canvas keeps a margin outside the walls so a shape sitting on
   * one is not cut off — and the band around the floor is clipped away, so a
   * 390px window spends its width on the arena rather than on that margin.
   */
  floor?: number;
  /** Slack left around the square. Collapsed has no room for any. */
  pad?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(600);
  const size = floor === undefined ? measured : Math.round(floor * VIEW_MARGIN);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || floor !== undefined) return;
    const observer = new ResizeObserver(() => {
      setMeasured(Math.max(200, Math.min(el.clientWidth, el.clientHeight) - pad));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [floor, pad]);
  useEffect(() => {
    onSize?.(floor ?? size);
  }, [size, floor, onSize]);
  return (
    <div
      ref={ref}
      className={
        floor === undefined
          ? "flex min-h-0 min-w-0 flex-1 items-center justify-center"
          : "mx-auto flex shrink-0 items-center justify-center overflow-hidden"
      }
      style={floor === undefined ? undefined : { width: floor, height: floor }}
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

/**
 * The rail's row geometry. A step row is a fixed height on a fixed pitch, so a
 * Beat card spanning rows `lo..hi` is `(hi - lo + 1) * PITCH - GAP` tall and the
 * seam between two rows falls in the middle of the gap between them — which is
 * the only reason the Snap marker can be placed in pixels at all.
 */
/**
 * Where the Snap marker is allowed to sit: from the cast row down to the row
 * before the resolve. It cannot sit on the resolve row — freezing at the last
 * step says nothing — and a Beat under three rows has no choice to make.
 */
const clampFreeze = (row: number, lo: number, hi: number) =>
  Math.min(Math.max(row, lo), Math.max(lo, hi - 1));

/** The two rail sizes, in pixels. Everything that measures the rail reads one of these. */
export interface RailMetrics {
  /** A step row's height, and the pitch it repeats on with the grid's gap. */
  row: number;
  gap: number;
  pitch: number;
  /**
   * A step row says nothing but its number, so the column it lives in is a
   * gutter: the width the names used to take is the lanes' now, which is what
   * lets a Beat card read its whole label on one line.
   */
  gutter: number;
  /** One Beat card's lane. A Variant sublane is this plus the container's border. */
  lane: number;
  /**
   * The rail must never crowd the floor out: past this the lanes share it, and
   * a step with many Beats shows many narrow cards — which is the cue to fold
   * them into fewer Beats, not a reason to shrink the arena.
   */
  budget: number;
  /** The step-note column, and the selected row's actions. Expanded only. */
  note: number;
  actions: number;
  /** The Snap diamond's handle, which grows with the rows it has to be aimed at. */
  diamond: number;
  /** Panel padding, section padding, the gutter, the extra columns and the border. */
  chrome: number;
}

const railMetrics = (mode: "normal" | "expanded"): RailMetrics => {
  const base = mode === "expanded"
    ? { row: 40, gutter: 28, lane: 120, budget: 440, note: 168, actions: 104, diamond: 12 }
    : { row: 28, gutter: 24, lane: 92, budget: 336, note: 0, actions: 0, diamond: 10 };
  const gap = 4;
  return {
    ...base,
    gap,
    pitch: base.row + gap,
    // 8px of panel padding and 4px of section padding on each side, the gutter,
    // the extra columns and the panel's own border.
    chrome: 26 + base.gutter + base.note + base.actions + (base.note ? 8 : 0),
  };
};

interface Drag {
  /** Identifies this pointer gesture so an older acknowledgement cannot clear a newer one. */
  gesture: number;
  id: string;
  /** Whether this Beat was already open when the pointer went down. */
  wasOpen?: boolean;
  /**
   * Which of the card's four grips is in the hand: its cast edge, its resolve
   * edge, its Snap marker, or the body — which carries the whole Beat, span and
   * marker together, because a Beat that happens later happens later whole.
   */
  mode: "top" | "bottom" | "body" | "freeze";
  grabbed: number;
  /** Row indices within the section the box is drawn in, not step numbers. */
  lo: number;
  hi: number;
  /** Where it started, so every move is measured from the same place. */
  from: [number, number];
  /**
   * The Snap marker's row while the pointer has it, and the row it started on.
   * Both are row indices like `lo`/`hi`; unset on anything with no marker — a
   * Beat under three rows, a Variant chip, a Variant container.
   */
  freeze?: number;
  freezeFrom?: number;
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
  preview,
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
  onPickBeat,
  onEditBeatVariant,
  onFocusBeat,
  onDebuffs,
  onHighlight,
  mode,
  onMode,
}: {
  plan: Plan;
  /** The Variant preview and edit destination, rendered above the outline. */
  preview: ReactNode;
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
  /** A click on a Beat card, whether it opened or closed it: point at its Parts. */
  onPickBeat(id: string): void;
  onEditBeatVariant(id: string | null): void;
  onFocusBeat(id: string): void;
  onDebuffs(id: string): void;
  onHighlight(id: string | null): void;
  /**
   * Which of the two rail sizes this is. The switch in the header is the rail's
   * own; the layouts themselves are the next thing to be built.
   */
  mode: "normal" | "expanded";
  onMode(mode: TimelineMode): void;
}) {
  // Deleting the last step leaves the parent's index pointing past the end for
  // one render; the rail must not blow up in that gap.
  const at = Math.min(index, plan.steps.length - 1);
  const current = plan.steps[at];
  /**
   * The rail's pixels, this size. Every row height, lane width, freeze seam and
   * drag ruler reads them from here, so Expanded is the same rail measured
   * differently rather than a second one.
   */
  const M = railMetrics(mode);
  const expanded = mode === "expanded";
  /** The step whose note cell is a field right now. Expanded only. */
  const [editingNote, setEditingNote] = useState<string | null>(null);

  const [drag, setDrag] = useState<Drag | null>(null);
  const [variantDrag, setVariantDrag] = useState<Drag | null>(null);
  /**
   * A heading on its way somewhere: which one, and which slot it is over. Where
   * a section sits *is* the order of the fight, so dragging it is how you say
   * it. Steps have no such handle — a step's place is its mechanic's business.
   */
  const [sectionDrag, setSectionDrag] = useState<Slide | null>(null);
  /**
   * The row and the Beat card under the pointer. Both are drawn state, not
   * gestures: the row grows its actions, and the card lights its three grips
   * and lays its Snap seam across the whole rail, so the step the marker lands
   * on can be read off the names beside it.
   */
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [hoverBeat, setHoverBeat] = useState<string | null>(null);
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
   * The Snap marker's row: where the plan puts it, held inside the span it
   * belongs to. Empty means the cast row, and a row that fell outside the span
   * — a Beat dragged shorter since — reads as the nearest one that is legal.
   */
  const freezeRowOf = (mech: Mech, visible: Step[], lo: number, hi: number) => {
    const at = mech.freeze ? visible.findIndex((step) => step.id === mech.freeze) : -1;
    return clampFreeze(at < 0 ? lo : at, lo, hi);
  };

  /**
   * What a Beat is made of, in one line: its Parts grouped by what they are.
   * Expanded lanes are wide enough to carry it under the name, which is the
   * only place the count of a Beat's contents ever says what they were.
   */
  const partsLine = (mech: Mech) => {
    const detached = plan.steps.flatMap((step) =>
      Object.values(step.variantScenes ?? {}).flat()
    );
    const seen = new Set<string>();
    const kinds = new Map<string, number>();
    for (const entity of [...plan.entities, ...detached]) {
      if (entity.mech !== mech.id || seen.has(entity.id)) continue;
      seen.add(entity.id);
      const kind = entity.type === "zone" ? entity.shape : entity.type;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    return [...kinds]
      .map(([kind, n]) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ×${n}`)
      .join(" · ");
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
    const laneWidths = Array(from).fill(M.lane) as number[];
    const packs: (typeof boxes)[] = [];
    for (const box of boxes) {
      const pack = packs.find((mine) =>
        mine.every((p) => p.planHi < box.planLo || p.planLo > box.planHi)
      );
      if (pack) pack.push(box);
      else packs.push([box]);
    }
    for (const pack of packs) {
      // Each sublane must hold a normal Beat card, plus the Variant
      // container's own border and breathing room; a shared column is as wide
      // as the widest sublane that lands in it.
      const widths: number[] = [];
      for (const box of pack) {
        box.lane = from;
        box.subs.forEach((n, i) => (widths[i] = Math.max(widths[i] ?? 0, n * M.lane + 12)));
      }
      from += widths.length;
      laneWidths.push(...widths);
    }
    // The rail must never crowd the floor out: past a budget the lanes share
    // it, and a step with many Beats shows many narrow cards — which is the
    // cue to fold them into fewer Beats, not a reason to shrink the arena.
    const budget = M.budget;
    const total = laneWidths.reduce((sum, width) => sum + width, 0);
    if (total > budget) {
      const scale = budget / total;
      laneWidths.forEach((width, i) => (laneWidths[i] = Math.max(42, Math.floor(width * scale))));
    }
    return { placed, boxes, lanes: from, laneWidths, groups };
  }

  // Only the open section draws rows, so only it can want lanes.
  const laid = openMechanic
    ? layout(siblings, openMechanic)
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
  // your keyboard on, else the mech you have open. A step has no name in the
  // rail any more — its number is its caption — so F2 on a row means the Beat.
  const renameTarget = openMech?.id ?? null;
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
      // Beat, which preserves the old click-again-to-close behavior — and
      // either way the click said "this Beat", so its Parts come up selected.
      if (settled.wasOpen) onOpenMech(null);
      onPickBeat(mech.id);
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
    // The marker rides along: a Beat carried down a row freezes a row later,
    // and one whose cast edge was pushed past it takes it with it. The row it
    // ends on is only sent when it is not the cast row — "" is how the schema
    // spells "freezes as it casts".
    const wantFreeze =
      settled.freeze === undefined || hi - lo + 1 < 3 || settled.freeze <= lo
        ? ""
        : (visible[settled.freeze]?.id ?? "");
    const freezeMoved = settled.freeze !== undefined && wantFreeze !== (mech.freeze ?? "");
    if (lo !== wasLo || hi !== wasHi || freezeMoved)
      settle.push({
        op: "update_mech",
        mechId: mech.id,
        patch: {
          snap: visible[lo].id,
          boom: visible[hi].id,
          ...(freezeMoved ? { freeze: wantFreeze } : {}),
        },
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

  /** Put a menu up at the pointer, and keep the row underneath out of it. */
  function menuAt(event: ReactMouseEvent, items: MenuItem[]) {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu({ x: event.clientX, y: event.clientY }, items);
  }

  /**
   * Everything a step owns, as menu rows. The rail shows a step's number and
   * nothing else, so this is where the four actions that used to crowd the row
   * live now — and every menu in the rail ends with them, because whatever you
   * right-clicked, you right-clicked it on a step.
   */
  function stepItems(s: Step, at_: number): MenuItem[] {
    const stepAt = plan.steps.indexOf(s);
    return [
      { heading: `Step ${at_ + 1}` },
      {
        label: "Add step before",
        onSelect: async () => {
          await run({ op: "add_step", index: stepAt });
          setIndex(stepAt);
        },
      },
      {
        label: "Add step after",
        onSelect: async () => {
          await run({ op: "add_step", index: stepAt + 1 });
          setIndex(stepAt + 1);
        },
      },
      {
        label: "Duplicate step",
        onSelect: async () => {
          await run({ op: "duplicate_step", stepId: s.id });
          setIndex(stepAt + 1);
        },
      },
      {
        label: "Add Variant here",
        onSelect: () => void run({ op: "add_step_variant", stepId: s.id }),
      },
      { separator: true },
      {
        label: "Delete step",
        danger: true,
        disabled: plan.steps.length < 2,
        onSelect: async () => {
          await run({ op: "delete_step", stepId: s.id });
          setIndex(Math.max(0, stepAt - 1));
        },
      },
    ];
  }

  /** The row a menu was opened on: the ruler answers that, as it does for a drag. */
  const rowItems = (clientY: number, visible: Step[]): MenuItem[] => {
    const row = rowAt(clientY, visible);
    const step = visible[row];
    return step ? stepItems(step, row) : [];
  };

  /**
   * A Beat card's own rows, then the row's. Snap is here for the same reason
   * the diamond is: it is the only edit on a card that has nowhere else to go
   * once the hover chips are gone, and typing it is easier to aim than dragging.
   */
  function beatItems(mech: Mech, lo: number, hi: number, visible: Step[], clientY: number): MenuItem[] {
    const label = mechLabel(plan, mech);
    const row = rowAt(clientY, visible);
    const marked = hi - lo + 1 >= 3;
    const freezeRow = freezeRowOf(mech, visible, lo, hi);
    const shares = visible[row]
      ? plan.mechs.filter(
          (other) => other.id !== mech.id && mechSpan(plan, other).includes(visible[row].id)
        )
      : [];
    const items: MenuItem[] = [{ heading: label }];
    if (marked)
      items.push({
        label: "Snap here",
        // The marker lives between the cast and the resolve: on the cast row
        // it says nothing new, on the resolve row it says nothing at all.
        disabled: !(row > lo && row < hi),
        checked: row === freezeRow,
        onSelect: () =>
          void run({
            op: "update_mech",
            mechId: mech.id,
            patch: { freeze: row <= lo ? "" : (visible[row]?.id ?? "") },
          }),
      });
    items.push(
      {
        label: mech.locked ? "Unlock Beat" : "Lock Beat",
        onSelect: () => void run({ op: "update_mech", mechId: mech.id, patch: { locked: !mech.locked } }),
      },
      { label: "Rename Beat", onSelect: () => setRenaming(mech.id) },
      {
        label: "Merge into…",
        disabled: !shares.length,
        children: shares.map((other) => ({
          label: mechLabel(plan, other),
          onSelect: () => {
            onOpenMech(other.id);
            void run({ op: "merge_mechs", into: other.id, mechIds: [mech.id] });
          },
        })),
      },
      { separator: true },
      {
        label: "Delete Beat and everything in it",
        danger: true,
        onSelect: () => {
          onOpenMech(null);
          void run({ op: "delete_mech", mechId: mech.id });
        },
      },
      { separator: true }
    );
    return [...items, ...rowItems(clientY, visible)];
  }

  /** A Variant box's own rows, then the row's. */
  function stepVariantItems(
    owner: Step,
    variantId: string,
    visible: Step[],
    clientY: number
  ): MenuItem[] {
    const label = stepVariantLabel(owner, variantId);
    return [
      { heading: label },
      {
        label: "Rename",
        onSelect: () => {
          const name = window.prompt("Variant name", label);
          if (name !== null)
            void run({ op: "update_step_variant", stepId: owner.id, variantId, patch: { name } });
        },
      },
      { separator: true },
      {
        label: "Delete",
        danger: true,
        onSelect: () => void run({ op: "delete_step_variant", stepId: owner.id, variantId }),
      },
      { separator: true },
      ...rowItems(clientY, visible),
    ];
  }

  /** A section heading's rows: what it is called, where it sits, and away with it. */
  function mechanicItems(mechanic: Mechanic): MenuItem[] {
    // Its place in the plan, not in the list the pointer has: a drag in flight
    // must not decide where "up" is.
    const index_ = plan.mechanics.findIndex((m) => m.id === mechanic.id);
    const move = (to: number) => {
      // Moving a block of steps changes what sits at the selected index: hold
      // the step itself, or the open section changes under you.
      const keep = current?.id;
      void run({ op: "move_mechanic", mechanicId: mechanic.id, index: to }).then((res) => {
        const i = res.plan.steps.findIndex((s) => s.id === keep);
        if (i >= 0) setIndex(i);
      });
    };
    return [
      { heading: mechanicLabel(plan, mechanic) },
      { label: "Rename", onSelect: () => setRenaming(mechanic.id) },
      { label: "Move up", disabled: index_ === 0, onSelect: () => move(index_ - 1) },
      {
        label: "Move down",
        disabled: index_ >= plan.mechanics.length - 1,
        onSelect: () => move(index_ + 1),
      },
      { separator: true },
      {
        label: "Delete",
        danger: true,
        onSelect: async () => {
          await run({ op: "delete_mechanic", mechanicId: mechanic.id });
          setIndex(0);
        },
      },
    ];
  }

  /** The steps of one section, with the mechs running alongside them. */
  function grid(mechanic: Mechanic, visible: Step[], l: ReturnType<typeof layout>) {
    const showing = shownIn(mechanic);
    // The areas are labelled only when there is more than one of them: with a
    // single reading the rail is just the casts, as it always was.
    const split = l.groups.length > 1;
    const head = split ? 1 : 0;
    const end = visible.length + head + 1;
    // Hovering a Beat lays its Snap seam right across the rail, so the step the
    // marker lands on can be read off the names beside it rather than counted.
    const guided = l.placed.find((p) => p.mech.id === (drag?.id ?? hoverBeat));
    const guide =
      guided && guided.hi - guided.lo + 1 >= 3
        ? ((drag?.id === guided.mech.id ? drag.freeze : undefined) ??
          freezeRowOf(guided.mech, visible, guided.lo, guided.hi))
        : null;
    return (
      <>
      {/* The three moments are named once, above the grid, instead of every
          card spending a line saying the last of them. */}
      <div className="flex items-center gap-2.5 px-1 pb-1.5 pt-0.5 text-[9px] uppercase leading-3 tracking-wide text-ink-400">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-[2px] w-2.5 bg-ink-200" />
          cast
        </span>
        <span className="inline-flex items-center gap-1">
          <SnapDiamond size={8} fill="#b8c0cc" stroke="#dfe5ee" />
          snap
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-[3px] w-2.5 bg-amber-400/80" />
          resolve
        </span>
      </div>
      {/* Expanded gives the notes a column of their own, so the two things a
          step is — what happens and what to remember — are named above them. */}
      {expanded && (
        <div
          className="grid gap-x-1 pb-1 text-[9px] uppercase leading-3 tracking-wide text-ink-400"
          style={{
            gridTemplateColumns: `${M.gutter}px ${
              l.laneWidths.reduce((total, width) => total + width + 4, -4)
            }px ${M.note}px ${M.actions}px`,
          }}
        >
          <span />
          <span className="pl-1">Beats</span>
          <span className="pl-1.5">Step notes</span>
          <span />
        </div>
      )}
      <div
        className="grid gap-x-1 gap-y-1"
        style={{
          gridTemplateColumns: `${M.gutter}px ${l.laneWidths.map((width) => `${width}px`).join(" ")}${
            expanded ? ` ${M.note}px ${M.actions}px` : ""
          }`,
          // Rows are a fixed height rather than a share of the panel: the Snap
          // seam is drawn at a pixel offset inside a card, so a row that
          // stretched would slide the marker off the step it names.
          gridAutoRows: `${M.row}px`,
        }}
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
        {visible.map((s, i) => {
          const on = s.id === current?.id;
          return (
            // The row is the whole width of the rail: with no name to read, the
            // band under the cards is how you see which step an edge sits on,
            // and clicking anywhere that is not a card selects the step. The
            // cards are drawn after it, so they take their own clicks.
            <button
              key={s.id}
              data-row={s.id}
              data-step={s.id}
              data-current={on ? "true" : undefined}
              aria-current={on ? "step" : undefined}
              aria-label={`Step ${i + 1}`}
              ref={(el) => {
                rowRefs.current.set(s.id, el);
              }}
              style={{
                gridColumn: "1 / -1",
                gridRow: i + 1 + head,
                // Tailwind's hover:bg-ink-700 vanishes on an open section, which
                // is the only place rows are ever drawn.
                background: on ? undefined : s.id === hoverRow ? "rgba(46,53,67,0.6)" : undefined,
              }}
              onMouseEnter={() => setHoverRow(s.id)}
              onMouseLeave={() => setHoverRow((held) => (held === s.id ? null : held))}
              onClick={() => go(s)}
              onContextMenu={(event) => menuAt(event, stepItems(s, i))}
              className={`flex items-center rounded text-left ${on ? "bg-ink-600 text-white" : ""}`}
              title={
                editable
                  ? "W and S walk the steps. Right-click for what this step can do"
                  : "W and S walk the steps"
              }
            >
              <span
                className={`relative shrink-0 text-center ${expanded ? "text-[13px]" : "text-xs"} ${
                  on ? `text-white ${expanded ? "font-semibold" : ""}` : "text-ink-400"
                }`}
                style={{ width: M.gutter }}
              >
                {i + 1}
                {/* A step that carries a note says so beside its number; the
                    note itself lives on the arena card, and in Expanded in its
                    own column. */}
                {s.notes && (
                  <span
                    data-note-dot={s.id}
                    aria-hidden
                    title={s.notes}
                    className="absolute right-0.5 top-1 h-1 w-1 rounded-full bg-accent"
                  />
                )}
              </span>
            </button>
          );
        })}
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
          const held = drag?.id === mech.id ? drag : undefined;
          // Two rows have nothing to say: the first of them is the snap and
          // there is nowhere else it could be. Three is where the choice starts.
          const marked = hi - lo + 1 >= 3;
          const freezeRow = held?.freeze ?? freezeRowOf(mech, visible, lo, hi);
          // The seam sits in the gutter under its row, so it reads as a cut
          // between two steps rather than a line through one.
          const cut = (freezeRow - lo + 1) * M.pitch - M.gap / 2;
          const gripped = hoverBeat === mech.id || !!held;
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
              // On the wrapper rather than the card, so the Snap diamond and the
              // Variant chips hanging off it answer with the Beat's menu too.
              onContextMenu={(event) => menuAt(event, beatItems(mech, lo, hi, visible, event.clientY))}
            >
            <button
              data-mech={mech.id}
              title={`${label} — casts in step ${lo + 1}, resolves in step ${hi + 1}${
                gate ? `, only in ${variantLabel(mechanic, gate)}` : ""
              }. ${
                editable
                  ? "Drag the top edge to move the cast, the bottom edge to move the resolve, the body to move the whole Beat — or carry it sideways into a reading's area to say it only happens that way. Click to fill it."
                  : ""
              }`}
              onMouseEnter={() => {
                onHighlight(mech.id);
                setHoverBeat(mech.id);
              }}
              onMouseLeave={() => {
                onHighlight(null);
                setHoverBeat((on) => (on === mech.id ? null : on));
              }}
              // The box is the control: a thin strip at each end moves that end,
              // and everything between them carries the whole Beat. Halves would
              // make the commonest edit — "all of this happens a step later" —
              // cost two drags that have to agree with each other.
              onPointerDown={(e) => {
                if (e.button !== 0) return;
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
                  mode:
                    e.clientY - r.top < 6 ? "top" : r.bottom - e.clientY < 7 ? "bottom" : "body",
                  grabbed: rowAt(e.clientY, visible),
                  lo,
                  hi,
                  from: [lo, hi],
                  freeze: marked ? freezeRow : undefined,
                  freezeFrom: marked ? freezeRow : undefined,
                  moved: false,
                });
              }}
              onPointerMove={(e) => {
                if (drag?.id !== mech.id || drag.settling || drag.mode === "freeze") return;
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
                // resolves no sooner than it casts. Held over the pills the span
                // stays put — up there no row is meant. The body keeps its
                // length and stays inside the section, both ends at once.
                const next: [number, number] = onPill
                  ? [drag.lo, drag.hi]
                  : drag.mode === "top"
                    ? [Math.min(row, wasHi), wasHi]
                    : drag.mode === "bottom"
                      ? [wasLo, Math.max(row, wasLo)]
                      : (() => {
                          const span = wasHi - wasLo;
                          const top = Math.max(
                            0,
                            Math.min(visible.length - 1 - span, wasLo + row - drag.grabbed)
                          );
                          return [top, top + span] as [number, number];
                        })();
                // The marker goes wherever the Beat went: pushed along by a cast
                // edge that ran past it, carried bodily with the whole Beat, and
                // never left sitting on the resolve row.
                const freeze =
                  drag.freezeFrom === undefined
                    ? undefined
                    : clampFreeze(
                        drag.mode === "body" ? drag.freezeFrom + next[0] - wasLo : drag.freezeFrom,
                        next[0],
                        next[1]
                      );
                // "No gate yet" and "gated to both" are different states, and
                // both read as undefined: compare the gate itself, not its id.
                const same =
                  next[0] === drag.lo &&
                  next[1] === drag.hi &&
                  freeze === drag.freeze &&
                  !!gate === !!drag.gate &&
                  gate?.to === drag.gate?.to &&
                  into?.variantId === drag.into?.variantId &&
                  mergeInto === drag.mergeInto;
                if (same) return;
                setDrag({
                  ...drag,
                  gate,
                  into,
                  mergeInto,
                  freeze,
                  lo: next[0],
                  hi: next[1],
                  moved: true,
                });
              }}
              onPointerUp={(e) => endDrag(mech, lo, hi, visible, e)}
              onPointerCancel={() => setDrag(null)}
              onDoubleClick={() => editable && setRenaming(mech.id)}
              style={{ borderTopColor: color, background: tint(color, active ? 0.4 : 0.18) }}
              className={`relative flex h-full w-full touch-none flex-col overflow-hidden rounded border-t-2 border-b-[3px] border-b-amber-400/80 text-[10px] leading-[12px] ${
                expanded ? "items-start px-2 pt-1.5" : "items-center px-1 py-1"
              } ${
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
              {/* Past the seam the fill drains out and only the sides keep the
                  Beat's colour: those steps are drawn on the snapshot. */}
              {marked && freezeRow < hi && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0"
                  style={{
                    top: cut,
                    background: "rgba(20,23,28,0.35)",
                    boxShadow: `inset 1px 0 0 ${tint(color, 0.55)}, inset -1px 0 0 ${tint(color, 0.55)}`,
                  }}
                />
              )}
              {/* Which reading a cast is for is the area it sits in, so the box
                  itself does not repeat it. A name too long for the lane wraps
                  rather than losing its second word — except in Expanded, where
                  the lane is wide enough for the name on one line and a second
                  line saying what the Beat is made of. */}
              {expanded ? (
                <>
                  <span className="relative w-full truncate text-left text-[11px] font-semibold leading-[14px]">
                    {mech.locked && <LockGlyph />}
                    {label}
                  </span>
                  <span className="relative w-full truncate text-left text-[10px] leading-[13px] text-ink-400">
                    {partsLine(mech)}
                  </span>
                  {/* The seam is named as well as drawn: at this size there is
                      room for the word, so nobody has to know the diamond. */}
                  {marked && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-1.5 text-[9px] uppercase leading-3 tracking-wide text-ink-200"
                      style={{ top: cut - 14 }}
                    >
                      snap
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span
                    className="relative w-full text-center"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {mech.locked && <LockGlyph />}
                    {label}
                    {/* A one-row card has room for one line, so the count rides
                        along on the name. */}
                    {lo === hi && shapes > 0 && <span className="text-[9px] text-ink-400"> ×{shapes}</span>}
                  </span>
                  {lo !== hi && shapes > 0 && (
                    <span className="relative text-[9px] leading-[11px] text-ink-400">×{shapes}</span>
                  )}
                </>
              )}
              {/* The two edges light up under the pointer, so which strip moves
                  which end is something you can see before you press. */}
              {gripped && editable && (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-[6px]"
                    style={{ background: `linear-gradient(${tint(color, 0.9)}, transparent)` }}
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-[7px]"
                    style={{ background: "linear-gradient(transparent, rgba(251,191,36,0.45))" }}
                  />
                  {/* At this size the two edges are wide enough to say they are
                      handles rather than only glow. */}
                  {expanded && (
                    <>
                      <span
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-[3px] h-[3px] w-[18px] -translate-x-1/2 rounded-sm bg-white/55"
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute bottom-1 left-1/2 h-[3px] w-[18px] -translate-x-1/2 rounded-sm bg-white/75"
                      />
                    </>
                  )}
                </>
              )}
              {marked && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0"
                  style={{
                    top: cut - 0.5,
                    height: 0,
                    borderTop: `1px dashed ${gripped ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)"}`,
                  }}
                />
              )}
            </button>
            {marked && editable && (
              // The handle straddles the card's left edge, so it is grabbable
              // without stealing a strip of a 66px lane. It hangs off the
              // wrapper rather than the card because the card clips its
              // overflow; the +2 is the card's own top border, which the
              // wrapper does not have.
              <span
                data-freeze={mech.id}
                aria-label={`${label} Snap marker`}
                className="absolute z-20 touch-none cursor-ns-resize"
                style={{
                  left: -M.diamond / 2,
                  top: cut - M.diamond / 2 + 2,
                  width: M.diamond,
                  height: M.diamond,
                }}
                title={`Snap: baits, anchors and tethers follow their target through step ${
                  freezeRow + 1
                }, then freeze where they are. Drag to move it.`}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({
                    gesture: ++nextGesture.current,
                    id: mech.id,
                    mode: "freeze",
                    grabbed: freezeRow,
                    lo,
                    hi,
                    from: [lo, hi],
                    freeze: freezeRow,
                    freezeFrom: freezeRow,
                    moved: false,
                  });
                }}
                onPointerMove={(event) => {
                  if (drag?.id !== mech.id || drag.mode !== "freeze" || drag.settling) return;
                  const row = clampFreeze(rowAt(event.clientY, visible), drag.lo, drag.hi);
                  if (row !== drag.freeze) setDrag({ ...drag, freeze: row, moved: true });
                }}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  endDrag(mech, lo, hi, visible);
                }}
                onPointerCancel={() => setDrag(null)}
              >
                <SnapDiamond
                  size={M.diamond}
                  fill={held?.mode === "freeze" ? "#ffffff" : gripped ? "#dfe5ee" : color}
                  stroke={held?.mode === "freeze" ? "#ffffff" : "#e6ebf2"}
                />
              </span>
            )}
            {mech.variants.length > 0 && (
              <div
                data-timeline-variants={mech.id}
                className="absolute inset-x-1 bottom-[6px] z-10 flex min-h-0 flex-col gap-0.5"
                style={{ top: expanded ? 36 : 28 }}
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
        {guide !== null && (
          <div
            aria-hidden
            className="pointer-events-none"
            style={{
              gridColumn: "1 / -1",
              gridRow: guide + 1 + head,
              alignSelf: "end",
              height: 0,
              marginBottom: -2.5,
              borderTop: "1px dashed rgba(255,255,255,0.18)",
            }}
          />
        )}
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
                    onContextMenu={(event) =>
                      menuAt(event, stepVariantItems(owner, variant.id, visible, event.clientY))
                    }
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
                      // Wide enough to carry the Variant's own name, so a half
                      // is readable without hovering it for the tooltip.
                      className={`flex shrink-0 touch-none items-center overflow-hidden font-bold tracking-[0.04em] text-ink-900 ${
                        expanded ? "h-4 px-1.5 text-[9px] leading-4" : "h-3 px-1 text-[8px] leading-3"
                      } ${
                        editable ? "cursor-grab active:cursor-grabbing" : ""
                      } ${
                        editing && !previewing ? "outline outline-1 -outline-offset-1 outline-amber-300/80" : ""
                      }`}
                      style={{ background: color }}
                      title={`${stepVariantLabel(owner, variant.id)} — click to preview and edit it; drag this edge to move the Variant split's start Step`}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
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
                    >
                      <span className="truncate">{stepVariantLabel(owner, variant.id)}</span>
                    </button>
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
                            onContextMenu={(event) =>
                              menuAt(event, beatItems(beat, beatLo, beatHi, visible, event.clientY))
                            }
                            className={`flex min-h-0 touch-none select-none flex-col overflow-hidden rounded border-t-2 border-b-[3px] border-b-amber-400/80 text-[10px] leading-[12px] ${
                              expanded ? "items-start px-1.5 pt-1.5" : "items-center px-1 py-1"
                            } ${
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
                              if (event.button !== 0) return;
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
                            {expanded ? (
                              // Inside a box a Beat is the same card, minus the
                              // Snap caption: the seam is the container's to
                              // draw, not a nested chip's.
                              <>
                                <span className="w-full truncate text-left text-[11px] font-semibold leading-[14px]">
                                  {mechLabel(plan, beat)}
                                </span>
                                <span className="w-full truncate text-left text-[10px] leading-[13px] text-ink-400">
                                  {partsLine(beat)}
                                </span>
                              </>
                            ) : (
                              <span
                                className="w-full text-center"
                                style={{
                                  display: "-webkit-box",
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: "vertical",
                                  overflow: "hidden",
                                }}
                              >
                                {mechLabel(plan, beat)}
                              </span>
                            )}
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
                              className="pointer-events-none flex min-h-0 select-none flex-col items-center overflow-hidden rounded border-t-2 border-b-[3px] border-b-amber-400/80 px-1 py-1 text-[10px] leading-[12px] opacity-80 ring-1 ring-white/70"
                              style={{
                                borderTopColor: mechColor(plan, held),
                                background: tint(mechColor(plan, held), 0.18),
                                gridRow: `${rowLo - lo + 1} / ${rowHi - lo + 2}`,
                              }}
                            >
                              <span className="w-full truncate text-center">{mechLabel(plan, held)}</span>
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
                  if (event.button !== 0) return;
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
        {/* The note column: the arena's own card, on the row it belongs to.
            Expanded reads a mechanic top to bottom without a second pane. */}
        {expanded &&
          visible.map((s, i) => {
            const on = s.id === current?.id;
            if (!s.notes && !on) return null;
            const box = { gridColumn: l.laneWidths.length + 2, gridRow: i + 1 + head };
            if (on && editable && editingNote === s.id)
              return (
                <div key={`note:${s.id}`} style={box} className="flex items-center">
                  {/* Uncontrolled + keyed: local typing stays smooth, remote
                      edits reset it — the pane this replaced did the same. */}
                  <textarea
                    key={`${s.id}:${s.notes}`}
                    autoFocus
                    className="field h-[34px] w-full resize-none px-1.5 py-0.5 text-xs leading-4"
                    defaultValue={s.notes}
                    placeholder="Step notes…"
                    onBlur={(event) => {
                      setEditingNote(null);
                      if (event.target.value !== s.notes)
                        void run({
                          op: "update_step",
                          stepId: s.id,
                          patch: { notes: event.target.value },
                        });
                    }}
                  />
                </div>
              );
            return (
              <div key={`note:${s.id}`} style={box} className="flex items-center">
                <button
                  type="button"
                  data-note-cell={s.id}
                  className={`flex h-[34px] w-full items-center gap-1.5 overflow-hidden rounded border bg-ink-900/85 px-1.5 py-px text-left shadow ${
                    on ? "border-accent" : s.notes ? "border-ink-600/70" : "border-ink-600/50"
                  }`}
                  title={
                    on && editable
                      ? "Click to write this step's note. It is the card on the arena."
                      : s.notes
                  }
                  onClick={() => {
                    if (!on) {
                      go(s);
                      return;
                    }
                    if (editable) setEditingNote(s.id);
                  }}
                >
                  <span aria-hidden className="shrink-0 text-ink-400">
                    <NoteGrip />
                  </span>
                  <span
                    className={`min-w-0 flex-1 text-xs leading-4 ${s.notes ? "text-ink-100" : "text-ink-400"}`}
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {s.notes || "Step notes…"}
                  </span>
                </button>
              </div>
            );
          })}
        {/* The row's own menu, spelled out on the row you are on: right-click
            is invisible, and at this size there is room to say it. */}
        {expanded &&
          editable &&
          current &&
          (() => {
            const i = visible.findIndex((s) => s.id === current.id);
            if (i < 0) return null;
            const items = stepItems(current, i);
            const act = (label: string) =>
              items.find(
                (item): item is Extract<MenuItem, { label: string }> =>
                  "label" in item && item.label === label
              );
            const buttons: [string, string][] = [
              ["Add Variant here", "M8 2l5 6-5 6-5-6z"],
              ["Duplicate step", "M5 5h9v9h-9zM11 5V3H2v9h3"],
              ["Add step after", "M8 3v10M3 8h10"],
              ["Delete step", "M4 4l8 8M12 4l-8 8"],
            ];
            return (
              <div
                style={{ gridColumn: l.laneWidths.length + 3, gridRow: i + 1 + head }}
                className="flex items-center gap-0.5"
              >
                {buttons.map(([label, d]) => {
                  const item = act(label);
                  if (!item) return null;
                  return (
                    <button
                      key={label}
                      type="button"
                      data-step-action={label}
                      aria-label={label}
                      title={label}
                      disabled={item.disabled}
                      className={`grid h-6 w-6 place-items-center rounded text-ink-100 hover:bg-ink-600 disabled:opacity-30 ${
                        item.danger ? "hover:text-red-300" : ""
                      }`}
                      onClick={() => item.onSelect?.()}
                    >
                      <RailIcon d={d} />
                    </button>
                  );
                })}
              </div>
            );
          })()}
      </div>
      </>
    );
  }

  /**
   * The three adds, in one row under the grid: a Beat casting in the step you
   * are on, the same as a debuff deal, and a step after the last one. They used
   * to be two stacked buttons under the Beat panel and a lone "+" in the
   * gutter, which put the commonest thing you do to a timeline in two places.
   */
  function addRow(visible: Step[]) {
    const into =
      editingBeatVariant && plan.variantModel === "step"
        ? stepVariantOwner(plan, editingBeatVariant)
        : undefined;
    const addBeat = async (debuff = false) => {
      // Minted here so the Beat is on the rail in the same paint as the click.
      const id = `mech_${crypto.randomUUID()}`;
      await run([
        { op: "add_mech", id, snap: current.id },
        ...(into
          ? [
              {
                op: "assign_beats_to_step_variant" as const,
                stepId: into.step.id,
                variantId: into.variant.id,
                beatIds: [id],
              },
            ]
          : []),
      ]);
      onOpenMech(id);
      if (debuff) onDebuffs(id);
    };
    const where = into ? `in ${stepVariantLabel(into.step, into.variant.id)}` : "here";
    return (
      <div className="mt-2 flex gap-1">
        <button
          type="button"
          // The section behind them is ink-700, which is the plain button
          // colour: a shade up is what keeps the primary looking pressable.
          style={{ background: "var(--color-ink-600)" }}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded text-[13px] text-[#e6ebf2]"
          aria-label={`New Beat ${where}`}
          title="A new Beat casting in the Step you are on. Say where it resolves, then drop its Parts in."
          onClick={() => void addBeat()}
        >
          <RailIcon d="M8 3v10M3 8h10" />
          Beat
        </button>
        <button
          type="button"
          className="flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded border border-ink-600 text-[13px] text-ink-200 hover:bg-ink-600"
          aria-label="New debuff Beat here"
          title="A Beat that deals the fight's debuffs onto role pools. While it is active, the party's tokens wear the deal."
          onClick={() => void addBeat(true)}
        >
          <RailIcon d="M8 3v10M3 8h10" />
          Debuff Beat
        </button>
        <button
          type="button"
          className="flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded border border-ink-600 text-[13px] text-ink-200 hover:bg-ink-600"
          aria-label="Add step after the last one"
          title="A new step after the last one"
          onClick={async () => {
            const last = visible[visible.length - 1];
            const stepAt = last ? plan.steps.indexOf(last) : plan.steps.length - 1;
            await run({ op: "add_step", index: stepAt + 1 });
            setIndex(stepAt + 1);
          }}
        >
          <RailIcon d="M8 3v10M3 8h10" />
          Step
        </button>
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
      </>
    );
  }

  return (
    <nav
      className="panel shrink-0 overflow-y-auto border-y-0 border-l-0 p-2"
      // The lanes decide the width now that the step column is a gutter — but
      // the chrome under them (the add row, the Beat panel) still needs a panel
      // to sit in, so a narrow fight does not get a narrow rail. In Expanded
      // the note and action columns are part of that width too.
      style={{
        width: Math.max(
          236,
          M.chrome + laid.laneWidths.reduce((total, width) => total + width + 4, 0)
        ),
      }}
      // Delete on the rail is the step you have your keyboard on. It is claimed
      // here rather than on the window so the canvas keeps its own Delete, and
      // it never fires on a step the rail is not focused on.
      onKeyDown={(event) => {
        if (event.key !== "Delete" || !editable) return;
        const el = event.target as HTMLElement | null;
        if (!el?.closest("[data-row]")) return;
        if (!current || plan.steps.length < 2) return;
        event.preventDefault();
        event.stopPropagation();
        const stepAt = plan.steps.indexOf(current);
        void run({ op: "delete_step", stepId: current.id }).then(() =>
          setIndex(Math.max(0, stepAt - 1))
        );
      }}
    >
      {preview}
      <div className="label">Encounter</div>
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 truncate text-sm text-ink-200">{plan.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-ink-400">
          {plan.mechanics.length} {plan.mechanics.length === 1 ? "mechanic" : "mechanics"}
        </span>
        <TimelineModeSwitch value={mode} onChange={onMode} />
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
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
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
                  onContextMenu={(event) => menuAt(event, mechanicItems(mechanic))}
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
                {grid(mechanic, siblings, laid)}
                {editable && addRow(siblings)}
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

/** The arena note card's own handle, so the rail's copy reads as the same card. */
function NoteGrip() {
  return (
    <svg width="10" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {[4, 8, 12].map((y) =>
        [6, 10].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1" />)
      )}
    </svg>
  );
}

/** A step action, drawn rather than spelled with a character. */
function RailIcon({ d }: { d: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/** The Snap marker's handle: a diamond sitting astride the card's left edge. */
function SnapDiamond({ size, fill, stroke }: { size: number; fill: string; stroke: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" className="block">
      <path d="M5 0.7L9.3 5 5 9.3 0.7 5z" fill={fill} stroke={stroke} strokeWidth="1.2" />
    </svg>
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

/**
 * The seven groups, on demand.
 *
 * A group is two things at once: a handful of people you can take hold of, and
 * the sets somebody already gave them. Neither is worth a permanent column of
 * screen — the drop rail over the arena covers "give one of these to each of
 * them" — so this is where you go to select a light party, restack it, or take
 * a set back off it.
 */
/**
 * A 280px panel hung under a button, drawn at the document root.
 *
 * A popover left where it is written is at the mercy of whatever the button
 * sits in: the editor header is 48px tall and hides its overflow, so the panel
 * came out sliced, and the palette — later in the document, so later in the
 * paint order — covered what was left. Going out to <body> and positioning
 * against the button's rect is what keeps it whole and on top. z-40 clears the
 * inspector (z-30) and stays under modals (z-50) and context menus (z-200).
 *
 * It owns dismissal too, since "outside" now means outside two separate
 * subtrees: the button and the portalled panel.
 */
function AnchoredPanel({
  anchorRef,
  onClose,
  label,
  children,
}: {
  anchorRef: { current: HTMLElement | null };
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    // Right edges line up, the way the panel used to sit under its button, and
    // it flips above rather than run off the bottom of a short window.
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const pad = 6;
      const left = Math.max(pad, Math.min(a.right - p.width, window.innerWidth - p.width - pad));
      const below = a.bottom + 4;
      const top =
        below + p.height > window.innerHeight - pad
          ? Math.max(pad, a.top - p.height - 4)
          : below;
      setAt((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };

    place();
    // The panel grows a line when it has something to say; follow its height.
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className="panel fixed z-40 w-[280px] rounded p-3 shadow-xl shadow-black/50"
      role="dialog"
      aria-label={label}
      // Placed after the first measure, so it never flashes at the corner.
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body
  );
}

function GroupsPopover({
  rows,
  movable,
  onSelect,
  onCarry,
  onHighlight,
  onDeleteSet,
}: {
  rows: { id: GroupId; label: string; people: number; sets: { id: string; label: string; ids: string[] }[] }[];
  /** Whether a group can be carried onto the floor from here. */
  movable: boolean;
  onSelect(group: GroupId): void;
  onCarry(group: GroupId | null): void;
  onHighlight(id: string | null): void;
  onDeleteSet(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div ref={ref} className="relative ml-auto flex">
      <button
        type="button"
        className="btn px-1.5 py-0.5 text-[11px]"
        aria-expanded={open}
        aria-label="Groups"
        title="Select, move or unbind a group"
        onClick={() => setOpen((value) => !value)}
      >
        Groups ▾
      </button>
      {open && (
        <AnchoredPanel anchorRef={ref} onClose={close} label="Groups">
          <button
            className="btn absolute right-2 top-2 px-2"
            aria-label="Close groups"
            title="Close"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
          <div className="mr-8 grid gap-1">
            {rows.map((row) => (
              <div key={row.id}>
                <div
                  data-group-row={row.id}
                  draggable={movable && row.people > 0}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData("text/plain", "group:" + row.id);
                    ev.dataTransfer.effectAllowed = "move";
                    onCarry(row.id);
                  }}
                  onDragEnd={() => onCarry(null)}
                  onClick={() => {
                    onSelect(row.id);
                    setOpen(false);
                  }}
                  title={
                    row.people > 0
                      ? `Click to select the ${row.label}. Drag this onto the floor to stack them tightly there`
                      : `Nobody is in the ${row.id}`
                  }
                  className={`flex items-baseline gap-2 rounded px-2 py-1 hover:bg-ink-800 ${
                    movable && row.people > 0 ? "cursor-grab active:cursor-grabbing" : ""
                  }`}
                >
                  <div className="text-sm font-semibold text-ink-100">{row.label}</div>
                  <div className="text-[11px] text-ink-400">
                    {row.people} {row.people === 1 ? "player" : "players"}
                  </div>
                </div>
                {/* The set is the object: its shapes are frozen on the canvas,
                    so this row is how you find it and how you take it away. */}
                {row.sets.map((b) => (
                  <div
                    key={b.id}
                    onMouseEnter={() => onHighlight(b.id)}
                    onMouseLeave={() => onHighlight(null)}
                    className="ml-2 mt-1 flex items-center gap-1 rounded bg-ink-900/70 px-2 py-1 text-xs"
                  >
                    <span className="truncate">
                      {b.label} ×{b.ids.length}
                    </span>
                    <button
                      className="ml-auto text-ink-400 hover:text-red-300"
                      title={`Remove this ${b.label.toLowerCase()} from the ${row.id}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onHighlight(null);
                        onDeleteSet(b.ids);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </AnchoredPanel>
      )}
    </div>
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
  const close = useCallback(() => setOpen(false), []);

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
        <AnchoredPanel anchorRef={shareRef} onClose={close} label="Sharing options">
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
        </AnchoredPanel>
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
  | { at: "actors"; ids: string[] }
  | { at: "source"; id: string }
  | { at: "entity"; id: string }
  | { at: "tether"; id: string };

/**
 * What a palette drop will be where it is held: baited (the game picks who),
 * anchored (this person has it), or none (a shape on the floor, or nothing).
 */
type DropIntent = {
  mode: "bait" | "anchor" | "none";
  detail: string;
  /** Letting go here does nothing: it says why instead. */
  blocked?: boolean;
  /** The thing it binds to, in arena units, so the floor can ring it. */
  ring?: { x: number; y: number; r: number };
};

const DROP_TITLE: Record<DropIntent["mode"], string> = { bait: "Baited", anchor: "Anchored", none: "None" };

/** Baits take the bait anchor's gold, anchors the selection blue. */
const dropColor = (intent: DropIntent) =>
  intent.blocked ? "#ef5350" : { bait: "#e0b152", anchor: "#7aa2f7", none: "#9aa5b1" }[intent.mode];

/** The pill that rides beside the pointer while a palette item is in hand. */
function DropHintPill({ intent, clientX, clientY }: { intent: DropIntent; clientX: number; clientY: number }) {
  const color = dropColor(intent);
  return createPortal(
    <div
      data-drop-hint={intent.mode}
      className="pointer-events-none fixed z-50 flex max-w-[300px] items-baseline gap-1.5 rounded-md border bg-ink-900/95 px-2 py-1 text-xs shadow-lg"
      style={{ left: clientX + 18, top: clientY + 20, borderColor: color }}
    >
      <span className="shrink-0 font-semibold" style={{ color }}>
        {DROP_TITLE[intent.mode]}
      </span>
      <span className="text-ink-200">{intent.detail}</span>
    </div>,
    document.body
  );
}

/** The aimed palette shapes, the ones that can be fired along a tether. */
const RIDERS: PaletteMechanicKind[] = ["beam", "protean", "linestack"];
const ridesTethers = (kind: PaletteKind): kind is PaletteMechanicKind =>
  (RIDERS as PaletteKind[]).includes(kind);

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

/** What the Add palette does, carried by the "?" button next to its heading. */
const PALETTE_HELP =
  "Drag onto the floor to place one, onto a group to give everybody one, or onto a boss, " +
  "add, or bait anchor to have it thrown at whoever stands nearest. Drop a tether on any object, " +
  "then pick any other object. Scroll over anything on the arena to size it — shift for fine steps.";

/** A locked Beat's padlock, sized to sit in front of its name. */
function LockGlyph() {
  return (
    <svg
      aria-label="Locked"
      viewBox="0 0 10 12"
      className="mr-0.5 inline-block h-[9px] w-[8px] align-[-1px]"
      fill="none"
      stroke="currentColor"
    >
      <path d="M2.5 5.5 V3.5 a2.5 2.5 0 0 1 5 0 V5.5" strokeWidth="1.4" />
      <rect x="1" y="5.5" width="8" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PaletteGlyph({ kind, size = 30 }: { kind: PaletteKind; size?: number }) {
  const stroke = "#7aa2f7";
  return (
    <svg data-palette-glyph width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
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
      {(kind === "plus" || kind === "x") && (
        <path
          d="M12 3 H18 V12 H27 V18 H18 V27 H12 V18 H3 V12 H12 Z"
          transform={kind === "x" ? "rotate(45 15 15)" : undefined}
          fill="rgba(255,112,67,0.35)"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
        />
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
