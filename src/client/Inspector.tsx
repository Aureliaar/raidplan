import { useEffect, useState } from "react";
import type { Op } from "../shared/apply";
import {
  MARKER_IDS,
  TETHER_STYLES,
  anchorTarget,
  anchoredPose,
  authoredEntitiesForStep,
  composeBeatVariantEntities,
  entitiesForStep,
  mechLabel,
  mechColor,
  BAIT_RULES,
  type BaitRule,
  ZONE_SHAPES,
  arenaUnitsToYalms,
  yalmsToArenaUnits,
  resolveEntityForStep,
  variantStepEdited,
  type Entity,
  type Plan,
} from "../shared/schema";
import { BAIT_KINDS, baitNeedsSource, baitSpec, type BaitKind } from "../shared/ops";
import { playersHit } from "../shared/hits";
import { JOBS, ROLES } from "../shared/jobs";
import { ACTOR_KEYS, ARENA_BACKGROUNDS, MARKER_KEYS } from "../shared/assets";
import { api } from "./api";
import {
  arenaCalibration,
  arenaMatchesKnownGeometry,
  knownArenaCalibration,
} from "../shared/arena-calibration";




/**
 * Who this zone catches. Players are points in FFXIV, so a token whose art
 * overlaps the edge is not necessarily in it — the one call you cannot make by
 * looking at the picture.
 */
function Hits({
  plan,
  stepId,
  zoneId,
  shown,
}: {
  plan: Plan;
  stepId: string;
  zoneId: string;
  shown?: Record<string, string>;
}) {
  const hit = playersHit(plan, stepId, zoneId, shown);
  return (
    <p className="mb-3 rounded bg-ink-800 px-2 py-1 text-xs text-ink-400">
      hits{" "}
      <b className="text-ink-200">
        {hit.length ? hit.map((h) => h.name ?? h.id).join(", ") : "nobody"}
      </b>{" "}
      in this step
    </p>
  );
}

/**
 * The target editor for a bait. "closest" is the interesting setting: the bait
 * is not attached to a player at all, it re-picks whoever is nearest each time
 * the plan is drawn, so the plan keeps describing the mechanic rather than one
 * particular pull of it. The line at the bottom says who that is right now.
 */
