import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearTables, getNotification } from '../src/db.js';
import type { SendJobData } from '../src/queue/queue.js';
import { redisAvailable } from './helpers.js';

const hasRedis = await redisAvailable();

describe.skipIf(!hasRedis)('queue: enqueueNotification + dispatch (cần Redis)', () => {
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

  it('gửi ngay → status queued, sau dispatch job không delay', async () => {
    const res = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    expect(res.status).toBe('queued');
    await queueMod.dispatchPendingOutbox();
    const job = await queueMod.notificationQueue.getJob(res.id);
    expect(job).toBeTruthy();
    expect(job!.delay).toBe(0);
    const row = getNotification(res.id)!;
    expect(row.notification.status).toBe('queued');
    expect(row.notification.scheduled_at).toBeNull();
    expect(row.events[0]!.event).toBe('enqueued');
  });

  it('sendAt tương lai → scheduled, sau dispatch delay đúng khoảng, scheduled_at ghi DB', async () => {
    const sendAt = new Date(Date.now() + 5_000).toISOString();
    const res = await queueMod.enqueueNotification({ channel: 'sms', recipient: '+8490', body: 'x', sendAt });
    expect(res.status).toBe('scheduled');
    await queueMod.dispatchPendingOutbox();
    const job = await queueMod.notificationQueue.getJob(res.id);
    expect(job).toBeTruthy();
    expect(job!.delay).toBeGreaterThan(4_000);
    expect(job!.delay).toBeLessThanOrEqual(5_000);
    expect(getNotification(res.id)!.notification.scheduled_at).toBe(sendAt);
  });

  it('sendAt quá khứ → coi như gửi ngay (queued), vẫn lưu mốc client yêu cầu', async () => {
    const sendAt = new Date(Date.now() - 60_000).toISOString();
    const res = await queueMod.enqueueNotification({
      channel: 'push',
      recipient: 'device-token',
      body: 'x',
      sendAt,
    });
    expect(res.status).toBe('queued');
    // hành vi hiện tại: không schedule nữa nhưng vẫn ghi lại mốc client yêu cầu
    expect(getNotification(res.id)!.notification.scheduled_at).toBe(sendAt);
  });

  it('job mặc định: retry 3 lần, backoff exponential 1s, jobId = id notification', async () => {
    const res = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    await queueMod.dispatchPendingOutbox();
    const job = await queueMod.notificationQueue.getJob(res.id);
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    expect(job!.id).toBe(res.id);
    expect((job!.data as SendJobData).notificationId).toBe(res.id);
  });

  it('priority: high/normal/low map sang số BullMQ (nhỏ = ưu tiên cao)', async () => {
    const high = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x', priority: 'high' });
    const low = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x', priority: 'low' });
    const none = await queueMod.enqueueNotification({ channel: 'email', recipient: 'a@b.c', body: 'x' });
    await queueMod.dispatchPendingOutbox();
    expect((await queueMod.notificationQueue.getJob(high.id))!.opts.priority).toBe(1);
    expect((await queueMod.notificationQueue.getJob(low.id))!.opts.priority).toBe(9);
    expect((await queueMod.notificationQueue.getJob(none.id))!.opts.priority).toBeUndefined();
  });
});
