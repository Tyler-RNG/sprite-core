import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "openclaw/plugin-sdk/config-runtime";
import type { SpriteCoreConfig } from "./types.js";

const SPRITE_CORE_PLUGIN_ID = "sprite-core";

// Serial write lock. Two concurrent PUTs to different agent fields can still
// clobber each other because each reads the full snapshot, mutates its slice,
// then writes. Serializing through this queue makes the read-modify-write
// atomic at the plugin layer. (Openclaw itself doesn't guarantee cross-write
// ordering.)
let writeChain: Promise<unknown> = Promise.resolve();

export type SpriteCoreConfigMutator = (current: SpriteCoreConfig) => SpriteCoreConfig;

/**
 * Read the live config, project our plugin slice through [mutate], and write
 * back using the SDK's read-for-write snapshot. Pairing the read snapshot's
 * `writeOptions` with the write is essential — it carries the env-snapshot
 * needed to re-preserve `${VAR}` interpolations. Reading with `loadConfig()`
 * and writing with `writeConfigFile(...)` loses that and re-persists secrets
 * as plaintext.
 *
 * Stays strictly inside `plugins.entries["sprite-core"].config`. Other plugin
 * slices, channel config, provider config, etc. are never touched.
 */
export async function updateSpriteCoreConfig(mutate: SpriteCoreConfigMutator): Promise<void> {
  const run = async () => {
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    // Mutate `resolved`, not `config`. `resolved` is the post-include,
    // post-${VAR} form without runtime defaults baked in — that's what the
    // write path expects so it can re-wrap env substitutions. Using the
    // runtime form would freeze defaults into the persisted file.
    const cfg = snapshot.resolved;
    const plugins = cfg.plugins ?? {};
    const entries = plugins.entries ?? {};
    const ourEntry = entries[SPRITE_CORE_PLUGIN_ID] ?? {};
    const currentPluginCfg = (ourEntry.config ?? {}) as SpriteCoreConfig;

    const nextPluginCfg = mutate(currentPluginCfg);

    const nextCfg = {
      ...cfg,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          [SPRITE_CORE_PLUGIN_ID]: {
            ...ourEntry,
            // SpriteCoreConfig has named optional fields; the slot type wants
            // Record<string, unknown>. They're structurally compatible but
            // TS rejects the direct assignment; cast through unknown.
            config: nextPluginCfg as unknown as Record<string, unknown>,
          },
        },
      },
    };

    await writeConfigFile(nextCfg, writeOptions);
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {
    /* swallow so the chain doesn't get wedged by a single failure */
  });
  await next;
}
