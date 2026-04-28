import { describe, it, expect } from "vitest";
import { PixellabBridge, type SubmitFn } from "./pixellab-bridge.js";

/**
 * Build a fake fetch that:
 *  - Returns the configured submit response on POST.
 *  - Returns a sequence of background-job responses on GET, ending with a
 *    "completed" or "failed" status.
 */
function makeFakeFetch(opts: {
  submitJobId?: string;
  submitStatus?: number;
  submitBody?: unknown;
  pollResponses?: Array<{ status: "running" | "completed" | "failed" }>;
}): typeof fetch {
  const polls = (opts.pollResponses ?? [{ status: "completed" }]).slice();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" || (method === "GET" && !url.includes("/background-jobs/"))) {
      // Submit response.
      const status = opts.submitStatus ?? 200;
      const body = JSON.stringify(
        opts.submitBody ?? { background_job_id: opts.submitJobId ?? "job-1" },
      );
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Poll response.
    const next = polls.shift() ?? { status: "completed" };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const submitOk = (jobId: string): SubmitFn => async (fetcher) => {
  const res = await fetcher("/animate-character", {
    method: "POST",
    body: JSON.stringify({ character_id: "c1" }),
  });
  const body = (await res.json()) as { background_job_id: string };
  return { pixellabJobId: body.background_job_id ?? jobId, submitResult: body };
};

describe("PixellabBridge", () => {
  it("runs a job through queued → running → completed", async () => {
    const bridge = new PixellabBridge({
      fetchImpl: makeFakeFetch({ submitJobId: "px-1" }),
      pollIntervalMs: 1,
    });
    const entry = await bridge.startJob({
      apiKey: "k",
      op: "animate-character",
      label: "test",
      submit: submitOk("px-1"),
    });
    expect(entry.status).toBe("running");
    expect(entry.pixellabJobId).toBe("px-1");

    const final = await bridge.awaitJob(entry.id);
    expect(final.status).toBe("completed");
    expect(final.finishedAt).toBeGreaterThan(0);
    expect(bridge.activeCount).toBe(0);
  });

  it("marks a job failed when pixellab status is failed", async () => {
    const bridge = new PixellabBridge({
      fetchImpl: makeFakeFetch({
        submitJobId: "px-2",
        pollResponses: [{ status: "failed" }],
      }),
      pollIntervalMs: 1,
    });
    const entry = await bridge.startJob({
      apiKey: "k",
      op: "animate-character",
      label: "test",
      submit: submitOk("px-2"),
    });
    const final = await bridge.awaitJob(entry.id);
    expect(final.status).toBe("failed");
    expect(final.error).toMatch(/pixellab job failed/);
    expect(bridge.activeCount).toBe(0);
  });

  it("marks a job failed when submit throws and releases the slot", async () => {
    const bridge = new PixellabBridge({
      fetchImpl: makeFakeFetch({}),
      pollIntervalMs: 1,
    });
    const entry = await bridge.startJob({
      apiKey: "k",
      op: "animate-character",
      label: "boom",
      submit: async () => {
        throw new Error("submit blew up");
      },
    });
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("submit blew up");
    expect(bridge.activeCount).toBe(0);
  });

  it("queues a 4th submit while 3 are in flight, then drains FIFO", async () => {
    // Each fake fetch resolves its poll on demand by parking until we tick.
    const ticks: Array<() => void> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST") {
        const id = `px-${ticks.length + 1}`;
        return new Response(JSON.stringify({ background_job_id: id }), {
          status: 200,
        });
      }
      // Poll: extract the job id and park; the test resolves them in order.
      const m = url.match(/background-jobs\/(.+)$/);
      const jobId = m ? decodeURIComponent(m[1]!) : "?";
      // Block until the test ticks this poll.
      await new Promise<void>((resolve) => ticks.push(resolve));
      return new Response(JSON.stringify({ status: "completed", id: jobId }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const bridge = new PixellabBridge({
      fetchImpl,
      maxConcurrent: 3,
      pollIntervalMs: 1,
    });

    const j1 = await bridge.startJob({
      apiKey: "k", op: "animate-character", label: "j1", submit: submitOk("px-1"),
    });
    const j2 = await bridge.startJob({
      apiKey: "k", op: "animate-character", label: "j2", submit: submitOk("px-2"),
    });
    const j3 = await bridge.startJob({
      apiKey: "k", op: "animate-character", label: "j3", submit: submitOk("px-3"),
    });
    expect(bridge.activeCount).toBe(3);

    // Fourth call must block on acquire — start it but don't await.
    let j4Resolved = false;
    const j4Promise = bridge.startJob({
      apiKey: "k", op: "animate-character", label: "j4", submit: submitOk("px-4"),
    }).then((e) => { j4Resolved = true; return e; });

    // Give the event loop a tick — j4 must still be parked.
    await new Promise((r) => setTimeout(r, 5));
    expect(j4Resolved).toBe(false);
    expect(bridge.waitingCount).toBe(1);

    // Tick j1's poll → completes → slot frees → j4 acquires.
    ticks.shift()?.();
    await bridge.awaitJob(j1.id);
    const j4 = await j4Promise;
    expect(j4Resolved).toBe(true);
    expect(j4.status).toBe("running");

    // Drain remaining polls.
    while (ticks.length) ticks.shift()?.();
    await bridge.awaitJob(j2.id);
    await bridge.awaitJob(j3.id);
    await bridge.awaitJob(j4.id);
    expect(bridge.activeCount).toBe(0);
  });

  it("listJobs returns entries in submit order", async () => {
    const bridge = new PixellabBridge({
      fetchImpl: makeFakeFetch({}),
      pollIntervalMs: 1,
    });
    const a = await bridge.startJob({
      apiKey: "k", op: "create-character", label: "a", submit: submitOk("px-a"),
    });
    const b = await bridge.startJob({
      apiKey: "k", op: "animate-character", label: "b", submit: submitOk("px-b"),
    });
    const list = bridge.listJobs();
    expect(list.map((j) => j.id)).toEqual([a.id, b.id]);
  });

  it("pruneTerminal drops finished entries past the cutoff", async () => {
    let nowVal = 1000;
    const bridge = new PixellabBridge({
      fetchImpl: makeFakeFetch({}),
      pollIntervalMs: 1,
      now: () => nowVal,
    });
    const a = await bridge.startJob({
      apiKey: "k", op: "animate-character", label: "a", submit: submitOk("px-a"),
    });
    await bridge.awaitJob(a.id);
    expect(bridge.getJob(a.id)?.status).toBe("completed");

    nowVal = 100_000;
    const removed = bridge.pruneTerminal(60_000);
    expect(removed).toBe(1);
    expect(bridge.getJob(a.id)).toBeNull();
  });

  it("getJson surfaces a typed PixellabError on non-2xx responses", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "rate-limited" }), {
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch;
    const bridge = new PixellabBridge({ fetchImpl });
    await expect(bridge.getJson("/characters", "k")).rejects.toMatchObject({
      name: "PixellabError",
      code: "rate-limited",
      status: 429,
    });
  });
});
