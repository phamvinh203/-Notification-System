import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp({ apiKey: config.apiKey });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`API chạy tại http://localhost:${config.port} — Bull Board: /admin/queues`);
console.log(config.apiKey ? 'Auth: BẬT (yêu cầu header x-api-key)' : 'Auth: TẮT (set API_KEY để bật)');
