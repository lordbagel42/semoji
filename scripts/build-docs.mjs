import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("swagger-ui-dist/package.json"));
const { version } = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
if (version !== "5.33.0") {
  throw new Error(`Expected swagger-ui-dist 5.33.0, found ${version}`);
}

const destination = fileURLToPath(
  new URL("../public/vendor/", import.meta.url),
);
await mkdir(destination, { recursive: true });
for (const file of [
  "swagger-ui-bundle.js",
  "swagger-ui.css",
  "LICENSE",
  "NOTICE",
  "swagger-ui-bundle.js.LICENSE.txt",
]) {
  await copyFile(join(source, file), join(destination, file));
}
console.log(`Built Swagger UI ${version} assets in public/vendor/`);