function BaitTarget({
  plan,
  entity,
  anchor,
  stepId,
  scope,
  variant,
  shown,
  editable,
  run,
}: {
  plan: Plan;
  entity: Entity;
  anchor: NonNullable<Entity["anchor"]>;
  stepId: string;
  scope: "step" | "all";
  /** The reading of this step's mechanic being played, when it goes two ways. */
  variant?: string;
  /** Which reading of every mechanic is on screen, for solving baits. */
  shown?: Record<string, string>;
  editable: boolean;
  run(ops: Op | Op[]): Promise<unknown>;
}) {
  // Anchors are structure, not pose: they belong to the entity in every step.
  const setAnchor = (props: Partial<NonNullable<Entity["anchor"]>>) =>
    run({ op: "update_entity", id: entity.id, patch: { anchor: { ...anchor, ...props } } });

  const resolved = entitiesForStep(plan, stepId, undefined, shown);
  const now = anchorTarget({ ...entity, anchor } as Entity, new Map(resolved.map((e) => [e.id, e])));
  const candidates = (plan.variantModel === "beat"
    ? composeBeatVariantEntities(plan, stepId, shown).entities
    : authoredEntitiesForStep(plan, stepId, variant)).filter(
    (e) => !e.anchor && e.type !== "tether" && e.id !== entity.id
  );
  const nudged = plan.variantModel === "beat"
    ? entity
    : resolveEntityForStep(plan, entity, stepId, variant);

  return (
    <div className="mb-3 rounded bg-ink-800 p-2 text-xs">
      <div className="label mb-1">bait target</div>
      <div className="flex flex-wrap gap-1">
        <select
          className="field flex-1"
          disabled={!editable}
          value={anchor.pick ?? "fixed"}
          onChange={(e) =>
            e.target.value === "fixed"
              ? setAnchor({ pick: undefined, to: now?.id ?? candidates[0]?.id ?? "" })
              : setAnchor({ pick: e.target.value as BaitRule })
          }
        >
          {BAIT_RULES.map((r) => (
            <option key={r} value={r}>
              {r} {anchor.of === "any" ? "entity" : anchor.of}
            </option>
          ))}
          <option value="fixed">a named entity</option>
        </select>
        {anchor.pick ? (
          <input
            className="field w-16"
            type="number"
            min={1}
            max={8}
            title="1 = the closest, 2 = the second closest"
            disabled={!editable}
            value={anchor.rank}
            onChange={(e) => setAnchor({ rank: Math.max(1, Math.min(8, Number(e.target.value))) })}
          />
        ) : (
          <select
            className="field flex-1"
            disabled={!editable}
            value={anchor.to}
            onChange={(e) => setAnchor({ to: e.target.value })}
          >
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ?? e.id}
              </option>
            ))}
          </select>
        )}
      </div>

      {anchor.from && (
        <div className="mt-1 flex items-center gap-1">
          <span className="text-ink-400">from</span>
          <select
            className="field flex-1"
            disabled={!editable}
            value={anchor.from}
            onChange={(e) => setAnchor({ from: e.target.value })}
          >
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ?? e.id}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-ink-400">
            <input
              type="checkbox"
              disabled={!editable}
              checked={anchor.extend}
              onChange={(e) => setAnchor({ extend: e.target.checked })}
            />
            to wall
          </label>
        </div>
      )}

      <p className="mt-1 text-ink-400">
        right now: <b className="text-ink-200">{now ? (now.name ?? now.id) : "nobody in this step"}</b>. Drag
        it to sit off to one side — x/y is an offset from wherever the bait lands, so it keeps following.{" "}
        {editable && (nudged.x !== 0 || nudged.y !== 0) && (
          <button
            className="underline"
            onClick={() =>
              run({
                op: "update_entity",
                id: entity.id,
                patch: { x: 0, y: 0 },
                stepId: scope === "step" ? stepId : undefined,
                variant: scope === "step" ? variant : undefined,
              })
            }
          >
            recentre
          </button>
        )}{" "}
        {editable && (
          <button
            className="underline"
            onClick={() =>
              run({
                op: "update_entity",
                id: entity.id,
                patch: { anchor: null, ...freeze(plan, stepId, entity, shown) },
              })
            }
          >
            unbind
          </button>
        )}
      </p>
    </div>
  );
}

/**
 * Hang a baited mechanic off the selected entity. Everything it needs is already
 * on screen — who it lands on is whatever you have selected — so this is one
 * dropdown and a button rather than a placement mode.
 */
