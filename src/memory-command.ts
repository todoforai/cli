/** `memory` — your memory/context and the current project's, as git checkouts (history, diff, revert, push). */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { GREEN, RED, RESET } from "./colors";

export function printMemoryHelp() {
  process.stderr.write(`
tfa-cli memory — memory and context folders as git checkouts

Usage:
  tfa-cli memory sync [--project <id>]   Clone, or pull, into:
      ~/.todoforai/{memory,context}                 yours          (todoforai:memory, todoforai:context)
      ~/.todoforai/projects/<id>/{memory,context}   the project's  (todoforai:projects/<id>/…)
  tfa-cli memory path [--project <id>]   Print the checkout paths

Every change to these folders is committed on the server, from any client. In a checkout
use plain git: log, diff, show, revert, commit, then \`git push\` — the push updates the live
folder. A push behind the server is refused: \`git pull\` first. Files over 5 MB live outside
history (upload them instead). Project folders: members with write access push. The project
defaults to $TODOFORAI_PROJECT_ID.
`);
}

const FOLDERS = ["memory", "context"];

/** Checkout dir → remote path, for the user and (if any) the project. */
function checkouts(projectId?: string): [string, string][] {
  const root = join(homedir(), ".todoforai");
  const scopes: [string, string][] = [[root, ""], ...(projectId ? [[join(root, "projects", projectId), `projects/${projectId}/`] as [string, string]] : [])];
  return scopes.flatMap(([dir, remote]) => FOLDERS.map((f): [string, string] => [join(dir, f), `${remote}${f}.git`]));
}

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** git credential helper: git runs `tfa-cli memory credential get`, so every fetch/push uses
 *  the token the CLI resolves now (refreshed device tokens included) — none stored in .git. */
const helper = (apiUrl: string) => `!tfa-cli --api-url ${apiUrl} memory credential`;

export async function memoryCommand(apiUrl: string, apiKey: string, positionals: string[], projectId?: string) {
  const sub = positionals[1] ?? "sync";
  if (sub === "credential") {
    // Only for the API's own host: a remote pointed elsewhere gets no token.
    let input = "";
    for await (const c of process.stdin) input += c;
    const host = /^host=(.*)$/m.exec(input)?.[1];
    if (positionals[2] === "get" && host === new URL(apiUrl).host) process.stdout.write(`username=tfa\npassword=${apiKey}\n`);
    return;
  }
  if (sub === "path") { for (const [dir] of checkouts(projectId)) console.log(dir); return; }
  if (sub !== "sync") { printMemoryHelp(); process.exit(2); }

  let failed = false;
  for (const [dir, remote] of checkouts(projectId)) {
    const auth = ["-c", "credential.helper=", "-c", `credential.helper=${helper(apiUrl)}`];
    const r = existsSync(join(dir, ".git"))
      ? git([...auth, "pull", "-q", "--no-rebase", "origin", "main"], dir)
      : (mkdirSync(dir, { recursive: true }), git([...auth, "clone", "-q", `${apiUrl}/api/v1/resources/git/${remote}`, dir]));
    if (r.ok) {
      // Plain `git pull` / `git push` in the checkout authenticate the same way.
      git(["config", "credential.helper", helper(apiUrl)], dir);
      git(["config", "pull.rebase", "false"], dir);
      process.stderr.write(`${GREEN}✓${RESET} ${dir}\n`);
    } else {
      failed = true;
      process.stderr.write(`${RED}✗ ${dir}: ${r.out.split("\n").pop()}${RESET}\n`);
    }
  }
  if (failed) process.exit(1);
}
