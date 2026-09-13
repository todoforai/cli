#!/usr/bin/env node
// Dev (linked repo) under bun: run src directly so there is no stale-build step.
// Node (and the published package, which ships only dist/) runs the bundle;
// the @shared/* file: deps are bundled in.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dist = fileURLToPath(new URL("../dist/todoforai-cli.js", import.meta.url));
await import(existsSync(src) && typeof Bun !== "undefined" ? src : dist);
