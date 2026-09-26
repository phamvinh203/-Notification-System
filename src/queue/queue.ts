import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { createNotification, findByIdempotencyKey, getNotification, recordEvent, setStatus, type Channel, type Status } from '../db.js';

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

  try {
    createNotification({
      id, channel: input.channel, recipient: input.recipient, subject: input.subject,
      body: input.body, status, scheduled_at: scheduledAt?.toISOString() ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    });
  } catch {
    // race: 2 request cùng key chạy song song — unique index chặn, trả notification của request thắng
    if (input.idempotencyKey) {
      const existing = findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status as Status, deduplicated: true };
    }
    throw new Error('không tạo được notification (idempotency conflict không tìm thấy row cũ)');
  }
  recordEvent(id, 'enqueued', isScheduled ? `scheduled at ${scheduledAt?.toISOString()}` : 'immediate');

  await addJob({ ...input, id, delay });
  return { id, status };
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
