export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  failRate: Number(process.env.FAIL_RATE ?? 0.3),
  dbPath: process.env.DB_PATH ?? 'notifications.db',
};
