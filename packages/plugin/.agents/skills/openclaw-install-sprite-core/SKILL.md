---
name: openclaw-install-sprite-core
description: Install and configure the SpriteCore plugin for OpenClaw — npm install, run the bootstrap script, restart the gateway. Use this when the user asks to "install sprite-core", "enable the sprite avatar plugin", "set up multi-state avatars", or equivalent.
---

# Install SpriteCore Plugin

The plugin ships with a bootstrap script that does most of the work. The
flow is three commands plus an optional ElevenLabs key.

## Preconditions

Confirm with the user before starting:

- **OpenClaw gateway running locally.** Check `openclaw plugins list` —
  if it errors, install/start OpenClaw first.
- **Voice (optional).** If the user wants TTS/STT, they need an
  `ELEVENLABS_API_KEY` in the gateway's environment. The plugin works
  without it (avatar still animates, no spoken audio).
- **Custom agent id (optional).** The bootstrap defaults to an agent id
  literally named `agent`. If the user has existing named agents and wants
  the avatar wired to one of them, edit `openclaw.json` after step 2 and
  rename the `agents.agent` block to `agents.<their-id>` (or copy/extend it).

## The three commands

### 1. Install from npm

```bash
openclaw plugins install @tylerwarburton/sprite-core
```

This auto-enables the plugin (`enabledByDefault: true` in the manifest).
The install scanner may show a few warn-level findings about the pixellab
helper scripts — those are advisory, not blocking, and don't require
`--dangerously-force-unsafe-install`.

**Verify:**

```bash
openclaw plugins inspect sprite-core
```

Expect `Status: loaded` (after gateway restart in step 3) or `Status:
discovered`, `Source: npm`, `Spec: @tylerwarburton/sprite-core@<version>`.

### 2. Seed default config + placeholder atlas

```bash
node ~/.openclaw/extensions/sprite-core/scripts/init-config.mjs
```

Idempotent. Does nothing if `plugins.entries["sprite-core"].config` already
exists. On a fresh install:

- Writes a minimal config block (assets enabled, default `agent` with four
  states `idle`/`thinking`/`happy`/`sad`).
- Copies the placeholder atlas to `~/.openclaw/state/assets/avatars/agent/`.
- Backs up the prior `openclaw.json` next to the config file.

If the user wants TTS, they need to add the `streamTts` block manually
(or via `openclaw config set`):

```jsonc
"streamTts": {
  "enabled": true,
  "provider": "elevenlabs",
  "apiKey": { "source": "env", "id": "ELEVENLABS_API_KEY" },
  "defaultModel": "eleven_turbo_v2"
}
```

And export `ELEVENLABS_API_KEY` in the gateway's environment (for systemd
user units, edit `~/.config/systemd/user/openclaw-gateway.service.d/override.conf`
or add to `~/.profile`; for the macOS app, edit the launch agent plist).

### 3. Restart the gateway

```bash
# Linux systemd user unit:
systemctl --user restart openclaw-gateway

# macOS menubar app:
# Quit + relaunch from the menu bar (do not pkill — the app respawns it).
```

**Verify it loaded:**

```bash
openclaw plugins inspect sprite-core | grep -E "Status:|Source:|Version:"
curl -sS -H "Authorization: Bearer $(openclaw config get gateway.auth.token)" \
  http://localhost:18789/sprite-core/agents | head -c 200
```

The HTTP call should return a JSON object with an `agents` map. If it
returns HTML (the OpenClaw Control UI), the plugin's routes aren't
registered — re-check `openclaw plugins inspect sprite-core` for load errors.

## Replace the placeholder with real art

Two paths:

1. **Generate via pixellab.ai.** Ask the user to invoke the
   `openclaw-pixellab-avatar` skill (also shipped in this plugin's
   `.agents/skills/`).
2. **Hand-author.** Drop frames at
   `~/.openclaw/state/assets/avatars/<agentId>/frames/<state>/NN.webp`
   then re-pack. See `~/.openclaw/extensions/sprite-core/template/agent/README.md`
   for the swap procedure.

## Done

That's it. The four-color placeholder renders on the watch/phone the moment
the gateway comes back up. No agent-side prompting changes needed — the
plugin contributes its own `[avatar:<state>]` system-prompt block to clients
with sprite display capability.
