/** tfa-cli's side of @shared/fbe/shellCli/titleMatch: the same matching, a miss prints red and exits 2. */

import { CliExit } from "@shared/fbe/shellCli/core";
import * as m from "@shared/fbe/shellCli/titleMatch";
import { RED, RESET } from "./colors";

export const fail = (msg: string): never => { process.stderr.write(`${RED}${msg}${RESET}\n`); process.exit(2); };

const exiting = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
  try { return f(...a); } catch (e) { if (e instanceof CliExit) fail(e.message.replace(/^Error: /, "")); throw e; }
};

export const matchScore = m.matchScore;
export const searchByTitle = exiting(m.searchByTitle) as typeof m.searchByTitle;
export const findByTitle = exiting(m.findByTitle) as typeof m.findByTitle;
export const findExact = exiting(m.findExact) as typeof m.findExact;
