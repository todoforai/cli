#!/usr/bin/env node
// Dev (linked repo) under bun: run src directly so there is no stale-build step.
// Node (and the published package, which ships only dist/) runs the bundle;
// the @shared/* file: deps are bundled in.
// import() takes the URL, not a path: on Windows fileURLToPath gives `C:\...`,
// which the ESM loader rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME, protocol 'c:').
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = new URL("../src/index.ts", import.meta.url);
const dist = new URL("../dist/todoforai-cli.js", import.meta.url);
await import((existsSync(fileURLToPath(src)) && typeof Bun !== "undefined" ? src : dist).href);
