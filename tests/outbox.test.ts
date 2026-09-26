import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTables, countOutbox, getNotification, setStatus } from '../src/db.js';
import type { SendJobData } from '../src/queue/queue.js';
import { redisAvailable } from './helpers.js';

const hasRedis = await redisAvailable();

// Outbox pattern: enqueue chỉ ghi DB (notification + outbox cùng transaction),
// dispatchPendingOutbox mới đẩy job lên BullMQ
describe.skipIf(!hasRedis)('outbox pattern (cần Redis)', () => {
  type QueueMod = typeof import('../src/queue/queue.js');
  let queueMod: QueueMod;

  beforeAll(async () => {
    queueMod = await import('../src/queue/queue.js');
  });

  beforeEach(() => clearTables());

  afterAll(async () => {
    await queueMod.notificationQueue.obliterate({ force: true }).catch(() => {});
    await queueMod.connection.quit();
  });

  it('enqueueNotification → outbox pending, CHƯA có job trong queue', async () => {
    const res = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    expect(res.status).toBe('queued');
    expect(countOutbox('pending')).toBe(1);
    expect(await queueMod.notificationQueue.getJob(res.id)).toBeFalsy();
  });

  it('dispatchPendingOutbox → job xuất hiện với đúng data, outbox đánh dấu dispatched', async () => {
    const res = await queueMod.enqueueNotification({ channel: 'sms', recipient: '+8490', body: 'otp-1', priority: 'high' });
    const dispatched = await queueMod.dispatchPendingOutbox();
    expect(dispatched).toBe(1);
    expect(countOutbox('pending')).toBe(0);
    expect(countOutbox('dispatched')).toBe(1);

    const job = await queueMod.notificationQueue.getJob(res.id);
    expect(job).toBeTruthy();
    const data = job!.data as SendJobData;
    expect(data.notificationId).toBe(res.id);
    expect(data.channel).toBe('sms');
    expect(data.body).toBe('otp-1');
    expect(job!.opts.priority).toBe(1);
  });

  it('dispatch 2 lần → lần 2 không dispatch gì thêm (idempotent)', async () => {
    await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    expect(await queueMod.dispatchPendingOutbox()).toBe(1);
    expect(await queueMod.dispatchPendingOutbox()).toBe(0);
    expect(countOutbox('dispatched')).toBe(1);
  });

  it('scheduled: delay được lưu trong payload và áp đúng khi dispatch', async () => {
    const sendAt = new Date(Date.now() + 5_000).toISOString();
    const res = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x', sendAt });
    expect(res.status).toBe('scheduled');
    await queueMod.dispatchPendingOutbox();
    const job = await queueMod.notificationQueue.getJob(res.id);
    expect(job!.delay).toBeGreaterThan(4_000);
  });

  it('notification bị hủy trước kịp dispatch → dispatcher bỏ qua, không tạo job', async () => {
    const res = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    setStatus(res.id, 'cancelled');
    const dispatched = await queueMod.dispatchPendingOutbox();
    expect(dispatched).toBe(1); // xử lý 1 row
    expect(await queueMod.notificationQueue.getJob(res.id)).toBeFalsy();
    expect(getNotification(res.id)!.notification.status).toBe('cancelled');
  });
});
