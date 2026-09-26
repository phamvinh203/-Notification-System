import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Channel } from './db.js';
import { config } from './config.js';

// ===== one-click unsubscribe: link ký HMAC nhúng vào nội dung notification =====
// token = base64url(JSON payload) + '.' + hex(HMAC-SHA256(secret, payload))
// payload: { v, recipient, channel, topic?, iat, exp } — exp mặc định 365 ngày.
// Token rơi vào tay người lạ chỉ tắt được kênh của đúng recipient đó (rủi ro thấp),
// nhưng vẫn có hạn dùng để giới hạn thời gian sống của link trong email cũ.

const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// secret theo thứ tự ưu tiên; random theo process chỉ phù hợp dev (không có .env/auth)
let ephemeralSecret: string | null = null;
function getSecret(): string {
  return (
    config.unsubscribeSecret ??
    config.webhookSigningSecret ??
    config.apiKey ??
    (ephemeralSecret ??= randomBytes(32).toString('hex'))
  );
}

export interface UnsubscribePayload {
  v: number;
  recipient: string;
  channel: Channel;
  /** có → hủy đăng ký khỏi topic (link trong broadcast); không → tắt cả kênh (preference) */
  topic?: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(payloadB64: string): string {
  return createHmac('sha256', getSecret()).update(payloadB64).digest('hex');
}

export function createUnsubscribeToken(
  recipient: string,
  channel: Channel,
  topic?: string,
): string {
  const payload: UnsubscribePayload = {
    v: TOKEN_VERSION,
    recipient,
    channel,
    ...(topic ? { topic } : {}),
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/** Trả payload nếu token hợp lệ (HMAC khớp + chưa hết hạn), ngược lại null */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as UnsubscribePayload;
    if (payload.v !== TOKEN_VERSION) return null; // chặn version lạ
    if (typeof payload.recipient !== 'string' || !payload.recipient) return null;
    if (typeof payload.channel !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** URL unsubscribe chèn vào nội dung — dùng {{unsubscribe_url}} trong body/template */
export function buildUnsubscribeUrl(recipient: string, channel: Channel, topic?: string): string {
  const token = createUnsubscribeToken(recipient, channel, topic);
  return `${config.publicBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}
