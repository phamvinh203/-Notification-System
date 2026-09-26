import client from 'prom-client';
import { countByChannel, countByStatus, countOutbox } from './db.js';
import { notificationQueue } from './queue/queue.js';

// registry riêng, không dùng default global để chủ động nội dung expose
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const statusGauge = new client.Gauge({
  name: 'notifications_by_status',
  help: 'Số notification theo trạng thái (từ SQLite)',
  labelNames: ['status'],
  registers: [registry],
});

const channelGauge = new client.Gauge({
  name: 'notifications_by_channel',
  help: 'Số notification theo kênh (từ SQLite)',
  labelNames: ['channel'],
  registers: [registry],
});

const outboxGauge = new client.Gauge({
  name: 'outbox_pending',
  help: 'Số outbox row chưa dispatch',
  registers: [registry],
});

const queueGauge = new client.Gauge({
  name: 'bullmq_jobs',
  help: 'Số job trong queue theo trạng thái BullMQ',
  labelNames: ['state'],
  registers: [registry],
});

// gauges tính trực tiếp từ SQLite + Redis lúc scrape — luôn đúng realtime,
// và không cần hai process (api/worker) tự giữ counter riêng
export async function updateMetrics(): Promise<void> {
  statusGauge.reset();
  for (const [status, total] of Object.entries(countByStatus())) {
    statusGauge.set({ status }, total);
  }
  channelGauge.reset();
  for (const [channel, total] of Object.entries(countByChannel())) {
    channelGauge.set({ channel }, total);
  }
  outboxGauge.set(countOutbox('pending'));

  const counts = await notificationQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  queueGauge.reset();
  for (const [state, total] of Object.entries(counts)) {
    queueGauge.set({ state }, total);
  }
}
