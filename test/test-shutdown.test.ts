/** Killing the CLI detaches (todo keeps running), except --isolated runs, which
 *  it must stop server-side; a dropped socket must resume. */
import { test, expect } from "bun:test";
import { spawn } from "child_process";
import { resolve } from "path";
import { FrontendWebSocket } from "@shared/api";
import { fakeBackend } from "./fixtures/fake-backend";
import { watchTodo, resubscribe } from "../src/watch";

async function killedWith(sig: NodeJS.Signals, code: number, twice = false, child_ = "watch-child.ts", ready = "WATCHING", mode = "isolated") {
  const be = fakeBackend();
  const url = await be.listen();
  const child = spawn("bun", [resolve(import.meta.dir, "fixtures", child_), url, mode], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  await new Promise<void>((r) => child.stderr!.on("data", (d) => { err += d; if (String(d).includes(ready)) r(); }));
  if (ready === "WATCHING") await new Promise((r) => setTimeout(r, 300)); // let subscribe land
  child.kill(sig);
  if (twice) child.kill(sig);
  const exit = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  await new Promise((r) => setTimeout(r, 100));
  expect(exit).toBe(code);
  const stops = be.frames.filter((f) => f.type === "todo:interrupt_signal");
  expect(stops).toEqual(mode === "isolated" ? [{ type: "todo:interrupt_signal", payload: { projectId: "proj-1", todoId: "todo-1" } }] : []);
  if (mode !== "isolated") expect(err).toContain("tfa-cli --resume todo-1");
  await be.close();
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  test(`${sig} detaches (todo keeps running) and exits ${code}`, () => killedWith(sig, code, false, "watch-child.ts", "WATCHING", "detach"), 15_000);
  test(`--isolated: ${sig} stops the todo and exits ${code}`, () => killedWith(sig, code), 15_000);
}
test("--isolated: double SIGTERM still stops the todo exactly once", async () => {
  await killedWith("SIGTERM", 143, true);
}, 15_000);

test("--isolated: signal mid-create: waits for the todo, stops it, keeps the signal's exit code", async () => {
  await killedWith("SIGTERM", 143, false, "exit-race-child.ts", "CREATING");
}, 15_000);
test("signal mid-create detaches with the resume hint", async () => {
  await killedWith("SIGTERM", 143, false, "exit-race-child.ts", "CREATING", "detach");
}, 15_000);

test("failed initial subscribe goes through the reconnect window", async () => {
  const be = fakeBackend();
  const url = await be.listen();
  const ws = new FrontendWebSocket(url, "test-key");
  await ws.connect();
  be.failSubscribes(2);
  be.setStatus("READY");
  expect(await watchTodo(ws, "todo-1", "proj-1", {})).toBe(true);
  expect(process.exitCode).toBe(0);
  expect(be.frames.some((f) => f.type === "todo:interrupt_signal")).toBe(false);
  await ws.close();
  await be.close();
}, 15_000);

test("resubscribe deadline cuts a hanging subscribe", async () => {
  const be = fakeBackend();
  const url = await be.listen();
  be.hangSubscribes();
  const ws = new FrontendWebSocket(url, "test-key");
  const t0 = Date.now();
  expect(await resubscribe(ws, "todo-1", () => {}, 2_000)).toBe(false);
  expect(Date.now() - t0).toBeLessThan(2_500); // subscribe alone would wait 15s
  await ws.close();
  await be.close();
}, 10_000);

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
