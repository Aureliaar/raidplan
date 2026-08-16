import { useEffect, useState } from "react";
import { api } from "./api";
import type { User } from "../shared/schema";
import { PlanList } from "./PlanList";
import { Editor } from "./Editor";

/** Two screens: the plan list at "/" and an editor at "/p/:id". */
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function navigate(to: string) {
  history.pushState({}, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const path = usePath();
  const [state, setState] = useState<{ user: User | null; devAuth: boolean } | null>(null);

  useEffect(() => {
    api.me().then(setState).catch(() => setState({ user: null, devAuth: false }));
  }, []);

  if (!state) return <Splash>Loading…</Splash>;
  if (!state.user) return <SignIn devAuth={state.devAuth} />;

  const planMatch = /^\/p\/([^/]+)$/.exec(path);
  if (planMatch) return <Editor planId={planMatch[1]} user={state.user} />;
  return <PlanList user={state.user} />;
}

function Splash({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-ink-400">{children}</div>;
}

function SignIn({ devAuth }: { devAuth: boolean }) {
  const [name, setName] = useState("");
  return (
    <div className="flex h-full items-center justify-center">
      <div className="panel w-[340px] rounded-lg p-6">
        <h1 className="mb-1 text-xl font-semibold text-white">raidplan</h1>
        <p className="mb-5 text-sm text-ink-400">
          Vibe-editable FFXIV raid plans, with an MCP server so models can move the pieces.
        </p>
        {devAuth ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              location.href = `/auth/dev?name=${encodeURIComponent(name || "dev")}`;
            }}
          >
            <label className="label">Local sign-in (Discord not configured)</label>
            <input
              className="field"
              placeholder="your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn btn-primary w-full" type="submit">
              Continue
            </button>
          </form>
        ) : (
          <a className="btn btn-primary block text-center" href="/auth/discord">
            Sign in with Discord
          </a>
        )}
      </div>
    </div>
  );
}
