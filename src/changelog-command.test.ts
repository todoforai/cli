import { describe, expect, test } from "bun:test";
import { cmpVersion, filterReleases, parseAppChangelog, parseReleaseBullets, type ReleaseEntry } from "./changelog-command";

describe("changelog-command", () => {
  test("cmpVersion compares dotted versions with or without leading v", () => {
    expect(cmpVersion("v0.1.99", "0.1.98")).toBeGreaterThan(0);
    expect(cmpVersion("0.1.98", "v0.1.99")).toBeLessThan(0);
    expect(cmpVersion("v1.6.4", "1.6.4")).toBe(0);
    expect(cmpVersion("v0.2.0", "v0.1.99")).toBeGreaterThan(0);
  });

  test("parseReleaseBullets extracts bullet lines and skips footers", () => {
    const body = [
      "- widgets: deterministic ids",
      "- connections: group live clients",
      "",
      "npm: `@todoforai/cli@0.1.99`",
      "",
      "**Full Changelog**: https://github.com/todoforai/cli/compare/v0.1.98...v0.1.99",
    ].join("\n");
    expect(parseReleaseBullets(body)).toEqual([
      "widgets: deterministic ids",
      "connections: group live clients",
    ]);
  });

  test("parseAppChangelog parses CHANGELOG.md sections", () => {
    const md = `# Changelog\n\n## v1.0.31 — 2026-11-24\n\n- Voice Lock\n- Dictation fix\n\n## v1.0.11 — 2026-10-22\n\n- Hungarian UI\n`;
    const entries = parseAppChangelog(md);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      target: "app",
      version: "v1.0.31",
      date: "2026-11-24",
      bullets: ["Voice Lock", "Dictation fix"],
    });
  });

  test("filterReleases respects since and limit", () => {
    const rows: ReleaseEntry[] = ["v0.1.99", "v0.1.98", "v0.1.97", "v0.1.96"].map((version) => ({
      target: "cli",
      version,
      date: "2026-11-26",
      bullets: [],
      url: "",
    }));
    expect(filterReleases(rows, "0.1.97", 10).map((r) => r.version)).toEqual(["v0.1.99", "v0.1.98"]);
    expect(filterReleases(rows, undefined, 2).map((r) => r.version)).toEqual(["v0.1.99", "v0.1.98"]);
  });
});
