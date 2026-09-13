// Minimal human-in-the-loop endpoint so a handoff can be resumed before Ayaan's full API lands.
// No dependencies. Ayaan's api.ts should replace this by forwarding POST /jobs/:id/resume to the same segment.resume.
//
//   GET  /handoffs                -> pending handoffs [{ jobId, wall, viewerUrl, generation }]
//   POST /jobs/:id/resume         -> body { "generation": n } ; { ok: true } or { ok: false, reason }
//   GET  /health

import http from "node:http";
import type { HandoffEvent } from "@periscope/contracts";
import type { SteelSegment } from "../steel/segment.js";

export interface ResumeServerOptions { port?: number; segment: SteelSegment; }

export function startResumeServer(opts: ResumeServerOptions): { close(): void; port: number; recordHandoff(evt: HandoffEvent): void } {
  const pending = new Map<string, HandoffEvent>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/handoffs") return send(200, [...pending.values()].filter((h) => h.state === "awaiting_human"));
    const m = url.pathname.match(/^\/jobs\/([^/]+)\/resume$/);
    if (req.method === "POST" && m) {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        try {
          const body = raw ? (JSON.parse(raw) as { generation?: number }) : {};
          const jobId = decodeURIComponent(m[1]);
          const generation = body.generation ?? pending.get(jobId)?.generation ?? 0;
          const r = await opts.segment.resume(jobId, generation);
          if (r.ok) pending.delete(jobId);
          send(r.ok ? 200 : 409, r);
        } catch (e) { send(400, { ok: false, reason: (e as Error).message }); }
      });
      return;
    }
    send(404, { ok: false, reason: "not found" });
  });
  const port = opts.port ?? Number(process.env.PERISCOPE_RESUME_PORT ?? 4747);
  // A second run on the same machine must not die because the first one holds the port: warn and run without the endpoint.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.warn(`[resume] port ${port} is in use (another run?); resume endpoint disabled for this run, set PERISCOPE_RESUME_PORT to change it`);
    else console.warn(`[resume] endpoint error: ${err.message}`);
  });
  server.listen(port);
  return {
    port,
    close: () => server.close(),
    recordHandoff: (evt) => { if (evt.state === "awaiting_human") pending.set(evt.jobId, evt); else pending.delete(evt.jobId); },
  };
}
