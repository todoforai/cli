// Deprecated legacy alias: `tfa-cli widgets …` runs `tfa-show widgets …` (the shared command) in-process. Out of --help.

import { readFileSync, statSync } from "fs";
import { basename, resolve } from "path";
import type { ApiClient } from "@shared/api";
import { restBasePath } from "@shared/api";
import { runShellCli } from "@shared/fbe/shellCli";
import { showCli } from "@shared/fbe/shellCli/show";
import type { CliHttpReply, CliIo } from "@shared/fbe/shellCli/core";
import { getEnv } from "./args";

export async function widgetsCommand(api: ApiClient, positionals: string[], args: Record<string, any>, projectId?: string) {
  const send = async (path: string, init: RequestInit): Promise<CliHttpReply> => {
    const res = await fetch(`${api.apiUrl}${restBasePath(api.apiKey)}${path}`, { ...init, headers: { ...init.headers, "x-api-key": api.apiKey } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, text: new TextDecoder().decode(bytes), bytes };
  };
  const io: CliIo = {
    http: (method, path, json) => send(path, json === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
    upload: (path, fields, file, method = "POST") => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (file) form.append("file", new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
      return send(path, { method, body: form });
    },
    stdin: async () => process.stdin.isTTY ? null : readFileSync(0),
    file: async (p) => { const abs = resolve(p); try { return statSync(abs).isFile() ? { name: basename(abs), bytes: readFileSync(abs) } : null; } catch { return null; } },
    env: { todoId: getEnv("TODO_ID"), projectId, cwd: process.cwd(), stdoutTty: !!process.stdout.isTTY },
  };
  const flags = [args.json && "--json", args.title !== undefined && ["--title", String(args.title)], args.group && ["--group", String(args.group)]].filter(Boolean).flat() as string[];
  const r = await runShellCli(showCli, ["widgets", ...flags, "--", ...positionals.slice(1)], io);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
