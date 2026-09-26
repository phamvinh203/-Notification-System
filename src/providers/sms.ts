import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay bằng Twilio/eSMS adapter khi cần
export const smsProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:sms] delivery failed to ${req.to}`);
    }
    console.log(`[mock:sms] sent to ${req.to}: ${req.body.slice(0, 40)}`);
  },
};
