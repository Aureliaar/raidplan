const FFLOGS_TOKEN_URL = "https://www.fflogs.com/oauth/token";

type FFLogsOAuthEnv = {
  FFLOGS_CLIENT_ID?: string;
  FFLOGS_CLIENT_SECRET?: string;
};

export async function exchangeFFLogsAuthorizationCode(
  code: string,
  redirectUri: string,
  env: FFLogsOAuthEnv
): Promise<{ access_token: string; expires_in?: number }> {
  if (!env.FFLOGS_CLIENT_ID || !env.FFLOGS_CLIENT_SECRET) {
    throw new Error("FF Logs integration is not configured on this server");
  }
  const response = await fetch(FFLOGS_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.FFLOGS_CLIENT_ID}:${env.FFLOGS_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code,
    }),
  });
  const body = await response.json().catch(() => null) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;
  if (!response.ok) {
    const detail = [body?.error, body?.error_description].filter(Boolean).join(": ");
    throw new Error(`FF Logs token exchange: ${detail || `request failed (${response.status})`}`);
  }
  if (!body?.access_token) throw new Error("FF Logs token exchange did not return an access token");
  return { access_token: body.access_token, expires_in: body.expires_in };
}
