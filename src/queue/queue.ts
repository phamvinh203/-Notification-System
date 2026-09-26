import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { createNotification, recordEvent, type Channel, type Status } from '../db.js';

export const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export interface JobData {
  notificationId: string;
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
}

export interface EnqueueInput {
  channel: Channel;
  recipient: string;
  subject?: string;
  body: string;
  sendAt?: string; // ISO — có thì thành scheduled
}

export const notificationQueue = new Queue<JobData>('notifications', { connection });

export async function enqueueNotification(input: EnqueueInput): Promise<{ id: string; status: Status }> {
  const id = randomUUID();
  const scheduledAt = input.sendAt ? new Date(input.sendAt) : undefined;
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : undefined;
  const isScheduled = delay !== undefined && delay > 0;
  const status: Status = isScheduled ? 'scheduled' : 'queued';

  createNotification({
    id, channel: input.channel, recipient: input.recipient, subject: input.subject,
    body: input.body, status, scheduled_at: scheduledAt?.toISOString() ?? null,
  });
  recordEvent(id, 'enqueued', isScheduled ? `scheduled at ${scheduledAt?.toISOString()}` : 'immediate');

  await notificationQueue.add(
    'send',
    { notificationId: id, channel: input.channel, recipient: input.recipient, subject: input.subject, body: input.body },
    {
      jobId: id,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  );
  return { id, status };
}
