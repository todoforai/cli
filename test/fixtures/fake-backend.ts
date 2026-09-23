/** Minimal stand-in for the backend's frontend socket + subscribe endpoint. */
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "http";

export function fakeBackend(port = 0) {
  const frames: any[] = [];
  const sockets = new Set<WebSocket>();
  let status = "RUNNING";
  const http: Server = createServer((req, res) => {
    if (req.method === "POST" && /\/api\/v1\/todos\/[^/]+\/subscribe$/.test(req.url || "")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, handleProtocols: (p) => [...p][0] });
  wss.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("message", (d) => frames.push(JSON.parse(d.toString())));
  });
  return {
    frames,
    setStatus: (s: string) => { status = s; },
    broadcast: (m: any) => sockets.forEach((s) => s.send(JSON.stringify(m))),
    dropAll: () => sockets.forEach((s) => s.terminate()),
    listen: () => new Promise<string>((r) => http.listen(port, "127.0.0.1", () => r(`http://127.0.0.1:${(http.address() as any).port}`))),
    close: () => new Promise<void>((r) => { sockets.forEach((s) => s.terminate()); wss.close(); http.closeAllConnections(); http.close(() => r()); }),
  };
}
