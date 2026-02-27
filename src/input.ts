/** Terminal input helpers — line reading, raw-mode multiline with bracketed paste */

import { createInterface } from "readline";
import { BRIGHT_WHITE, RESET } from "./colors";

export function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(prompt, (ans) => {
      rl.close();
      res(ans.trim());
    });
  });
}

/** Raw-mode prompt with bracketed paste: multiline paste preserved, Enter submits.
 *  Returns { promise, cancel } — call cancel() to abort the prompt externally. */
export function readMultiline(prompt: string): { promise: Promise<string>; cancel: () => void } {
  let cancelFn: () => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    const out = process.stderr;
    let buf = "";
    let cursor = 0; // cursor position within buf
    let pasting = false;
    let done = false;
    let screenRow = 0; // current terminal row relative to prompt start

    // Strip ANSI to compute visible prompt length
    const promptLen = prompt.replace(/\x1b\[[0-9;]*m/g, "").length;

    out.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write("\x1b[?2004h"); // enable bracketed paste

    /** Compute terminal row (0-based from prompt start) for a buffer position.
     *  Matches terminal deferred-wrap behavior: cursor at exactly N*cols
     *  is on the last column of the current row, not column 0 of the next. */
    function rowOf(pos: number): number {
      const cols = process.stderr.columns || 80;
      const lines = buf.slice(0, pos).split("\n");
      let row = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (i === 0 ? promptLen : 0) + lines[i].length;
        if (i < lines.length - 1) {
          // Full logical line (followed by \n): occupies ceil(len/cols) rows
          row += len === 0 ? 1 : Math.ceil(len / cols);
        } else {
          // Cursor line: ceil(len/cols)-1 gives the 0-based row within
          // this logical line. At exact multiples of cols the cursor is
          // at the end of the row (deferred wrap), not on a new row.
          row += len > 0 ? Math.ceil(len / cols) - 1 : 0;
        }
      }
      return row;
    }

    /** Compute terminal column (0-based) for a buffer position.
     *  At an exact wrap boundary (linePos is nonzero multiple of cols),
     *  returns cols to indicate the cursor is past the last column
     *  (deferred wrap state). */
    function colOf(pos: number): number {
      const cols = process.stderr.columns || 80;
      const lastNl = buf.lastIndexOf("\n", pos - 1);
      const lineStart = lastNl + 1;
      const offset = lineStart === 0 ? promptLen : 0;
      const linePos = offset + (pos - lineStart);
      if (linePos > 0 && linePos % cols === 0) return cols;
      return linePos % cols;
    }

    /** Total terminal rows occupied by prompt + buffer content.
     *  Each logical line occupies ceil(len/cols) rows (minimum 1). */
    function totalRows(): number {
      const cols = process.stderr.columns || 80;
      const lines = buf.split("\n");
      let rows = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (i === 0 ? promptLen : 0) + lines[i].length;
        rows += len === 0 ? 1 : Math.ceil(len / cols);
      }
      return rows;
    }

    /** Full redraw from prompt start. */
    function redraw() {
      const cols = process.stderr.columns || 80;
      // Move to prompt start using tracked screen position
      out.write("\r");
      if (screenRow > 0) out.write(`\x1b[${screenRow}A`);
      out.write("\x1b[J"); // clear to end of screen
      out.write(prompt + buf.replace(/\n/g, "\r\n"));
      // Position cursor at target row/col.
      // rowOf/colOf match the terminal's deferred-wrap behavior, so the
      // end-of-content position is always totalRows()-1 (same as terminal).
      const targetRow = rowOf(cursor);
      const endRow = totalRows() - 1;
      const rowsBack = endRow - targetRow;
      const col = colOf(cursor);
      if (rowsBack > 0) out.write(`\x1b[${rowsBack}A`);
      if (col <= cols) {
        out.write("\r");
        if (col > 0 && col < cols) out.write(`\x1b[${col}C`);
        // col === cols: deferred wrap — move to last column explicitly
        if (col === cols) out.write(`\x1b[${cols}G`);
      }
      screenRow = targetRow;
    }

    function finish(cancelled: boolean) {
      if (done) return;
      done = true;
      // Move to end of content before exiting
      const rowsDown = totalRows() - 1 - screenRow;
      if (rowsDown > 0) out.write(`\x1b[${rowsDown}B`);
      out.write("\x1b[?2004l"); // disable bracketed paste
      out.write("\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      if (cancelled) reject(new Error("cancelled"));
      else resolve(buf.trim());
    }

    /** Find next word boundary to the right */
    function wordRight(): number {
      let p = cursor;
      while (p < buf.length && buf[p] === " ") p++;
      while (p < buf.length && buf[p] !== " ") p++;
      return p;
    }
    /** Find next word boundary to the left */
    function wordLeft(): number {
      let p = cursor;
      while (p > 0 && buf[p - 1] === " ") p--;
      while (p > 0 && buf[p - 1] !== " ") p--;
      return p;
    }
    /** Kill from cursor to end of line */
    function killToEnd() {
      buf = buf.slice(0, cursor);
      redraw();
    }
    /** Delete word backward (Ctrl+W) */
    function deleteWordBack() {
      const to = wordLeft();
      if (to === cursor) return;
      buf = buf.slice(0, to) + buf.slice(cursor);
      cursor = to;
      redraw();
    }

    /**
     * Parse a CSI sequence starting at chunk[i] where chunk[i] === '\x1b'.
     * Returns the new index i (after consuming the sequence).
     * CSI = ESC [ (params) (letter)  e.g. \x1b[1;5D
     */
    function handleCSI(chunk: string, start: number): number {
      let i = start + 1; // skip ESC
      if (i >= chunk.length || chunk[i] !== "[") {
        // Not CSI - skip ESC + one char
        if (i < chunk.length) i++;
        return i;
      }
      i++; // skip '['

      // Collect parameter bytes (digits, semicolons)
      let params = "";
      while (i < chunk.length && /[0-9;]/.test(chunk[i])) {
        params += chunk[i];
        i++;
      }
      // Final byte (letter or ~)
      const final = i < chunk.length ? chunk[i] : "";
      i++; // skip final byte

      // Parse modifier: "1;5" means modifier=5 (Ctrl), etc.
      const parts = params.split(";");
      const modifier = parts.length > 1 ? parseInt(parts[1]) : 0;
      const code = parts[0] || "";
      const ctrl = modifier === 5;

      switch (final) {
        case "D": // Left
          if (ctrl) { cursor = wordLeft(); redraw(); }
          else if (cursor > 0) { cursor--; redraw(); }
          break;
        case "C": // Right
          if (ctrl) { cursor = wordRight(); redraw(); }
          else if (cursor < buf.length) { cursor++; redraw(); }
          break;
        case "H": // Home
          cursor = 0; redraw();
          break;
        case "F": // End
          cursor = buf.length; redraw();
          break;
        case "~":
          if (code === "3" && cursor < buf.length) { // Delete
            buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
            redraw();
          }
          break;
      }
      return i;
    }

    function onData(data: Buffer) {
      let s = data.toString("utf-8");
      while (s.length > 0 && !done) {
        if (pasting) {
          const end = s.indexOf("\x1b[201~");
          if (end >= 0) {
            const text = s.slice(0, end).replace(/\r\n?|\n/g, "\n"); // normalize newlines
            buf = buf.slice(0, cursor) + text + buf.slice(cursor);
            cursor += text.length;
            pasting = false;
            s = s.slice(end + 6);
            redraw();
          } else {
            const text = s.replace(/\r\n?|\n/g, "\n"); // normalize newlines
            buf = buf.slice(0, cursor) + text + buf.slice(cursor);
            cursor += text.length;
            s = "";
            redraw();
          }
        } else {
          const ps = s.indexOf("\x1b[200~");
          const chunk = ps >= 0 ? s.slice(0, ps) : s;

          for (let i = 0; i < chunk.length && !done; i++) {
            const c = chunk.charCodeAt(i);
            if (c === 0x03) { finish(true); return; }              // Ctrl+C
            if (c === 0x0d || c === 0x0a) { finish(false); return; } // Enter
            if (c === 0x17) { deleteWordBack(); }                   // Ctrl+W
            else if (c === 0x0b) { killToEnd(); }                   // Ctrl+K
            else if (c === 0x7f || c === 0x08) {                    // Backspace
              if (cursor > 0) {
                buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
                cursor--;
                redraw();
              }
            } else if (c === 0x1b) {                                // ESC sequence
              // Alt+Enter (ESC + CR) → insert newline
              if (i + 1 < chunk.length && chunk.charCodeAt(i + 1) === 0x0d) {
                buf = buf.slice(0, cursor) + "\n" + buf.slice(cursor);
                cursor++;
                i++; // skip the \r
                redraw();
              } else {
                i = handleCSI(chunk, i) - 1; // -1 because for loop does i++
              }
            } else if (c === 0x01) {                                // Ctrl+A (Home)
              cursor = 0; redraw();
            } else if (c === 0x05) {                                // Ctrl+E (End)
              cursor = buf.length; redraw();
            } else if (c >= 0x20) {
              buf = buf.slice(0, cursor) + chunk[i] + buf.slice(cursor);
              cursor++;
              redraw();
            }
          }

          if (ps >= 0) { pasting = true; s = s.slice(ps + 6); }
          else s = "";
        }
      }
    }

    process.stdin.on("data", onData);

    cancelFn = () => finish(true);
  });
  return { promise, cancel: () => cancelFn() };
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    try {
      const content = await readMultiline(`${BRIGHT_WHITE}TODO>${RESET} `).promise;
      if (!content) { process.stderr.write("Error: Empty input\n"); process.exit(1); }
      return content;
    } catch {
      process.stderr.write("\nCancelled\n"); process.exit(1);
    }
  }
  // Piped
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString("utf-8").trim();
  if (!content) { process.stderr.write("Error: Empty input\n"); process.exit(1); }
  return content;
}
