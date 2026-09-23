/** Killing the CLI must stop its todo server-side; a dropped socket must resume. */
import { test, expect } from "bun:test";
import { spawn } from "child_process";
import { resolve } from "path";
import { FrontendWebSocket } from "@shared/api";
import { fakeBackend } from "./fixtures/fake-backend";
import { watchTodo, resubscribe } from "../src/watch";

async function killedWith(sig: NodeJS.Signals, code: number, twice = false) {
  const be = fakeBackend();
  const url = await be.listen();
  const child = spawn("bun", [resolve(import.meta.dir, "fixtures/watch-child.ts"), url], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr!.on("data", (d) => { if (String(d).includes("WATCHING")) r(); }));
  await new Promise((r) => setTimeout(r, 300)); // let subscribe land
  child.kill(sig);
  if (twice) child.kill(sig);
  const exit = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  await new Promise((r) => setTimeout(r, 100));
  expect(exit).toBe(code);
  expect(be.frames.filter((f) => f.type === "todo:interrupt_signal")).toEqual([{ type: "todo:interrupt_signal", payload: { projectId: "proj-1", todoId: "todo-1" } }]);
  await be.close();
}

test("SIGTERM stops the todo and exits 143", () => killedWith("SIGTERM", 143), 15_000);
test("SIGINT stops the todo and exits 130", () => killedWith("SIGINT", 130), 15_000);
test("SIGHUP stops the todo and exits 129", () => killedWith("SIGHUP", 129), 15_000);
test("double SIGTERM still stops the todo exactly once", async () => {
  await killedWith("SIGTERM", 143, true);
}, 15_000);

test("dropped socket reconnects and still sees completion", async () => {
  const be = fakeBackend();
  const url = await be.listen();
  const ws = new FrontendWebSocket(url, "test-key");
  await ws.connect();
  const done = watchTodo(ws, "todo-1", "proj-1", {});
  await new Promise((r) => setTimeout(r, 300));
  be.setStatus("READY");   // finished while we were disconnected
  be.dropAll();
  expect(await done).toBe(true);
  expect(process.exitCode).toBe(0);
  await ws.close();
  await be.close();
}, 15_000);

test("resubscribe gives up when the backend stays down", async () => {
  const ws = new FrontendWebSocket("http://127.0.0.1:9", "test-key"); // nothing listens on :9
  const t0 = Date.now();
  expect(await resubscribe(ws, "todo-1", () => {}, 2_000)).toBe(false);
  expect(Date.now() - t0).toBeLessThan(5_000);
}, 10_000);
