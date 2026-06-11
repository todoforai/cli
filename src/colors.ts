/** Shared ANSI color constants. Disabled when stdout is not a TTY or NO_COLOR is set. */

const on = !process.env.NO_COLOR && !!process.stdout.isTTY;
export const c = (seq: string) => on ? seq : "";

export const YELLOW = c("\x1b[33m");
export const GREEN = c("\x1b[32m");
export const RED = c("\x1b[31m");
export const DIM = c("\x1b[90m");
export const CYAN = c("\x1b[36m");
export const BOLD = c("\x1b[1m");
export const WHITE = c("\x1b[38;2;255;255;255m");
export const BRIGHT_WHITE = c("\x1b[97m");
export const BRAND = c("\x1b[38;2;249;110;46m");
export const RESET = c("\x1b[0m");

// Diff backgrounds
export const DIM_ATTR = c("\x1b[2m"); // dim attribute (not gray fg)
export const BG_RED = c("\x1b[48;2;55;20;20m");
export const BG_GREEN = c("\x1b[48;2;20;45;20m");
export const BG_RED_HL = c("\x1b[48;2;100;35;35m");
export const BG_GREEN_HL = c("\x1b[48;2;35;85;35m");
