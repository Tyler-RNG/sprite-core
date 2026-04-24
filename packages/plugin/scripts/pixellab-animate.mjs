#!/usr/bin/env node
// Add animations to an existing pixellab.ai character.
//
// Hits POST /v2/animate-character once per emotion, polls the per-direction
// background jobs until each completes, then reports what's now on the
// character. The exporter (pixellab-export.mjs) consumes this output directly.
//
// Flow (full):
//   1. pixellab-create.mjs --name … --description …      → character_id
//   2. eyeball the rotations                              → approve
//   3. pixellab-animate.mjs --uid <id> --emotions …       ← THIS SCRIPT
//   4. pixellab-export.mjs --uid <id> --overwrite         → atlas + manifest
//
// Usage:
//   node scripts/pixellab-animate.mjs \
//     --uid <character-uuid> \
//     --emotions idle,thinking,happy,sad,angry,surprised
//
//   --uid <id>            Character UUID (required)
//   --emotions <list>     Comma-separated emotion list (required). Each value
//                         becomes an action_description like "idle expression"
//                         sent to pixellab. The exporter will map
//                         animation_type back to the SpriteCore state name.
//   --prompt-map <json>   Optional JSON object overriding the action
//                         description for specific emotions, e.g.
//                         '{"thinking":"hand on chin looking up hmm expression"}'
//   --mode <m>            Animation mode: template | v3 | pro (default: v3)
//   --frame-count <n>     Frames per animation (4-16, default: 8; v3 only)
//   --directions <list>   Comma-separated list; omit for all available
//   --timeout-ms <n>      Max wait per emotion (default: 600000 = 10min)
//   --api-key-command <cmd>  Shell command returning the API key on stdout
//   --dry-run             Print the plan without calling pixellab
//   --json                Emit final state as JSON to stdout

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIXELLAB_API_BASE = "https://api.pixellab.ai/v2";
const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_FRAME_COUNT = 8;

// Pixellab reads `action_description` as a natural-language prompt. The
// clean `animation_type` we want back comes from pixellab's own classifier
// on the prompt, so the wording matters. Motion-oriented verbs + explicit
// body language land on-target far more often than bare emotion tokens —
// "happy" alone often produces a neutral stance; "big smile, eyes bright,
// slight excited bounce" reliably produces a recognizable happy loop.
const DEFAULT_PROMPTS = {
  idle: "standing still, gentle breathing, subtle weight shift side to side",
  thinking: "hand on chin, eyes glancing upward, head tilting thoughtfully, pondering",
  happy: "big open-mouth smile, eyes bright and crinkled in joy, slight excited bounce",
  sad: "head lowered, eyes downcast, shoulders slumped, downturned mouth, sorrowful",
  angry: "furrowed brow, clenched teeth, fists tightened, body leaning forward, frustrated",
  surprised: "eyes wide open, mouth agape, slight step back, arms raised, shocked",
  smile: "gentle mouth curving from neutral to a warm genuine smile, eyes softening",
  frown: "neutral expression turning to a disappointed frown, brow slightly furrowed",
  love: "eyes becoming hearts, cheeks blushing pink, hands clasped near chest, shy adoring smile",
  wink: "one eye closed in a playful wink, confident smirk, slight head tilt, finger-gun gesture",
  sleepy: "eyes transitioning from alert to drowsy half-closed, head gently nodding, yawning",
  annoyed: "neutral turning to frustrated eye roll, arms crossing, exasperated sigh",
};

