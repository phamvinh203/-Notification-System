import { worker } from './queue/worker.js';
import { connection } from './queue/queue.js';

console.log(`Worker đang chạy (concurrency ${worker.opts.concurrency}) — Ctrl+C để dừng`);

async function shutdown(signal: string): Promise<void> {
  console.log(`Nhận ${signal} — đang đóng worker...`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
