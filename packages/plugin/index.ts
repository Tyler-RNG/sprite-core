import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AGENTS_ROUTE_PATH, handleAgentsRequest } from "./src/agents-route.js";
import {
  AGENTS_WRITE_ROUTE_PREFIX,
  handleAgentsWriteRequest,
} from "./src/agents-write-route.js";
import {
  ATLAS_WRITE_ROUTE_PREFIX,
  handleAtlasWriteRequest,
} from "./src/atlas-write-route.js";
import { ASSETS_ROUTE_PATH, handleAssetsRequest } from "./src/assets-route.js";
import { PixellabBridge } from "./src/pixellab-bridge.js";
import {
  handlePixellabExportRequest,
  handlePixellabLinkRequest,
  handlePixellabRequest,
  PIXELLAB_ROUTE_PREFIX,
} from "./src/pixellab-routes.js";
import { buildCharacterManifest } from "./src/character-manifest.js";
import {
  CHARACTER_MANIFEST_ROUTE_PATH,
  handleCharacterManifestRequest,
} from "./src/character-manifest-route.js";
import {
  buildPromptingInstruction,
  hasSpriteDisplayCapability,
  isAtlasAvatarConfig,
} from "./src/prompting.js";
import { handleSttRequest, STT_ROUTE_PATH } from "./src/stt-route.js";
import { handleTtsRequest, TTS_ROUTE_PATH } from "./src/tts-route.js";
import { handleUiRequest, UI_ROUTE_PATH } from "./src/ui-route.js";
import type { SpriteCoreConfig } from "./src/types.js";

const SPRITE_CORE_PLUGIN_ID = "sprite-core";

function readPluginConfig(): SpriteCoreConfig | undefined {
  const cfg = loadConfig();
  return cfg.plugins?.entries?.[SPRITE_CORE_PLUGIN_ID]?.config as SpriteCoreConfig | undefined;
}

