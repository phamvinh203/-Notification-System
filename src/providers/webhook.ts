import type { NotificationProvider, SendRequest } from './types.js';

// webhook là provider "thật" đầu tiên: POST JSON tới URL trong recipient
export const webhookProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    const res = await fetch(req.to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: req.subject, body: req.body }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`[webhook] receiver trả ${res.status} cho ${req.to}`);
    }
  },
};
