/** Interactive project/agent selection — port of project_selectors.py */

import { createInterface } from "readline";

// ── helpers ──────────────────────────────────────────────────────────

export function getDisplayName(item: any): string {
  if (item?.project?.name) return item.project.name;
  return item?.name || "Unknown";
}

export function getItemId(item: any): string {
  if (item?.project?.id) return item.project.id;
  return item?.id || "";
}

// ── terminal I/O ─────────────────────────────────────────────────────

function terminalLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function singleChar(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (buf) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      const ch = buf.toString("utf-8").trim();
      const decoded = ch === "" || ch === "\r" || ch === "\n" ? "" : ch[0].toLowerCase();
      process.stderr.write(decoded + "\n");
      resolve(decoded);
    });
  });
}

// ── selectors ────────────────────────────────────────────────────────

type SetProjectDefault = (id: string, name: string) => void;

export function selectProject(
  projects: any[],
  defaultId: string | null,
  setDefault: SetProjectDefault,
): Promise<{ id: string; name: string }> {
  if (!projects?.length) {
    process.stderr.write("Error: No projects available\n");
    process.exit(1);
  }

  // Auto-select single
  if (projects.length === 1) {
    const id = getItemId(projects[0]);
    const name = getDisplayName(projects[0]);
    process.stderr.write(`Auto-selected project: ${name}\n`);
    setDefault(id, name);
    return Promise.resolve({ id, name });
  }

  // Use default
  if (defaultId) {
    const match = projects.find((p) => getItemId(p) === defaultId);
    if (match) {
      const name = getDisplayName(match);
      process.stderr.write(`Using default project: ${name}\n`);
      return Promise.resolve({ id: defaultId, name });
    }
  }

  return (async () => {
    process.stderr.write("\nPlease choose a project:\n\n");
    for (let i = 0; i < projects.length; i++) {
      const name = getDisplayName(projects[i]);
      const id = getItemId(projects[i]);
      process.stderr.write(` [${i + 1}] ${name}\n`);
      if (id && id !== name) process.stderr.write(`     ${id}\n`);
    }
    process.stderr.write("\n");

    while (true) {
      const choice = await terminalLine("Please enter your numeric choice: ");
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < projects.length) {
        const id = getItemId(projects[idx]);
        const name = getDisplayName(projects[idx]);
        setDefault(id, name);
        process.stderr.write(`Selected: ${name}\n`);
        return { id, name };
      }
      process.stderr.write(`Please enter a number between 1 and ${projects.length}\n`);
    }
  })();
}

type SetAgentDefault = (name: string, settings: any) => void;

export function selectAgent(
  agents: any[],
  defaultName: string | null,
  setDefault: SetAgentDefault,
): Promise<any> {
  if (!agents?.length) {
    process.stderr.write("Error: No agents available\n");
    process.exit(1);
  }

  if (agents.length === 1) {
    const name = getDisplayName(agents[0]);
    process.stderr.write(`Auto-selected agent: ${name}\n`);
    setDefault(name, agents[0]);
    return Promise.resolve(agents[0]);
  }

  if (defaultName) {
    const match = agents.find((a) => defaultName.toLowerCase().includes(getDisplayName(a).toLowerCase()) || getDisplayName(a).toLowerCase().includes(defaultName.toLowerCase()));
    if (match) {
      const name = getDisplayName(match);
      process.stderr.write(`Using default agent: ${name}\n`);
      return Promise.resolve(match);
    }
  }

  return (async () => {
    process.stderr.write("\nPlease choose an agent:\n\n");
    for (let i = 0; i < agents.length; i++) {
      process.stderr.write(` [${i + 1}] ${getDisplayName(agents[i])}\n`);
    }
    process.stderr.write("\n");

    while (true) {
      const choice = await terminalLine("Please enter your numeric choice: ");
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < agents.length) {
        const agent = agents[idx];
        const name = getDisplayName(agent);
        setDefault(name, agent);
        process.stderr.write(`Selected: ${name}\n`);
        return agent;
      }
      process.stderr.write(`Please enter a number between 1 and ${agents.length}\n`);
    }
  })();
}
