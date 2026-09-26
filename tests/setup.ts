import { mkdirSync } from 'node:fs';

// Chạy trước mọi test file — phải set env TRƯỚC khi db/queue import config
process.env.NODE_ENV = 'test';
process.env.DB_PATH = '.tmp/test-notifications.db';
process.env.FAIL_RATE = '0';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15';

// SQLite không tự tạo thư mục cha
mkdirSync('.tmp', { recursive: true });
