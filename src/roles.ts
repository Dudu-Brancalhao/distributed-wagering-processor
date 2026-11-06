import type { DynamicModule, Type } from "@nestjs/common";
import type { AppRole } from "./infrastructure/config/config.schema";
import { WageringApiModule } from "./interfaces/http/wagering-api.module";
import { SqsConsumerModule } from "./interfaces/sqs/sqs-consumer.module";
import { OutboxPublisherModule } from "./interfaces/workers/outbox-publisher.module";
import { PendingReferenceWorkerModule } from "./interfaces/workers/pending-reference-worker.module";

type RoleModule = Type<unknown> | DynamicModule;

/** Modules each process role contributes. */
const ROLE_MODULES: Readonly<Record<AppRole, readonly RoleModule[]>> = {
  api: [WageringApiModule],
  consumer: [SqsConsumerModule],
  outbox: [OutboxPublisherModule],
  "pending-reference": [PendingReferenceWorkerModule],
};

export function modulesForRoles(roles: readonly AppRole[]): RoleModule[] {
  return roles.flatMap((role) => ROLE_MODULES[role]);
}
