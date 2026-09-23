// Child for test-shutdown: a signal arrives while the todo is still being created
// and main() finishes right after — the stop must still go out, with the signal's code.
import { FrontendWebSocket } from "@shared/api";
import { installSignalHandlers, trackStart, finish } from "../../src/shutdown";

installSignalHandlers();
const ws = new FrontendWebSocket(process.argv[2], "test-key");
await ws.connect();
trackStart(ws, "proj-1", new Promise((r) => setTimeout(() => r("todo-1"), 500))); // addMessage in flight
process.stderr.write("CREATING\n");
await new Promise((r) => process.once("SIGTERM", r));
finish(0); // main() settling mid-shutdown must not pre-empt it
