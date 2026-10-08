/** Killing the CLI detaches (todo keeps running, resume hint); a dropped socket must resume. */
import { test, expect } from "bun:test";
import { spawn } from "child_process";
import { resolve } from "path";
import { FrontendWebSocket } from "@shared/api";
import { fakeBackend } from "./fixtures/fake-backend";
import { watchTodo, resubscribe } from "../src/watch";

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  test(`${sig} detaches (todo keeps running) and exits ${code}`, async () => {
    const be = fakeBackend();
    const url = await be.listen();
    const child = spawn("bun", [resolve(import.meta.dir, "fixtures", "watch-child.ts"), url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    await new Promise<void>((r) => child.stderr!.on("data", (d) => { err += d; if (String(d).includes("WATCHING")) r(); }));
    await new Promise((r) => setTimeout(r, 300)); // let subscribe land
    child.kill(sig);
    expect(await new Promise<number | null>((r) => child.on("exit", (c) => r(c)))).toBe(code);
    expect(err).toContain("tfa-cli --resume todo-1");
    expect(be.frames.some((f) => f.type === "todo:interrupt_signal")).toBe(false);
    await be.close();
  }, 15_000);
}

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