function BaitPanel({
  plan,
  target,
  stepId,
  scope,
  variant,
  shown,
  editable,
  run,
}: {
  plan: Plan;
  target: Entity;
  stepId: string;
  scope: "step" | "all";
  /** The reading of this step's mechanic being played, when it goes two ways. */
  variant?: string;
  /** Which reading of every mechanic is on screen, for solving baits. */
  shown?: Record<string, string>;
  editable: boolean;
  run(ops: Op | Op[]): Promise<unknown>;
}) {
  const sources = (plan.variantModel === "beat"
    ? composeBeatVariantEntities(plan, stepId, shown).entities
    : authoredEntitiesForStep(plan, stepId, variant)).filter(
    (e) => e.id !== target.id && e.type !== "tether" && !e.anchor
  );
  const [kind, setKind] = useState<BaitKind>("beam");
  const [from, setFrom] = useState(
    () => sources.find((e) => e.type === "enemy")?.id ?? sources[0]?.id ?? ""
  );
  const needsSource = baitNeedsSource(kind);

  return (
    <div className="mb-3 rounded bg-ink-800 p-2">
      <div className="label mb-1">bait this {target.type}</div>
      <div className="flex gap-1">
        <select
          className="field flex-1"
          disabled={!editable}
          value={kind}
          onChange={(e) => setKind(e.target.value as BaitKind)}
        >
          {BAIT_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        {needsSource && (
          <select
            className="field flex-1"
            disabled={!editable}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {sources.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name ?? e.id}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn"
          disabled={!editable || (needsSource && !from)}
          onClick={() =>
            run({
              op: "add_entity",
              spec: baitSpec(kind, target.id, from || undefined, {
                name: `${kind} ${target.name ?? ""}`.trim(),
                steps: scope === "step" ? [stepId] : "all",
              }) as never,
            })
          }
        >
          add
        </button>
      </div>
    </div>
  );
}

/** Unbinding keeps the bait where it currently is, rather than snapping it home. */
function freeze(plan: Plan, stepId: string, entity: Entity, shown?: Record<string, string>) {
  const byId = new Map(entitiesForStep(plan, stepId, undefined, shown).map((e) => [e.id, e]));
  return anchoredPose(entity, byId, plan.arena) ?? {};
}

/** Preserve useful intermediate text such as `0.` while a number is typed. */
function NumberInput({
  value,
  step,
  disabled,
  onCommit,
}: {
  value: number;
  step: number;
  disabled: boolean;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next)) {
      if (next !== value) onCommit(next);
    } else {
      setDraft(String(value));
    }
  };

  return (
    <input
      className="field"
      type="number"
      step={step}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Property editor for the selected entity. Writes go through the same op API as
 * everything else; with scope "step" they land as per-step overrides.
 */
export function Inspector({
  plan,
  entity,
  stepId,
  scope,
  variant,
  shown: playing,
  editable,
  run,
  onDeselect,
}: {
  plan: Plan;
  entity: Entity | null;
  stepId: string;
  scope: "step" | "all";
  /** The reading of this step's mechanic being played, when it goes two ways. */
  variant?: string;
  /** Which reading of every mechanic is on screen, for solving baits. */
  shown?: Record<string, string>;
  editable: boolean;
  run(ops: Op | Op[]): Promise<unknown>;
  onDeselect(): void;
}) {
  if (!entity) {
    return (
      <div>
        <h2 className="label mb-2">Arena</h2>
        <ArenaFields plan={plan} editable={editable} run={run} />
        <p className="mt-4 text-xs text-ink-400">Select something on the canvas to edit it.</p>
      </div>
    );
  }

  const mechOf = entity.mech ? plan.mechs.find((m) => m.id === entity.mech) : undefined;
  const shownEntity = plan.variantModel === "beat"
    ? entity
    : resolveEntityForStep(plan, entity, stepId, variant);
  const physicalCalibration = arenaCalibration(plan);
  const authoredScene = plan.variantModel === "beat"
    ? composeBeatVariantEntities(plan, stepId, playing).entities
    : authoredEntitiesForStep(plan, stepId, variant);
  const variantOnly = !plan.entities.some((candidate) => candidate.id === entity.id);
  const detached = !!variant && variantStepEdited(plan, stepId, variant);
  const players = authoredScene.filter((candidate) => candidate.type === "player");
  const tetherSet = entity.type === "tether" && entity.bond
    ? authoredScene.filter((e) => e.type === "tether" && e.bond?.id === entity.bond?.id)
    : entity.type === "tether" ? [entity] : [];
  const patchTetherSet = (props: Record<string, unknown>) =>
    run(tetherSet.map((tether) => ({ op: "update_entity" as const, id: tether.id, patch: props })));
  const overridden =
    !!entity.overrides?.[stepId] || (!!variant && variantStepEdited(plan, stepId, variant));
  const patch = (props: Record<string, unknown>) =>
    run({
      op: "update_entity",
      id: entity.id,
      patch: props,
      stepId: scope === "step" ? stepId : undefined,
      variant: scope === "step" ? variant : undefined,
    });

  const num = (key: string, label: string, step = 1) => (
    <Field label={label} key={key}>
      <NumberInput
        value={Math.round(((shownEntity as unknown as Record<string, number>)[key] ?? 0) * 100) / 100}
        step={step}
        disabled={!editable}
        onCommit={(value) => patch({ [key]: value })}
      />
    </Field>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="label">
          {entity.type} {overridden && <span className="text-accent">· step override</span>}
        </h2>
        <button className="btn text-xs" onClick={onDeselect}>
          ✕
        </button>
      </div>

      {entity.type === "marker" && (
        <p className="mb-2 text-xs text-ink-400">
          Waymarks belong to the whole plan: they sit in every step, and they only move on the
          waymark layer.
        </p>
      )}

      {entity.type === "zone" && entity.shape !== "arrow" && (
        <Hits plan={plan} stepId={stepId} zoneId={entity.id} shown={playing} />
      )}

      {variantOnly && scope === "all" && (
        <p className="mb-2 text-xs text-ink-400">
          This exists only in this reading and step, so its edits stay here.
        </p>
      )}
      {entity.type !== "marker" && !variantOnly && detached && scope === "all" && (
        <p className="mb-2 text-xs text-ink-400">
          This reading is detached. Every-step edits update the shared source, not this frozen scene.
        </p>
      )}

      {!entity.anchor && entity.type !== "tether" && (
        <BaitPanel
          plan={plan}
          target={entity}
          stepId={stepId}
          scope={scope}
          variant={variant}
          shown={playing}
          editable={editable}
          run={run}
        />
      )}

      {shownEntity.anchor && (
        <BaitTarget
          plan={plan}
          entity={entity}
          anchor={shownEntity.anchor}
          stepId={stepId}
          scope={scope}
          variant={variant}
          shown={playing}
          editable={editable}
          run={run}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="name" span>
          <input
            className="field"
            disabled={!editable}
            value={shownEntity.name ?? ""}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        {num("x", shownEntity.anchor ? "offset x" : "x")}
        {num("y", shownEntity.anchor ? "offset y" : "y")}
        {num("rotation", "rotation°", 15)}
        {num("scale", "scale", 0.1)}

        {entity.type === "player" && (
          <Field label="job" span>
            <select
              className="field"
              disabled={!editable}
              value={(shownEntity as { job: string }).job}
              onChange={(e) => patch({ job: e.target.value })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              {JOBS.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.id} — {j.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {entity.type === "player" && num("size", "size")}
        {(entity.type === "player" || entity.type === "enemy") && (
          <Field label="art" span>
            <select
              className="field"
              disabled={!editable}
              value={(shownEntity as { icon?: string }).icon ?? ""}
              onChange={(e) => patch({ icon: e.target.value || undefined })}
            >
              <option value="">auto ({entity.type === "player" ? "from job" : "from size"})</option>
              {ACTOR_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k.replace("actor/", "")}
                </option>
              ))}
            </select>
          </Field>
        )}
        {entity.type === "enemy" && num("size", "hitbox r")}

        {entity.type === "marker" && (
          <Field label="waymark" span>
            <select
              className="field"
              disabled={!editable}
              value={(shownEntity as { marker: string }).marker}
              onChange={(e) => patch({ marker: e.target.value })}
            >
              {MARKER_IDS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        )}
        {entity.type === "marker" && num("size", "size")}

        {entity.type === "zone" && (
          <>
            <Field label="shape" span>
              <select
                className="field"
                disabled={!editable}
                value={(shownEntity as { shape: string }).shape}
                onChange={(e) => patch({ shape: e.target.value })}
              >
                {ZONE_SHAPES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {num("radius", "radius")}
            {num("innerRadius", "inner r")}
            {num("angle", "cone °", 5)}
            {num("width", "width")}
            {num("length", "length")}
            {num("count", "count")}
            {num("soak", "soak")}
          </>
        )}

        {entity.type === "icon" && (
          <>
            <Field label="icon" span>
              <select
                className="field"
                disabled={!editable}
                value={(shownEntity as { src: string }).src}
                onChange={(e) => patch({ src: e.target.value })}
              >
                {[...MARKER_KEYS, ...ACTOR_KEYS].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            {num("size", "size")}
          </>
        )}

        {entity.type === "text" && (
          <Field label="text" span>
            <input
              className="field"
              disabled={!editable}
              value={(shownEntity as { text: string }).text}
              onChange={(e) => patch({ text: e.target.value })}
            />
          </Field>
        )}
        {entity.type === "text" && num("fontSize", "font size")}

        {entity.type === "tether" && (
          <>
            <Field label="from player">
              <select
                className="field"
                disabled={!editable}
                value={(shownEntity as Extract<Entity, { type: "tether" }>).from}
                onChange={(e) => patch({ from: e.target.value })}
              >
                {players.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name ?? player.job}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="to player">
              <select
                className="field"
                disabled={!editable}
                value={(shownEntity as Extract<Entity, { type: "tether" }>).to}
                onChange={(e) => patch({ to: e.target.value })}
              >
                {players.map((player) => (
                  <option key={player.id} value={player.id}>
                    {player.name ?? player.job}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="style" span>
              <select
                className="field"
                disabled={!editable}
                value={(shownEntity as { style: string }).style}
                onChange={(e) => patchTetherSet({ style: e.target.value })}
              >
                <option value="close">together</option>
                <option value="far">go far</option>
                {TETHER_STYLES.filter((s) => s !== "close" && s !== "far").map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="required range" span>
              <select
                className="field"
                disabled={!editable || ((shownEntity as { style: string }).style !== "close" && (shownEntity as { style: string }).style !== "far")}
                value={(shownEntity as { range?: number }).range ?? ""}
                onChange={(e) => {
                  if (e.target.value) void patchTetherSet({ range: Number(e.target.value) });
                }}
              >
                <option value="" disabled>not configured</option>
                {(() => {
                  const current = (shownEntity as { range?: number }).range;
                  const presets = [5, 8, 10, 12, 15, 20, 25, 30].map((yalms) => ({
                    yalms,
                    range: yalmsToArenaUnits(plan.arena, yalms, physicalCalibration.widthYalms),
                  }));
                  const custom = current !== undefined && !presets.some(({ range }) => Math.abs(range - current) < 1e-6)
                    ? arenaUnitsToYalms(plan.arena, current, physicalCalibration.widthYalms)
                    : undefined;
                  return (
                    <>
                      {custom !== undefined && (
                        <option value={current}>{Math.round(custom * 10) / 10} yalms (current)</option>
                      )}
                      {presets.map(({ yalms, range }) => (
                        <option key={yalms} value={range}>{yalms} yalms</option>
                      ))}
                    </>
                  );
                })()}
              </select>
            </Field>
            {(() => {
              const tether = shownEntity as Extract<Entity, { type: "tether" }>;
              const resolved = entitiesForStep(plan, stepId, undefined, playing);
              const byId = new Map(resolved.map((e) => [e.id, e]));
              const from = byId.get(tether.from);
              const to = byId.get(tether.to);
              if (!from || !to || tether.range === undefined || (tether.style !== "close" && tether.style !== "far")) return null;
              const distance = Math.hypot(to.x - from.x, to.y - from.y);
              const ok = tether.style === "close" ? distance <= tether.range : distance >= tether.range;
              const measured = arenaUnitsToYalms(plan.arena, distance, physicalCalibration.widthYalms);
              const required = arenaUnitsToYalms(plan.arena, tether.range, physicalCalibration.widthYalms);
              const shownDistance = Math.round(measured * 10) / 10;
              const shownRange = Math.round(required * 10) / 10;
              return (
                <p className={`col-span-2 rounded px-2 py-1 text-xs ${ok ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>
                  {shownDistance} {tether.style === "close" ? "≤" : "≥"} {shownRange} yalms — {ok ? "satisfied" : "not satisfied"}
                </p>
              );
            })()}
          </>
        )}

        <Field label="colour">
          <input
            className="field h-8 p-0"
            type="color"
            disabled={!editable}
            value={shownEntity.color ?? "#ff7043"}
            onChange={(e) => patch({ color: e.target.value })}
          />
        </Field>
        <Field label="opacity">
          <input
            className="w-full"
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            disabled={!editable}
            value={shownEntity.opacity}
            onChange={(e) => patch({ opacity: Number(e.target.value) })}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        <button
          className="btn"
          disabled={!editable}
          onClick={() => run({ op: "duplicate_entity", id: entity.id })}
        >
          Duplicate
        </button>
        <button
          className="btn"
          disabled={!editable}
          onClick={() => run({ op: "reorder_entity", id: entity.id, where: "front" })}
        >
          Front
        </button>
        <button
          className="btn"
          disabled={!editable}
          onClick={() => run({ op: "reorder_entity", id: entity.id, where: "back" })}
        >
          Back
        </button>
        {/* A waymark is the same in every step by definition, so neither the
            per-step pose nor step membership means anything for one. */}
        {entity.type !== "marker" && (
          <>
            <button
              className="btn"
              disabled={!editable || !overridden}
              onClick={() =>
                run({
                  op: "clear_override",
                  id: entity.id,
                  stepId,
                  variant: scope === "step" ? variant : undefined,
                })
              }
              title="Revert this entity to its base pose in this step"
            >
              Clear override
            </button>
            <button
              className="btn"
              disabled={!editable || !!entity.mech}
              title={
                entity.mech
                  ? "This belongs to a mech, which decides when it is on the floor"
                  : undefined
              }
              onClick={() =>
                run({
                  op: "update_entity",
                  id: entity.id,
                  patch: { steps: entity.steps === "all" ? [stepId] : "all" },
                })
              }
            >
              {entity.steps === "all" ? "Only this step" : "All steps"}
            </button>
            {/* Which cast this shape is part of: a mech times it and aims it,
                so moving it between slots is a real edit, not a label. */}
            {mechOf && (
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ background: mechColor(plan, mechOf) }}
                title="Drawn in its mech's colour"
              />
            )}
            <select
              className="field w-auto"
              disabled={!editable}
              title="The mech this shape belongs to"
              value={entity.mech ?? ""}
              onChange={(e) =>
                run({
                  op: "assign_mech",
                  ids: [entity.id],
                  mechId: e.target.value || null,
                })
              }
            >
              <option value="">no mech</option>
              {plan.mechs.map((m) => (
                <option key={m.id} value={m.id}>
                  {mechLabel(plan, m)}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          className="btn text-red-300"
          disabled={!editable}
          onClick={() => {
            run({ op: "delete_entities", ids: [entity.id] });
            onDeselect();
          }}
        >
          Delete
        </button>
      </div>

      <p className="mt-3 font-mono text-[10px] text-ink-400">{entity.id}</p>
    </div>
  );
}

function ArenaFields({
  plan,
  editable,
  run,
}: {
  plan: Plan;
  editable: boolean;
  run(ops: Op | Op[]): Promise<unknown>;
}) {
  const set = (patch: Record<string, unknown>) => run({ op: "set_arena", patch: patch as never });
  const radial = plan.arena.grid.type === "radial";
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const customBackdrop = plan.arena.image && !ARENA_BACKGROUNDS.some((b) => b.key === plan.arena.image);
  const calibration = arenaCalibration(plan);
  const knownCalibration = knownArenaCalibration(plan);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="shape" span>
        <select
          className="field"
          disabled={!editable}
          value={plan.arena.shape}
          onChange={(e) => set({ shape: e.target.value })}
        >
          <option value="square">square</option>
          <option value="circle">circle</option>
          <option value="rect">rect</option>
        </select>
      </Field>
      <Field label="width">
        <input
          className="field"
          type="number"
          disabled={!editable}
          value={plan.arena.width}
          onChange={(e) => set({ width: Number(e.target.value) })}
        />
      </Field>
      <Field label="height">
        <input
          className="field"
          type="number"
          disabled={!editable}
          value={plan.arena.height}
          onChange={(e) => set({ height: Number(e.target.value) })}
        />
      </Field>
      <Field label="backdrop" span>
        <select
          className="field"
          disabled={!editable}
          value={plan.arena.image ?? ""}
          onChange={(e) => set({ image: e.target.value || null })}
        >
          <option value="">none</option>
          {customBackdrop && <option value={plan.arena.image}>custom upload</option>}
          {ARENA_BACKGROUNDS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="arena width (yalms)" span>
        <NumberInput
          value={calibration.widthYalms}
          step={0.1}
          disabled={!editable}
          onCommit={(widthYalms) => set({ widthYalms })}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-400">
          <span>
            {Math.round(calibration.widthYalms * 10) / 10}×{Math.round(calibration.heightYalms * 10) / 10} yalms · {calibration.label}
          </span>
          {calibration.source === "manual" && (
            <button className="btn px-1.5 py-0.5 text-[10px]" disabled={!editable} onClick={() => set({ widthYalms: null })}>
              reset
            </button>
          )}
        </div>
        {knownCalibration && !arenaMatchesKnownGeometry(plan, knownCalibration) && (
          <button
            className="btn mt-1 w-full text-xs"
            disabled={!editable}
            onClick={() => set({
              shape: knownCalibration.shape,
              height: plan.arena.width * (knownCalibration.heightYalms / knownCalibration.widthYalms),
            })}
          >
            Apply known {knownCalibration.widthYalms}×{knownCalibration.heightYalms} shape
          </button>
        )}
      </Field>
      <Field label="custom backdrop" span>
        <input
          className="field"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={!editable || uploading}
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) return;
            setUploadError("");
            setUploadNotice("");
            setUploading(true);
            try {
              const uploaded = await api.uploadBackground(file);
              await set({ image: uploaded.url });
              if (uploaded.resized) {
                setUploadNotice(
                  `Downscaled ${uploaded.originalWidth}×${uploaded.originalHeight} to ${uploaded.width}×${uploaded.height}`
                );
              }
            } catch (error) {
              setUploadError(error instanceof Error ? error.message : "Upload failed");
            } finally {
              setUploading(false);
              input.value = "";
            }
          }}
        />
        <p className={`mt-1 text-xs ${uploadError ? "text-red-300" : "text-ink-400"}`}>
          {uploadError ||
            uploadNotice ||
            (uploading ? "Preparing and uploading…" : "PNG, JPEG or WebP · larger images downscale automatically")}
        </p>
      </Field>
      <Field label="backdrop opacity" span>
        <input
          className="w-full"
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          disabled={!editable || !plan.arena.image}
          value={plan.arena.imageOpacity}
          onChange={(e) => set({ imageOpacity: Number(e.target.value) })}
        />
      </Field>
      <Field label="grid" span>
        <select
          className="field"
          disabled={!editable}
          value={plan.arena.grid.type}
          onChange={(e) => set({ grid: { ...plan.arena.grid, type: e.target.value } })}
        >
          <option value="none">none</option>
          <option value="square">square</option>
          <option value="radial">radial</option>
          <option value="cross">cross</option>
        </select>
      </Field>
      {/* A radial grid is counted in rings and spokes, a square one in rows and
          columns — show whichever pair the current grid actually uses. */}
      <Field label={radial ? "rings" : "rows"}>
        <input
          className="field"
          type="number"
          disabled={!editable || plan.arena.grid.type === "none"}
          value={radial ? plan.arena.grid.rings : plan.arena.grid.rows}
          onChange={(e) =>
            set({ grid: { ...plan.arena.grid, [radial ? "rings" : "rows"]: Number(e.target.value) } })
          }
        />
      </Field>
      <Field label={radial ? "spokes" : "cols"}>
        <input
          className="field"
          type="number"
          disabled={!editable || plan.arena.grid.type === "none"}
          value={radial ? plan.arena.grid.spokes : plan.arena.grid.cols}
          onChange={(e) =>
            set({ grid: { ...plan.arena.grid, [radial ? "spokes" : "cols"]: Number(e.target.value) } })
          }
        />
      </Field>
    </div>
  );
}

function Field({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return (
    <div className={span ? "col-span-2" : undefined}>
      <div className="label mb-0.5">{label}</div>
      {children}
    </div>
  );
}
