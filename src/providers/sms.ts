import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const smsProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<{ info?: string } | void> {
    if (config.smsMode === 'twilio') {
      if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFrom) {
        throw new Error('[twilio] thiếu TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM');
      }
      const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization:
            'Basic ' + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: req.to, From: config.twilioFrom, Body: req.body }),
      });
      if (!res.ok) {
        throw new Error(`[twilio] API trả ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { sid?: string };
      return { info: `SMS thật qua Twilio (sid: ${data.sid ?? '?'})` };
    }

    // mock — fail ngẫu nhiên theo FAIL_RATE để demo retry
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:sms] delivery failed to ${req.to}`);
    }
    console.log(`[mock:sms] sent to ${req.to}: ${req.body.slice(0, 40)}`);
  },
};
