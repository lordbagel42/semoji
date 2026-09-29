import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CODEX_PROVIDER = "emoji_openai";
export const CODEX_PROVIDER_CONFIG = {
  name: "OpenAI",
  wire_api: "responses",
  requires_openai_auth: true,
  request_max_retries: 0,
  stream_max_retries: 0,
  supports_websockets: false,
  supports_standalone_web_search: false,
};

/** Only these local codes, never provider messages or image content, escape. */
export class ModelError extends Error {
  constructor(
    public readonly code: string,
    public readonly uncertain = false,
  ) {
    super(code);
    this.name = "CodexError";
  }
}

/** Managed policy is unsupported, not overridden. Recheck before each session. */
export async function assertHotCodexFiles(home: string): Promise<void> {
  for (const path of [
    join(home, "config.toml"),
    join(home, "AGENTS.md"),
    join(home, "AGENTS.override.md"),
    "/etc/codex/config.toml",
    "/etc/codex/managed_config.toml",
    "/etc/codex/requirements.toml",
  ]) {
    const contents = await readFile(path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    if (contents.trim())
      throw new ModelError("hot_codex_requires_clean_config", false);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModelError("invalid_configuration", false);
  return value as Record<string, unknown>;
};
const at = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((parent, key) => object(parent)[key], value);

/** Codex 0.157.1 wire shapes, checked before thread/start schedules prewarm.
 * These reads are not an atomic configuration lock. Operator-owned inputs must
 * stay stable while the process runs; on any observed change we stop, not repair. */
export function assertHotCodexPolicy(
  read: unknown,
  requirements: unknown,
  expected: Record<string, unknown>,
): void {
  function deny(): never {
    throw new ModelError("invalid_configuration", false);
  }
  // Authenticated accounts include login restrictions and chronicle=false even
  // without managed configuration. Accept only those inert restrictions; require
  // the pinned RPC's instruction/provider fields rather than trusting omissions.
  if (object(requirements).requirements !== null) {
    const policy = object(object(requirements).requirements);
    for (const key of [
      "additionalDeveloperInstructions",
      "modelProvider",
      "modelProviders",
      "chatgptBaseUrl",
      "hooks",
    ])
      if (policy[key] !== null) deny();
    for (const [key, value] of Object.entries(policy)) {
      if (value === null) continue;
      if (
        key === "allowedLoginMethods" &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((x) => x === "api" || x === "chatgpt")
      )
        continue;
      if (
        key === "featureRequirements" &&
        isDeepStrictEqual(value, { chronicle: false })
      )
        continue;
      deny();
    }
  }
  const result = object(read);
  const config = object(result.config);
  if (!Array.isArray(result.layers)) deny();
  const flags: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected)) {
    const parts = key.split(".");
    let parent = flags;
    for (const part of parts.slice(0, -1)) {
      parent[part] ??= {};
      parent = object(parent[part]);
    }
    parent[parts.at(-1) as string] = value;
  }
  let sessions = 0;
  for (const entry of result.layers) {
    const layer = object(entry);
    const type = object(layer.name).type;
    if (type === "sessionFlags") {
      sessions++;
      if (
        layer.disabledReason !== undefined ||
        !isDeepStrictEqual(layer.config, flags)
      )
        deny();
    } else if (
      !["system", "user", "project"].includes(String(type)) ||
      !isDeepStrictEqual(layer.config, {})
    )
      deny();
  }
  if (sessions !== 1) deny();
  for (const [key, value] of Object.entries(expected)) {
    // This pinned RPC's ToolsV2 drops these two fields. Validate them in the
    // exact sessionFlags layer above, with every other contributing layer empty.
    if (key.startsWith("tools.")) continue;
    if (!isDeepStrictEqual(at(config, key), value)) deny();
  }
  if (
    config.chatgpt_base_url !== "https://chatgpt.com/backend-api/" ||
    !isDeepStrictEqual(config.model_providers, {
      [CODEX_PROVIDER]: {
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
        ...CODEX_PROVIDER_CONFIG,
      },
    }) ||
    !isDeepStrictEqual(config.mcp_servers, {})
  )
    deny();
  for (const key of [
    "instructions",
    "developer_instructions",
    "model_instructions_file",
    "hooks",
  ])
    if (config[key] !== null) deny();
}
