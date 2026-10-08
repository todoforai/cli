// Child for test-shutdown: watch a todo against the fake backend until killed.
// argv[3] === "isolated": the run can't outlive the CLI (stopRunOnExit).
import { FrontendWebSocket } from "@shared/api";
import { installSignalHandlers, stopRunOnExit } from "../../src/shutdown";
import { watchTodo } from "../../src/watch";

installSignalHandlers();
if (process.argv[3] === "isolated") stopRunOnExit();
const ws = new FrontendWebSocket(process.argv[2], "test-key");
await ws.connect();
process.stderr.write("WATCHING\n");
await watchTodo(ws, "todo-1", "proj-1", {});
