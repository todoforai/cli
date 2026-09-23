// Child for test-shutdown: watch a todo against the fake backend until killed.
import { FrontendWebSocket } from "@shared/api";
import { installSignalHandlers } from "../../src/shutdown";
import { watchTodo } from "../../src/watch";

installSignalHandlers();
const ws = new FrontendWebSocket(process.argv[2], "test-key");
await ws.connect();
process.stderr.write("WATCHING\n");
await watchTodo(ws, "todo-1", "proj-1", { exitOnInterrupt: true });
