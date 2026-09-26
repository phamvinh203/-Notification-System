import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay bằng FCM/APNs adapter khi cần
export const pushProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:push] delivery failed to device ${req.to}`);
    }
    console.log(`[mock:push] sent to device ${req.to}`);
  },
};
