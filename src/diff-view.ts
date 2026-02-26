/** Collapsed unified diff rendering for terminal with syntax highlighting */

import { diff_match_patch } from "diff-match-patch";
import { highlight, Theme } from "cli-highlight";
import { extname } from "path";
import chalk from "chalk";

const WHITE = "\x1b[38;2;255;255;255m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
// Line-level backdrop
const BG_RED = "\x1b[48;2;55;20;20m";
const BG_GREEN = "\x1b[48;2;20;45;20m";
// Word-level emphasis
const BG_RED_HL = "\x1b[48;2;100;35;35m";
const BG_GREEN_HL = "\x1b[48;2;35;85;35m";

const CONTEXT_LINES = 3;
const MAX_OUTPUT_LINES = 80;

// Bright syntax theme for dark terminal backgrounds
// Monokai theme — vivid, high-saturation colors
const SYNTAX_THEME: Theme = {
  default: chalk.rgb(248, 248, 242),    // Monokai foreground
  keyword: chalk.rgb(249, 38, 114),     // pink
  built_in: chalk.rgb(102, 217, 239),   // cyan
  type: chalk.rgb(102, 217, 239),       // cyan
  literal: chalk.rgb(174, 129, 255),    // purple
  number: chalk.rgb(174, 129, 255),     // purple
  regexp: chalk.rgb(230, 219, 116),     // yellow
  string: chalk.rgb(230, 219, 116),     // yellow
  subst: chalk.rgb(248, 248, 242),      // foreground
  symbol: chalk.rgb(174, 129, 255),     // purple
  class: chalk.rgb(166, 226, 46),       // green
  function: chalk.rgb(166, 226, 46),    // green
  title: chalk.rgb(166, 226, 46),       // green
  params: chalk.rgb(253, 151, 31),      // orange
  comment: chalk.rgb(117, 113, 94),     // gray
  doctag: chalk.rgb(117, 113, 94),      // gray
  meta: chalk.rgb(249, 38, 114),        // pink
  "meta-keyword": chalk.rgb(249, 38, 114),
  "meta-string": chalk.rgb(230, 219, 116),
  section: chalk.rgb(166, 226, 46),     // green
  tag: chalk.rgb(249, 38, 114),         // pink
  name: chalk.rgb(249, 38, 114),        // pink
  attr: chalk.rgb(166, 226, 46),        // green
  attribute: chalk.rgb(166, 226, 46),
  variable: chalk.rgb(248, 248, 242),   // foreground
  bullet: chalk.rgb(174, 129, 255),     // purple
  code: chalk.rgb(230, 219, 116),       // yellow
  emphasis: chalk.italic,
  strong: chalk.bold,
  formula: chalk.rgb(248, 248, 242),    // foreground
  link: chalk.rgb(102, 217, 239).underline,
  quote: chalk.rgb(117, 113, 94).italic,
  addition: chalk.rgb(166, 226, 46),    // green
  deletion: chalk.rgb(249, 38, 114),    // pink
};

/** Strip ANSI escape sequences */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Replace all RESET sequences in syntax-highlighted text so the line bg persists */
function patchResets(text: string, bg: string): string {
  return text.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
}

/** Syntax-highlight a block of text, returning per-line results */
function syntaxHighlight(text: string, filePath: string): string[] {
  try {
    const ext = extname(filePath).slice(1);
    if (!ext) return text.split("\n");
    const highlighted = highlight(text, { language: ext, ignoreIllegals: true, theme: SYNTAX_THEME });
    return highlighted.split("\n");
  } catch {
    return text.split("\n");
  }
}

/** Word-level highlight within a pair of removed/added line chunks.
 *  Works on plain text, then re-applies syntax colors. */
function highlightInline(
  oldLines: string[], newLines: string[],
  oldSyntax: string[], newSyntax: string[],
): { old: string[]; new: string[] } {
  const dmp = new diff_match_patch();
  const oldText = oldLines.join("\n");
  const newText = newLines.join("\n");
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  // Build per-line markup: unchanged chars get syntax colors, changed chars get highlight
  let oldPos = 0;
  let newPos = 0;
  let oldResult = "";
  let newResult = "";
  const oldSyntaxJoined = oldSyntax.join("\n");
  const newSyntaxJoined = newSyntax.join("\n");

  for (const [op, text] of diffs) {
    if (op === 0) {
      // Unchanged — use syntax-highlighted version
      const oldSlice = sliceSyntax(oldSyntaxJoined, oldPos, oldPos + text.length);
      const newSlice = sliceSyntax(newSyntaxJoined, newPos, newPos + text.length);
      oldResult += oldSlice;
      newResult += newSlice;
      oldPos += text.length;
      newPos += text.length;
    } else if (op === -1) {
      const syn = sliceSyntax(oldSyntaxJoined, oldPos, oldPos + text.length);
      oldResult += `${BG_RED_HL}${patchResets(syn, BG_RED_HL)}${RESET}${BG_RED}`;
      oldPos += text.length;
    } else {
      const syn = sliceSyntax(newSyntaxJoined, newPos, newPos + text.length);
      newResult += `${BG_GREEN_HL}${patchResets(syn, BG_GREEN_HL)}${RESET}${BG_GREEN}`;
      newPos += text.length;
    }
  }
  return { old: oldResult.split("\n"), new: newResult.split("\n") };
}

