import { useEffect, useState } from "react";

// Mirrors the OpenClaw Control UI's persisted theme onto our own document
// so the dashboard tracks the parent site's appearance. The Control UI:
//   - persists to localStorage["openclaw.control.settings.v1:<scope>"] (or
//     legacy "openclaw.control.settings.v1") with shape
//     `{ theme: "claw"|"knot"|"dash", themeMode: "system"|"light"|"dark", ... }`
//   - applies the resolved theme as `<html data-theme="..." data-theme-mode="...">`
//
// Since the dashboard is served same-origin, we can read those keys directly.
// We also subscribe to `storage` events so flipping the toggle in another tab
// updates this one instantly, and to `prefers-color-scheme` so `system` mode
// follows OS changes.

const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";

type ThemeName = "claw" | "knot" | "dash";
type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light";

const VALID_THEMES = new Set<ThemeName>(["claw", "knot", "dash"]);
const VALID_MODES = new Set<ThemeMode>(["system", "light", "dark"]);

function readPersistedSelection(): { theme: ThemeName; mode: ThemeMode } {
  const fallback = { theme: "claw" as ThemeName, mode: "system" as ThemeMode };
  if (typeof localStorage === "undefined") return fallback;
  try {
    // Prefer scoped keys (the UI writes one per gateway scope); fall back to legacy.
    const candidates: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(SETTINGS_KEY_PREFIX)) candidates.push(key);
    }
    candidates.push(LEGACY_SETTINGS_KEY);
    for (const key of candidates) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { theme?: unknown; themeMode?: unknown };
      const theme = VALID_THEMES.has(parsed.theme as ThemeName)
        ? (parsed.theme as ThemeName)
        : fallback.theme;
      const mode = VALID_MODES.has(parsed.themeMode as ThemeMode)
        ? (parsed.themeMode as ThemeMode)
        : fallback.mode;
      return { theme, mode };
    }
  } catch {
    // best-effort
  }
  return fallback;
}

function prefersLight(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
  );
}

function resolveTheme(theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  const resolved: "light" | "dark" =
    mode === "system" ? (prefersLight() ? "light" : "dark") : mode;
  if (theme === "claw") return resolved === "light" ? "light" : "dark";
  if (theme === "knot") return resolved === "light" ? "openknot-light" : "openknot";
  return resolved === "light" ? "dash-light" : "dash";
}

export type OpenclawThemeState = {
  /** Resolved palette: dark / light / openknot / openknot-light / dash / dash-light. */
  resolved: ResolvedTheme;
  /** Concrete light/dark — the same value written to data-theme-mode. */
  mode: "light" | "dark";
  /** Logical selection persisted by the Control UI ("system" before resolution). */
  selection: ThemeMode;
};

function compute(): OpenclawThemeState {
  const { theme, mode } = readPersistedSelection();
  const resolved = resolveTheme(theme, mode);
  const concrete: "light" | "dark" =
    mode === "system" ? (prefersLight() ? "light" : "dark") : mode;
  return { resolved, mode: concrete, selection: mode };
}

function apply(state: OpenclawThemeState): void {
  const root = document.documentElement;
  root.dataset.theme = state.resolved;
  root.dataset.themeMode = state.mode;
}

/**
 * Subscribes the dashboard to the OpenClaw Control UI's persisted theme.
 * Idempotent — safe to call once at the App root.
 *
 * Returns the resolved theme state so consumers can render an indicator
 * (e.g. the header chip showing "🌙 dark · synced from Control UI").
 */
export function useOpenclawTheme(): OpenclawThemeState {
  const [state, setState] = useState<OpenclawThemeState>(() => compute());

  useEffect(() => {
    const tick = (): void => {
      const next = compute();
      apply(next);
      setState((prev) =>
        prev.resolved === next.resolved &&
        prev.mode === next.mode &&
        prev.selection === next.selection
          ? prev
          : next,
      );
    };
    tick();

    const onStorage = (e: StorageEvent): void => {
      if (e.key === null) {
        // Whole-store clear — just re-resolve.
        tick();
        return;
      }
      if (e.key.startsWith(SETTINGS_KEY_PREFIX) || e.key === LEGACY_SETTINGS_KEY) {
        tick();
      }
    };
    window.addEventListener("storage", onStorage);

    const media =
      typeof matchMedia === "function"
        ? matchMedia("(prefers-color-scheme: light)")
        : null;
    const onMediaChange = (): void => tick();
    media?.addEventListener("change", onMediaChange);

    // Same-tab updates from the Control UI don't fire `storage`, so poll lightly.
    // 2s cadence is well below human perception of a stale theme but cheap.
    const poll = window.setInterval(tick, 2000);

    return () => {
      window.removeEventListener("storage", onStorage);
      media?.removeEventListener("change", onMediaChange);
      window.clearInterval(poll);
    };
  }, []);

  return state;
}
