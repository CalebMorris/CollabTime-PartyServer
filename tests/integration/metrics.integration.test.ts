import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopStats,
} from '../../src/metrics/eventloop.js';

async function buildServer() {
  const fastify = Fastify({ logger: false });
  fastify.get('/metrics', async () => ({ eventLoopLag: getEventLoopStats() }));
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  return fastify;
}

describe('GET /metrics', () => {
  let fastify: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    startEventLoopMonitor();
    fastify = await buildServer();
  });

  afterEach(async () => {
    await fastify.close();
    stopEventLoopMonitor();
  });

  it('returns 200', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
  });

  it('returns eventLoopLag with all expected fields', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/metrics' });
    const body = JSON.parse(response.body);
    expect(body.eventLoopLag).toMatchObject({
      meanMs: expect.any(Number),
      p50Ms: expect.any(Number),
      p95Ms: expect.any(Number),
      p99Ms: expect.any(Number),
      maxMs: expect.any(Number),
    });
  });

  it('returns null for eventLoopLag when monitor is not running', async () => {
    stopEventLoopMonitor();
    const response = await fastify.inject({ method: 'GET', url: '/metrics' });
    const body = JSON.parse(response.body);
    expect(body.eventLoopLag).toBeNull();
  });
});
