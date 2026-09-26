import Fastify from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { config } from './config.js';
import { registerRoutes } from './api/routes.js';
import { notificationQueue } from './queue/queue.js';
import { worker } from './queue/worker.js';

const app = Fastify({ logger: true });

await app.register(registerRoutes);

const boardAdapter = new FastifyAdapter();
boardAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(notificationQueue)], serverAdapter: boardAdapter });
await app.register(boardAdapter.registerPlugin(), { prefix: '/admin/queues' });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`API + worker chạy tại http://localhost:${config.port} — Bull Board: /admin/queues`);
console.log(`Worker đang chạy: ${worker.isRunning()}`);
