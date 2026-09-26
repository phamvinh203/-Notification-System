import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { clearTables, createNotification, getNotification } from '../src/db.js';
import { redisAvailable } from './helpers.js';

const hasRedis = await redisAvailable();

// import động trong beforeAll — khi Redis không có thì skip mà không để connection treo
type QueueMod = typeof import('../src/queue/queue.js');
type AppMod = typeof import('../src/app.js');

describe.skipIf(!hasRedis)('API integration (cần Redis)', () => {
  const KEY = 'test-secret';
  let app: FastifyInstance;
  let queueMod: QueueMod;

  beforeAll(async () => {
    queueMod = await import('../src/queue/queue.js');
    const appMod: AppMod = await import('../src/app.js');
    app = await appMod.buildApp({ apiKey: KEY, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await queueMod.notificationQueue.obliterate({ force: true }).catch(() => {});
  });

  beforeEach(() => clearTables());

  const post = (payload: Record<string, unknown>, key: string | null = KEY, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/notifications',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...extra },
      payload,
    });
  const get = (url: string, key: string | null = KEY) =>
    app.inject({ method: 'GET', url, headers: key ? { 'x-api-key': key } : {} });
  const del = (url: string, key: string | null = KEY) =>
    app.inject({ method: 'DELETE', url, headers: key ? { 'x-api-key': key } : {} });

  it('POST body thiếu trường → 400', async () => {
    const res = await post({ channel: 'email' });
    expect(res.statusCode).toBe(400);
  });

  it('POST channel lạ → 400', async () => {
    const res = await post({ channel: 'fax', recipient: 'a@b.c', body: 'hi' });
    expect(res.statusCode).toBe(400);
  });

  it('POST hợp lệ → 202 queued, row có trong DB, có event enqueued', async () => {
    const res = await post({ channel: 'email', recipient: 'a@b.c', subject: 'S', body: 'hello' });
    expect(res.statusCode).toBe(202);
    const { id, status } = res.json() as { id: string; status: string };
    expect(status).toBe('queued');
    const row = getNotification(id);
    expect(row).toBeDefined();
    expect(row!.events[0]!.event).toBe('enqueued');
  });

  it('POST có sendAt tương lai → 202 scheduled', async () => {
    const res = await post({
      channel: 'sms',
      recipient: '+84901234567',
      body: 'x',
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('scheduled');
  });

  it('GET /notifications trả envelope phân trang {items,total,limit,offset}', async () => {
    for (let i = 0; i < 5; i++) {
      createNotification({ id: `seed-${i}`, channel: 'email', recipient: 'r', body: 'b', status: 'queued', scheduled_at: null });
    }
    const res = await get('/notifications?limit=2&offset=1');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it('GET /notifications limit=0 → 400 (limit phải 1..100)', async () => {
    const res = await get('/notifications?limit=0');
    expect(res.statusCode).toBe(400);
  });

  it('GET /notifications/:id lạ → 404', async () => {
    const res = await get('/notifications/nope');
    expect(res.statusCode).toBe(404);
  });

  it('DELETE scheduled → cancelled và job bị remove khỏi queue', async () => {
    const created = (await (
      await post({ channel: 'email', recipient: 'a@b.c', body: 'x', sendAt: new Date(Date.now() + 60_000).toISOString() })
    ).json()) as { id: string };
    const delRes = await del(`/notifications/${created.id}`);
    expect(delRes.statusCode).toBe(200);
    expect((delRes.json() as { status: string }).status).toBe('cancelled');
    expect(getNotification(created.id)!.notification.status).toBe('cancelled');
    expect(await queueMod.notificationQueue.getJob(created.id)).toBeFalsy();
  });

  it('DELETE notification đã gửi → 409', async () => {
    createNotification({ id: 'sent-1', channel: 'email', recipient: 'r', body: 'b', status: 'sent', scheduled_at: null });
    const res = await del('/notifications/sent-1');
    expect(res.statusCode).toBe(409);
  });

  it('DELETE id lạ → 404', async () => {
    const res = await del('/notifications/nope');
    expect(res.statusCode).toBe(404);
  });

  describe('metrics', () => {
    it('GET /metrics có key → 200 Prometheus text, chứa gauge của hệ thống', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-api-key': KEY } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('notifications_by_status');
      expect(res.body).toContain('bullmq_jobs');
    });

    it('GET /metrics là đọc mở — không cần key', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('auth API key', () => {
    it('thiếu key → 401', async () => {
      const res = await post({ channel: 'email', recipient: 'a@b.c', body: 'x' }, null);
      expect(res.statusCode).toBe(401);
    });

    it('sai key → 401', async () => {
      const res = await post({ channel: 'email', recipient: 'a@b.c', body: 'x' }, 'wrong-key');
      expect(res.statusCode).toBe(401);
    });

    it('DELETE và replay là thao tác ghi → thiếu key vẫn 401', async () => {
      const delRes = await del('/notifications/anything', null);
      expect(delRes.statusCode).toBe(401);
      const replayRes = await app.inject({ method: 'POST', url: '/notifications/anything/replay' });
      expect(replayRes.statusCode).toBe(401);
    });

    it('GET danh sách là đọc mở — không cần key (chính sách reads-open)', async () => {
      const res = await get('/notifications', null);
      expect(res.statusCode).toBe(200);
    });

    it('/health luôn mở, không cần key', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('Bull Board /admin/queues cũng bị chặn khi thiếu key', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/queues' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('idempotency key', () => {
    it('POST 2 lần cùng Idempotency-Key → cùng id, deduplicated=true, không tạo row mới', async () => {
      const payload = { channel: 'email', recipient: 'idem@example.com', body: 'x' };
      const first = await (await post(payload, KEY, { 'idempotency-key': 'idem-1' })).json();
      expect(first.deduplicated).toBeUndefined();
      expect(first.status).toBe('queued');

      const second = await (await post(payload, KEY, { 'idempotency-key': 'idem-1' })).json();
      expect(second.id).toBe(first.id);
      expect(second.deduplicated).toBe(true);

      // key khác → notification mới
      const third = await (await post(payload, KEY, { 'idempotency-key': 'idem-2' })).json();
      expect(third.id).not.toBe(first.id);
      expect(third.deduplicated).toBeUndefined();
    });

    it('không key → hoạt động như bình thường (202)', async () => {
      const res = await post({ channel: 'email', recipient: 'nokey@example.com', body: 'x' });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('template engine', () => {
    it('POST template + params → body được render', async () => {
      const created = (await (
        await post({ channel: 'sms', recipient: '+8490', template: 'otp', params: { code: '246810', minutes: 5 } })
      ).json()) as { id: string };
      const detail = await get(`/notifications/${created.id}`);
      const body = (detail.json() as { notification: { body: string } }).notification.body;
      expect(body).toContain('246810');
      expect(body).toContain('5 phut');
    });

    it('template không tồn tại → 400', async () => {
      const res = await post({ channel: 'email', recipient: 'a@b.c', template: 'khong-ton-tai' });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('không tồn tại');
    });

    it('gửi cả body và template (hoặc không cái nào) → 400', async () => {
      const both = await post({ channel: 'email', recipient: 'a@b.c', body: 'b', template: 'otp' });
      expect(both.statusCode).toBe(400);
      const neither = await post({ channel: 'email', recipient: 'a@b.c' });
      expect(neither.statusCode).toBe(400);
    });

    it('GET /templates liệt kê template khả dụng', async () => {
      const res = await get('/templates');
      expect(res.statusCode).toBe(200);
      const names = (res.json() as { templates: string[] }).templates;
      expect(names).toContain('otp');
      expect(names).toContain('welcome');
    });
  });

  describe('channel webhook', () => {
    it('recipient không phải URL → 400', async () => {
      const res = await post({ channel: 'webhook', recipient: 'khong-phai-url', body: 'x' });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('URL http(s)');
    });

    it('recipient là URL hợp lệ → 202 queued', async () => {
      const res = await post({ channel: 'webhook', recipient: 'https://example.com/hook', body: 'x' });
      expect(res.statusCode).toBe(202);
      expect((res.json() as { status: string }).status).toBe('queued');
    });
  });

  describe('replay job dead', () => {
    it('replay notification không phải failed → 409', async () => {
      createNotification({ id: 'sent-r', channel: 'email', recipient: 'r', body: 'b', status: 'sent', scheduled_at: null });
      const res = await app.inject({ method: 'POST', url: '/notifications/sent-r/replay', headers: { 'x-api-key': KEY } });
      expect(res.statusCode).toBe(409);
    });

    it('replay id lạ → 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/notifications/nope/replay', headers: { 'x-api-key': KEY } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('rate limit theo recipient', () => {
    it('vượt RATE_LIMIT_PER_MINUTE (default 10) → 429', async () => {
      const recipient = 'rl-test@example.com';
      for (let i = 0; i < 10; i++) {
        const res = await post({ channel: 'email', recipient, body: `x${i}` });
        expect(res.statusCode).toBe(202);
      }
      const over = await post({ channel: 'email', recipient, body: 'vượt limit' });
      expect(over.statusCode).toBe(429);
      // recipient khác thì vẫn bình thường
      const other = await post({ channel: 'email', recipient: 'rl-other@example.com', body: 'x' });
      expect(other.statusCode).toBe(202);
    }, 30_000);
  });
});
