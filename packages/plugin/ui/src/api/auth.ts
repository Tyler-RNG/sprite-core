// The OpenClaw gateway authenticates plugin HTTP routes via
// `Authorization: Bearer <token>`. The Control UI persists its device-bound
// auth on this origin under one of two known shapes; we read whichever is
// present and attach it to our same-origin fetches.
//
// Shape 1 — device auth (current): localStorage["openclaw.device.auth.v1"]
//   JSON: { version: 1, deviceId: string, tokens: { [role]: string } }
//   Roles seen in the wild: "user", "assistant", "system", "unknown".
//   Any non-empty token in `tokens` is a valid Bearer for /sprite-core/*.
//
// Shape 2 — legacy per-tenant token: localStorage["openclaw.control.token.v1:<url>"]
//   value is the raw token string.
//
// If neither is present, the user has not signed in to the Control UI on
// this origin; the SPA cannot bootstrap auth on its own.

const DEVICE_AUTH_KEY = "openclaw.device.auth.v1";
const V1_PREFIX = "openclaw.control.token.v1:";
const V1_LEGACY = "openclaw.control.token.v1";
const ROLE_PREFERENCE = ["user", "assistant", "system", "unknown"];
// Local override — set by the dashboard's "paste your token" UI when none of
// the Control UI's storage shapes yields a usable token.
const OVERRIDE_KEY = "sprite-core.dashboard.gatewayToken.v1";

export function setOverrideToken(token: string): void {
  if (typeof localStorage === "undefined") return;
  const t = token.trim();
  if (!t) {
    localStorage.removeItem(OVERRIDE_KEY);
    return;
  }
  localStorage.setItem(OVERRIDE_KEY, t);
}

export function clearOverrideToken(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(OVERRIDE_KEY);
}

export function readOverrideToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  const v = (localStorage.getItem(OVERRIDE_KEY) ?? "").trim();
  return v || null;
}

type DeviceAuthStore = {
  version: number;
  deviceId: string;
  tokens: Record<string, string>;
};

function readDeviceAuth(store: Storage): string | null {
  const raw = store.getItem(DEVICE_AUTH_KEY);
  if (!raw) return null;
  let parsed: DeviceAuthStore;
  try {
    parsed = JSON.parse(raw) as DeviceAuthStore;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== 1 || !parsed.tokens) return null;
  for (const role of ROLE_PREFERENCE) {
    const t = parsed.tokens[role];
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  // Any other role we didn't anticipate.
  for (const t of Object.values(parsed.tokens)) {
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  return null;
}

function readPerTenantToken(store: Storage): string | null {
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;
    if (key !== V1_LEGACY && !key.startsWith(V1_PREFIX)) continue;
    const value = (store.getItem(key) ?? "").trim();
    if (value) return value;
  }
  return null;
}

function listOpenclawKeys(store: Storage, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && key.startsWith("openclaw.")) out.push(`${name}:${key}`);
  }
  return out;
}

type TokenScan = { token: string | null; openclawKeys: string[] };

function scan(): TokenScan {
  // 1. Manual override (set via the dashboard's paste-token UI) wins.
  const override = readOverrideToken();
  if (override) return { token: override, openclawKeys: [] };

  // 2. Try anything the Control UI may have persisted.
  const stores: Array<[Storage, string]> = [];
  if (typeof localStorage !== "undefined") stores.push([localStorage, "local"]);
  if (typeof sessionStorage !== "undefined") stores.push([sessionStorage, "session"]);

  for (const [store] of stores) {
    const t = readDeviceAuth(store) ?? readPerTenantToken(store);
    if (t) return { token: t, openclawKeys: [] };
  }
  const openclawKeys: string[] = [];
  for (const [store, name] of stores) openclawKeys.push(...listOpenclawKeys(store, name));
  return { token: null, openclawKeys };
}

export class MissingAuthTokenError extends Error {
  readonly openclawKeys: readonly string[];
  constructor(openclawKeys: readonly string[]) {
    const hint =
      openclawKeys.length === 0
        ? "No openclaw.* keys were found in localStorage on this origin. " +
          "Open the OpenClaw Control UI in another tab (same origin), sign in, then reload."
        : `Found openclaw.* keys but no usable token: ${openclawKeys.join(", ")}.`;
    super(`Sprite dashboard could not find the Control UI auth token. ${hint}`);
    this.name = "MissingAuthTokenError";
    this.openclawKeys = openclawKeys;
  }
}

export function readAuthToken(): string | null {
  return scan().token;
}

export function authHeader(): Record<string, string> {
  const s = scan();
  if (!s.token) throw new MissingAuthTokenError(s.openclawKeys);
  return { Authorization: `Bearer ${s.token}` };
}
