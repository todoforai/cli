/** ASCII block logo for TODOforAI CLI. */

// Letter bitmaps: 6 rows tall, 4 wide (except 'i' = 1 wide)
// 'x' = bright white, 'l' = gray, ' ' = black
const LETTERS: Record<string, string[]> = {
  t: [" x  ", "xxxx", " x  ", " xll", " xll", " xxx"],
  o: ["    ", "xxxx", "x  x", "xllx", "xllx", "xxxx"],
  d: ["   x", "xxxx", "x  x", "xllx", "xllx", "xxxx"],
  f: ["  xx", " x  ", "xxxx", "lxll", "lxll", "lxll"],
  r: ["    ", "x xx", "xx  ", "xlll", "xlll", "xlll"],
  c: ["    ", "xxxx", "x   ", "xlll", "xlll", "xxxx"],
  e: ["    ", "xxxx", "x  x", "xxxx", "xlll", "xxxx"],
  a: ["    ", "xxxx", "   x", "xxxx", "xllx", "xxxx"],
  i: ["x", " ", "x", "x", "x", "x"],
  "4": ["    ", "  x ", " xx ", "xlxl", "xxxx", "llxl"],
};

const GAP = " ";
const WORD = "todo4ai";

function renderHalfBlock(top: string, bot: string): string {
  const W = "\x1b[38;2;249;110;46m"; // brand orange fg (#f96e2e)
  const G = "\x1b[38;2;140;60;20m"; // dark orange fg (fade)
  const BW = "\x1b[48;2;249;110;46m"; // brand orange bg
  const BG = "\x1b[48;2;140;60;20m"; // dark orange bg (fade)
  const R = "\x1b[0m";

  if (top === " " && bot === " ") return " ";
  if (top === bot) {
    const fg = top === "x" ? W : G;
    return `${fg}\u2588${R}`;
  }
  if (top === " ") {
    const fg = bot === "x" ? W : G;
    return `${fg}\u2584${R}`;
  }
  if (bot === " ") {
    const fg = top === "x" ? W : G;
    return `${fg}\u2580${R}`;
  }
  // Mixed colors: upper-half block (top=fg, bottom=bg)
  const fg = top === "x" ? W : G;
  const bg = bot === "x" ? BW : BG;
  return `${fg}${bg}\u2580${R}`;
}

function renderLogo(): string[] {
  // Build 6 pixel rows
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    let row = "";
    for (let i = 0; i < WORD.length; i++) {
      if (i > 0) row += GAP;
      row += LETTERS[WORD[i]][r];
    }
    rows.push(row);
  }

  // Pair rows into 3 half-block lines
  const lines: string[] = [];
  for (let pair = 0; pair < 3; pair++) {
    let topRow = rows[pair * 2];
    let botRow = rows[pair * 2 + 1];
    const maxLen = Math.max(topRow.length, botRow.length);
    topRow = topRow.padEnd(maxLen);
    botRow = botRow.padEnd(maxLen);
    let line = "";
    for (let i = 0; i < maxLen; i++) {
      line += renderHalfBlock(topRow[i], botRow[i]);
    }
    lines.push(line);
  }
  return lines;
}

export function printLogo(): void {
  for (const line of renderLogo()) {
    process.stderr.write(`  ${line}\n`);
  }
  process.stderr.write("\n");
}
