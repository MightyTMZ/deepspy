// Owner: Fahad. Layer 4: tell a human a wall needs them. Test: C18.
// Channels: the SSE handoff event (written by handoff.ts), a desktop notification, an optional webhook.
// Repeats every two minutes until the handoff is resumed or abandoned.

import { exec } from "node:child_process";
import type { HandoffEvent, WallDetected } from "@periscope/contracts";

export interface NotifierOptions {
  webhookUrl?: string;
  repeatMs?: number;                 // default 2 minutes
  desktop?: boolean;                 // default true
  fetchImpl?: typeof fetch;
}

export class Notifier {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: NotifierOptions = {}) {}

  async notify(evt: HandoffEvent, wall: WallDetected): Promise<void> {
    await this.send(evt, wall);
    const t = setInterval(() => void this.send(evt, wall), this.opts.repeatMs ?? 2 * 60 * 1000);
    this.timers.set(evt.jobId, t);
  }

  stop(jobId: string): void {
    const t = this.timers.get(jobId);
    if (t) clearInterval(t);
    this.timers.delete(jobId);
  }

  private async send(evt: HandoffEvent, wall: WallDetected): Promise<void> {
    const title = `Periscope needs you: ${evt.wall} on job ${evt.jobId}`;
    const body = `Open the live view and resolve it, then resume. ${evt.viewerUrl}`;
    if (this.opts.desktop !== false) desktopNotify(title, body);
    if (this.opts.webhookUrl) {
      const f = this.opts.fetchImpl ?? fetch;
      await f(this.opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${title}\n${body}`, jobId: evt.jobId, wall: evt.wall, viewerUrl: evt.viewerUrl, screenshotPath: wall.screenshotPath, generation: evt.generation }),
      }).catch(() => undefined);
    }
  }
}

function desktopNotify(title: string, body: string): void {
  const q = (s: string) => s.replace(/"/g, '\\"');
  if (process.platform === "win32") {
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
      `$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
      `$n = $t.GetElementsByTagName('text'); $n.Item(0).AppendChild($t.CreateTextNode('${title.replace(/'/g, "''")}')) | Out-Null; ` +
      `$n.Item(1).AppendChild($t.CreateTextNode('${body.replace(/'/g, "''")}')) | Out-Null; ` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Periscope').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    exec(`powershell -NoProfile -Command "${q(ps)}"`, () => undefined);
  } else if (process.platform === "darwin") {
    exec(`osascript -e 'display notification "${q(body)}" with title "${q(title)}"'`, () => undefined);
  } else {
    exec(`notify-send "${q(title)}" "${q(body)}"`, () => undefined);
  }
}
