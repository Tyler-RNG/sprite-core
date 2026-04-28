// Mirrors packages/plugin/src/types.ts. Duplicated on purpose: the plugin is
// a server-side package with openclaw imports that don't belong in a browser
// bundle, so we copy only the wire types the UI needs. Keep in sync with the
// source; a lint or test-level sync check is a reasonable future addition.
//
// See: packages/plugin/src/types.ts

export type AvatarStateEntry = { file: string; description?: string };
export type AvatarStatesConfig = {
  kind: "states";
  default: string;
  states: Record<string, AvatarStateEntry>;
  instruction?: string;
};

export type LoopMode = "infinite" | "once" | "ping-pong";
export type SpriteSequence = {
  count: number;
  fps?: number;
  loop?: LoopMode;
  holdLastFrame?: boolean;
  iterations?: number;
};

export type SpriteStatePhased = {
  intro?: SpriteSequence;
  loop: SpriteSequence;
  outro?: SpriteSequence;
  description?: string;
};

export type SpriteState =
  | (SpriteSequence & { description?: string })
  | SpriteStatePhased;

export type AvatarTransition = string | { blend: "crossfade"; ms: number };

export type AvatarSpritesConfig = {
  kind: "sprites";
  default: string;
  basePath: string;
  format?: "webp" | "png" | "jpg";
  states: Record<string, SpriteState>;
  transitions?: Record<string, AvatarTransition>;
  instruction?: string;
};

export type AvatarAtlasConfig = {
  kind: "atlas";
  default: string;
  manifest: string;
  descriptions?: Record<string, string>;
  instruction?: string;
};

export type AvatarConfig =
  | AvatarStatesConfig
  | AvatarSpritesConfig
  | AvatarAtlasConfig;

export type VoiceConfig = {
  provider?: string;
  voiceId?: string;
  label?: string;
  [key: string]: unknown;
};

export type PromptingConfig = {
  descriptions?: Record<string, string>;
  instruction?: string;
};

export type EmotionDirective = {
  voiceId?: string;
  stability?: number;
  similarity?: number;
  style?: number;
  speakerBoost?: boolean;
  speed?: number;
  audioTag?: string;
};

export type EmotionEntry = {
  description: string;
  directive?: EmotionDirective;
};

export type PixellabLink = {
  characterId: string;
  lastSyncedAt?: number;
};

export type AgentEntry = {
  avatar?: AvatarConfig;
  voice?: VoiceConfig;
  prompting?: PromptingConfig;
  emotions?: Record<string, EmotionEntry>;
  pixellab?: PixellabLink;
};

export type AgentsResponse = {
  agents: Record<string, AgentEntry>;
  publicBaseUrl?: string;
};

// ----- pixellab.ai bridge wire types -----
// Mirrors what the gateway proxies through /sprite-core/pixellab/*. Names
// follow pixellab's own JSON shape so we can pass responses through largely
// untouched.

export type PixellabCharacter = {
  id: string;
  name: string;
  prompt?: string;
  size?: { width: number; height: number };
  directions?: number;
  created_at?: string;
  animation_count?: number;
  template_id?: string;
  view?: string;
  preview_url?: string;
  tags?: string[];
};

export type PixellabCharactersResponse = {
  characters: PixellabCharacter[];
};

export type PixellabHealth = {
  configured: boolean;
  apiBase: string;
  activeJobs: number;
  waitingJobs: number;
};

export type PixellabJobStatus = "queued" | "running" | "completed" | "failed";

export type PixellabJobEntry = {
  id: string;
  pixellabJobId?: string;
  op: "create-character" | "animate-character";
  label: string;
  status: PixellabJobStatus;
  startedAt: number;
  finishedAt?: number;
  submitResult?: unknown;
  result?: unknown;
  error?: string;
};
