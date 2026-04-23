import { Type } from "@sinclair/typebox";

// Non-empty string primitive. Inlined here so this package has no dependency
// on openclaw core — this is the root of the client contract.
const NonEmptyString = Type.String({ minLength: 1 });

// Display capabilities a client advertises in `caps` at pair time. The gateway
// uses these to decide which manifest modes to populate for that client.
export const DISPLAY_CAP_SPRITE_HEADSHOT = "display:sprite-headshot" as const;
export const DISPLAY_CAP_SPRITE_FULLBODY = "display:sprite-fullbody" as const;
export const DISPLAY_CAP_TEXT = "display:text" as const;
export const DISPLAY_CAP_TTS = "display:tts" as const;

export const DISPLAY_CAPS = [
  DISPLAY_CAP_SPRITE_HEADSHOT,
  DISPLAY_CAP_SPRITE_FULLBODY,
  DISPLAY_CAP_TEXT,
  DISPLAY_CAP_TTS,
] as const;

// Render modes a character manifest can describe. Clients pick the ones that
// match their caps. Open string so future modes (e.g. "rig-skeletal") don't
// break the schema; DISPLAY_MODE_* constants below are the recommended set.
export const DISPLAY_MODE_HEADSHOT = "headshot" as const;
export const DISPLAY_MODE_FULLBODY = "fullbody" as const;

const LoopModeSchema = Type.Union([
  Type.Literal("infinite"),
  Type.Literal("once"),
  Type.Literal("ping-pong"),
]);

// A single source rectangle inside an atlas image. For non-atlas frame sources
// only `ref` is set (points at a whole-image asset) and rect coords are omitted.
const FrameRefSchema = Type.Object(
  {
    ref: NonEmptyString,
    x: Type.Optional(Type.Integer({ minimum: 0 })),
    y: Type.Optional(Type.Integer({ minimum: 0 })),
    w: Type.Optional(Type.Integer({ minimum: 1 })),
    h: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const FrameSequenceSchema = Type.Object(
  {
    frames: Type.Array(FrameRefSchema, { minItems: 1 }),
    fps: Type.Number({ minimum: 1, maximum: 120 }),
    loop: LoopModeSchema,
    holdLastFrame: Type.Optional(Type.Boolean()),
    iterations: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

// An animation is either a single sequence (flat) or a phased trio. The flat
// form is the common case; phases are for states that need smooth entry/exit.
const AnimationSchema = Type.Object(
  {
    description: Type.Optional(NonEmptyString),
    sequence: Type.Optional(FrameSequenceSchema),
    intro: Type.Optional(FrameSequenceSchema),
    loop: Type.Optional(FrameSequenceSchema),
    outro: Type.Optional(FrameSequenceSchema),
  },
  { additionalProperties: false },
);

// Transition descriptor that runtimes play while swapping animations. Either
// a named phase ("thinking.intro") or an inline blend directive.
const TransitionRefSchema = Type.Union([
  NonEmptyString,
  Type.Object(
    {
      blend: Type.Literal("crossfade"),
      ms: Type.Integer({ minimum: 1, maximum: 10_000 }),
    },
    { additionalProperties: false },
  ),
]);

// Per-mode data carried by the manifest. Each mode bundles an optional atlas
// image ref, a per-animation table, and a state-to-animation defaults map.
const ModeContentSchema = Type.Object(
  {
    atlas: Type.Optional(
      Type.Object(
        {
          image: NonEmptyString,
          size: Type.Object(
            {
              w: Type.Integer({ minimum: 1 }),
              h: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
          frameSize: Type.Optional(
            Type.Object(
              {
                w: Type.Integer({ minimum: 1 }),
                h: Type.Integer({ minimum: 1 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    animations: Type.Record(NonEmptyString, AnimationSchema),
    transitions: Type.Optional(Type.Record(NonEmptyString, TransitionRefSchema)),
  },
  { additionalProperties: false },
);

// Asset bundle the client should fetch to render the manifest. Paths are
// gateway-asset-endpoint relative (served under `/openclaw-assets/<path>`).
const AssetBundleSchema = Type.Object(
  {
    refs: Type.Record(NonEmptyString, NonEmptyString),
  },
  { additionalProperties: false },
);

// Per-emotion TTS voice-directive override. Applied by clients after they
// parse `<<<state>>>` markers out of assistant text — the text segment that
// follows a marker inherits the base TalkDirective merged field-by-field with
// this override. Fields omitted here fall back to the base directive.
//
// Server-authored (lives in the SpriteCore plugin config); clients never
// invent overrides of their own. Prompt-visible descriptions are intentionally
// NOT shipped on the wire — they're server-only because the plugin is the
// single author of prompt text.
const EmotionDirectiveSchema = Type.Object(
  {
    voiceId: Type.Optional(NonEmptyString),
    stability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    style: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    speakerBoost: Type.Optional(Type.Boolean()),
    speed: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
    audioTag: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

const EmotionEntrySchema = Type.Object(
  {
    directive: Type.Optional(EmotionDirectiveSchema),
  },
  { additionalProperties: false },
);

export const CharacterManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    modes: Type.Array(NonEmptyString, { minItems: 1 }),
    stateMap: Type.Record(NonEmptyString, NonEmptyString),
    content: Type.Record(NonEmptyString, ModeContentSchema),
    assets: AssetBundleSchema,
    emotions: Type.Optional(Type.Record(NonEmptyString, EmotionEntrySchema)),
  },
  { additionalProperties: false },
);

export const NodeGetCharacterManifestParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    modes: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  },
  { additionalProperties: false },
);

export const NodeGetCharacterManifestResultSchema = Type.Object(
  {
    manifest: CharacterManifestSchema,
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

// Re-exported individual schemas for downstream use (AJV compile, codegen).
export {
  FrameRefSchema,
  FrameSequenceSchema,
  AnimationSchema,
  TransitionRefSchema,
  ModeContentSchema,
  AssetBundleSchema,
  EmotionDirectiveSchema,
  EmotionEntrySchema,
  LoopModeSchema,
};

import type { Static } from "@sinclair/typebox";

export type CharacterManifest = Static<typeof CharacterManifestSchema>;
export type NodeGetCharacterManifestParams = Static<
  typeof NodeGetCharacterManifestParamsSchema
>;
export type NodeGetCharacterManifestResult = Static<
  typeof NodeGetCharacterManifestResultSchema
>;
export type FrameRef = Static<typeof FrameRefSchema>;
export type FrameSequence = Static<typeof FrameSequenceSchema>;
export type Animation = Static<typeof AnimationSchema>;
export type TransitionRef = Static<typeof TransitionRefSchema>;
export type ModeContent = Static<typeof ModeContentSchema>;
export type AssetBundle = Static<typeof AssetBundleSchema>;
export type EmotionEntry = Static<typeof EmotionEntrySchema>;
export type EmotionDirective = Static<typeof EmotionDirectiveSchema>;
export type LoopMode = Static<typeof LoopModeSchema>;

// Wire version literal for the CharacterManifest envelope. Bump + fanout to
// every client when making a breaking change to the shape.
export const CHARACTER_MANIFEST_VERSION = 1 as const;
