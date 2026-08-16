import type { Op } from "../shared/apply";
import {
  MARKER_IDS,
  TETHER_STYLES,
  ZONE_SHAPES,
  resolveEntity,
  type Entity,
  type Plan,
} from "../shared/schema";
import { JOBS, ROLES } from "../shared/jobs";

/**
 * Property editor for the selected entity. Writes go through the same op API as
 * everything else; with scope "step" they land as per-step overrides.
 */
export function Inspector({
  plan,
  entity,
  stepId,
  scope,
  editable,
  run,
  onDeselect,
}: {
  plan: Plan;
  entity: Entity | null;
  stepId: string;
  scope: "step" | "all";
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

  const shown = resolveEntity(entity, stepId);
  const overridden = !!entity.overrides?.[stepId];
  const patch = (props: Record<string, unknown>) =>
    run({ op: "update_entity", id: entity.id, patch: props, stepId: scope === "step" ? stepId : undefined });

  const num = (key: string, label: string, step = 1) => (
    <Field label={label} key={key}>
      <input
        className="field"
        type="number"
        step={step}
        disabled={!editable}
        value={Math.round(((shown as unknown as Record<string, number>)[key] ?? 0) * 100) / 100}
        onChange={(e) => patch({ [key]: Number(e.target.value) })}
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

      <div className="grid grid-cols-2 gap-2">
        <Field label="name" span>
          <input
            className="field"
            disabled={!editable}
            value={shown.name ?? ""}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        {num("x", "x")}
        {num("y", "y")}
        {num("rotation", "rotation°", 15)}
        {num("scale", "scale", 0.1)}

        {entity.type === "player" && (
          <Field label="job" span>
            <select
              className="field"
              disabled={!editable}
              value={(shown as { job: string }).job}
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
        {entity.type === "enemy" && num("size", "hitbox r")}

        {entity.type === "marker" && (
          <Field label="waymark" span>
            <select
              className="field"
              disabled={!editable}
              value={(shown as { marker: string }).marker}
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
                value={(shown as { shape: string }).shape}
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

        {entity.type === "text" && (
          <Field label="text" span>
            <input
              className="field"
              disabled={!editable}
              value={(shown as { text: string }).text}
              onChange={(e) => patch({ text: e.target.value })}
            />
          </Field>
        )}
        {entity.type === "text" && num("fontSize", "font size")}

        {entity.type === "tether" && (
          <Field label="style" span>
            <select
              className="field"
              disabled={!editable}
              value={(shown as { style: string }).style}
              onChange={(e) => patch({ style: e.target.value })}
            >
              {TETHER_STYLES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="colour">
          <input
            className="field h-8 p-0"
            type="color"
            disabled={!editable}
            value={shown.color ?? "#ff7043"}
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
            value={shown.opacity}
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
        <button
          className="btn"
          disabled={!editable || !overridden}
          onClick={() => run({ op: "clear_override", id: entity.id, stepId })}
          title="Revert this entity to its base pose in this step"
        >
          Clear override
        </button>
        <button
          className="btn"
          disabled={!editable}
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
      <Field label="rows/rings">
        <input
          className="field"
          type="number"
          disabled={!editable}
          value={plan.arena.grid.rows}
          onChange={(e) =>
            set({ grid: { ...plan.arena.grid, rows: Number(e.target.value), rings: Number(e.target.value) } })
          }
        />
      </Field>
      <Field label="cols/spokes">
        <input
          className="field"
          type="number"
          disabled={!editable}
          value={plan.arena.grid.cols}
          onChange={(e) =>
            set({ grid: { ...plan.arena.grid, cols: Number(e.target.value), spokes: Number(e.target.value) } })
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
