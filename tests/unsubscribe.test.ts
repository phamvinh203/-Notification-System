// Env phải set TRƯỚC bất kỳ dynamic import nào (config.js đọc env lúc import).
// File này KHÔNG import tĩnh module dự án để giữ đúng thứ tự đó.
process.env.UNSUBSCRIBE_SECRET = 'test-unsub-secret';

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { redisAvailable } from './helpers.js';

const hasRedis = await redisAvailable();

describe.skipIf(!hasRedis)('one-click unsubscribe + biến hệ thống trong body (cần Redis)', () => {
  type QueueMod = typeof import('../src/queue/queue.js');
  type WorkerMod = typeof import('../src/queue/worker.js');
  type AppMod = typeof import('../src/app.js');
  type DbMod = typeof import('../src/db.js');
  type UnsubMod = typeof import('../src/unsubscribe.js');

  const KEY = 'test-secret';
  let app: FastifyInstance;
  let queueMod: QueueMod;
  let workerMod: WorkerMod;
  let db: DbMod;
  let unsub: UnsubMod;

  beforeAll(async () => {
    queueMod = await import('../src/queue/queue.js');
    workerMod = await import('../src/queue/worker.js');
    db = await import('../src/db.js');
    const appMod: AppMod = await import('../src/app.js');
    app = await appMod.buildApp({ apiKey: KEY, logger: false });
    unsub = await import('../src/unsubscribe.js');
  });

  beforeEach(() => db.clearTables());

  afterAll(async () => {
    await app.close();
    await workerMod.worker.close();
    const scheds = await queueMod.notificationQueue.getJobSchedulers();
    for (const s of scheds) await queueMod.notificationQueue.removeJobScheduler(s.key).catch(() => {});
    await queueMod.notificationQueue.obliterate({ force: true }).catch(() => {});
    await queueMod.connection.quit();
  });

  const post = (payload: Record<string, unknown>, key: string | null = KEY) =>
    app.inject({
      method: 'POST', url: '/notifications',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      payload,
    });

  /** GET trang unsubscribe như một browser (Accept: text/html) */
  const visitUnsubscribe = (token: string) =>
    app.inject({
      method: 'GET', url: `/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { accept: 'text/html' },
    });

  const extractToken = (body: string): string => {
    const m = /token=([A-Za-z0-9_.-]+)/.exec(body);
    if (!m) throw new Error(`body không chứa token: ${body}`);
    return m[1];
  };

  /** poll tới khi broadcast chuyển 'dispatched' (fan-out trong worker đã xong) */
  async function waitForBroadcastDispatched(id: string, timeoutMs = 15_000) {
    const start = Date.now();
    for (;;) {
      const b = db.getBroadcast(id);
      if (b?.status === 'dispatched') return b;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout chờ broadcast ${id} dispatched — hiện: ${b?.status ?? 'không có row'}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ===== unit: token ký HMAC =====

  it('token roundtrip: verify trả đúng recipient/channel', () => {
    const token = unsub.createUnsubscribeToken('a@b.c', 'email');
    const payload = unsub.verifyUnsubscribeToken(token);
    expect(payload).toMatchObject({ v: 1, recipient: 'a@b.c', channel: 'email' });
    expect(payload!.topic).toBeUndefined();
  });

  it('token sửa chữ ký hoặc payload → null', () => {
    const token = unsub.createUnsubscribeToken('a@b.c', 'email');
    const [payloadB64, sig] = token.split('.');
    expect(unsub.verifyUnsubscribeToken(`${payloadB64}.${'0'.repeat(sig.length)}`)).toBeNull();
    // sửa payload giữ chữ ký cũ
    const forged = Buffer.from(JSON.stringify({ v: 1, recipient: 'victim@b.c', channel: 'email', exp: Date.now() + 1e9 })).toString('base64url');
    expect(unsub.verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
    expect(unsub.verifyUnsubscribeToken('khong-phai-token')).toBeNull();
  });

  it('token hết hạn → null', () => {
    // tự ký token với exp trong quá khứ bằng đúng secret đã set ở đầu file
    const expired = { v: 1, recipient: 'a@b.c', channel: 'email' as const, iat: 0, exp: Date.now() - 1000 };
    const b = Buffer.from(JSON.stringify(expired)).toString('base64url');
    const sig = createHmac('sha256', 'test-unsub-secret').update(b).digest('hex');
    expect(unsub.verifyUnsubscribeToken(`${b}.${sig}`)).toBeNull();
  });

  it('buildUnsubscribeUrl: URL gốc từ config + token verify được', () => {
    const url = unsub.buildUnsubscribeUrl('a@b.c', 'sms');
    expect(url).toMatch(/^http:\/\/localhost:3000\/unsubscribe\?token=/);
    const payload = unsub.verifyUnsubscribeToken(decodeURIComponent(url.split('token=')[1]));
    expect(payload).toMatchObject({ recipient: 'a@b.c', channel: 'sms' });
  });

  // ===== E2E: biến hệ thống chèn vào body lúc enqueue =====

  it('POST /notifications: {{unsubscribe_url}} và {{recipient}} được thay bằng giá trị thật', async () => {
    const res = await post({ channel: 'push', recipient: 'u1', body: 'Chào {{recipient}} — hủy: {{unsubscribe_url}}' });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };

    const row = db.getNotification(id)!;
    expect(row.notification.body).toContain('Chào u1');
    const token = extractToken(row.notification.body);
    const payload = unsub.verifyUnsubscribeToken(token);
    expect(payload).toMatchObject({ recipient: 'u1', channel: 'push' });
  });

  it('bấm link → tắt kênh (preference), trang HTML xác nhận, bấm lại idempotent', async () => {
    const res = await post({ channel: 'email', recipient: 'u2', body: 'hủy: {{unsubscribe_url}}' });
    const { id } = res.json() as { id: string };
    const token = extractToken(db.getNotification(id)!.notification.body);

    const page = await visitUnsubscribe(token);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Đã hủy nhận tin thành công');
    expect(db.getPreference('u2', 'email')).toEqual({ enabled: false });

    // bấm lại — vẫn 200, thông báo đã hủy từ trước
    const again = await visitUnsubscribe(token);
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain('từ trước');

    // token giả mạo → 400
    const bad = await visitUnsubscribe('fake.token');
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('không hợp lệ');
  });

  // ===== E2E: broadcast render per-recipient, link scope theo topic =====

  it('broadcast: mỗi subscriber nhận link token RIÊNG; hủy = rời topic, không tắt preference', async () => {
    db.subscribeTopic('newsletter', 'r1@x', 'email');
    db.subscribeTopic('newsletter', 'r2@x', 'email');

    const send = await app.inject({
      method: 'POST', url: '/topics/newsletter/send',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      payload: { subject: 'Bản tin', body: 'Chào {{recipient}} — hủy: {{unsubscribe_url}}' },
    });
    expect(send.statusCode).toBe(202);
    const { broadcastId } = send.json() as { broadcastId: string };

    await waitForBroadcastDispatched(broadcastId);
    await queueMod.dispatchPendingOutbox();

    const items = db.listNotifications({ broadcastId }, { limit: 10, offset: 0 });
    expect(items.length).toBe(2);

    // mỗi người một token riêng, đều verify được và scope đúng recipient
    const tokens = items.map((n) => {
      const payload = unsub.verifyUnsubscribeToken(extractToken(n.body));
      expect(payload).toBeTruthy();
      expect(n.body).toContain(`Chào ${payload!.recipient}`);
      return { recipient: payload!.recipient, token: extractToken(n.body), payload: payload! };
    });
    expect(new Set(tokens.map((t) => t.token)).size).toBe(2);
    for (const t of tokens) expect(t.payload.topic).toBe('newsletter');

    // r1 bấm link → rời topic, preference KHÔNG bị tắt
    const page = await visitUnsubscribe(tokens.find((t) => t.recipient === 'r1@x')!.token);
    expect(page.statusCode).toBe(200);
    expect(db.listTopicSubscribers('newsletter').map((s) => s.recipient)).toEqual(['r2@x']);
    expect(db.getPreference('r1@x', 'email')).toBeUndefined();
  });
});
