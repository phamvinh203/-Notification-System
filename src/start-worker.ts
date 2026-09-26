import { worker } from './queue/worker.js';
import { connection, dispatchPendingOutbox } from './queue/queue.js';

// Outbox dispatcher: poll bảng outbox (pending) → push BullMQ.
// Chạy trong worker process — API chỉ ghi DB, không cần nói chuyện với Redis lúc nhận request.
const DISPATCH_INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS ?? 500);
const dispatcherTimer = setInterval(() => {
  void dispatchPendingOutbox().catch((err) => console.error('[outbox] dispatch lỗi:', err.message));
}, DISPATCH_INTERVAL_MS);
dispatcherTimer.unref();

console.log(`Worker đang chạy (concurrency ${worker.opts.concurrency}, outbox dispatch mỗi ${DISPATCH_INTERVAL_MS}ms) — Ctrl+C để dừng`);

async function shutdown(signal: string): Promise<void> {
  console.log(`Nhận ${signal} — đang đóng worker...`);
  clearInterval(dispatcherTimer);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