function parseArgs(argv) {
  const opts = {
    uid: null,
    emotions: null,
    promptMap: {},
    mode: "v3",
    frameCount: DEFAULT_FRAME_COUNT,
    directions: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    apiKeyCommand: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--uid":
        opts.uid = argv[++i];
        break;
      case "--emotions":
        opts.emotions = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--prompt-map":
        try {
          opts.promptMap = JSON.parse(argv[++i]);
        } catch (err) {
          console.error(`--prompt-map: invalid JSON: ${err.message}`);
          process.exit(2);
        }
        break;
      case "--mode":
        opts.mode = argv[++i];
        break;
      case "--frame-count":
        opts.frameCount = parseInt(argv[++i], 10);
        break;
      case "--directions":
        opts.directions = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--timeout-ms":
        opts.timeoutMs = parseInt(argv[++i], 10);
        break;
      case "--api-key-command":
        opts.apiKeyCommand = argv[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  if (!opts.uid || !opts.emotions || opts.emotions.length === 0) {
    console.error("--uid and --emotions are required");
    printUsage();
    process.exit(2);
  }
  return opts;
}

function printUsage() {
  const here = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.error(
    `Usage: node ${here} --uid <character-uuid> --emotions idle,thinking,happy [options]`,
  );
  console.error("");
  console.error("  --uid <id>             Character UUID (required)");
  console.error("  --emotions <list>      Comma-separated emotions (required)");
  console.error("  --prompt-map <json>    Override per-emotion prompts");
  console.error("  --mode <m>             template | v3 (default) | pro");
  console.error("  --frame-count <n>      4-16 (default 8; v3 only)");
  console.error("  --directions <list>    Comma-separated directions");
  console.error("  --timeout-ms <n>       Max wait per emotion (default 600000)");
  console.error("  --api-key-command <cmd>  Shell command returning the API key");
  console.error("  --dry-run              Print plan without calling pixellab");
  console.error("  --json                 Emit final animation list as JSON");
}

function resolveApiKey(apiKeyCommand) {
  const fromEnv = process.env.PIXELLAB_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (apiKeyCommand) {
    try {
      const out = execFileSync("sh", ["-c", apiKeyCommand], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim();
      if (out) {
        return out;
      }
    } catch (err) {
      console.error(`--api-key-command failed: ${err.message}`);
      process.exit(1);
    }
  }
  try {
    const out = execFileSync("pass", ["show", "pixellab/api-key"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      return out;
    }
  } catch {
    // fall through
  }
  console.error("No pixellab API key available.");
  console.error("  Set PIXELLAB_API_KEY, pass --api-key-command, or put the key in `pass`.");
  process.exit(1);
  return ""; // unreachable
}

function resolvePrompt(emotion, promptMap) {
  if (typeof promptMap[emotion] === "string" && promptMap[emotion].trim()) {
    return promptMap[emotion].trim();
  }
  if (DEFAULT_PROMPTS[emotion]) {
    return DEFAULT_PROMPTS[emotion];
  }
  return `${emotion} expression`;
}

async function queueAnimation({ apiKey, uid, prompt, mode, frameCount, directions }) {
  const body = {
    character_id: uid,
    action_description: prompt,
    mode,
  };
  if (mode === "v3") {
    body.frame_count = frameCount;
  }
  if (directions && directions.length > 0) {
    body.directions = directions;
  }
  const res = await fetch(`${PIXELLAB_API_BASE}/animate-character`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `animate-character failed: HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`,
    );
  }
  return res.json();
}

async function pollJob({ apiKey, jobId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PIXELLAB_API_BASE}/background-jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = await res.json();
      const status = body?.status;
      if (status === "completed") {
        return body;
      }
      if (status === "failed") {
        throw new Error(`job ${jobId} failed: ${JSON.stringify(body).slice(0, 400)}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function listAnimations({ apiKey, uid }) {
  const res = await fetch(
    `${PIXELLAB_API_BASE}/characters/${encodeURIComponent(uid)}/animations`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (!res.ok) {
    return null;
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.animations) ? body.animations : null;
}

function log(opts, ...args) {
  if (opts.json) {
    return;
  }
  console.log(...args);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const emotionPrompts = opts.emotions.map((e) => ({
    emotion: e,
    prompt: resolvePrompt(e, opts.promptMap),
  }));

  log(opts, `pixellab animate: ${opts.uid}`);
  log(opts, `  mode:          ${opts.mode}`);
  log(opts, `  frame count:   ${opts.frameCount}`);
  log(opts, `  directions:    ${opts.directions ? opts.directions.join(", ") : "all"}`);
  log(opts, `  emotions (${emotionPrompts.length}):`);
  for (const { emotion, prompt } of emotionPrompts) {
    log(opts, `    ${emotion.padEnd(12)}  ${prompt}`);
  }

  if (opts.dryRun) {
    log(opts, "");
    log(opts, "(dry-run — no pixellab calls)");
    return 0;
  }

  const apiKey = resolveApiKey(opts.apiKeyCommand);

  log(opts, "");
  log(opts, "queueing animations…");
  const results = [];
  for (const { emotion, prompt } of emotionPrompts) {
    log(opts, `  → ${emotion}`);
    try {
      const queued = await queueAnimation({
        apiKey,
        uid: opts.uid,
        prompt,
        mode: opts.mode,
        frameCount: opts.frameCount,
        directions: opts.directions,
      });
      const jobIds = queued.background_job_ids || [];
      const dirs = queued.directions || [];
      log(opts, `    ${jobIds.length} job(s) queued across [${dirs.join(", ")}]`);
      // Wait for every direction's job to finish before moving on so we don't
      // pile up and exceed pixellab's concurrency limits.
      for (const jobId of jobIds) {
        await pollJob({ apiKey, jobId, timeoutMs: opts.timeoutMs });
      }
      log(opts, `    ✓ ${emotion} complete`);
      results.push({ emotion, prompt, jobIds, directions: dirs, status: "completed" });
    } catch (err) {
      log(opts, `    ✗ ${emotion} failed: ${err.message}`);
      results.push({ emotion, prompt, status: "failed", error: err.message });
    }
  }

  log(opts, "");
  log(opts, "fetching final animation list…");
  const anims = await listAnimations({ apiKey, uid: opts.uid });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          character_id: opts.uid,
          requested: results,
          animations: anims,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log("");
  if (anims === null) {
    console.log(`(could not fetch animation list for ${opts.uid} — check the pixellab UI)`);
  } else if (anims.length === 0) {
    console.log(`character ${opts.uid} has no animations on pixellab yet`);
  } else {
    console.log(`character ${opts.uid} now has ${anims.length} animation(s):`);
    for (const a of anims) {
      const at = a.animation_type || "(untyped)";
      const gid = (a.animation_group_id || "").slice(0, 8);
      const frames = (a.directions || [{}])[0]?.frame_count || 0;
      console.log(`  ${at.padEnd(12)}  ${frames} frames  group=${gid}`);
    }
  }
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log("");
    console.log(`${failed.length} emotion(s) failed:`);
    for (const f of failed) {
      console.log(`  ${f.emotion}: ${f.error}`);
    }
    return 1;
  }
  console.log("");
  console.log(`next: export with \`pixellab-export.mjs --uid ${opts.uid} --overwrite\``);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
