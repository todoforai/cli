// Zero-dep update notifier. Cache file shared across todoforai CLIs under
// ~/.config/todoforai/. Sync cost <5ms; registry fetch is not awaited but
// may briefly keep the event loop alive (max 3s via AbortSignal.timeout).
// Silent on CI / non-TTY / NO_UPDATE_NOTIFIER.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(os.homedir(), ".config", "todoforai");

// Compare dotted numeric versions; ignores pre-release suffixes (`-dev`, `-rc.1`).
// Returns >0 if a>b, <0 if a<b, 0 if equal.
function cmpVer(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  const pb = b.split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function checkForUpdates(pkg: { name: string; version: string }): void {
  if (!process.stderr.isTTY || process.env.CI || process.env.NO_UPDATE_NOTIFIER) return;

  const cacheFile = path.join(CACHE_DIR, `notifier-${encodeURIComponent(pkg.name)}.json`);
  let cache: { ts?: number; latest?: string } = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}

  if (cache.latest && cmpVer(cache.latest, pkg.version) > 0) {
    process.stderr.write(
      `\n\x1b[33m  Update available: \x1b[2m${pkg.version}\x1b[22m → \x1b[1m${cache.latest}\x1b[0m\n` +
      `\x1b[33m  Run:\x1b[0m npm i -g ${pkg.name}\n\n`
    );
  }

  if (Date.now() - (cache.ts ?? 0) > TTL_MS) {
    // Bump ts immediately so failed/slow lookups don't retry every run.
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, ts: Date.now() }));
    } catch {}
    fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() as any : null)
      .then(j => {
        if (!j?.version) return;
        fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), latest: j.version }));
      })
      .catch(() => {});
  }
}
