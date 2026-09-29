import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = dirname(dirname(require.resolve("@scalar/api-reference")));
const { version } = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
if (version !== "1.72.2") {
  throw new Error(`Expected @scalar/api-reference 1.72.2, found ${version}`);
}

const destination = fileURLToPath(
  new URL("../public/vendor/", import.meta.url),
);
// This directory contains only generated, ignored vendor assets.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(
  join(source, "dist/browser/standalone.js"),
  join(destination, "scalar.js"),
);
await copyFile(
  new URL("./scalar-LICENSE.txt", import.meta.url),
  join(destination, "LICENSE"),
);
console.log(`Built Scalar ${version} assets in public/vendor/`);
