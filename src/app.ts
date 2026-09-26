import Fastify, { type FastifyInstance } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { registerRoutes } from './api/routes.js';
import { notificationQueue } from './queue/queue.js';
import { registry, updateMetrics } from './metrics.js';

export interface BuildAppOptions {
  /** Set = bắt buộc header x-api-key khớp cho /notifications* và /admin/*. null/undefined = tắt auth (dev local). */
  apiKey?: string | null;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // health check — luôn mở, không cần key (dùng cho docker healthcheck)
  app.get('/health', async () => ({ ok: true }));

  // Prometheus metrics — cùng chính sách auth như /notifications*
  app.get('/metrics', async (_req, reply) => {
    await updateMetrics();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  // API key auth: preHandler chạy cho mọi route đăng ký sau nó, kể cả route của Bull Board plugin
  app.addHook('preHandler', async (req, reply) => {
    const apiKey = opts.apiKey;
    if (!apiKey) return;
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health') return;
    if (!path.startsWith('/notifications') && !path.startsWith('/admin/queues') && path !== '/metrics') return;
    if (req.headers['x-api-key'] !== apiKey) {
      return reply.code(401).send({ error: 'thiếu hoặc sai header x-api-key' });
    }
  });

  await app.register(registerRoutes);

  const boardAdapter = new FastifyAdapter();
  boardAdapter.setBasePath('/admin/queues');
  createBullBoard({ queues: [new BullMQAdapter(notificationQueue)], serverAdapter: boardAdapter });
  await app.register(boardAdapter.registerPlugin(), { prefix: '/admin/queues' });

  return app;
}
