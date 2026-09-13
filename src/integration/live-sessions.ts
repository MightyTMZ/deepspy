// Which run owns which live Steel session, for the frontend's live view. The pool knows the sessions; this maps them
// to runs and competitors so judges can watch each agent with a caption. Never exposes the CDP url.
import type { LeaseRequest, SessionHandle } from "@periscope/contracts";
import type { LiveSession } from "../steel/pool.js";

export interface LiveSessionView extends LiveSession {
  runId?: string;
  competitor?: string;
  /** Steel's embeddable WebRTC player for the session (no auth needed, verified Sept 13). */
  playerUrl: string;
}

export class LiveSessions {
  private readonly owners = new Map<string, { runId: string; competitor?: string }>();

  /** Wrap a segment's acquireSession so every lease is attributed to a run until it is released. */
  wrap(runId: string, competitor: string | undefined, acquire: (req: LeaseRequest) => Promise<SessionHandle>): (req: LeaseRequest) => Promise<SessionHandle> {
    return async (req) => {
      const handle = await acquire(req);
      this.owners.set(handle.sessionId, { runId, competitor });
      const release = handle.release.bind(handle);
      handle.release = async () => { this.owners.delete(handle.sessionId); await release(); };
      return handle;
    };
  }

  /** Join the pool's live sessions with their owners. */
  view(active: LiveSession[], runId?: string): LiveSessionView[] {
    return active
      .map((s) => ({ ...s, ...this.owners.get(s.sessionId), playerUrl: playerUrlFor(s.sessionId) }))
      .filter((s) => !runId || s.runId === runId);
  }
}

export function playerUrlFor(sessionId: string): string {
  return `https://api.steel.dev/v1/sessions/${sessionId}/player`;
}
