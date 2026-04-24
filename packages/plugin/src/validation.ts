import type {
  SpriteCoreAgentEntry,
  SpriteCoreAvatarConfig,
  SpriteCoreEmotionDirective,
  SpriteCoreEmotionEntry,
  SpriteCoreVoiceConfig,
  SpriteCorePromptingConfig,
} from "./types.js";

// Narrow, hand-rolled validators for the write-side payloads. Mirrors the
// plugin's openclaw.plugin.json configSchema shapes but only the subset we
// accept over HTTP: full AgentEntry and single EmotionEntry. Kept dep-free
// so the plugin bundle doesn't grow an ajv/zod runtime.
//
// Returns the canonicalized value on success (unknown keys stripped) and a
// list of path-qualified error messages on failure.

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function validateEmotionEntry(input: unknown): ValidationResult<SpriteCoreEmotionEntry> {
  const errors: string[] = [];
  const obj = asObject(input, "emotion", errors);
  if (!obj) {
    return { ok: false, errors };
  }

  const description = asString(obj["description"], "emotion.description", errors, { required: true });
  let directive: SpriteCoreEmotionDirective | undefined;
  if (obj["directive"] !== undefined) {
    directive = validateDirective(obj["directive"], "emotion.directive", errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      description: description ?? "",
      ...(directive ? { directive } : {}),
    },
  };
}

export function validateAgentEntry(input: unknown): ValidationResult<SpriteCoreAgentEntry> {
  const errors: string[] = [];
  const obj = asObject(input, "agent", errors);
  if (!obj) {
    return { ok: false, errors };
  }

  const out: SpriteCoreAgentEntry = {};
  if (obj["avatar"] !== undefined) {
    const avatar = validateAvatar(obj["avatar"], "agent.avatar", errors);
    if (avatar) {
      out.avatar = avatar;
    }
  }
  if (obj["voice"] !== undefined) {
    const voice = validateVoice(obj["voice"], "agent.voice", errors);
    if (voice) {
      out.voice = voice;
    }
  }
  if (obj["prompting"] !== undefined) {
    const prompting = validatePrompting(obj["prompting"], "agent.prompting", errors);
    if (prompting) {
      out.prompting = prompting;
    }
  }
  if (obj["emotions"] !== undefined) {
    const emotions = validateEmotionsMap(obj["emotions"], "agent.emotions", errors);
    if (emotions) {
      out.emotions = emotions;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: out };
}

// --- helpers ---

function asObject(v: unknown, path: string, errors: string[]): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    errors.push(`${path}: expected object`);
    return null;
  }
  return v as Record<string, unknown>;
}

function asString(
  v: unknown,
  path: string,
  errors: string[],
  opts: { required?: boolean } = {},
): string | undefined {
  if (v === undefined) {
    if (opts.required) {
      errors.push(`${path}: required`);
    }
    return undefined;
  }
  if (typeof v !== "string") {
    errors.push(`${path}: expected string`);
    return undefined;
  }
  return v;
}

function asNumberInRange(
  v: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${path}: expected finite number`);
    return undefined;
  }
  if (v < min || v > max) {
    errors.push(`${path}: expected ${min}..${max}, got ${v}`);
    return undefined;
  }
  return v;
}

function asBool(v: unknown, path: string, errors: string[]): boolean | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "boolean") {
    errors.push(`${path}: expected boolean`);
    return undefined;
  }
  return v;
}

function validateDirective(
  input: unknown,
  path: string,
  errors: string[],
): SpriteCoreEmotionDirective | undefined {
  const obj = asObject(input, path, errors);
  if (!obj) {
    return undefined;
  }
  const out: SpriteCoreEmotionDirective = {};
  const voiceId = asString(obj["voiceId"], `${path}.voiceId`, errors);
  if (voiceId !== undefined) {
    out.voiceId = voiceId;
  }
  const stability = asNumberInRange(obj["stability"], `${path}.stability`, errors, 0, 1);
  if (stability !== undefined) {
    out.stability = stability;
  }
  const similarity = asNumberInRange(obj["similarity"], `${path}.similarity`, errors, 0, 1);
  if (similarity !== undefined) {
    out.similarity = similarity;
  }
  const style = asNumberInRange(obj["style"], `${path}.style`, errors, 0, 1);
  if (style !== undefined) {
    out.style = style;
  }
  const speakerBoost = asBool(obj["speakerBoost"], `${path}.speakerBoost`, errors);
  if (speakerBoost !== undefined) {
    out.speakerBoost = speakerBoost;
  }
  const speed = asNumberInRange(obj["speed"], `${path}.speed`, errors, 0.25, 4);
  if (speed !== undefined) {
    out.speed = speed;
  }
  const audioTag = asString(obj["audioTag"], `${path}.audioTag`, errors);
  if (audioTag !== undefined) {
    out.audioTag = audioTag;
  }
  return out;
}

function validateAvatar(
  input: unknown,
  path: string,
  errors: string[],
): SpriteCoreAvatarConfig | undefined {
  // Avatar shapes are operator territory today — accept the raw object if it
  // has a known `kind`, otherwise reject. We don't deep-validate the nested
  // sprite/atlas shapes here; the next `loadConfig()` call runs openclaw's
  // full JSON-schema validator and rejects malformed branches at load.
  const obj = asObject(input, path, errors);
  if (!obj) {
    return undefined;
  }
  const kind = obj["kind"];
  if (kind !== "states" && kind !== "sprites" && kind !== "atlas") {
    errors.push(`${path}.kind: expected "states" | "sprites" | "atlas"`);
    return undefined;
  }
  return obj as unknown as SpriteCoreAvatarConfig;
}

function validateVoice(
  input: unknown,
  path: string,
  errors: string[],
): SpriteCoreVoiceConfig | undefined {
  const obj = asObject(input, path, errors);
  if (!obj) {
    return undefined;
  }
  return obj as SpriteCoreVoiceConfig;
}

function validatePrompting(
  input: unknown,
  path: string,
  errors: string[],
): SpriteCorePromptingConfig | undefined {
  const obj = asObject(input, path, errors);
  if (!obj) {
    return undefined;
  }
  const out: SpriteCorePromptingConfig = {};
  if (obj["descriptions"] !== undefined) {
    const descObj = asObject(obj["descriptions"], `${path}.descriptions`, errors);
    if (descObj) {
      const descriptions: Record<string, string> = {};
      for (const [k, v] of Object.entries(descObj)) {
        const s = asString(v, `${path}.descriptions.${k}`, errors);
        if (s !== undefined) {
          descriptions[k] = s;
        }
      }
      out.descriptions = descriptions;
    }
  }
  const instruction = asString(obj["instruction"], `${path}.instruction`, errors);
  if (instruction !== undefined) {
    out.instruction = instruction;
  }
  return out;
}

function validateEmotionsMap(
  input: unknown,
  path: string,
  errors: string[],
): Record<string, SpriteCoreEmotionEntry> | undefined {
  const obj = asObject(input, path, errors);
  if (!obj) {
    return undefined;
  }
  const out: Record<string, SpriteCoreEmotionEntry> = {};
  for (const [k, v] of Object.entries(obj)) {
    const r = validateEmotionEntry(v);
    if (!r.ok) {
      for (const e of r.errors) {
        errors.push(e.replace(/^emotion/, `${path}.${k}`));
      }
      continue;
    }
    out[k] = r.value;
  }
  return out;
}
