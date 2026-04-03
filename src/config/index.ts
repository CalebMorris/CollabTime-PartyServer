import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().url().optional(),
  HEARTBEAT_PING_MS: z.coerce.number().int().positive().default(20_000),
  HEARTBEAT_PONG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  HEARTBEAT_GRACE_PERIOD_MS: z.coerce.number().int().positive().default(30_000),
  ROOM_TTL_MS: z.coerce.number().int().positive().default(7_200_000),
  GC_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BACKOFF_AFTER: z.coerce.number().int().positive().default(3),
  MAX_PARTICIPANTS_PER_ROOM: z.coerce.number().int().positive().default(50),
  EVENT_LOOP_LAG_THRESHOLD_MS: z.coerce.number().int().positive().default(100),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && !data.CORS_ORIGIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CORS_ORIGIN is required in production',
      path: ['CORS_ORIGIN'],
    });
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