/** Extract a slice from a syntax-highlighted string by plain-text position */
function sliceSyntax(syntaxStr: string, start: number, end: number): string {
  let plainPos = 0;
  let result = "";
  let i = 0;
  while (i < syntaxStr.length && plainPos < end) {
    if (syntaxStr[i] === "\x1b") {
      // Consume ANSI escape
      const escEnd = syntaxStr.indexOf("m", i);
      if (escEnd !== -1) {
        if (plainPos >= start) result += syntaxStr.slice(i, escEnd + 1);
        i = escEnd + 1;
        continue;
      }
    }
    if (plainPos >= start) result += syntaxStr[i];
    plainPos++;
    i++;
  }
  return result;
}

export function renderDiff(originalContent: string, modifiedContent: string, filePath: string): string {
  const dmp = new diff_match_patch();
  const orig = originalContent || "";
  const mod = modifiedContent || "";

  // Syntax-highlight full files (plain lines for diff, highlighted for display)
  const origSyntaxLines = syntaxHighlight(orig, filePath);
  const modSyntaxLines = syntaxHighlight(mod, filePath);

  // Line-based diff for collapsed view
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(orig, mod);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  type DiffLine = { op: number; text: string; origLine?: number; modLine?: number };
  const lines: DiffLine[] = [];
  let origLine = 1;
  let modLine = 1;

  // Process diffs pairwise for word-level highlighting on -1/+1 pairs
  let i = 0;
  while (i < diffs.length) {
    const [op, text] = diffs[i];

    if (op === 0) {
      const chunk = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      for (const line of chunk) {
        // Use syntax-highlighted version for context lines
        const syntaxLine = origSyntaxLines[origLine - 1] ?? line;
        lines.push({ op: 0, text: syntaxLine, origLine, modLine });
        origLine++;
        modLine++;
      }
      i++;
    } else if (op === -1 && i + 1 < diffs.length && diffs[i + 1][0] === 1) {
      // Paired remove+add — word-level highlighting
      const oldText = text.endsWith("\n") ? text.slice(0, -1) : text;
      const newText = diffs[i + 1][1];
      const newTextClean = newText.endsWith("\n") ? newText.slice(0, -1) : newText;
      const oldPlain = oldText.split("\n");
      const newPlain = newTextClean.split("\n");
      const oldSyn = oldPlain.map((_, j) => origSyntaxLines[origLine + j - 1] ?? "");
      const newSyn = newPlain.map((_, j) => modSyntaxLines[modLine + j - 1] ?? "");
      const hl = highlightInline(oldPlain, newPlain, oldSyn, newSyn);
      for (let j = 0; j < hl.old.length; j++) {
        lines.push({ op: -1, text: hl.old[j], origLine });
        origLine++;
      }
      for (let j = 0; j < hl.new.length; j++) {
        lines.push({ op: 1, text: hl.new[j], modLine });
        modLine++;
      }
      i += 2;
    } else if (op === -1) {
      const chunk = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      for (const line of chunk) {
        const syntaxLine = origSyntaxLines[origLine - 1] ?? line;
        lines.push({ op: -1, text: syntaxLine, origLine });
        origLine++;
      }
      i++;
    } else {
      const chunk = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      for (const line of chunk) {
        const syntaxLine = modSyntaxLines[modLine - 1] ?? line;
        lines.push({ op: 1, text: syntaxLine, modLine });
        modLine++;
      }
      i++;
    }
  }

  // Find changed line indices
  const changed = new Set<number>();
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].op !== 0) changed.add(idx);
  }
  if (changed.size === 0) return "";

  // Expand context around changes
  const visible = new Set<number>();
  for (const idx of changed) {
    for (let c = Math.max(0, idx - CONTEXT_LINES); c <= Math.min(lines.length - 1, idx + CONTEXT_LINES); c++) {
      visible.add(c);
    }
  }

  // Render
  const parts: string[] = [`${CYAN}── ${filePath} ──${RESET}\n`];
  let outputLines = 1;
  let lastIdx = -2;

  for (let idx = 0; idx < lines.length && outputLines < MAX_OUTPUT_LINES; idx++) {
    if (!visible.has(idx)) continue;
    if (idx > lastIdx + 1) {
      parts.push(`${DIM}  ···${RESET}\n`);
      outputLines++;
    }
    lastIdx = idx;

    const dl = lines[idx];
    const ln = dl.op === 1 ? dl.modLine : dl.origLine;
    const pad = String(ln ?? "").padStart(4);

    if (dl.op === -1) {
      parts.push(`${BG_RED}\x1b[38;2;180;80;80m${pad} -${RESET}${BG_RED}${WHITE}${patchResets(dl.text, BG_RED + WHITE)}${RESET}\n`);
    } else if (dl.op === 1) {
      parts.push(`${BG_GREEN}\x1b[38;2;80;160;80m${pad} +${RESET}${BG_GREEN}${WHITE}${patchResets(dl.text, BG_GREEN + WHITE)}${RESET}\n`);
    } else {
      parts.push(`${DIM}${pad}  ${RESET}${WHITE}${dl.text}${RESET}\n`);
    }
    outputLines++;
  }

  if (outputLines >= MAX_OUTPUT_LINES) {
    const remaining = [...visible].filter(i => i > lastIdx).length;
    if (remaining > 0) parts.push(`${DIM}  + ${remaining} more lines${RESET}\n`);
  }

  return parts.join("");
}
