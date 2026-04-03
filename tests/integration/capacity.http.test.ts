import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

async function buildCapacityServer(capacityChecker: () => boolean) {
  const fastify = Fastify({ logger: false });

  fastify.get('/capacity', async () => {
    const accepting = capacityChecker();
    return { accepting_rooms: accepting, reason: accepting ? null : 'HIGH_LOAD' };
  });

  await fastify.listen({ port: 0, host: '127.0.0.1' });
  return fastify;
}

describe('GET /capacity', () => {
  let fastify: Awaited<ReturnType<typeof buildCapacityServer>>;

  afterEach(async () => {
    await fastify.close();
  });

  describe('when server is accepting rooms', () => {
    beforeEach(async () => {
      fastify = await buildCapacityServer(() => true);
    });

    it('returns 200', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/capacity' });
      expect(response.statusCode).toBe(200);
    });

    it('returns accepting_rooms: true with null reason', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/capacity' });
      expect(JSON.parse(response.body)).toEqual({ accepting_rooms: true, reason: null });
    });
  });

  describe('when server is not accepting rooms', () => {
    beforeEach(async () => {
      fastify = await buildCapacityServer(() => false);
    });

    it('returns 200', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/capacity' });
      expect(response.statusCode).toBe(200);
    });

    it('returns accepting_rooms: false with HIGH_LOAD reason', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/capacity' });
      expect(JSON.parse(response.body)).toEqual({ accepting_rooms: false, reason: 'HIGH_LOAD' });
    });
  });
});
