import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  clearTables, createNotification, getBroadcast, getNotification,
  getPreference, listNotifications, setPreference,
} from '../src/db.js';
import { broadcastNotificationId } from '../src/queue/queue.js';
import { redisAvailable, waitForEvent, waitForStatus } from './helpers.js';

const hasRedis = await redisAvailable();

// Mock providers — điều khiển DETERMINISTIC: đếm số lần gửi, ép fail khi cần
const providerState = vi.hoisted(() => ({ sendCalls: 0, failTimes: 0 }));
vi.mock('../src/providers/index.js', () => ({
  providers: {
    email: {
      send: async () => {
        providerState.sendCalls++;
        if (providerState.failTimes > 0) {
          providerState.failTimes--;
          throw new Error('mock:email fail (giả lập)');
        }
      },
    },
    push: { send: async () => {} },
    sms: { send: async () => {} },
  },
}));

// Topics + broadcast + preferences + recurring (cần Redis)
describe.skipIf(!hasRedis)('topics/broadcast/preferences/recurring (cần Redis)', () => {
  type QueueMod = typeof import('../src/queue/queue.js');
  type WorkerMod = typeof import('../src/queue/worker.js');
  type AppMod = typeof import('../src/app.js');

  const KEY = 'test-secret';
  let app: FastifyInstance;
  let queueMod: QueueMod;
  let workerMod: WorkerMod;

  beforeAll(async () => {
    queueMod = await import('../src/queue/queue.js');
    workerMod = await import('../src/queue/worker.js');
    const appMod: AppMod = await import('../src/app.js');
    app = await appMod.buildApp({ apiKey: KEY, logger: false });
  });

  beforeEach(() => {
    clearTables();
    providerState.sendCalls = 0;
    providerState.failTimes = 0;
  });

  afterAll(async () => {
    await app.close();
    await workerMod.worker.close();
    // dọn job scheduler (recurring) còn sót trước khi obliterate
    const scheds = await queueMod.notificationQueue.getJobSchedulers();
    for (const s of scheds) await queueMod.notificationQueue.removeJobScheduler(s.key).catch(() => {});
    await queueMod.notificationQueue.obliterate({ force: true }).catch(() => {});
    await queueMod.connection.quit();
  });

  const post = (url: string, payload: Record<string, unknown>, key: string | null = KEY) =>
    app.inject({
      method: 'POST', url,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      payload,
    });
  const put = (url: string, payload: Record<string, unknown>, key: string | null = KEY) =>
    app.inject({
      method: 'PUT', url,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      payload,
    });
  const del = (url: string, key: string | null = KEY) =>
    app.inject({ method: 'DELETE', url, headers: key ? { 'x-api-key': key } : {} });
  const get = (url: string) => app.inject({ method: 'GET', url });

  /** poll tới khi broadcast chuyển 'dispatched' (fan-out trong worker đã xong) */
  async function waitForBroadcastDispatched(id: string, timeoutMs = 15_000) {
    const start = Date.now();
    for (;;) {
      const b = getBroadcast(id);
      if (b?.status === 'dispatched') return b;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout chờ broadcast ${id} dispatched — hiện: ${b?.status ?? 'không có row'}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ===== topics API =====

  it('subscribe → 201 created, subscribe lại → 200 idempotent, list topic đúng', async () => {
    const first = await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { created: boolean }).created).toBe(true);

    const again = await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { created: boolean }).created).toBe(false);

    const subs = await get('/topics/news/subscribers');
    expect(subs.json() as object).toEqual({
      topic: 'news',
      subscribers: [{ recipient: 'a@b.c', channel: 'email' }],
    });

    const topics = await get('/topics');
    expect(topics.json() as object).toEqual({ topics: [{ topic: 'news', subscribers: 1 }] });
  });

  it('DELETE subscriber đúng cách → removed; lặp lại → 404', async () => {
    await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    const ok = await app.inject({
      method: 'DELETE', url: '/topics/news/subscribers',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      payload: { recipient: 'a@b.c', channel: 'email' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { removed: boolean }).removed).toBe(true);

    const repeat = await app.inject({
      method: 'DELETE', url: '/topics/news/subscribers',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      payload: { recipient: 'a@b.c', channel: 'email' },
    });
    expect(repeat.statusCode).toBe(404);
  });

  it('write không có api key → 401 (POST subscribe, PUT preference)', async () => {
    expect((await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' }, null)).statusCode).toBe(401);
    expect((await put('/preferences/a@b.c', { channel: 'email', enabled: false }, null)).statusCode).toBe(401);
  });

  // ===== preferences API =====

  it('PUT preference tắt/bật kênh → GET phản ánh đúng', async () => {
    const off = await put('/preferences/a@b.c', { channel: 'email', enabled: false });
    expect(off.statusCode).toBe(200);
    expect(getPreference('a@b.c', 'email')).toEqual({ enabled: false });

    const list = await get('/preferences/a@b.c');
    expect((list.json() as { preferences: Array<{ channel: string; enabled: boolean }> }).preferences)
      .toEqual([{ channel: 'email', enabled: false, updated_at: expect.any(String) }]);

    const on = await put('/preferences/a@b.c', { channel: 'email', enabled: true });
    expect(on.statusCode).toBe(200);
    expect(getPreference('a@b.c', 'email')).toEqual({ enabled: true });
  });

  it('PUT preference channel lạ → 400', async () => {
    expect((await put('/preferences/a@b.c', { channel: 'fax', enabled: false })).statusCode).toBe(400);
  });

  // ===== broadcast fan-out E2E =====

  it('broadcast: 1 request → fan-out N notification, id deterministic, counts đúng', async () => {
    await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    await post('/topics/news/subscribers', { recipient: 'd@e.f', channel: 'email' });

    const send = await post('/topics/news/send', { subject: 'Tin nóng', body: 'chào cả nhà' });
    expect(send.statusCode).toBe(202);
    const { broadcastId, subscribers } = send.json() as { broadcastId: string; subscribers: number };
    expect(subscribers).toBe(2);

    // worker nhận job 'broadcast' → fan-out qua outbox → dispatcher đẩy job send → provider gửi
    const b = await waitForBroadcastDispatched(broadcastId);
    expect(b.total).toBe(2);

    await queueMod.dispatchPendingOutbox();
    const items = listNotifications({ broadcastId }, { limit: 100, offset: 0 });
    expect(items.length).toBe(2);
    for (const n of items) {
      expect(n.id).toBe(broadcastNotificationId(broadcastId, n.recipient, n.channel));
      await waitForStatus(n.id, ['sent']);
    }

    const done = getBroadcast(broadcastId)!;
    expect(done.created).toBe(2);
    expect(done.sent).toBe(2);
    expect(done.pending).toBe(0);
    expect(providerState.sendCalls).toBe(2);

    // GET /notifications?broadcast= lọc theo broadcast
    const res = await get(`/notifications?broadcast=${broadcastId}`);
    expect((res.json() as { total: number }).total).toBe(2);
  });

  it('broadcast khi topic chưa có subscriber → 404', async () => {
    const res = await post('/topics/empty/send', { body: 'x' });
    expect(res.statusCode).toBe(404);
  });

  it('broadcast send body + template cùng lúc → 400', async () => {
    await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    const res = await post('/topics/news/send', { body: 'x', template: 'otp', params: { code: '1' } });
    expect(res.statusCode).toBe(400);
  });

  it('broadcast dùng template → body render trước khi fan-out', async () => {
    await post('/topics/news/subscribers', { recipient: 'a@b.c', channel: 'email' });
    const send = await post('/topics/news/send', { template: 'otp', params: { code: '424242' } });
    expect(send.statusCode).toBe(202);
    const { broadcastId } = send.json() as { broadcastId: string };
    const b = await waitForBroadcastDispatched(broadcastId);
    expect(b.body).toContain('424242');
  });

  // ===== preference chặn gửi =====

  it('người nhận tắt kênh → worker đánh dấu blocked, KHÔNG gọi provider', async () => {
    setPreference('blocked@guy', 'email', false);
    const res = await post('/notifications', { channel: 'email', recipient: 'blocked@guy', body: 'x' });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };

    await queueMod.dispatchPendingOutbox();
    await waitForStatus(id, ['blocked']);
    const row = getNotification(id)!;
    expect(row.notification.status).toBe('blocked');
    expect(row.events.some((e) => e.event === 'blocked_preference')).toBe(true);
    expect(providerState.sendCalls).toBe(0);
  });

  it('preference tắt → subscriber bị bỏ qua ngay từ khâu fan-out', async () => {
    await post('/topics/news/subscribers', { recipient: 'on@guy', channel: 'email' });
    await post('/topics/news/subscribers', { recipient: 'off@guy', channel: 'email' });
    setPreference('off@guy', 'email', false);

    const send = await post('/topics/news/send', { body: 'x' });
    const { broadcastId } = send.json() as { broadcastId: string };
    const b = await waitForBroadcastDispatched(broadcastId);
    expect(b.total).toBe(1); // chỉ on@guy nhận
    expect(listNotifications({ broadcastId }, { limit: 10, offset: 0 }).map((n) => n.recipient))
      .toEqual(['on@guy']);
  });

  // ===== recurring (cron) =====

  it('recurrence cron → status recurring, repeatable job trên BullMQ', async () => {
    const res = await post('/notifications', { channel: 'email', recipient: 'a@b.c', body: 'báo cáo hằng ngày', recurrence: '0 8 * * *' });
    expect(res.statusCode).toBe(202);
    const { id, status } = res.json() as { id: string; status: string };
    expect(status).toBe('recurring');

    const row = getNotification(id)!;
    expect(row.notification.status).toBe('recurring');
    expect(row.notification.recurrence).toBe('0 8 * * *');
    expect(row.events.some((e) => e.event === 'recurring_scheduled')).toBe(true);

    const scheds = await queueMod.notificationQueue.getJobSchedulers();
    expect(scheds.find((s) => s.key === id)).toBeTruthy();
  });

  it('recurrence cron sai → 400', async () => {
    const res = await post('/notifications', { channel: 'email', recipient: 'a@b.c', body: 'x', recurrence: 'khong-phai-cron' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('recurrence không hợp lệ');
  });

  it('recurrence + Idempotency-Key → retry trả lại lịch cũ (deduplicated)', async () => {
    const payload = { channel: 'email', recipient: 'a@b.c', body: 'x', recurrence: '0 8 * * *' };
    const headers = { 'content-type': 'application/json', 'x-api-key': KEY, 'idempotency-key': 'rec-key-1' };

    const first = await app.inject({ method: 'POST', url: '/notifications', headers, payload });
    const { id } = first.json() as { id: string };

    const retry = await app.inject({ method: 'POST', url: '/notifications', headers, payload });
    const body = retry.json() as { id: string; deduplicated?: boolean };
    expect(body.id).toBe(id);
    expect(body.deduplicated).toBe(true);
  });

  it('DELETE lịch recurring → gỡ repeatable job + status cancelled', async () => {
    const res = await post('/notifications', { channel: 'email', recipient: 'a@b.c', body: 'x', recurrence: '*/5 * * * *' });
    const { id } = res.json() as { id: string };
    expect((await queueMod.notificationQueue.getJobSchedulers()).some((s) => s.key === id)).toBe(true);

    const cancelled = await del(`/notifications/${id}`);
    expect(cancelled.statusCode).toBe(200);
    expect(getNotification(id)!.notification.status).toBe('cancelled');
    expect((await queueMod.notificationQueue.getJobSchedulers()).some((s) => s.key === id)).toBe(false);
  });

  it('lần bắn recurring fail → ghi fire_failed, giữ status recurring (không rơi failed vĩnh viễn)', async () => {
    // seed row 'recurring' + job thường attempts:1 — worker chỉ đọc status recurring của row,
    // không cần job repeatable thật để kiểm chứng nhánh fire_failed
    providerState.failTimes = 1;
    const id = 'rec-fail-1';
    createNotification({ id, channel: 'email', recipient: 'a@b.c', body: 'x', status: 'recurring', scheduled_at: null });
    await queueMod.notificationQueue.add(
      'send',
      { notificationId: id, channel: 'email', recipient: 'a@b.c', body: 'x' },
      { jobId: id, attempts: 1 },
    );

    await waitForEvent(id, 'fire_failed');
    expect(getNotification(id)!.notification.status).toBe('recurring');
  });
});
