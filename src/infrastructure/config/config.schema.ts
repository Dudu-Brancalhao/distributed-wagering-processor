import { hostname } from "node:os";
import { z } from "zod";

export const APP_ROLES = ["api", "consumer", "outbox", "pending-reference"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

const rolesSchema = z
  .string()
  .default(APP_ROLES.join(","))
  .transform((raw) => raw.split(",").map((role) => role.trim()))
  .pipe(z.array(z.enum(APP_ROLES)).min(1))
  .transform((roles) => [...new Set(roles)]);

export const sqsConfigSchema = z.object({
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1).default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default("test"),
  SQS_ENDPOINT: z.url().default("http://localhost:4566"),
  SQS_WAGER_QUEUE_NAME: z.string().endsWith(".fifo").default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().endsWith(".fifo").default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith(".fifo").default("wagering-events.fifo"),
  SQS_MAX_RECEIVE_COUNT: positiveInt(5),
  SQS_VISIBILITY_TIMEOUT_S: positiveInt(30),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(20),
  SQS_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_HANDLER_CONCURRENCY: positiveInt(10),
  SQS_RETRY_BASE_S: positiveInt(2),
  SQS_RETRY_MAX_S: positiveInt(60),
});

export const appConfigSchema = sqsConfigSchema.extend({
  APP_ROLES: rolesSchema,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),
  DB_POOL_MAX: positiveInt(10),
  DB_LOCK_TIMEOUT_MS: positiveInt(2000),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(5000),
  DB_TRANSACTION_TIMEOUT_MS: positiveInt(8000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: positiveInt(10000),
  DB_CONNECT_TIMEOUT_MS: positiveInt(2000),
  DB_QUERY_TIMEOUT_MS: positiveInt(6000),
  LOCK_CONTENTION_THRESHOLD_MS: positiveInt(10),
  OUTBOX_POLL_INTERVAL_MS: positiveInt(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  OUTBOX_RETRY_BASE_MS: positiveInt(1000),
  OUTBOX_RETRY_MAX_MS: positiveInt(300000),
  PENDING_REFERENCE_POLL_INTERVAL_MS: positiveInt(1000),
  PENDING_REFERENCE_MAX_ATTEMPTS: positiveInt(20),
  PENDING_REFERENCE_RETRY_BASE_MS: positiveInt(1000),
  PENDING_REFERENCE_RETRY_MAX_MS: positiveInt(300000),
  SHUTDOWN_GRACE_MS: positiveInt(20000),
});

export type SqsConfig = z.infer<typeof sqsConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
