// Zero-dep update notifier. Cache file shared across todoforai CLIs.
// - Non-blocking: cache read is sync (<1ms); registry fetch fires & forgets.
// - Silent on CI / non-TTY / NO_UPDATE_NOTIFIER.
// - Cache TTL: 1 day per package.

import fs from "fs";
import path from "path";
import os from "os";

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(os.homedir(), ".config", "todoforai");

export function checkForUpdates(pkg: { name: string; version: string }): void {
  if (!process.stderr.isTTY || process.env.CI || process.env.NO_UPDATE_NOTIFIER) return;

  const cacheFile = path.join(CACHE_DIR, `notifier-${pkg.name.replace(/[/@]/g, "-")}.json`);
  let cache: { ts?: number; latest?: string } = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}

  if (cache.latest && cache.latest !== pkg.version) {
    process.stderr.write(
      `\n\x1b[33m  Update available: \x1b[2m${pkg.version}\x1b[22m → \x1b[1m${cache.latest}\x1b[0m\n` +
      `\x1b[33m  Run:\x1b[0m npm i -g ${pkg.name}\n\n`
    );
  }

  if (Date.now() - (cache.ts ?? 0) > TTL_MS) {
    fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() as any : null)
      .then(j => {
        if (!j?.version) return;
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), latest: j.version }));
      })
      .catch(() => {});
  }
}
