/** `tfa-cli machine size` — the cloud machine's size and price (sandbox.upgrade). */

import type { ApiClient } from "@shared/api";
import { VM_UPGRADE, billedVmResources, vmUpgradeDailyUsd, vmUpgradeMonthlyUsd, type VmResources } from "@shared/fbe";
import { getEnv } from "./args";
import { singleChar } from "./select";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./colors";

export function printMachineHelp() {
  process.stderr.write(`
tfa-cli machine size — your cloud machine's size and its price

Usage:
  tfa-cli machine size                              current size, what the plan includes, price
  tfa-cli machine size --disk 20 [--memory 4] [--cpus 2]   resize (unset = keep current)
  tfa-cli machine size --plan                       back to the plan's size (stops the charge)
  tfa-cli machine size --for <email> [--disk …]     a member's machine on a workspace you own or admin,
                                                    paid from that workspace's credit

Options:
  --memory GB   ${VM_UPGRADE.MEMORY_GB.join(", ")}
  --cpus N      ${VM_UPGRADE.VCPUS.join(", ")}
  --disk GB     ${VM_UPGRADE.DISK_GB.join(", ")}
  --yes         skip the confirmation
  --reason "…"  agent shell: why, shown on the approval card
  --json        print the state as JSON

Only what is above the plan costs: $${VM_UPGRADE.USD_PER_GB_MONTH}/GB RAM, $${VM_UPGRADE.USD_PER_VCPU_MONTH}/vCPU, $${VM_UPGRADE.USD_PER_10GB_DISK_MONTH}/10 GB disk a month,
charged daily from credit. A resize restarts the machine: files in /root and /home stay.
From an agent shell nothing is applied: an approval card goes to the user, whose click applies it.
`);
}

type Scope = { ownerId?: string; userId?: string };
interface MachineState { plan: VmResources; upgrade: VmResources | null; pendingDisk: { diskGb: number; graceUntil: number } | null; dailyUsd: number; monthlyUsd: number; payerId?: string }

const fmt = (r: VmResources) => `${r.memoryGb} GB RAM · ${r.vcpus} vCPU · ${r.diskGb} GB disk`;
const usd = (n: number) => `$${n.toFixed(2)}`;

function fail(msg: string): never {
  process.stderr.write(`${RED}${msg}${RESET}\n`);
  process.exit(2);
}

/** A dimension's value: the plan's own, or an upgrade option above it (as VmUpgradeService.validate). */
function pick(flag: string, raw: unknown, options: readonly number[], planValue: number, current: number): number {
  if (raw === undefined) return current;
  const v = Number(raw);
  if (v === planValue || (options as readonly number[]).includes(v) && v > planValue) return v;
  fail(`--${flag} ${raw}: choose ${[planValue, ...options.filter((o) => o > planValue)].join(", ")}`);
}

/** `--for <email>`: a member (or the owner) of a workspace the caller owns or admins. */
async function resolveScope(api: ApiClient, who: string | undefined): Promise<Scope> {
  if (!who) return {};
  const q = who.toLowerCase();
  const teams: any[] = await api.getTeams();
  for (const t of teams.filter((t) => t.canManage)) {
    if (t.ownerEmail?.toLowerCase() === q || t.ownerId === who) return { ownerId: t.ownerId, userId: t.ownerId };
    const m = t.members?.find((m: any) => m.email?.toLowerCase() === q || m.id === who);
    if (m) return { ownerId: t.ownerId, userId: m.id };
  }
  fail(`--for ${who}: not a member of a workspace you own or admin`);
}

