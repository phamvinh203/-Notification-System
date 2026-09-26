import { Worker, type Job } from 'bullmq';
import { connection, enqueueSafe, broadcastNotificationId, type JobData, type SendJobData } from './queue.js';
import { providers } from '../providers/index.js';
import {
  getBroadcast, getNotification, getPreference, listTopicSubscribers, recordEvent,
  setBroadcastDispatched, setStatus, type Channel,
} from '../db.js';
import { renderBody } from '../templates.js';
import { buildUnsubscribeUrl } from '../unsubscribe.js';

// provider.send có thể trả về info (VD link xem email Ethereal, message id Twilio)
// — completed event cần nó nên lưu tạm theo notificationId trong process này
const sendInfo = new Map<string, string>();

type BroadcastData = { broadcastId: string };

async function process(job: Job<JobData>): Promise<void> {
  // job 'broadcast': fan-out — đọc subscribers của topic, tạo 1 notification cho mỗi người
  if (job.name === 'broadcast') {
    await fanOutBroadcast((job.data as BroadcastData).broadcastId);
    return;
  }

  const data = job.data as SendJobData;
  const id = data.notificationId;
  const row = getNotification(id);
  if (!row) return;

  // notification bị hủy sau khi job đã lên queue (race DELETE-vs-dispatcher/worker)
  // → bỏ qua, không gọi provider; completed handler giữ nguyên status cancelled
  if (row.notification.status === 'cancelled') {
    recordEvent(id, 'skipped_cancelled', 'worker bỏ qua job vì notification đã bị hủy');
    return;
  }

  // recurring: row là LỊCH lặp, không đổi trạng thái mỗi lần bắn
  const isRecurring = row.notification.status === 'recurring';
  if (!isRecurring) setStatus(id, 'processing');
  recordEvent(id, 'processing', `attempt ${job.attemptsMade + 1}`);

  // preference: người nhận tắt kênh này → không gửi, đánh dấu blocked
  const pref = getPreference(row.notification.recipient, data.channel as Channel);
  if (pref && !pref.enabled) {
    setStatus(id, 'blocked');
    recordEvent(id, 'blocked_preference', `kênh ${data.channel} đã bị tắt bởi ${row.notification.recipient}`);
    return;
  }

  const result = await providers[data.channel].send({
    to: data.recipient,
    subject: data.subject,
    body: data.body,
  });
  if (result?.info) sendInfo.set(id, result.info);
}

// fan-out broadcast: tạo notification cho từng subscriber (qua outbox — giữ đúng kiến trúc).
// Idempotent: mỗi (broadcast, recipient, channel) có id/jobId deterministic → job retry lại
// không tạo trùng; người nhận đã tắt kênh (preference) bị bỏ qua ngay từ khâu fan-out.
async function fanOutBroadcast(broadcastId: string): Promise<void> {
  const broadcast = getBroadcast(broadcastId);
  if (!broadcast) return;
  const subscribers = listTopicSubscribers(broadcast.topic);
  let created = 0;
  for (const sub of subscribers) {
    const pref = getPreference(sub.recipient, sub.channel);
    if (pref && !pref.enabled) continue;
    const notifId = broadcastNotificationId(broadcastId, sub.recipient, sub.channel);
    // render PER-RECIPIENT: link unsubscribe ký riêng từng người (hủy = rời topic, không tắt cả kênh)
    const body = renderBody(broadcast.body, {
      recipient: sub.recipient,
      unsubscribe_url: buildUnsubscribeUrl(sub.recipient, sub.channel, broadcast.topic),
    });
    await enqueueSafe({
      id: notifId,
      broadcastId,
      channel: sub.channel,
      recipient: sub.recipient,
      subject: broadcast.subject ?? undefined,
      body,
    });
    created++;
  }
  setBroadcastDispatched(broadcastId, created);
  console.log(`[broadcast] ${broadcastId.slice(0, 8)} topic "${broadcast.topic}" → tạo ${created}/${subscribers.length} notification`);
}

export const worker = new Worker<JobData>('notifications', process, {
  connection,
  concurrency: 5,
});

worker.on('completed', (job) => {
  if (job.name === 'broadcast') return;
  const id = (job.data as SendJobData).notificationId;
  const current = getNotification(id)?.notification.status;
  // job completed nhưng notification đã bị hủy/blocked (guard ở process) → không đè status
  if (current === 'cancelled' || current === 'blocked') {
    sendInfo.delete(id);
    return;
  }
  // recurring giữ nguyên status 'recurring' — chỉ ghi event từng lần bắn
  if (current !== 'recurring') setStatus(id, 'sent');
  recordEvent(id, 'sent', sendInfo.get(id));
  sendInfo.delete(id);
});

worker.on('failed', (job, err) => {
  if (!job) return;
  if (job.name === 'broadcast') {
    console.error(`[broadcast] job ${(job.data as BroadcastData).broadcastId} fail: ${err.message}`);
    return;
  }
  const id = (job.data as SendJobData).notificationId;
  // lần bắn recurring fail — cron tự bắn lần sau, không đánh dấu dead vĩnh viễn
  if (getNotification(id)?.notification.status === 'recurring') {
    recordEvent(id, 'fire_failed', err.message);
    return;
  }
  const isFinal = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isFinal) {
    setStatus(id, 'failed');
    recordEvent(id, 'dead', err.message);
  } else {
    recordEvent(id, 'retry_scheduled', `attempt ${job.attemptsMade} failed: ${err.message}`);
  }
});
