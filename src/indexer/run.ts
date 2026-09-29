import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type EmojiResult, PROMPT_VERSION, SCHEMA_VERSION } from "../shared.js";
import { createCodexDescriber } from "./codex.js";
import { ModelError } from "./codex-policy.js";
import { MediaError, prepareMedia } from "./media.js";
import type { Store } from "./store.js";

export async function availableMemoryMb(): Promise<number> {
  const info = await readFile("/proc/meminfo", "utf8");
  const value = /^MemAvailable:\s+(\d+) kB$/m.exec(info)?.[1];
  if (!value) throw new Error("memory_measurement_unavailable");
  return Math.floor(Number(value) / 1024);
}

export async function runIndexer(
  store: Store,
  options: {
    home: string;
    model: string;
    target: number;
    initial: number;
    limit: number;
    reserveMb: number;
    signal: AbortSignal;
  },
) {
  const owner = store.own();
  let provider: Awaited<ReturnType<typeof createCodexDescriber>> | undefined;
  let concurrency = options.initial;
  let preparing = 0;
  let admitted = 0;
  let completed = 0;
  let rampAt = Date.now();
  let rampCompleted = 0;
  let blocked: string | null = null;
  const completions: number[] = [];
  const terminalGenerations: { at: number; failed: boolean }[] = [];
  function recordGeneration(failed: boolean) {
    const now = Date.now();
    while ((terminalGenerations[0]?.at ?? Infinity) <= now - 60_000)
      terminalGenerations.shift();
    terminalGenerations.push({ at: now, failed });
    if (failed) {
      const failures = terminalGenerations.filter((item) => item.failed).length;
      if (failures >= 5 && failures * 10 >= terminalGenerations.length)
        blocked ??= "repeated_generation_failures";
    }
  }
  const active = new Set<Promise<void>>();
  const analyses = new Map<string, Promise<EmojiResult>>();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let memory = await availableMemoryMb();
  const heartbeat = () =>
    store.heartbeat(owner, {
      state: blocked
        ? "blocked"
        : memory < options.reserveMb
          ? "paused"
          : "running",
      concurrency: active.size,
      targetConcurrency: options.target,
      completedPerMinute: completions.filter((at) => at > Date.now() - 60_000)
        .length,
      availableMemoryMb: memory,
      reason:
        blocked ??
        (memory < options.reserveMb
          ? "Waiting for the configured memory reserve."
          : null),
    });
  const timer = setInterval(() => {
    try {
      heartbeat();
    } catch {
      controller.abort();
    }
  }, 5000);
  try {
    heartbeat();
    provider = await createCodexDescriber({
      home: options.home,
      model: options.model,
      capacity: options.target,
      timeoutMs: 180_000,
    });
    const describer = provider;
    while (!signal.aborted && !blocked) {
      memory = await availableMemoryMb();
      const disk = await statfs(store.directory);
      if (signal.aborted || blocked) break;
      if (disk.bavail * disk.bsize < 1024 * 1024 * 1024) {
        blocked = "disk_reserve_reached";
        break;
      }
      if (memory < options.reserveMb) {
        concurrency = Math.max(1, Math.floor(concurrency / 2));
        heartbeat();
        await sleep(1000);
        continue;
      }
      if (
        Date.now() - rampAt > 30_000 &&
        completed - rampCompleted >= Math.max(4, concurrency)
      ) {
        concurrency = Math.min(options.target, concurrency * 2);
        rampAt = Date.now();
        rampCompleted = completed;
      }
      if (
        active.size < concurrency &&
        preparing < 2 &&
        admitted < options.limit
      ) {
        const source = store.claim(owner);
        if (source) {
          admitted++;
          preparing++;
          const operation = (async () => {
            let prepared = false;
            let inferenceStarted = false;
            try {
              const input = await prepareMedia(
                source,
                join(store.directory, "media"),
                signal,
              );
              preparing--;
              prepared = true;
              const key = `${input.media.hash}:${PROMPT_VERSION}:${options.model}`;
              let result = store.cached(key);
              if (!result) {
                let analysis = analyses.get(key);
                if (!analysis) {
                  const started = Date.now();
                  inferenceStarted = true;
                  analysis = describer
                    .describe(source, input.media, input.imagePaths, signal)
                    .then((value) => {
                      // Count model calls, not cached images or shared waiters.
                      recordGeneration(false);
                      return {
                        schemaVersion: SCHEMA_VERSION,
                        source,
                        media: input.media,
                        analysis: value,
                        provenance: {
                          provider: "codex" as const,
                          model: options.model,
                          promptVersion: PROMPT_VERSION,
                          indexedAt: new Date().toISOString(),
                          durationMs: Date.now() - started,
                        },
                      };
                    });
                  analyses.set(key, analysis);
                }
                result = await analysis;
              }
              const published = store.complete(
                owner,
                { ...result, source },
                key,
              );
              analyses.delete(key);
              if (published) {
                completed++;
                completions.push(Date.now());
              }
              if (describer.failure) blocked = describer.failure;
              while ((completions[0] ?? Infinity) < Date.now() - 60_000)
                completions.shift();
            } catch (error) {
              const code =
                error instanceof ModelError || error instanceof MediaError
                  ? error.code
                  : "indexing_failed";
              store.fail(
                owner,
                source,
                code,
                error instanceof ModelError
                  ? error.uncertain
                  : inferenceStarted,
              );
              // A timeout is isolated only after terminal + thread/closed receipts.
              // Keep it unknown and never replay it. Other uncertain failures stop.
              if (
                error instanceof ModelError &&
                !describer.failure &&
                (code === "generation_timeout" ||
                  (!error.uncertain &&
                    [
                      "generation_failed",
                      "provider_internal_error",
                      "connection_failed",
                      "invalid_analysis",
                      "policy_blocked",
                    ].includes(code)))
              ) {
                // Duplicate images share one promise, including its failure.
                if (inferenceStarted) recordGeneration(true);
              } else if (!(error instanceof MediaError)) {
                blocked ??= describer.failure ?? code;
              }
            } finally {
              if (!prepared) preparing--;
            }
          })();
          active.add(operation);
          void operation
            .finally(() => active.delete(operation))
            .catch(() => {
              blocked = "persistence_failed";
              controller.abort();
            });
          continue;
        }
      }
      if (
        !active.size &&
        (admitted >= options.limit || store.status().counts.pending === 0)
      )
        break;
      await sleep(100);
    }
    if (signal.aborted) controller.abort();
    await Promise.allSettled(active);
    heartbeat();
    if (blocked) throw new Error(blocked);
  } finally {
    clearInterval(timer);
    controller.abort();
    await Promise.allSettled(active);
    await provider?.close();
    store.release(owner);
  }
}
