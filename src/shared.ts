import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const PROMPT_VERSION = "emoji-vision-1";
export const WORKSPACE_ID = "T0266FRGM";
// Existing Slack catalogues include Unicode and legacy apostrophes in names.
export const nameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{M}\p{N}_+'-]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const terms = z.array(z.string().min(1).max(100)).max(40);

export const sourceSchema = z
  .object({
    workspaceId: z.literal(WORKSPACE_ID),
    name: nameSchema,
    source: z.string().min(1).max(2048),
    revision: hash,
    canonicalName: nameSchema.nullable(),
    imageUrl: z.url().max(2048).nullable(),
    aliasOf: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type EmojiSource = z.infer<typeof sourceSchema>;

export const analysisSchema = z
  .object({
    summary: z.string().min(1).max(300),
    description: z.string().min(40).max(6000),
    visibleText: z.array(z.string().max(500)).max(20),
    subjects: terms,
    actions: terms,
    colors: terms,
    style: terms,
    emotions: terms,
    tags: terms,
    usageExamples: z.array(z.string().min(1).max(400)).max(8),
    interpretation: z.string().max(2000),
    uncertainties: z.array(z.string().min(1).max(400)).max(12),
    confidence: z.enum(["high", "medium", "low"]),
    animationDescription: z.string().max(1200),
    embeddingText: z.string().min(1).max(1600),
  })
  .strict();
export type EmojiAnalysis = z.infer<typeof analysisSchema>;
export const analysisJsonSchema = z.toJSONSchema(analysisSchema);

export const mediaSchema = z
  .object({
    hash,
    mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    frames: z.number().int().min(1).max(10000),
    sampledFrames: z.array(z.number().int().nonnegative()).min(1).max(8),
  })
  .strict();
export type EmojiMedia = z.infer<typeof mediaSchema>;

export const resultSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    source: sourceSchema,
    media: mediaSchema,
    analysis: analysisSchema,
    provenance: z
      .object({
        provider: z.literal("codex"),
        model: z.string().min(1).max(100),
        promptVersion: z.literal(PROMPT_VERSION),
        indexedAt: z.iso.datetime(),
        durationMs: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type EmojiResult = z.infer<typeof resultSchema>;

export const leaseSchema = z
  .object({
    id: z.string().uuid(),
    source: sourceSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type EmojiLease = z.infer<typeof leaseSchema>;

export interface IndexStatus {
  mode: "local" | "cloud";
  state: "idle" | "running" | "paused" | "blocked";
  updatedAt: string;
  counts: Record<
    | "total"
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "unknown"
    | "aliases",
    number
  >;
  concurrency: number;
  targetConcurrency: number;
  completedPerMinute: number;
  availableMemoryMb: number | null;
  reason: string | null;
  recent: Array<{
    name: string;
    state: string;
    summary: string | null;
    imageUrl: string | null;
    error: string | null;
  }>;
}

export interface SearchHit {
  name: string;
  shortcode: string;
  canonicalName: string | null;
  imageUrl: string | null;
  summary: string;
  description: string;
  score: number;
  match: "exact" | "keyword" | "semantic";
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const input =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function catalogSources(
  catalog: Record<string, string>,
): Promise<EmojiSource[]> {
  return Promise.all(
    Object.entries(catalog).map(async ([name, source]) => {
      nameSchema.parse(name);
      let canonicalName: string | null = name;
      let imageUrl: string | null = source;
      const visited = new Set<string>([name]);
      while (imageUrl?.startsWith("alias:")) {
        const target: string = imageUrl.slice(6);
        if (visited.has(target) || !catalog[target]) {
          canonicalName = null;
          imageUrl = null;
          break;
        }
        visited.add(target);
        canonicalName = target;
        imageUrl = catalog[target] ?? null;
      }
      return sourceSchema.parse({
        workspaceId: WORKSPACE_ID,
        name,
        source,
        canonicalName,
        imageUrl,
        aliasOf: source.startsWith("alias:") ? source.slice(6) : null,
        revision: await sha256(
          JSON.stringify([
            SCHEMA_VERSION,
            name,
            source,
            canonicalName,
            imageUrl,
          ]),
        ),
      });
    }),
  );
}

export function searchText(name: string, analysis: EmojiAnalysis): string {
  return [
    name.replaceAll(/[_-]/g, " "),
    analysis.summary,
    analysis.description,
    ...analysis.visibleText,
    ...analysis.subjects,
    ...analysis.actions,
    ...analysis.emotions,
    ...analysis.tags,
    ...analysis.usageExamples,
    analysis.interpretation,
  ].join(" ");
}

export function ftsQuery(query: string): string {
  return query
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_+-]+/u)
    .filter(Boolean)
    .slice(0, 12)
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" OR ");
}
