import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import type { NotificationProvider, SendRequest } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ethereal: SMTP thật, tạo tài khoản test tự động — email xem được online qua link preview,
// KHÔNG delivery vào hộp thư cá nhân. Muốn inbox thật: dùng SMTP riêng (Gmail app password...)
// hoặc EMAIL_MODE=resend với RESEND_API_KEY.
let etherealAccount: Promise<Awaited<ReturnType<typeof nodemailer.createTestAccount>>> | null = null;
function ethereal(): ReturnType<typeof nodemailer.createTestAccount> {
  etherealAccount ??= nodemailer.createTestAccount();
  return etherealAccount;
}

export const emailProvider: NotificationProvider = {
  async send(req: SendRequest): Promise<{ info?: string } | void> {
    if (config.emailMode === 'resend') {
      if (!config.resendApiKey || !config.resendFrom) {
        throw new Error('[resend] thiếu RESEND_API_KEY hoặc RESEND_FROM');
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.resendFrom,
          to: [req.to],
          subject: req.subject ?? '(no subject)',
          text: req.body,
        }),
      });
      if (!res.ok) {
        throw new Error(`[resend] API trả ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { id?: string };
      return { info: `email thật qua Resend (id: ${data.id ?? '?'})` };
    }

    if (config.emailMode === 'smtp') {
      let transporter: Transporter;
      if (config.smtpPreset === 'ethereal') {
        const acct = await ethereal();
        transporter = nodemailer.createTransport({
          host: 'smtp.ethereal.email',
          port: 587,
          secure: false,
          auth: { user: acct.user, pass: acct.pass },
        });
      } else {
        if (!config.smtpHost) throw new Error('[smtp] thiếu SMTP_HOST');
        transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpSecure,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
        });
      }
      const info = await transporter.sendMail({
        from: config.emailFrom,
        to: req.to,
        subject: req.subject ?? '(no subject)',
        text: req.body,
      });
      const previewUrl = nodemailer.getTestMessageUrl(info);
      return {
        info: previewUrl
          ? `email SMTP thật — xem thư tại: ${previewUrl}`
          : `email SMTP thật (${info.messageId})`,
      };
    }

    // mock — fail ngẫu nhiên theo FAIL_RATE để demo retry
    await sleep(300 + Math.random() * 500);
    if (Math.random() < config.failRate) {
      throw new Error(`[mock:email] delivery failed to ${req.to}`);
    }
    console.log(`[mock:email] sent to ${req.to}: ${req.subject ?? '(no subject)'}`);
  },
};
