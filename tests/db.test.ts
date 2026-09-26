import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTables,
  countNotifications,
  createNotification,
  getNotification,
  listNotifications,
  recordEvent,
  setStatus,
} from '../src/db.js';

type SeedInput = Parameters<typeof createNotification>[0];

function seed(i: number, over: Partial<SeedInput> = {}): void {
  createNotification({
    id: `n-${i}`,
    channel: 'email',
    recipient: `user${i}@example.com`,
    body: `body ${i}`,
    status: 'queued',
    scheduled_at: null,
    ...over,
  });
}

// created_at chỉ chính xác đến ms — sleep nhẹ để 3 row có mốc thời gian phân biệt được
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => clearTables());

describe('db layer (unit — không cần Redis)', () => {
  it('tạo rồi đọc lại notification kèm events', () => {
    seed(1);
    recordEvent('n-1', 'enqueued', 'immediate');
    const row = getNotification('n-1');
    expect(row).toBeDefined();
    expect(row!.notification.recipient).toBe('user1@example.com');
    expect(row!.events).toHaveLength(1);
    expect(row!.events[0]!.event).toBe('enqueued');
    expect(row!.events[0]!.detail).toBe('immediate');
  });

  it('getNotification trả undefined cho id lạ', () => {
    expect(getNotification('nope')).toBeUndefined();
  });

  it('setStatus cập nhật trạng thái', () => {
    seed(2);
    setStatus('n-2', 'sent');
    expect(getNotification('n-2')!.notification.status).toBe('sent');
  });

  it('recordEvent giữ đúng thứ tự tăng dần', () => {
    seed(3);
    recordEvent('n-3', 'enqueued');
    recordEvent('n-3', 'processing');
    recordEvent('n-3', 'sent');
    expect(getNotification('n-3')!.events.map((e) => e.event)).toEqual(['enqueued', 'processing', 'sent']);
  });

  it('listNotifications lọc theo status và channel', () => {
    seed(1);
    seed(2, { status: 'sent' });
    seed(3, { channel: 'sms' });
    const all = { limit: 100, offset: 0 };
    expect(listNotifications({}, all)).toHaveLength(3);
    expect(listNotifications({ status: 'sent' }, all)).toHaveLength(1);
    expect(listNotifications({ channel: 'sms' }, all)).toHaveLength(1);
    expect(listNotifications({ status: 'queued', channel: 'sms' }, all)).toHaveLength(1);
    expect(listNotifications({ status: 'failed' }, all)).toHaveLength(0);
  });

  it('listNotifications sắp xếp mới nhất trước', async () => {
    seed(1);
    await sleep(5);
    seed(2);
    await sleep(5);
    seed(3);
    expect(listNotifications({}, { limit: 100, offset: 0 }).map((n) => n.id)).toEqual(['n-3', 'n-2', 'n-1']);
  });

  it('phân trang: limit/offset cắt đúng, total không phụ thuộc phân trang', async () => {
    for (let i = 1; i <= 5; i++) {
      seed(i);
      await sleep(2);
    }
    expect(listNotifications({}, { limit: 2, offset: 0 }).map((n) => n.id)).toEqual(['n-5', 'n-4']);
    expect(listNotifications({}, { limit: 2, offset: 4 })).toHaveLength(1);
    expect(listNotifications({}, { limit: 2, offset: 10 })).toHaveLength(0);
    expect(countNotifications({})).toBe(5);
    expect(countNotifications({ status: 'queued' })).toBe(5);
  });

  it('countNotifications đếm theo filter', () => {
    seed(1);
    seed(2, { status: 'sent' });
    seed(3, { status: 'sent' });
    expect(countNotifications({})).toBe(3);
    expect(countNotifications({ status: 'sent' })).toBe(2);
  });
});
