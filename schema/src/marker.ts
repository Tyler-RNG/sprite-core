/**
 * Streaming parser for avatar-state markers embedded in assistant text.
 *
 * A marker is the literal text `<<<state>>>` or `<<<state-N>>>` appearing
 * inline anywhere in the reply (not restricted to its own line). Matching
 * markers are stripped from the visible text and surfaced separately; invalid
 * marker shapes (empty or disallowed state names) are treated as literal text.
 *
 * The triple-angle-bracket escape is deliberately unusual so the model is
 * unlikely to produce it by accident.
 *
 * The parser is stateful across chunks: a marker split mid-token across two
 * chunks is still recognized. Non-marker content is emitted immediately when
 * possible so streaming UX isn't delayed.
 *
 * Play-count semantics:
 *   - bare `<<<state>>>` — `count = null`, loop until next marker
 *   - `<<<state-0>>>`    — `count = 0`, equivalent to bare
 *   - `<<<state-N>>>`    — `count = N >= 1`, play N times then hold last frame
 *
 * This file is the canonical reference implementation — Kotlin and Swift ports
 * must match its semantics.
 */

export const AVATAR_MARKER_OPEN = "<<<";
export const AVATAR_MARKER_CLOSE = ">>>";

export type AvatarMarker = {
  state: string;
  count: number | null;
};

export type AvatarMarkerParseResult = {
  cleanedText: string;
  markers: AvatarMarker[];
};

export type AvatarMarkerParser = {
  push(chunk: string): AvatarMarkerParseResult;
  flush(): AvatarMarkerParseResult;
  reset(): void;
};

const STATE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isValidStateName(name: string): boolean {
  return name.length > 0 && STATE_NAME_RE.test(name);
}

/**
 * Split a raw marker body into (state, count). Triggers on the *last* dash
 * when the suffix is a non-negative integer — `head_cocked-1` (N=1) becomes
 * `head_cocked` + 1, but `head-cocked` (no digits after dash) stays as
 * `head-cocked` + null. Returns null count when the body has no numeric
 * suffix. Exported for test coverage.
 */
export function resolveStateAndCount(body: string): { state: string; count: number | null } {
  const dashIdx = body.lastIndexOf("-");
  if (dashIdx <= 0 || dashIdx === body.length - 1) return { state: body, count: null };
  const countPart = body.slice(dashIdx + 1);
  if (!/^\d+$/.test(countPart)) return { state: body, count: null };
  const count = Number.parseInt(countPart, 10);
  if (count < 0) return { state: body, count: null };
  const state = body.slice(0, dashIdx);
  if (state.length === 0) return { state: body, count: null };
  return { state, count };
}

function processSafePrefix(
  combined: string,
): AvatarMarkerParseResult & { remainder: string } {
  const markers: AvatarMarker[] = [];
  let out = "";
  let i = 0;

  while (i < combined.length) {
    const openAt = combined.indexOf(AVATAR_MARKER_OPEN, i);
    if (openAt === -1) {
      // No complete `<<<` left. But the tail might be a partial start
      // (`<` or `<<`) that could extend into a marker with more input; buffer
      // those trailing `<` characters so the next chunk can complete them.
      let j = combined.length;
      while (j > i && combined[j - 1] === "<") {
        j -= 1;
      }
      out += combined.slice(i, j);
      return { cleanedText: out, markers, remainder: combined.slice(j) };
    }
    out += combined.slice(i, openAt);
    const closeAt = combined.indexOf(
      AVATAR_MARKER_CLOSE,
      openAt + AVATAR_MARKER_OPEN.length,
    );
    if (closeAt === -1) {
      return { cleanedText: out, markers, remainder: combined.slice(openAt) };
    }
    const rawBody = combined.slice(openAt + AVATAR_MARKER_OPEN.length, closeAt);
    if (isValidStateName(rawBody)) {
      const { state, count } = resolveStateAndCount(rawBody);
      markers.push({ state, count });
    } else {
      out += combined.slice(openAt, closeAt + AVATAR_MARKER_CLOSE.length);
    }
    i = closeAt + AVATAR_MARKER_CLOSE.length;
  }

  return { cleanedText: out, markers, remainder: "" };
}

export function createAvatarMarkerParser(): AvatarMarkerParser {
  let buffer = "";

  return {
    push(chunk) {
      if (chunk.length === 0) {
        return { cleanedText: "", markers: [] };
      }
      const combined = buffer + chunk;
      const { cleanedText, markers, remainder } = processSafePrefix(combined);
      buffer = remainder;
      return { cleanedText, markers };
    },
    flush() {
      if (buffer.length === 0) {
        return { cleanedText: "", markers: [] };
      }
      const leftover = buffer;
      buffer = "";
      return { cleanedText: leftover, markers: [] };
    },
    reset() {
      buffer = "";
    },
  };
}

export function parseAvatarMarkers(text: string): AvatarMarkerParseResult {
  const parser = createAvatarMarkerParser();
  const first = parser.push(text);
  const last = parser.flush();
  return {
    cleanedText: first.cleanedText + last.cleanedText,
    markers: [...first.markers, ...last.markers],
  };
}

/**
 * Text segment produced by [splitByMarkers]. `emotion` is the state name of
 * the marker immediately preceding this segment, or `null` for the leading
 * segment (before any marker) and for segments introduced by an invalid
 * marker shape (emitted as literal text).
 */
export type TextSegmentWithEmotion = {
  text: string;
  emotion: string | null;
  emotionCount: number | null;
};

/**
 * Split `text` into segments delimited by `<<<state>>>` markers. Each
 * segment carries the preceding marker's state as its `emotion` (null for
 * the leading segment before any marker).
 *
 * Invalid marker shapes are treated as literal text and merged into the
 * enclosing segment. Empty-text segments are dropped.
 */
export function splitByMarkers(text: string): TextSegmentWithEmotion[] {
  if (text.length === 0) return [];
  const segments: TextSegmentWithEmotion[] = [];
  let currentText = "";
  let currentEmotion: string | null = null;
  let currentEmotionCount: number | null = null;
  let i = 0;
  while (i < text.length) {
    const openAt = text.indexOf(AVATAR_MARKER_OPEN, i);
    if (openAt === -1) {
      currentText += text.slice(i);
      break;
    }
    currentText += text.slice(i, openAt);
    const closeAt = text.indexOf(
      AVATAR_MARKER_CLOSE,
      openAt + AVATAR_MARKER_OPEN.length,
    );
    if (closeAt === -1) {
      currentText += text.slice(openAt);
      break;
    }
    const rawBody = text.slice(openAt + AVATAR_MARKER_OPEN.length, closeAt);
    if (isValidStateName(rawBody)) {
      const { state, count } = resolveStateAndCount(rawBody);
      if (currentText.length > 0) {
        segments.push({
          text: currentText,
          emotion: currentEmotion,
          emotionCount: currentEmotionCount,
        });
        currentText = "";
      }
      currentEmotion = state;
      currentEmotionCount = count;
    } else {
      currentText += text.slice(openAt, closeAt + AVATAR_MARKER_CLOSE.length);
    }
    i = closeAt + AVATAR_MARKER_CLOSE.length;
  }
  if (currentText.length > 0) {
    segments.push({
      text: currentText,
      emotion: currentEmotion,
      emotionCount: currentEmotionCount,
    });
  }
  return segments;
}
