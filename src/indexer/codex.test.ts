import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { catalogSources, type EmojiAnalysis } from "../shared.js";
import { createCodexDescriber } from "./codex.js";

test("validated terminal output survives retirement failure, with retries disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emoji-codex-retirement-"));
  const png = join(directory, "frame.png");
  await writeFile(png, "fixture", { mode: 0o600 });
  const child = Object.assign(new childProcess.ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const analysis: EmojiAnalysis = {
    summary: "Red square",
    description: "A solid red square in the upper left of a white image.",
    visibleText: [],
    subjects: ["square"],
    actions: [],
    colors: ["red"],
    style: [],
    emotions: [],
    tags: [],
    usageExamples: [],
    interpretation: "",
    uncertainties: [],
    confidence: "high",
    animationDescription: "",
    embeddingText: "red square",
  };
  let turns = 0;
  const spawn = mock.method(
    childProcess,
    "spawn",
    (_command: string, args: string[]) => {
      const flags: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-c") continue;
        const flag = args[++i] ?? "";
        const split = flag.indexOf("=");
        const path = flag.slice(0, split).split(".");
        let target = flags;
        for (const part of path.slice(0, -1)) {
          target[part] ??= {};
          target = target[part] as Record<string, unknown>;
        }
        target[path.at(-1) as string] = JSON.parse(flag.slice(split + 1));
      }
      const providers = flags.model_providers as Record<
        string,
        Record<string, unknown>
      >;
      assert.equal(providers.emoji_openai?.request_max_retries, 0);
      assert.equal(providers.emoji_openai?.stream_max_retries, 0);
      assert.equal(providers.emoji_openai?.supports_websockets, false);
      assert.equal(
        (flags.features as Record<string, unknown>)
          .unbounded_connection_retries,
        false,
      );
      const normalized = {
        ...flags,
        chatgpt_base_url: "https://chatgpt.com/backend-api/",
        mcp_servers: {},
        instructions: null,
        developer_instructions: null,
        model_instructions_file: null,
        hooks: null,
        model_providers: {
          emoji_openai: {
            base_url: null,
            model_catalog_url: null,
            env_key: null,
            env_key_instructions: null,
            experimental_bearer_token: null,
            auth: null,
            gateway_oauth: null,
            aws: null,
            query_params: null,
            http_headers: null,
            env_http_headers: null,
            stream_idle_timeout_ms: null,
            websocket_connect_timeout_ms: null,
            ...providers.emoji_openai,
          },
        },
      };
      const send = (value: unknown) =>
        child.stdout.write(`${JSON.stringify(value)}\n`);
      child.stdin.on("data", (bytes) => {
        const request = JSON.parse(bytes.toString());
        if (request.id === undefined) return;
        if (request.method === "thread/unsubscribe") {
          send({
            id: request.id,
            error: { code: -32000, message: "fixture retirement failure" },
          });
          setImmediate(() => child.emit("close", 0));
          return;
        }
        const result =
          request.method === "config/read"
            ? {
                config: normalized,
                layers: [{ name: { type: "sessionFlags" }, config: flags }],
              }
            : request.method === "configRequirements/read"
              ? { requirements: null }
              : request.method === "thread/start"
                ? {
                    thread: { id: "thread" },
                    modelProvider: "emoji_openai",
                    approvalPolicy: "never",
                    sandbox: { type: "readOnly" },
                    instructionSources: [],
                  }
                : request.method === "turn/start"
                  ? { turn: { id: "turn" } }
                  : {};
        send({ id: request.id, result });
        if (request.method === "turn/start") {
          turns++;
          send({
            method: "item/completed",
            params: {
              threadId: "thread",
              turnId: "turn",
              item: { type: "agentMessage", text: JSON.stringify(analysis) },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: "thread",
              turn: { id: "turn", status: "completed" },
            },
          });
        }
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  // The dedicated auth home must not contain the image fixture.
  const home = await mkdtemp(join(tmpdir(), "emoji-codex-home-"));
  let provider: Awaited<ReturnType<typeof createCodexDescriber>> | undefined;
  try {
    provider = await createCodexDescriber({
      home,
      model: "fixture",
      capacity: 1,
    });
    const [source] = await catalogSources({
      square: "https://emoji.slack-edge.com/square.png",
    });
    assert.ok(source);
    const result = await provider.describe(
      source,
      {
        hash: "a".repeat(64),
        mime: "image/png",
        width: 24,
        height: 24,
        frames: 1,
        sampledFrames: [0],
      },
      [png],
    );
    assert.deepEqual(result, analysis);
    assert.ok(provider.failure);
    await assert.rejects(
      provider.describe(
        source,
        {
          hash: "a".repeat(64),
          mime: "image/png",
          width: 24,
          height: 24,
          frames: 1,
          sampledFrames: [0],
        },
        [png],
      ),
    );
    assert.equal(turns, 1);
  } finally {
    child.emit("close", 0);
    await provider?.close();
    spawn.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true });
    await rm(home, { recursive: true });
  }
});