export async function machineCommand(api: ApiClient, positionals: string[], args: Record<string, any>) {
  const sub = positionals[1] ?? "size";
  if (sub !== "size") { printMachineHelp(); fail(`Unknown 'machine' subcommand: ${sub}`); }
  // An agent shell can't read the roster (billing.* is denied): a teammate's machine is sized on the Team page.
  if (args.for && api.apiKey.startsWith("dst_")) fail("--for isn't available from an agent shell; the owner or an admin sizes a teammate's machine on the Team page (Custom…).");
  const scope = await resolveScope(api, args.for);
  const state: MachineState = await api.getMachineSize(scope);
  const { plan } = state;
  const current = state.upgrade ?? plan;
  const resizing = args.plan || args.memory !== undefined || args.cpus !== undefined || args.disk !== undefined;

  if (!resizing) {
    if (args.json) { console.log(JSON.stringify(state, null, 2)); return; }
    const out = process.stdout;
    out.write(`${BOLD}${fmt(current)}${RESET}${state.upgrade ? "" : `  ${DIM}(plan size)${RESET}`}\n`);
    out.write(`${DIM}plan includes ${fmt(plan)}${RESET}\n`);
    out.write(state.monthlyUsd ? `${usd(state.monthlyUsd)}/mo above the plan (${usd(state.dailyUsd)}/day)${state.payerId && scope.ownerId && state.payerId === scope.ownerId ? ", workspace credit" : ""}\n` : `nothing above the plan\n`);
    if (state.pendingDisk) out.write(`${YELLOW}disk can't shrink below ${state.pendingDisk.diskGb} GB yet (data on it); billed after ${new Date(state.pendingDisk.graceUntil).toLocaleDateString()}${RESET}\n`);
    out.write(`${DIM}max ${VM_UPGRADE.MEMORY_GB.at(-1)} GB RAM · ${VM_UPGRADE.VCPUS.at(-1)} vCPU · ${VM_UPGRADE.DISK_GB.at(-1)} GB disk — tfa-cli machine size --help${RESET}\n`);
    return;
  }

  const target: VmResources = args.plan ? { ...plan } : {
    memoryGb: pick("memory", args.memory, VM_UPGRADE.MEMORY_GB, plan.memoryGb, current.memoryGb),
    vcpus: pick("cpus", args.cpus, VM_UPGRADE.VCPUS, plan.vcpus, current.vcpus),
    diskGb: pick("disk", args.disk, VM_UPGRADE.DISK_GB, plan.diskGb, current.diskGb),
  };
  const resources = vmUpgradeMonthlyUsd(target, plan) === 0 ? null : target;
  // Same size, same payer, nothing pending: nothing to do (a pending disk shrink is retried by applying again).
  const samePayer = !resources || !scope.ownerId || state.payerId === scope.ownerId;
  if (JSON.stringify(resources) === JSON.stringify(state.upgrade) && samePayer && !state.pendingDisk) { process.stderr.write(`Already ${fmt(current)}\n`); return; }
  const billed = billedVmResources(resources, plan, state.pendingDisk, Date.now());
  const monthly = vmUpgradeMonthlyUsd(billed, plan);
  const summary = `${fmt(current)} → ${fmt(target)}: ${monthly ? `${usd(monthly)}/mo (${usd(vmUpgradeDailyUsd(billed, plan))}/day) from ${scope.ownerId ? "the workspace's" : "your"} credit` : "no charge"}`;

  // An agent shell may only propose it: it spends credit and restarts the machine (the server refuses dst_ too).
  if (api.apiKey.startsWith("dst_")) {
    const todoId = getEnv("TODO_ID");
    if (!todoId) fail("An agent shell can't resize the machine and has no todo to ask the user in ($TODOFORAI_TODO_ID).");
    const card = await api.proposeMachineSize(todoId, resources, { ...scope, ...(args.reason && { reason: args.reason }) });
    process.stderr.write(`Approval card posted for the user: ${summary}\nIt applies only when they approve; their answer arrives as their next message. End your turn.\n`);
    if (args.json) console.log(JSON.stringify(card));
    return;
  }

  process.stderr.write(`${summary}\n${YELLOW}The machine restarts: files in /root and /home stay, changes elsewhere are lost.${RESET}\n`);
  if (!args.yes) {
    if (!process.stdin.isTTY) fail("Refusing to resize non-interactively without --yes.");
    if (await singleChar("Resize? [y/N] ") !== "y") { process.stderr.write("Aborted\n"); return; }
  }
  const next: MachineState = await api.setMachineSize(resources, scope);
  if (args.json) { console.log(JSON.stringify(next, null, 2)); return; }
  process.stderr.write(`${GREEN}✅ ${fmt(next.upgrade ?? next.plan)}${next.monthlyUsd ? ` · ${usd(next.monthlyUsd)}/mo` : ""}${RESET}\n`);
}
