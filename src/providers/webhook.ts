import { createHmac } from 'node:crypto';
import type { NotificationProvider, SendRequest } from './types.js';
import { config } from '../config.js';

/**
 * Ký payload webhook kiểu Stripe: HMAC-SHA256 của `<timestamp>.<raw body>`, hex.
 * Receiver kiểm chứng: parse header `t=<unix>,v1=<hex>`, tính HMAC của `${t}.${rawBody}`
 * với secret của mình và so khớp (constant-time); timestamp quá cũ (>5 phút) nên từ chối
 * để chống replay. Export riêng để test/receiver tính lại không phụ thuộc provider.
 */
export function signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// webhook POST JSON tới URL trong recipient — có secret thì kèm chữ ký HMAC
export const webhookProvider: NotificationProvider = {
  async send(req: SendRequest) {
    const rawBody = JSON.stringify({ subject: req.subject, body: req.body });
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    let info: string | undefined;
    if (config.webhookSigningSecret) {
      const t = Math.floor(Date.now() / 1000);
      const sig = signWebhookPayload(config.webhookSigningSecret, t, rawBody);
      headers['x-notification-signature'] = `t=${t},v1=${sig}`;
      info = 'signed (HMAC v1)';
    }

    const res = await fetch(req.to, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`[webhook] receiver trả ${res.status} cho ${req.to}`);
    }
    return info ? { info } : undefined;
  },
};
