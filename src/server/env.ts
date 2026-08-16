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

  /** Chat panel (see src/server/chat.ts) — Zhipu GLM by default. */
  GLM_API_KEY?: string;
  GLM_BASE_URL?: string;
  GLM_MODEL?: string;
}

/** True when Discord isn't configured: enables the local dev sign-in. */
export function isDevAuth(env: AppEnv): boolean {
  return !env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET;
}

export function appUrl(env: AppEnv, request: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}
