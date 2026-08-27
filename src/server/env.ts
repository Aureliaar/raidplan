/**
 * Bindings + configuration. Vars live in wrangler.jsonc; everything optional
 * here is a secret (`wrangler secret put NAME`) or a `.dev.vars` entry.
 */
export interface AppEnv extends Env {
  APP_URL?: string;
  DISCORD_ALLOWLIST?: string;
  DISCORD_GUILD_ID?: string;

  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** HMAC key for session cookies. Required in production. */
  SESSION_SECRET?: string;
  /** "true" enables the passwordless local sign-in. Never set this in production. */
  DEV_AUTH: string;
  /** Shared secret for POST /auth/bootstrap, which mints an API token with no session. */
  BOOTSTRAP_SECRET?: string;

  /** Chat panel (see src/server/chat.ts) — Zhipu GLM by default. */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;

  /** FF Logs public API client credentials for the debuff import tool. */
  FFLOGS_CLIENT_ID?: string;
  FFLOGS_CLIENT_SECRET?: string;
}

/**
 * The passwordless `/auth/dev` sign-in. Opt-in via DEV_AUTH, never inferred:
 * a deploy with no Discord app configured is exactly the case where anyone who
 * finds the URL could otherwise mint themselves an account (and the first one
 * becomes admin).
 */
export function isDevAuth(env: AppEnv): boolean {
  return env.DEV_AUTH === "true" && (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET);
}

export function isDiscordAuth(env: AppEnv): boolean {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

export function appUrl(env: AppEnv, request: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}
