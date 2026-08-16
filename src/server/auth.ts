import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { type AppEnv, appUrl, isDevAuth } from "./env";
import { registry } from "./registry";
import type { User } from "../shared/schema";

/**
 * Two ways in:
 *   - a Discord OAuth session cookie (the web app),
 *   - a `rp_…` bearer token (the MCP server, scripts, CI).
 * Both resolve to the same `User` and the same per-plan ACL.
 */

const SESSION_COOKIE = "rp_session";
const STATE_COOKIE = "rp_oauth_state";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function secretOf(env: AppEnv): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  // A known fallback key means anyone can forge a session cookie, so it is only
  // tolerable on the local dev sign-in.
  if (isDevAuth(env)) return "dev-insecure-session-secret";
  throw new Error("SESSION_SECRET is not set (wrangler secret put SESSION_SECRET)");
}

async function hmac(env: AppEnv, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretOf(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signSession(env: AppEnv, userId: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ u: userId, e: Date.now() + SESSION_TTL * 1000 })));
  return `${body}.${await hmac(env, body)}`;
}

async function verifySession(env: AppEnv, token: string): Promise<string | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(env, body);
  if (sig.length !== expected.length) return null;
  // Constant-time-ish comparison.
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as { u: string; e: number };
    return payload.e > Date.now() ? payload.u : null;
  } catch {
    return null;
  }
}

export interface AuthResult {
  user: User | null;
  via: "session" | "token" | null;
}

/** Resolve the caller of a request. Never throws. */
export async function authenticate(request: Request, env: AppEnv): Promise<AuthResult> {
  const url = new URL(request.url);
  const header = request.headers.get("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const raw = bearer ?? url.searchParams.get("token") ?? request.headers.get("x-raidplan-token");

  if (raw?.startsWith("rp_")) {
    const user = await registry(env).userForTokenHash(await sha256Hex(raw));
    if (user) return { user, via: "token" };
  }

  const cookie = cookieFrom(request, SESSION_COOKIE);
  if (cookie) {
    const userId = await verifySession(env, cookie);
    if (userId) {
      const user = await registry(env).getUser(userId);
      if (user) return { user, via: "session" };
    }
  }
  return { user: null, via: null };
}

function cookieFrom(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Mint a fresh API token for a user; the plaintext is shown exactly once. */
export async function issueToken(env: AppEnv, userId: string, label: string) {
  const token = `rp_${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const { id } = await registry(env).createToken(userId, label, await sha256Hex(token));
  return { id, token };
}

/* --------------------------------------------------------------- routes */

export const authRoutes = new Hono<{ Bindings: AppEnv }>();

authRoutes.get("/discord", async (c) => {
  const env = c.env;
  if (isDevAuth(env)) return c.text("Discord OAuth is not configured (set DISCORD_CLIENT_ID/SECRET)", 501);
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  setCookie(c, STATE_COOKIE, `${state}|${c.req.query("next") ?? "/"}`, {
    httpOnly: true,
    secure: c.req.url.startsWith("https"),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const scope = env.DISCORD_GUILD_ID ? "identify guilds" : "identify";
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID!,
    response_type: "code",
    redirect_uri: `${appUrl(env, c.req.raw)}/auth/discord/callback`,
    scope,
    state,
    prompt: "none",
  });
  return c.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

authRoutes.get("/discord/callback", async (c) => {
  const env = c.env;
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stored = getCookie(c, STATE_COOKIE) ?? "";
  const [expected, next = "/"] = stored.split("|");
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (!code || !state || state !== expected) return c.text("Bad OAuth state", 400);

  const redirectUri = `${appUrl(env, c.req.raw)}/auth/discord/callback`;
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID!,
      client_secret: env.DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return c.text(`Discord token exchange failed: ${await tokenRes.text()}`, 502);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) return c.text("Could not read Discord profile", 502);
  const me = (await meRes.json()) as {
    id: string;
    username: string;
    global_name?: string;
    avatar?: string;
  };

  const allowlist = (env.DISCORD_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowlist.length && !allowlist.includes(me.id)) return c.text("This Discord account is not on the allowlist", 403);

  if (env.DISCORD_GUILD_ID) {
    const guilds = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const list = guilds.ok ? ((await guilds.json()) as { id: string }[]) : [];
    if (!list.some((g) => g.id === env.DISCORD_GUILD_ID))
      return c.text("You are not a member of the required Discord server", 403);
  }

  const user = await registry(env).upsertUser({
    id: `discord:${me.id}`,
    provider: "discord",
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : undefined,
  });

  setCookie(c, SESSION_COOKIE, await signSession(env, user.id), {
    httpOnly: true,
    secure: c.req.url.startsWith("https"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return c.redirect(next.startsWith("/") ? next : "/");
});

/** Local sign-in, available only while Discord OAuth is unconfigured. */
authRoutes.get("/dev", async (c) => {
  if (!isDevAuth(c.env)) return c.text("Dev sign-in is disabled", 403);
  const name = c.req.query("name") || "dev";
  const user = await registry(c.env).upsertUser({
    id: `local:${name.toLowerCase()}`,
    provider: "local",
    name,
  });
  setCookie(c, SESSION_COOKIE, await signSession(c.env, user.id), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
  return c.redirect(c.req.query("next") ?? "/");
});

/**
 * Mint an API token without a browser session.
 *
 * A deploy with no interactive sign-in has no other way to issue its first
 * token — tokens are created from a signed-in session, and there are no
 * sessions. Guarded by BOOTSTRAP_SECRET; unset it (or rotate it) to close the
 * door once you hold a token.
 *
 *   curl -X POST https://host/auth/bootstrap -H "x-bootstrap-secret: …" -d name=luca
 */
authRoutes.post("/bootstrap", async (c) => {
  const expected = c.env.BOOTSTRAP_SECRET;
  if (!expected) return c.text("Bootstrap is disabled", 403);
  if (!constantTimeEqual(c.req.header("x-bootstrap-secret") ?? "", expected))
    return c.text("Bad bootstrap secret", 403);

  const name = c.req.query("name") || "owner";
  const user = await registry(c.env).upsertUser({
    id: `bootstrap:${name.toLowerCase()}`,
    provider: "bootstrap",
    name,
  });
  const { token } = await issueToken(c.env, user.id, c.req.query("label") || "bootstrap");
  return c.json({
    user,
    token,
    mcpUrl: `${appUrl(c.env, c.req.raw)}/mcp`,
    hint: "Store this now — it is not shown again.",
  });
});

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

authRoutes.get("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});
