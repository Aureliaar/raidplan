import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { api } from "./api";
import { navigate } from "./App";
import { Scene } from "./canvas/Scene";
import { Inspector } from "./Inspector";
import { ChatPanel } from "./ChatPanel";
import type { Op } from "../shared/apply";
import type { Entity, Plan, PlanRole, User } from "../shared/schema";
import { ENTITY_TYPES } from "../shared/schema";

/**
 * The editor. Plan state arrives over the PlanAgent WebSocket — which is also
 * how edits made by a model through MCP land on screen — and every local change
 * is posted as an op, so both paths run identical server code.
 */
export function Editor({ planId, user }: { planId: string; user: User }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [role, setRole] = useState<PlanRole>("viewer");
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"step" | "all">("step");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  useAgent({
    agent: "plan-agent",
    name: planId,
    onStateUpdate: (state: Plan) => {
      if (state?.id) setPlan(state);
    },
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  useEffect(() => {
    api
      .getPlan(planId)
      .then((res) => {
        setPlan(res.plan);
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
        setPlan(res.plan);
        return res;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    },
    [planId]
  );

  if (error && !plan) return <div className="p-8 text-red-400">{error}</div>;
  if (!plan || !step) return <div className="p-8 text-ink-400">Loading plan…</div>;

  const selectedEntity = plan.entities.find((e) => e.id === selected) ?? null;

  async function addEntity(type: Entity["type"]) {
    const spec: Record<string, unknown> = { type, x: 0, y: 0 };
    if (type === "zone") spec.shape = "circle";
    if (type === "marker") spec.marker = "A";
    if (type === "player") spec.job = "any";
    if (type === "text") spec.text = "note";
    if (type === "tether") {
      const [a, b] = plan!.entities.filter((e) => e.type !== "tether");
      if (!a || !b) return setError("Need two entities to tether");
      spec.from = a.id;
      spec.to = b.id;
    }
    if (type === "icon") spec.src = "marker/attack1";
    if (type === "path") spec.points = [-100, 0, 100, 0];
    const res = await run({ op: "add_entity", spec: spec as never });
    const created = res.values[0] as { id: string } | null;
    if (created) setSelected(created.id);
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
        <span className="text-xs text-ink-400">
          rev {plan.rev} · {connected ? "live" : "offline"} · {role}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="label">Drag moves</span>
          <select
            className="field w-auto"
            value={scope}
            onChange={(e) => setScope(e.target.value as "step" | "all")}
          >
            <option value="step">this step only</option>
            <option value="all">every step</option>
          </select>
          <ShareButton planId={planId} canShare={role === "owner"} />
          <span className="text-xs text-ink-400">{user.name}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <StepRail
          plan={plan}
          index={stepIndex}
          editable={editable}
          onSelect={setStepIndex}
          run={run}
          setIndex={setStepIndex}
        />

        <CanvasArea>
          {(size) => (
            <Scene
              plan={plan}
              stepId={step.id}
              size={size}
              selected={selected}
              editable={editable}
              onSelect={setSelected}
              onMove={(id, x, y) =>
                run({
                  op: "update_entity",
                  id,
                  patch: { x, y },
                  stepId: scope === "step" ? step.id : undefined,
                })
              }
            />
          )}
        </CanvasArea>

        <aside className="panel w-[320px] shrink-0 overflow-y-auto border-y-0 border-r-0 p-3">
          <h2 className="label mb-2">Add</h2>
          <div className="mb-4 flex flex-wrap gap-1">
            {ENTITY_TYPES.map((t) => (
              <button key={t} className="btn" disabled={!editable} onClick={() => addEntity(t)}>
                {t}
              </button>
            ))}
            <button className="btn" disabled={!editable} onClick={() => run({ op: "add_waymarks" })}>
              waymarks
            </button>
            <button className="btn" disabled={!editable} onClick={() => run({ op: "add_party" })}>
              party
            </button>
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
      </div>

      {error && (
        <div className="bg-red-950 px-3 py-1 text-xs text-red-300" onClick={() => setError("")}>
          {error} (click to dismiss)
        </div>
      )}

      <ChatPanel planId={planId} />
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

function StepRail({
  plan,
  index,
  editable,
  onSelect,
  run,
  setIndex,
}: {
  plan: Plan;
  index: number;
  editable: boolean;
  onSelect(i: number): void;
  run(ops: Op | Op[]): Promise<unknown>;
  setIndex(i: number): void;
}) {
  const current = plan.steps[index];
  return (
    <nav className="panel w-[220px] shrink-0 overflow-y-auto border-y-0 border-l-0 p-2">
      <div className="label mb-2">Steps</div>
      <ol className="space-y-1">
        {plan.steps.map((s, i) => (
          <li key={s.id}>
            <button
              className={`w-full rounded px-2 py-1 text-left text-sm ${
                i === index ? "bg-ink-600 text-white" : "hover:bg-ink-700"
              }`}
              onClick={() => onSelect(i)}
            >
              {i + 1}. {s.name || "untitled"}
            </button>
          </li>
        ))}
      </ol>
      {editable && (
        <div className="mt-3 space-y-1">
          <button
            className="btn w-full"
            onClick={async () => {
              await run({ op: "duplicate_step", stepId: current.id });
              setIndex(index + 1);
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
              setIndex(Math.max(0, index - 1));
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
