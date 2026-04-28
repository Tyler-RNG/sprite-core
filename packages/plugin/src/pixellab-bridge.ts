/**
 * In-process bridge to pixellab.ai with a 3-job concurrency cap.
 *
 * PixelLab's API caps each account at 3 concurrent background jobs — exceeding
 * that cap returns HTTP 429 at submit time. This module owns:
 *
 * 1. A semaphore so dashboard- and CLI-driven jobs don't race each other into
 *    a 429.
 * 2. A job map so the dashboard can poll for status without re-hitting
 *    pixellab on every UI tick.
 * 3. Read-only passthroughs (`get`, `getJson`) for endpoints that don't
 *    consume a job slot (character listings, animation metadata, etc.).
 *
 * Callers hand the bridge a `submit` callback that posts to pixellab and
 * returns the `background_job_id`; the bridge polls until completion and
 * keeps the slot held end-to-end.
 */
export const PIXELLAB_API_BASE = "https://api.pixellab.ai/v2";
export const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 600_000;

export type JobOp = "create-character" | "animate-character";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type JobEntry = {
  /** Local id we hand out before pixellab returns a background_job_id. */
  id: string;
  /** Filled in once submit succeeds. May remain undefined if submit fails. */
  pixellabJobId?: string;
  op: JobOp;
  /** Human-readable label for the dashboard UI. */
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Body returned by the submit POST (e.g. `{ character_id, background_job_id }`). */
  submitResult?: unknown;
  /** Pixellab's terminal job body. */
  result?: unknown;
  error?: string;
};

export type SubmitFn = (
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
) => Promise<{ pixellabJobId: string; submitResult: unknown }>;

export type StartJobInput = {
  apiKey: string;
  op: JobOp;
  label: string;
  submit: SubmitFn;
  /** Per-call override; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
};

export type BridgeOptions = {
  maxConcurrent?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** Defaults to `Date.now`; overridable for tests. */
  now?: () => number;
  /** Defaults to `crypto.randomUUID`; overridable for tests. */
  randomId?: () => string;
};

export class PixellabBridge {
  private readonly maxConcurrent: number;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly jobs = new Map<string, JobEntry>();

  constructor(opts: BridgeOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.apiBase = opts.apiBase ?? PIXELLAB_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.randomId =
      opts.randomId ??
      (() =>
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  /** Number of jobs currently holding a slot (queued + running). */
  get activeCount(): number {
    return this.inFlight;
  }

  /** Number of jobs queued but not yet holding a slot. */
  get waitingCount(): number {
    return this.waiters.length;
  }

  listJobs(): JobEntry[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  getJob(id: string): JobEntry | null {
    return this.jobs.get(id) ?? null;
  }

  /** Drop terminal jobs older than `olderThanMs` from the in-memory map. */
  pruneTerminal(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const [id, entry] of this.jobs) {
      if (
        (entry.status === "completed" || entry.status === "failed") &&
        (entry.finishedAt ?? 0) < cutoff
      ) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Read-only passthrough to a pixellab endpoint. Does not consume a job
   * slot — use this for listing characters / animations / fetching detail.
   */
  async get(path: string, apiKey: string): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  async getJson<T = unknown>(path: string, apiKey: string): Promise<T> {
    const res = await this.get(path, apiKey);
    if (!res.ok) {
      throw new PixellabError(
        statusToCode(res.status),
        `pixellab GET ${path} failed: HTTP ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Submit a job, register it in the job map, and run polling to completion
   * in the background. Returns the registered `JobEntry` synchronously once
   * the slot is acquired and submit has either succeeded or failed.
   *
   * Slot ordering: callers acquire in FIFO order. If the bridge has fewer
   * than `maxConcurrent` slots in flight, this resolves immediately; otherwise
   * it parks until an in-flight job releases.
   */
  async startJob(input: StartJobInput): Promise<JobEntry> {
    const id = this.randomId();
    const entry: JobEntry = {
      id,
      op: input.op,
      label: input.label,
      status: "queued",
      startedAt: this.now(),
    };
    this.jobs.set(id, entry);

    await this.acquire();

    // After acquire, mutate via the map-stored entry so external listeners
    // observing `getJob(id)` see the running state.
    const slotEntry = this.jobs.get(id);
    if (!slotEntry) {
      // Pruned out from under us — bail and release.
      this.releaseSlot();
      return entry;
    }

    let submitResult: { pixellabJobId: string; submitResult: unknown };
    try {
      submitResult = await input.submit((path, init) => this.fetcher(path, init, input.apiKey));
    } catch (err) {
      slotEntry.status = "failed";
      slotEntry.error = errorMessage(err);
      slotEntry.finishedAt = this.now();
      this.releaseSlot();
      return slotEntry;
    }

    slotEntry.status = "running";
    slotEntry.pixellabJobId = submitResult.pixellabJobId;
    slotEntry.submitResult = submitResult.submitResult;

    // Polling runs in the background; the returned entry is observed via
    // getJob(id). The slot is released when polling resolves.
    void this.pollUntilTerminal(id, input.apiKey, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    return slotEntry;
  }

  /**
   * Wait for a registered job to reach a terminal state. Useful in tests and
   * for synchronous server flows (e.g. export-after-animate). The returned
   * entry is the same reference held in the job map.
   */
  async awaitJob(id: string): Promise<JobEntry> {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error(`unknown job: ${id}`);
    while (entry.status === "queued" || entry.status === "running") {
      await new Promise((r) => setTimeout(r, 50));
    }
    return entry;
  }

  // ----- internals -----

  private url(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    if (path.startsWith("/")) return `${this.apiBase}${path}`;
    return `${this.apiBase}/${path}`;
  }

  private async fetcher(
    path: string,
    init: RequestInit | undefined,
    apiKey: string,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return this.fetchImpl(this.url(path), { ...init, headers });
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  private releaseSlot(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async pollUntilTerminal(
    id: string,
    apiKey: string,
    timeoutMs: number,
  ): Promise<void> {
    const entry = this.jobs.get(id);
    if (!entry || !entry.pixellabJobId) {
      this.releaseSlot();
      return;
    }
    const deadline = this.now() + timeoutMs;
    try {
      while (this.now() < deadline) {
        const res = await this.get(
          `/background-jobs/${encodeURIComponent(entry.pixellabJobId)}`,
          apiKey,
        );
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body?.status === "completed") {
            entry.status = "completed";
            entry.result = body;
            entry.finishedAt = this.now();
            return;
          }
          if (body?.status === "failed") {
            entry.status = "failed";
            entry.error = `pixellab job failed: ${JSON.stringify(body).slice(0, 400)}`;
            entry.result = body;
            entry.finishedAt = this.now();
            return;
          }
        }
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
      entry.status = "failed";
      entry.error = `pixellab job ${entry.pixellabJobId} did not finish within ${timeoutMs}ms`;
      entry.finishedAt = this.now();
    } catch (err) {
      entry.status = "failed";
      entry.error = errorMessage(err);
      entry.finishedAt = this.now();
    } finally {
      this.releaseSlot();
    }
  }
}

export class PixellabError extends Error {
  constructor(
    public readonly code:
      | "rate-limited"
      | "auth"
      | "not-found"
      | "upstream",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PixellabError";
  }
}

function statusToCode(status: number): PixellabError["code"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "upstream";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
