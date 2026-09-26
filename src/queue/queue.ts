import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import {
  createBroadcast, createNotification, createNotificationWithOutbox, deleteNotification, findByIdempotencyKey,
  getNotification, getPendingOutbox, markOutboxDispatched, recordEvent, setStatus, type Channel, type Status,
} from '../db.js';

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export interface SendJobData {
  notificationId: string;
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
}

export interface BroadcastJobData {
  broadcastId: string;
}

export type JobData = SendJobData | BroadcastJobData;

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
  /** cron chuẩn (VD "0 8 * * *") — có thì thành lịch lặp, job repeatable thay vì outbox */
  recurrence?: string;
  /** broadcast fan-out truyền id deterministic để retry không tạo trùng */
  id?: string;
  broadcastId?: string;
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

  const id = input.id ?? randomUUID();

  // ===== RECURRING: lịch lặp cron — job repeatable trên BullMQ, không đi qua outbox
  // (outbox là cơ chế one-shot; repeatable job tự bắn lại theo cron đến khi bị remove)
  if (input.recurrence) {
    try {
      createNotification({
        id, channel: input.channel, recipient: input.recipient, subject: input.subject,
        body: input.body, status: 'recurring', scheduled_at: null,
        idempotency_key: input.idempotencyKey ?? null, recurrence: input.recurrence,
      });
    } catch {
      throw duplicateError(input, id);
    }
    try {
      // repeat.key = notification id → tìm/gỡ lịch theo id được (BullMQ v5: job scheduler)
      await notificationQueue.add(
        'send',
        { notificationId: id, channel: input.channel, recipient: input.recipient, subject: input.subject, body: input.body },
        { ...JOB_OPTS, repeat: { pattern: input.recurrence, key: id } },
      );
    } catch (e) {
      // cron pattern BullMQ chối bỏ → không để row mồ côi
      deleteNotification(id);
      throw new Error(`cron không hợp lệ: ${e instanceof Error ? e.message : String(e)}`);
    }
    recordEvent(id, 'recurring_scheduled', `pattern: ${input.recurrence}`);
    return { id, status: 'recurring' };
  }

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
      idempotency_key: input.idempotencyKey ?? null, broadcast_id: input.broadcastId ?? null,
    }, JSON.stringify({
      channel: input.channel, recipient: input.recipient, subject: input.subject,
      body: input.body, priority: input.priority, delay,
    }));
  } catch {
    // idempotency key trùng hoặc broadcast fan-out retry (id deterministic trùng)
    // → trả notification đã có; không khớp gì hết là lỗi thật
    throw duplicateError(input, id);
  }
  recordEvent(id, 'enqueued', isScheduled ? `scheduled at ${scheduledAt?.toISOString()}` : 'immediate');
  return { id, status };
}

// conflict khi INSERT: idempotency key trùng → trả row cũ; fan-out retry (id trùng) → trả row đã có.
// Không khớp gì hết → lỗi thật. enqueueSafe bọc lại để lấy EnqueueResult từ Error (SQLite sync + async flow).
function duplicateError(input: EnqueueInput, explicitId?: string): Error {
  const build = (row: { id: string; status: string }): Error => {
    const e = new Error('deduplicated') as Error & { dedupe?: EnqueueResult };
    e.dedupe = { id: row.id, status: row.status as Status, deduplicated: true };
    return e;
  };
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey(input.idempotencyKey);
    if (existing) return build(existing);
  }
  if (explicitId) {
    const existing = getNotification(explicitId);
    if (existing) return build(existing.notification);
  }
  return new Error('không tạo được notification (conflict không tìm thấy row cũ)');
}

export async function enqueueSafe(input: EnqueueInput): Promise<EnqueueResult> {
  try {
    return await enqueueNotification(input);
  } catch (e) {
    const dedupe = (e as Error & { dedupe?: EnqueueResult }).dedupe;
    if (dedupe) return dedupe;
    throw e;
  }
}

// ===== BROADCAST: 1 request gửi cho cả topic — fan-out chạy trong worker =====

export async function enqueueBroadcast(
  topic: string,
  payload: { subject?: string; body: string },
): Promise<{ id: string }> {
  const id = randomUUID();
  createBroadcast({ id, topic, subject: payload.subject, body: payload.body });
  // job 'broadcast' do worker xử lý: đọc subscribers → tạo N notification (qua outbox)
  await notificationQueue.add('broadcast', { broadcastId: id }, {
    jobId: id,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  });
  // KHÔNG recordEvent cho broadcast — delivery_events FK tới notifications(id),
  // còn broadcast id chỉ nằm trong bảng broadcasts (audit trail = row broadcasts + counts)
  return { id };
}

/** id deterministic cho fan-out — broadcast job retry lại không tạo notification trùng */
export function broadcastNotificationId(broadcastId: string, recipient: string, channel: string): string {
  const h = createHash('sha256').update(`${broadcastId}:${recipient}:${channel}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** hủy lịch lặp: job scheduler của BullMQ v5 đặt key = notification id (xem nhánh recurring) */
export async function removeRecurringJob(id: string): Promise<boolean> {
  return notificationQueue.removeJobScheduler(id);
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

