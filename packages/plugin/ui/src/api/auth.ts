// The OpenClaw Control UI authenticates its API calls with a bearer token it
// stores in localStorage under `openclaw.control.token.v1:<normalized-url>`.
// The SpriteCore dashboard runs same-origin with the Control UI, so we can
// read the same token and attach it to our own fetches. Without it, every
// `/sprite-core/*` call 401s — the gateway does not accept session cookies.
//
// Key shape (from the Control UI bundle):
//   `openclaw.control.token.v1:<protocol>//<host>[<pathname-without-trailing-slash>]`
// We don't need to reproduce the normalization exactly — we scan for any key
// with the `openclaw.control.token.v1:` prefix and use the first non-empty
// value. If the user manages multiple gateways from one Control UI, this
// could pick the wrong one, but in practice the dashboard is served *by* the
// gateway it talks to, so any stored token for this origin is correct.

const TOKEN_KEY_PREFIX = "openclaw.control.token.v1:";

export class MissingAuthTokenError extends Error {
  constructor() {
    super(
      "Not signed in to OpenClaw Control UI. Open the Control UI in another tab " +
        "on this origin and sign in, then reload this page.",
    );
    this.name = "MissingAuthTokenError";
  }
}

export function readAuthToken(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(TOKEN_KEY_PREFIX)) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function authHeader(): Record<string, string> {
  const token = readAuthToken();
  if (!token) {
    throw new MissingAuthTokenError();
  }
  return { Authorization: `Bearer ${token}` };
}
