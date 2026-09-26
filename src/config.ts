export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  failRate: Number(process.env.FAIL_RATE ?? 0.3),
  dbPath: process.env.DB_PATH ?? 'notifications.db',
  // chuỗi rỗng coi như không set — auth chỉ bật khi có key thật
  apiKey: process.env.API_KEY || null,
  // 0 = tắt rate limit; đặt thấp (VD 3) để demo 429 nhanh
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 10),
  // thư mục dashboard build — Docker đặt /app/dashboard-dist; local mặc định dashboard/dist nếu có
  dashboardDist: process.env.DASHBOARD_DIST || null,

  // ===== provider thật =====
  // email: mock | smtp | resend. smtp + SMTP_PRESET=ethereal = SMTP thật zero-config (xem thư online,
  // không delivery inbox cá nhân); smtp host riêng (Gmail app password...) = inbox thật.
  emailMode: (process.env.EMAIL_MODE ?? 'mock') as 'mock' | 'smtp' | 'resend',
  smtpPreset: process.env.SMTP_PRESET ?? null, // 'ethereal'
  smtpHost: process.env.SMTP_HOST ?? null,
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: process.env.SMTP_SECURE === 'true', // port 465
  smtpUser: process.env.SMTP_USER ?? null,
  smtpPass: process.env.SMTP_PASS ?? null,
  emailFrom: process.env.EMAIL_FROM ?? 'Notification System <no-reply@notifications.local>',
  resendApiKey: process.env.RESEND_API_KEY ?? null,
  resendFrom: process.env.RESEND_FROM ?? null, // VD: "Notification <onboarding@resend.dev>"
  // sms: mock | twilio (Twilio trial: SMS chỉ tới số đã verify)
  smsMode: (process.env.SMS_MODE ?? 'mock') as 'mock' | 'twilio',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? null,
  twilioFrom: process.env.TWILIO_FROM ?? null, // số gửi đi, VD +1xxxxxxxxxx
};
