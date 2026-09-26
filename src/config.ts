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
};
