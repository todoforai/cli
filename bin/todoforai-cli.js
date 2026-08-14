#!/usr/bin/env bun
// Dev (linked repo): run src directly so there is no stale-build step.
// Published package ships only dist/ (the @shared/* file: deps are bundled in).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dist = fileURLToPath(new URL("../dist/todoforai-cli.js", import.meta.url));
await import(existsSync(src) ? src : dist);
