import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import {
  type EmojiMedia,
  type EmojiSource,
  mediaSchema,
  sourceSchema,
} from "../shared.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_TOTAL_PIXELS = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
// Bound native decode work as well as JavaScript promises. Frames decode serially.
sharp.cache(false);
sharp.concurrency(1);
let running = 0;
const waiters = new Set<() => void>();

export class MediaError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "MediaError";
  }
}
function check(signal: AbortSignal) {
  if (signal.aborted) throw new MediaError("media_cancelled");
}
async function acquire(signal: AbortSignal) {
  check(signal);
  if (running >= 2) {
    if (waiters.size >= 64) throw new MediaError("media_busy");
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        waiters.delete(wake);
        reject(new MediaError("media_cancelled"));
      };
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      waiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
    // The releaser transfers its slot to this waiter, even if cancellation wins.
    if (signal.aborted) {
      release();
      check(signal);
    }
  } else running++;
}
function release() {
  const next = waiters.values().next().value;
  if (next) {
    waiters.delete(next);
    next();
  } else running--;
}
function allowedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MediaError("media_url_not_allowed");
  }
  // Exact Slack-owned emoji CDNs only. No wildcard hosts, custom ports or credentials.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["emoji.slack-edge.com", "a.slack-edge.com"].includes(url.hostname)
  )
    throw new MediaError("media_url_not_allowed");
  return url;
}
async function download(input: string, signal: AbortSignal): Promise<Buffer> {
  let url = allowedUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    check(signal);
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new MediaError("media_redirect_limit");
      url = allowedUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new MediaError("media_fetch_failed");
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_BYTES) {
      await response.body.cancel();
      throw new MediaError("media_too_large");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        check(signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new MediaError("media_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new MediaError("media_invalid");
    return Buffer.concat(chunks, size);
  }
  throw new MediaError("media_redirect_limit");
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new MediaError("media_cache_not_private");
}

/** Downloads once; only bounded, re-encoded sampled PNGs are supplied to vision. */
export async function prepareMedia(
  source: EmojiSource,
  cacheDirectory: string,
  signal?: AbortSignal,
): Promise<{ media: EmojiMedia; imagePaths: string[] }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let acquired = false;
  let temporary: string | undefined;
  try {
    if (
      !sourceSchema.safeParse(source).success ||
      !source.imageUrl ||
      !isAbsolute(cacheDirectory)
    )
      throw new MediaError("media_invalid");
    await acquire(combined);
    acquired = true;
    const bytes = await download(source.imageUrl, combined);
    check(combined);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const metadata = await sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      failOn: "warning",
      pages: 1,
    })
      .timeout({ seconds: 10 })
      .metadata();
    const mimeTypes: Record<string, EmojiMedia["mime"]> = {
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mime = mimeTypes[metadata.format ?? ""];
    const width = metadata.width ?? 0;
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    const frames = metadata.pages ?? 1;
    if (
      !mime ||
      width < 1 ||
      height < 1 ||
      width > 4096 ||
      height > 4096 ||
      frames < 1 ||
      frames > 1000 ||
      width * height > MAX_PIXELS ||
      width * height * frames > MAX_TOTAL_PIXELS
    )
      throw new MediaError("media_limits_exceeded");
    const count = Math.min(8, frames);
    const sampledFrames = Array.from({ length: count }, (_, i) =>
      count === 1 ? 0 : Math.round((i * (frames - 1)) / (count - 1)),
    );
    const media = mediaSchema.parse({
      hash,
      mime,
      width,
      height,
      frames,
      sampledFrames,
    });
    await privateDirectory(cacheDirectory);
    const directory = join(cacheDirectory, hash);
    await privateDirectory(directory);
    const imagePaths: string[] = [];
    for (const page of sampledFrames) {
      check(combined);
      const png = await sharp(bytes, {
        page,
        pages: 1,
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      })
        .timeout({ seconds: 10 })
        .rotate()
        .resize({
          width: 512,
          height: 512,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColourspace("srgb")
        .png()
        .toBuffer();
      check(combined);
      if (png.length > 2 * 1024 * 1024) throw new MediaError("media_too_large");
      const path = join(directory, `frame-${page}.png`);
      temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, png, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      temporary = undefined;
      imagePaths.push(path);
    }
    check(combined);
    return { media, imagePaths };
  } catch (error) {
    if (signal?.aborted) throw new MediaError("media_cancelled");
    if (timeout.aborted) throw new MediaError("media_timeout");
    if (error instanceof MediaError) throw error;
    throw new MediaError("media_invalid");
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    if (acquired) release();
  }
}
