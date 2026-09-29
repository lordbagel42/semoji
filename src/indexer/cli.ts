import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { catalogSchema, slackCatalog } from "../http.js";
import { catalogSources } from "../shared.js";
import { connect, remoteClient, upload } from "./remote.js";
import { runIndexer } from "./run.js";
import { serveDashboard } from "./server.js";
import { Store } from "./store.js";

process.umask(0o077);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    home: { type: "string" },
    model: { type: "string", default: "gpt-6-astra" },
    catalog: { type: "string" },
    output: { type: "string" },
    service: { type: "string", default: "https://emojis.raygen.dev" },
    port: { type: "string", default: process.env.PORT ?? "3091" },
    "max-concurrency": { type: "string", default: "1000" },
    "initial-concurrency": { type: "string", default: "4" },
    limit: { type: "string", default: "1000000" },
    "reserve-mb": { type: "string", default: "4096" },
    "include-unknown": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
function integer(input: string, min: number, max: number) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error("invalid_numeric_option");
  return value;
}
async function main() {
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Emoji indexer (Node 24)\n
sync --data ABSOLUTE_DIR [--catalog FILE]  Import emoji.list export or use SLACK_BOT_TOKEN
run --data DIR --home AUTH_HOME [--model gpt-6-astra] [--max-concurrency 1000]
    [--initial-concurrency 4] [--limit N] [--reserve-mb 4096]
serve --data DIR [--port 3091]             Read-only loopback dashboard
status --data DIR                         Sanitized progress
export --data DIR --output NEW_FILE       Export completed results as NDJSON
upload --data DIR [--service HTTPS_ORIGIN] Import using EMOJI_ADMIN_TOKEN
connect --data DIR --home AUTH_HOME       Listen using EMOJI_INDEXER_TOKEN
    [--service HTTPS_ORIGIN] [--model gpt-6-astra]
retry --data DIR [--include-unknown]      Explicitly permit new inference attempts

Interrupted jobs are not replayed. Before retry, confirm the old process has stopped.
Authentication is read only from the private Codex home; no tokens in CLI arguments.`);
    return;
  }
  if (!values.data || !isAbsolute(values.data))
    throw new Error("absolute_data_directory_required");
  const store = new Store(values.data);
  let serving = false;
  try {
    if (command === "sync") {
      let catalog: Record<string, string>;
      if (values.catalog) {
        if ((await stat(values.catalog)).size > 32 * 1024 * 1024)
          throw new Error("catalog_too_large");
        const input = JSON.parse(await readFile(values.catalog, "utf8"));
        if (input.ok === false) throw new Error("invalid_catalog_export");
        catalog = catalogSchema.parse(input.emoji ?? input);
      } else {
        const token = process.env.SLACK_BOT_TOKEN;
        if (!token) throw new Error("slack_bot_token_required");
        catalog = await slackCatalog(token);
      }
      store.sync(await catalogSources(catalog));
      console.log(JSON.stringify(store.status().counts));
    } else if (command === "upload") {
      await upload(
        store,
        remoteClient(values.service, process.env.EMOJI_ADMIN_TOKEN ?? ""),
      );
      console.log("Upload complete.");
    } else if (command === "run" || command === "connect") {
      if (!values.home || !isAbsolute(values.home))
        throw new Error("absolute_codex_home_required");
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      if (command === "connect") {
        await connect(
          store,
          remoteClient(values.service, process.env.EMOJI_INDEXER_TOKEN ?? ""),
          {
            home: values.home,
            model: values.model,
            signal: controller.signal,
          },
        );
        return;
      }
      const target = integer(values["max-concurrency"], 1, 1000);
      await runIndexer(store, {
        home: values.home,
        model: values.model,
        target,
        initial: integer(values["initial-concurrency"], 1, target),
        limit: integer(values.limit, 1, 1_000_000),
        reserveMb: integer(values["reserve-mb"], 1024, 1_000_000),
        signal: controller.signal,
      });
      console.log(JSON.stringify(store.status().counts));
    } else if (command === "serve") {
      const port = integer(values.port, 1024, 65535);
      serveDashboard(store, port);
      serving = true;
      console.log(`Read-only dashboard listening on loopback port ${port}.`);
    } else if (command === "status")
      console.log(JSON.stringify(store.status()));
    else if (command === "retry")
      console.log(
        JSON.stringify({
          reset: Number(store.retry(values["include-unknown"])),
        }),
      );
    else if (command === "export") {
      if (!values.output) throw new Error("output_path_required");
      const stream = createWriteStream(values.output, {
        flags: "wx",
        mode: 0o600,
      });
      for (const result of store.results()) {
        if (!stream.write(`${JSON.stringify(result)}\n`))
          await new Promise<void>((resolve, reject) => {
            stream.once("drain", resolve);
            stream.once("error", reject);
          });
      }
      await new Promise<void>((resolve, reject) => {
        stream.once("error", reject);
        stream.end(resolve);
      });
    } else throw new Error("unknown_command");
  } finally {
    if (!serving) store.close();
  }
}
void main().catch((error) => {
  const message =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "command_failed";
  console.error(message);
  process.exitCode = 1;
});
