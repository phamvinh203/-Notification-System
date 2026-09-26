import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { getNotification } from '../src/db.js';

/** Redis có sẵn không? — các test cần Redis sẽ skip khi không có (CI luôn có service Redis) */
export async function redisAvailable(): Promise<boolean> {
  const r = new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

/** Poll DB tới khi notification vào 1 trong các trạng thái mong đợi, hoặc timeout */
export async function waitForStatus(id: string, want: string[], timeoutMs = 15_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const status = getNotification(id)?.notification.status;
    if (status && want.includes(status)) return status;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout ${timeoutMs}ms chờ status [${want.join('|')}] của ${id} — hiện: ${status ?? 'không tìm thấy row'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
