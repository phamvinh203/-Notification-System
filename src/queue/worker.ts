import { Worker, type Job } from 'bullmq';
import { connection, type JobData } from './queue.js';
import { providers } from '../providers/index.js';
import { getNotification, recordEvent, setStatus } from '../db.js';

// provider.send có thể trả về info (VD link xem email Ethereal, message id Twilio)
// — completed event cần nó nên lưu tạm theo notificationId trong process này
const sendInfo = new Map<string, string>();

async function process(job: Job<JobData>): Promise<void> {
  const id = job.data.notificationId;

  // notification bị hủy sau khi job đã lên queue (race DELETE-vs-dispatcher/worker)
  // → bỏ qua, không gọi provider; completed handler giữ nguyên status cancelled
  const current = getNotification(id);
  if (current?.notification.status === 'cancelled') {
    recordEvent(id, 'skipped_cancelled', 'worker bỏ qua job vì notification đã bị hủy');
    return;
  }

  setStatus(id, 'processing');
  recordEvent(id, 'processing', `attempt ${job.attemptsMade + 1}`);
  const result = await providers[job.data.channel].send({
    to: job.data.recipient,
    subject: job.data.subject,
    body: job.data.body,
  });
  if (result?.info) sendInfo.set(id, result.info);
}

export const worker = new Worker<JobData>('notifications', process, {
  connection,
  concurrency: 5,
});

worker.on('completed', (job) => {
  const id = job.data.notificationId;
  // job completed nhưng notification đã bị hủy (guard ở process) → không đè status
  if (getNotification(id)?.notification.status === 'cancelled') {
    sendInfo.delete(id);
    return;
  }
  setStatus(id, 'sent');
  recordEvent(id, 'sent', sendInfo.get(id));
  sendInfo.delete(id);
});

worker.on('failed', (job, err) => {
  if (!job) return;
  const id = job.data.notificationId;
  const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isFinal) {
    setStatus(id, 'failed');
    recordEvent(id, 'dead', err.message);
  } else {
    recordEvent(id, 'retry_scheduled', `attempt ${job.attemptsMade} failed: ${err.message}`);
  }
});
