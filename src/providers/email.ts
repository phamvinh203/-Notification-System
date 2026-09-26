import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: mock — thay provider thật (nodemailer/SendGrid) bằng cách đổi body send()
export const emailProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<void> {
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:email] delivery failed to ${req.to}`);
    }
    console.log(`[mock:email] sent to ${req.to}: ${req.subject ?? '(no subject)'}`);
  },
};
