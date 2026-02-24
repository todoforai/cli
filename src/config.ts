/** Cross-platform config store — port of todoai_cli/config_store.py */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir, platform } from "os";

function getConfigDir(): string {
  const sys = platform();
  if (sys === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, "todoai-cli");
  }
  if (sys === "darwin") {
    return join(homedir(), "Library", "Application Support", "todoai-cli");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "todoai-cli");
}

function obfuscate(s: string): string {
  return s ? Buffer.from(s, "utf-8").toString("base64") : s;
}

function deobfuscate(s: string): string {
  if (!s) return s;
  try {
    return Buffer.from(s, "base64").toString("utf-8");
  } catch {
    return s;
  }
}

export interface ConfigData {
  default_project_id: string | null;
  default_project_name: string | null;
  default_agent_name: string | null;
  default_agent_settings: any | null;
  default_agent_settings_updated_at: string | null;
  default_api_url: string | null;
  default_api_key: string | null;
  recent_projects: { id: string; name: string }[];
  recent_agents: string[];
  last_todo_id: string | null;
}

function defaultConfig(): ConfigData {
  return {
    default_project_id: null,
    default_project_name: null,
    default_agent_name: null,
    default_agent_settings: null,
    default_agent_settings_updated_at: null,
    default_api_url: null,
    default_api_key: null,
    recent_projects: [],
    recent_agents: [],
    last_todo_id: null,
  };
}

export class ConfigStore {
  path: string;
  data: ConfigData;

  constructor(pathArg?: string) {
    if (pathArg) {
      const p = resolve(pathArg.replace(/^~/, homedir()));
      this.path = p.endsWith(".json") ? p : join(p, "config.json");
    } else {
      this.path = join(getConfigDir(), "config.json");
    }
    this.data = this.load();
  }

  private load(): ConfigData {
    if (!existsSync(this.path)) return defaultConfig();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"));
      if (raw.default_api_key) raw.default_api_key = deobfuscate(raw.default_api_key);
      return { ...defaultConfig(), ...raw };
    } catch {
      return defaultConfig();
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const out = { ...this.data };
      if (out.default_api_key) (out as any).default_api_key = obfuscate(out.default_api_key);
      writeFileSync(this.path, JSON.stringify(out, null, 2), "utf-8");
    } catch {}
  }

  setDefaultProject(id: string, name?: string): void {
    this.data.default_project_id = id;
    this.data.default_project_name = name || id;
    const recent = this.data.recent_projects.filter((p) => p.id !== id);
    recent.unshift({ id, name: name || id });
    this.data.recent_projects = recent.slice(0, 10);
    this.save();
  }

  setDefaultAgent(name: string, settings?: any): void {
    this.data.default_agent_name = name;
    this.data.default_agent_settings = settings || null;
    this.data.default_agent_settings_updated_at = new Date().toISOString();
    const recent = this.data.recent_agents.filter((a) => a !== name);
    recent.unshift(name);
    this.data.recent_agents = recent.slice(0, 10);
    this.save();
  }

  setDefaultApiUrl(url: string): void {
    this.data.default_api_url = url;
    this.save();
  }

  setDefaultApiKey(key: string): void {
    this.data.default_api_key = key;
    this.save();
  }
}
