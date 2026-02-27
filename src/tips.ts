const TIPS = [
  "Alt+Enter to insert a newline",
  "Ctrl+W to delete a word backward",
  "Ctrl+K to kill to end of line",
  "Ctrl+A / Ctrl+E to jump to start / end",
  "Paste multiline text — newlines are preserved",
  "/exit or /quit to leave",
];

export function randomTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}
