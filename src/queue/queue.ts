import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import {
  createNotificationWithOutbox, findByIdempotencyKey, getNotification,
  getPendingOutbox, markOutboxDispatched, recordEvent, setStatus, type Channel, type Status,
} from '../db.js';

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export interface JobData {
  notificationId: string;
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
}

// BullMQ: số nhỏ = ưu tiên cao hơn
export const PRIORITY_MAP = { high: 1, normal: 5, low: 9 } as const;
export type PriorityName = keyof typeof PRIORITY_MAP;

export interface EnqueueInput {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
  sendAt?: string; // ISO — có thì thành scheduled
  idempotencyKey?: string;
  priority?: PriorityName;
}

export interface EnqueueResult {
  id: string;
  status: Status;
  deduplicated?: true;
}

export const notificationQueue = new Queue<JobData>('notifications', { connection });

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
} as const;

async function addJob(input: EnqueueInput & { id: string; delay?: number }): Promise<void> {
  await notificationQueue.add(
    'send',
    { notificationId: input.id, channel: input.channel, recipient: input.recipient, subject: input.subject, body: input.body },
    {
      ...JOB_OPTS,
      jobId: input.id,
      delay: input.delay,
      priority: input.priority ? PRIORITY_MAP[input.priority] : undefined,
    },
  );
}

export async function enqueueNotification(input: EnqueueInput): Promise<EnqueueResult> {
  // idempotency: đã có key này → trả về notification cũ, không tạo mới
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { id: existing.id, status: existing.status as Status, deduplicated: true };
    }
  }

  const id = randomUUID();
  const scheduledAt = input.sendAt ? new Date(input.sendAt) : undefined;
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : undefined;
  const isScheduled = delay !== undefined && delay > 0;
  const status: Status = isScheduled ? 'scheduled' : 'queued';

  // OUTBOX PATTERN: intent đẩy job ghi CÙNG transaction với row notification —
  // không còn trường hợp "ghi DB xong, chết trước khi add job" (dual-write problem).
  // Job thực sự được dispatcher (worker process) đọc outbox rồi push lên BullMQ.
  try {
    createNotificationWithOutbox({
      id, channel: input.channel, recipient: input.recipient, subject: input.subject,
      body: input.body, status, scheduled_at: scheduledAt?.toISOString() ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    }, JSON.stringify({
      channel: input.channel, recipient: input.recipient, subject: input.subject,
      body: input.body, priority: input.priority, delay,
    }));
  } catch {
    // race: 2 request cùng key chạy song song — unique index chặn, trả notification của request thắng
    if (input.idempotencyKey) {
      const existing = findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status as Status, deduplicated: true };
    }
    throw new Error('không tạo được notification (idempotency conflict không tìm thấy row cũ)');
  }
  recordEvent(id, 'enqueued', isScheduled ? `scheduled at ${scheduledAt?.toISOString()}` : 'immediate');
  return { id, status };
}

// dispatcher (chạy trong worker process): đọc outbox pending → push BullMQ → đánh dấu dispatched.
// BullMQ jobId = notificationId nên push trùng (crash giữa add và mark) cũng không tạo job đôi.
export async function dispatchPendingOutbox(limit = 100): Promise<number> {
  const rows = getPendingOutbox(limit);
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as EnqueueInput & { delay?: number };
    const n = getNotification(row.notification_id);
    // notification đã bị hủy trước kịp dispatch → bỏ qua, không tạo job
    if (!n || n.notification.status === 'cancelled') {
      markOutboxDispatched(row.id);
      continue;
    }
    await addJob({ ...payload, id: row.notification_id });
    markOutboxDispatched(row.id);
  }
  return rows.length;
}

// đẩy lại job đã dead (status failed) — dùng cho POST /notifications/:id/replay
export async function replayNotification(id: string): Promise<EnqueueResult | 'not_found' | 'not_failed'> {
  const row = getNotification(id);
  if (!row) return 'not_found';
  if (row.notification.status !== 'failed') return 'not_failed';

  // job cũ còn nằm trong failed set — remove trước thì add lại với cùng jobId mới nhận
  const oldJob = await notificationQueue.getJob(id);
  await oldJob?.remove().catch(() => {});

  await addJob({
    id,
    channel: row.notification.channel as Channel,
    recipient: row.notification.recipient,
    subject: row.notification.subject ?? undefined,
    body: row.notification.body,
  });
  setStatus(id, 'queued');
  recordEvent(id, 'replayed');
  return { id, status: 'queued' };
}
