import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTables, createNotification, getNotification } from '../src/db.js';
import { redisAvailable, waitForStatus } from './helpers.js';

const hasRedis = await redisAvailable();

// Mock providers để điều khiển fail/fail-then-success DETERMINISTIC
// (provider thật fail theo FAIL_RATE = random, không thể assert)
const providerState = vi.hoisted(() => ({ failTimes: 0, sendCalls: 0 }));

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

describe.skipIf(!hasRedis)('worker + retry logic (cần Redis)', () => {
  type QueueMod = typeof import('../src/queue/queue.js');
  type WorkerMod = typeof import('../src/queue/worker.js');

  let queueMod: QueueMod;
  let workerMod: WorkerMod;

  // backoff 200ms exponential cho nhanh: 200 → 400 (thay vì 1s/2s/4s của prod)
  function seedJob(id: string, channel: 'email' | 'push' | 'sms' = 'email') {
    createNotification({ id, channel, recipient: 'a@b.c', body: 'x', status: 'queued', scheduled_at: null });
    return queueMod.notificationQueue.add(
      'send',
      { notificationId: id, channel, recipient: 'a@b.c', body: 'x' },
      { jobId: id, attempts: 3, backoff: { type: 'exponential', delay: 200 } },
    );
  }

  beforeAll(async () => {
    queueMod = await import('../src/queue/queue.js');
    workerMod = await import('../src/queue/worker.js');
  });

  beforeEach(() => {
    clearTables();
    providerState.failTimes = 0;
    providerState.sendCalls = 0;
  });

  afterAll(async () => {
    await workerMod.worker.close();
    await queueMod.notificationQueue.obliterate({ force: true }).catch(() => {});
    await queueMod.connection.quit();
  });

  it('provider OK ngay → sent, gọi đúng 1 lần, không có retry trong timeline', async () => {
    await seedJob('w-ok');
    const st = await waitForStatus('w-ok', ['sent']);
    expect(st).toBe('sent');
    expect(providerState.sendCalls).toBe(1);
    const events = getNotification('w-ok')!.events.map((e) => e.event);
    expect(events).toContain('processing');
    expect(events[events.length - 1]).toBe('sent');
    expect(events).not.toContain('retry_scheduled');
  });

  it('fail 1 lần rồi thành công → có retry_scheduled, gọi đủ 2 lần, cuối cùng sent', async () => {
    providerState.failTimes = 1;
    await seedJob('w-retry');
    const st = await waitForStatus('w-retry', ['sent']);
    expect(st).toBe('sent');
    expect(providerState.sendCalls).toBe(2);
    const events = getNotification('w-retry')!.events.map((e) => e.event);
    expect(events).toContain('retry_scheduled');
    expect(events[events.length - 1]).toBe('sent');
  });

  it('fail hết attempts → status failed + event dead (retry_scheduled đúng số lần)', async () => {
    providerState.failTimes = 99;
    await seedJob('w-dead');
    const st = await waitForStatus('w-dead', ['failed']);
    expect(st).toBe('failed');
    expect(providerState.sendCalls).toBe(3);
    const events = getNotification('w-dead')!.events.map((e) => e.event);
    expect(events.filter((e) => e === 'retry_scheduled')).toHaveLength(2);
    expect(events).toContain('dead');
  });

  it('replay job dead → chạy lại thành công, timeline có event replayed', async () => {
    // 1. làm job fail hết attempts
    providerState.failTimes = 99;
    await seedJob('w-replay');
    await waitForStatus('w-replay', ['failed']);
    const callsAfterFail = providerState.sendCalls;
    expect(callsAfterFail).toBe(3);

    // 2. replay khi provider đã "khỏi" → chạy lại từ đầu
    providerState.failTimes = 0;
    const queueMod2 = queueMod;
    const result = await queueMod2.replayNotification('w-replay');
    expect(result).toEqual({ id: 'w-replay', status: 'queued' });

    const st = await waitForStatus('w-replay', ['sent']);
    expect(st).toBe('sent');
    expect(providerState.sendCalls).toBe(callsAfterFail + 1);
    const events = getNotification('w-replay')!.events.map((e) => e.event);
    expect(events).toContain('replayed');
    expect(events[events.length - 1]).toBe('sent');
  });

  it('replay notification chưa fail → trả not_failed', async () => {
    await seedJob('w-notdead');
    const result = await queueMod.replayNotification('w-notdead');
    expect(result).toBe('not_failed');
  });
});
