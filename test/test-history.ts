import { ConfigStore } from "../src/config";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = mkdtempSync(join(tmpdir(), "todoai-test-"));
const testConfig = join(testDir, "config.json");

console.log("Testing history persistence...");

// First run - add some history
const cfg1 = new ConfigStore(testConfig);
cfg1.addToHistory("first command");
cfg1.addToHistory("second command");
cfg1.addToHistory("third command");
console.log("✓ Added 3 entries to history");

// Second run - load from disk and verify
const cfg2 = new ConfigStore(testConfig);
const history = cfg2.getHistory();
console.log("✓ Loaded history:", history);

if (history.length === 3 && 
    history[0] === "first command" &&
    history[1] === "second command" &&
    history[2] === "third command") {
  console.log("✓ History persisted correctly!");
} else {
  console.error("✗ History mismatch!");
  process.exit(1);
}

// Test deduplication
cfg2.addToHistory("second command"); // duplicate
const history2 = cfg2.getHistory();
if (history2.length === 3 && history2[2] === "second command") {
  console.log("✓ Deduplication works (moved to end)");
} else {
  console.error("✗ Deduplication failed!");
  process.exit(1);
}

// Cleanup
rmSync(testDir, { recursive: true });
console.log("✓ All tests passed!");