export default definePluginEntry({
  id: SPRITE_CORE_PLUGIN_ID,
  name: "SpriteCore",
  description:
    "In-gateway data plane for multi-state sprite/atlas avatars: asset serving, TTS streaming, and character-manifest RPC.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as SpriteCoreConfig;
    const assetsCfg = cfg.assets;
    const ttsCfg = cfg.streamTts;
    const sttCfg = cfg.streamStt;

    // Single-process pixellab bridge with a 3-job concurrency cap (the
    // pixellab account-wide limit). Both /sprite-core/pixellab/* routes and
    // future agent-scoped actions (animate-then-export) share this instance
    // so concurrent UI flows + CLI scripts (when run against the gateway)
    // don't race into a 429.
    const pixellabBridge = new PixellabBridge({
      apiBase: cfg.pixellab?.apiBase,
    });

    if (assetsCfg?.enabled === true) {
      const assetsAuth = assetsCfg.publicAssets === true ? "plugin" : "gateway";
      api.registerHttpRoute({
        path: ASSETS_ROUTE_PATH,
        match: "prefix",
        auth: assetsAuth,
        handler: (req, res) => handleAssetsRequest(req, res, { config: assetsCfg }),
      });
    }

    if (ttsCfg?.enabled === true) {
      const ttsHandler = (
        req: Parameters<typeof handleTtsRequest>[0],
        res: Parameters<typeof handleTtsRequest>[1],
      ) => handleTtsRequest(req, res, { config: ttsCfg });
      api.registerHttpRoute({
        path: TTS_ROUTE_PATH,
        match: "exact",
        auth: "gateway",
        handler: ttsHandler,
      });
      api.registerHttpRoute({
        path: "/tts",
        match: "exact",
        auth: "gateway",
        handler: ttsHandler,
      });
    }

    if (sttCfg?.enabled === true) {
      const sttHandler = (
        req: Parameters<typeof handleSttRequest>[0],
        res: Parameters<typeof handleSttRequest>[1],
      ) => handleSttRequest(req, res, { config: sttCfg });
      api.registerHttpRoute({
        path: STT_ROUTE_PATH,
        match: "exact",
        auth: "gateway",
        handler: sttHandler,
      });
      api.registerHttpRoute({
        path: "/stt",
        match: "exact",
        auth: "gateway",
        handler: sttHandler,
      });
    }

    api.registerHttpRoute({
      path: AGENTS_ROUTE_PATH,
      match: "exact",
      auth: "gateway",
      handler: (req, res) => {
        const fresh = readPluginConfig();
        return handleAgentsRequest(req, res, {
          agents: fresh?.agents,
          assets: fresh?.assets,
        });
      },
    });

    // Dashboard UI (browser SPA). Serves the built bundle from
    // packages/plugin/ui-dist/ shipped inside the plugin package. Prefix
    // match so nested asset paths (/sprite-core/ui/assets/app.abc123.js)
    // resolve through the same handler.
    //
    // auth: "plugin" — the static HTML + JS bundle has no secrets and must
    // be servable to a fresh browser so the SPA can bootstrap. The SPA then
    // uses `credentials: "same-origin"` for its API calls to `/sprite-core/*`
    // which remain gateway-gated. This mirrors how openclaw's Control UI
    // serves its HTML shell at `/` unauthenticated and authenticates its
    // API calls after the bundle has loaded.
    api.registerHttpRoute({
      path: UI_ROUTE_PATH,
      match: "prefix",
      auth: "plugin",
      handler: (req, res) => handleUiRequest(req, res),
    });

    // HTTP sibling of node.getCharacterManifest — the dashboard UI consumes
    // this to drive the client SDK's AssetSource without speaking the
    // gateway WebSocket. Keeps everything the UI needs on the HTTP plane.
    api.registerHttpRoute({
      path: CHARACTER_MANIFEST_ROUTE_PATH,
      match: "exact",
      auth: "gateway",
      handler: (req, res) =>
        handleCharacterManifestRequest(req, res, { readPluginConfig }),
    });

    // Write endpoints sharing the /sprite-core/agents/ prefix:
    //   PUT    /sprite-core/agents/:id
    //   PUT    /sprite-core/agents/:id/emotions/:state
    //   PUT    /sprite-core/agents/:id/pixellab-link
    //   DELETE /sprite-core/agents/:id/pixellab-link
    //   POST   /sprite-core/agents/:id/pixellab-export
    //   PATCH  /sprite-core/agents/:id/atlas/animations/:name
    //   DELETE /sprite-core/agents/:id/atlas/animations/:name
    //
    // The plugin runtime rejects duplicate prefix registrations, so we
    // register one handler that dispatches by path shape. Order: atlas-writer
    // first (matches /atlas/animations/), pixellab-link writer + export next
    // (match suffix-based paths), agent/emotion writer last (catches /:id
    // and /:id/emotions/:state).
    api.registerHttpRoute({
      path: AGENTS_WRITE_ROUTE_PREFIX,
      match: "prefix",
      auth: "gateway",
      handler: async (req, res) => {
        if (await handleAtlasWriteRequest(req, res, { readPluginConfig })) {
          return;
        }
        if (
          await handlePixellabExportRequest(req, res, { readPluginConfig })
        ) {
          return;
        }
        if (await handlePixellabLinkRequest(req, res)) {
          return;
        }
        await handleAgentsWriteRequest(req, res);
      },
    });

    // PixelLab passthroughs + bridge-backed create/animate/jobs:
    //   GET   /sprite-core/pixellab/health
    //   GET   /sprite-core/pixellab/voices            (proxies ElevenLabs)
    //   GET   /sprite-core/pixellab/characters
    //   GET   /sprite-core/pixellab/characters/:id
    //   GET   /sprite-core/pixellab/characters/:id/animations
    //   POST  /sprite-core/pixellab/characters
    //   POST  /sprite-core/pixellab/characters/:id/animate
    //   GET   /sprite-core/pixellab/jobs
    //   GET   /sprite-core/pixellab/jobs/:id
    api.registerHttpRoute({
      path: PIXELLAB_ROUTE_PREFIX,
      match: "prefix",
      auth: "gateway",
      handler: (req, res) =>
        handlePixellabRequest(req, res, {
          bridge: pixellabBridge,
          readPluginConfig,
        }),
    });

    // ATLAS_WRITE_ROUTE_PREFIX is intentionally unused now — kept exported
    // by the route module for tests; the dispatch lives above.
    void ATLAS_WRITE_ROUTE_PREFIX;

    // System-prompt contribution: teach the model the `<<<state>>>` marker
    // vocabulary, but only for sessions whose connected client can render a
    // sprite. Dashboard / Telegram / headless chat never see this block even
    // when the plugin is installed. Config is read fresh per turn so reloads
    // (new emotion entries, description edits) take effect immediately.
    //
    // `registerSystemPromptContribution` is exposed by the plugin runtime but
    // not yet in openclaw's published plugin-sdk d.ts surface. We narrow
    // through the host's known shape instead of `any` so the callback's
    // promptCtx still carries types the next reader can navigate.
    type PromptCtx = {
      agentId?: string;
      runtimeCapabilities?: readonly string[];
    };
    type SystemPromptApi = {
      registerSystemPromptContribution: (
        fn: (ctx: PromptCtx) => { stablePrefix: string } | undefined,
      ) => void;
    };
    const promptApi = api as unknown as Partial<SystemPromptApi>;
    if (typeof promptApi.registerSystemPromptContribution === "function") {
      promptApi.registerSystemPromptContribution(
        (promptCtx) => {
          if (!promptCtx.agentId) {
            return undefined;
          }
          if (!hasSpriteDisplayCapability(promptCtx.runtimeCapabilities)) {
            return undefined;
          }
          const fresh = readPluginConfig();
          const agent = fresh?.agents?.[promptCtx.agentId];
          if (!agent?.avatar || !isAtlasAvatarConfig(agent.avatar)) {
            return undefined;
          }
          const text = buildPromptingInstruction({
            avatar: agent.avatar,
            prompting: agent.prompting,
            emotions: agent.emotions,
          });
          return text ? { stablePrefix: text } : undefined;
        },
      );
    }

    // Gateway RPC: per-agent avatar + voice + prompting descriptors. Mirrors
    // the GET /sprite-core/agents HTTP endpoint over the WebSocket so clients
    // (phone, watch) that already speak RPC don't need a second HTTP path +
    // auth-token juggling. Reads fresh plugin config each call.
    //
    // Scope: `operator.read` — any connected operator (phone, watch relay)
    // can fetch this, same as `agents.list`. Without an explicit scope the
    // gateway defaults unclassified methods to `operator.admin`, which
    // blocks the phone's TalkSpeaker from resolving voice and silently
    // drops ElevenLabs TTS for every reply.
    api.registerGatewayMethod(
      "sprite-core.agents",
      async (ctx) => {
        const fresh = readPluginConfig();
        const publicBaseUrl = fresh?.assets?.publicBaseUrl?.trim() || undefined;
        const agentsOut: Record<string, unknown> = {};
        for (const [id, entry] of Object.entries(fresh?.agents ?? {})) {
          if (!entry) {
            continue;
          }
          agentsOut[id] = {
            ...(entry.avatar ? { avatar: entry.avatar } : {}),
            ...(entry.voice ? { voice: entry.voice } : {}),
            ...(entry.prompting ? { prompting: entry.prompting } : {}),
            ...(entry.emotions ? { emotions: entry.emotions } : {}),
            ...(entry.pixellab ? { pixellab: entry.pixellab } : {}),
          };
        }
        ctx.respond(
          true,
          { agents: agentsOut, ...(publicBaseUrl ? { publicBaseUrl } : {}) },
          undefined,
        );
      },
      { scope: "operator.read" },
    );

    // Gateway RPC: ship the watch a ready-to-render character manifest. Reads
    // fresh plugin config each call so config reload is observed.
    api.registerGatewayMethod("node.getCharacterManifest", async (ctx) => {
      const params = ctx.params as { agentId?: unknown; modes?: unknown };
      const agentId =
        typeof params.agentId === "string" && params.agentId.trim().length > 0
          ? params.agentId.trim()
          : null;
      if (!agentId) {
        ctx.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "agentId required",
        });
        return;
      }
      const modes = Array.isArray(params.modes)
        ? params.modes.filter((m): m is string => typeof m === "string")
        : undefined;
      const caps = ctx.client?.connect?.caps;
      const pluginConfig = readPluginConfig();
      try {
        const result = await buildCharacterManifest({
          pluginConfig,
          agentId,
          modes,
          caps,
        });
        if (!result.ok) {
          const code = result.code === "unknown-agent" ? "INVALID_REQUEST" : "UNAVAILABLE";
          ctx.respond(false, undefined, { code, message: result.message });
          return;
        }
        ctx.respond(true, { manifest: result.manifest, revision: result.revision }, undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.warn?.(`sprite-core: node.getCharacterManifest failed — ${message}`);
        ctx.respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "character manifest unavailable",
        });
      }
    });
  },
});
