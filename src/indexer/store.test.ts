import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalogSources, type EmojiResult } from "../shared.js";
import { deliverReceipts, prepareReceipts, RemoteError } from "./remote.js";
import { Store } from "./store.js";

test("claims are single-owner and stale results cannot replace a changed emoji", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emoji-ownership-"));
  const store = new Store(directory);
  try {
    const sources = await catalogSources({
      wave: "https://emoji.slack-edge.com/T0266FRGM/wave/a.png",
    });
    store.sync(sources);
    const owner = store.own();
    assert.throws(() => store.own(), /already_running/);
    const source = store.claim(owner);
    assert.ok(source);
    assert.equal(store.claim(owner), undefined);
    store.sync(
      await catalogSources({
        wave: "https://emoji.slack-edge.com/T0266FRGM/wave/b.png",
      }),
    );
    assert.equal(store.complete(owner, result(source), "old"), false);
    assert.deepEqual(store.cached("old")?.analysis, result(source).analysis);
    assert.equal(store.cached("old")?.source.revision, source.revision);
    assert.equal(store.status().counts.pending, 1);
    assert.equal(store.search("greeting").length, 0);
    store.release(owner);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("aliases use canonical descriptions; removals disappear and interrupted inference is not replayed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emoji-retention-"));
  const store = new Store(directory);
  try {
    const catalog = {
      wave: "https://emoji.slack-edge.com/T0266FRGM/wave/a.png",
      hello: "alias:wave",
      bye: "https://emoji.slack-edge.com/T0266FRGM/bye/b.png",
    };
    store.sync(await catalogSources(catalog));
    const owner = store.own();
    const first = store.claim(owner);
    assert.equal(first?.name, "bye");
    const second = store.claim(owner);
    assert.ok(second);
    assert.equal(second.name, "wave");
    assert.equal(store.complete(owner, result(second), "cached"), true);
    assert.equal(store.search("hello")[0]?.name, "hello");
    store.sync(await catalogSources({ bye: catalog.bye }));
    assert.deepEqual(store.search("hello"), []);
    store.release(owner);
    const restarted = store.own();
    assert.equal(store.status().counts.unknown, 1);
    assert.equal(store.claim(restarted), undefined);
    store.release(restarted);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("remote delivery retries durable results without replaying interrupted inference", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emoji-receipts-"));
  let store = new Store(directory);
  try {
    const [source] = await catalogSources({
      wave: "https://emoji.slack-edge.com/wave.png",
    });
    assert.ok(source);
    const saved = result(source);
    prepareReceipts(store);
    store.db
      .prepare(
        "INSERT INTO remote_receipts(id,origin,state,lease,result) VALUES(?,?,'result','{}',?)",
      )
      .run("completed", "https://local.test", JSON.stringify(saved));
    const delivered: unknown[] = [];
    const interrupted = {
      origin: "https://local.test",
      async post(_path: string, body: unknown) {
        delivered.push(body);
        throw new Error("lost_response");
      },
    };
    await assert.rejects(deliverReceipts(store, interrupted), /lost_response/);
    store.db
      .prepare(
        "INSERT INTO remote_receipts(id,origin,state,lease) VALUES('interrupted','https://local.test','submitted','{}')",
      )
      .run();
    store.close();
    store = new Store(directory);
    prepareReceipts(store);
    const retried: Array<{ path: string; body: unknown }> = [];
    await deliverReceipts(store, {
      origin: "https://local.test",
      async post(path, body) {
        retried.push({ path, body });
        if (path.endsWith("/fail")) throw new RemoteError(409);
        return { ok: true };
      },
    });
    assert.deepEqual(retried[0], {
      path: "/api/jobs/complete",
      body: delivered[0],
    });
    assert.deepEqual(retried[1], {
      path: "/api/jobs/fail",
      body: {
        leaseId: "interrupted",
        code: "interrupted_inference",
        uncertain: true,
      },
    });
    assert.equal(
      store.db
        .prepare("SELECT state FROM remote_receipts WHERE id='completed'")
        .get()?.state,
      "acknowledged",
    );
    assert.equal(
      store.db
        .prepare("SELECT state FROM remote_receipts WHERE id='interrupted'")
        .get()?.state,
      "stale",
    );
    assert.equal(
      store.db
        .prepare("SELECT result FROM remote_receipts WHERE id='completed'")
        .get()?.result,
      JSON.stringify(saved),
    );
    await deliverReceipts(store, interrupted); // no additional requests once reconciled
    assert.equal(delivered.length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

function result(source: EmojiResult["source"]): EmojiResult {
  return {
    schemaVersion: 1,
    source,
    media: {
      hash: "a".repeat(64),
      mime: "image/png",
      width: 24,
      height: 24,
      frames: 1,
      sampledFrames: [0],
    },
    analysis: {
      summary: "Hand waving",
      description: "A yellow hand raised with three blue movement strokes.",
      visibleText: [],
      subjects: ["hand"],
      actions: ["waving"],
      colors: ["yellow", "blue"],
      style: ["cartoon"],
      emotions: ["friendly"],
      tags: ["greeting"],
      usageExamples: ["Say hello"],
      interpretation: "A friendly greeting.",
      uncertainties: [],
      confidence: "high",
      animationDescription: "",
      embeddingText: "Yellow hand waving hello.",
    },
    provenance: {
      provider: "codex",
      model: "fixture",
      promptVersion: "emoji-vision-1",
      indexedAt: new Date().toISOString(),
      durationMs: 1,
    },
  };
}
