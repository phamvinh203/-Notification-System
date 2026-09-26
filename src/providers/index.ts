import type { Channel } from '../db.js';
import { emailProvider } from './email.js';
import { pushProvider } from './push.js';
import { smsProvider } from './sms.js';
import type { NotificationProvider } from './types.js';

export const providers: Record<Channel, NotificationProvider> = {
  email: emailProvider,
  push: pushProvider,
  sms: smsProvider,
};
