import type { DynamicModule, Type } from "@nestjs/common";
import type { AppRole } from "./infrastructure/config/config.schema";
import { WageringApiModule } from "./interfaces/http/wagering-api.module";

type RoleModule = Type<unknown> | DynamicModule;

/**
 * Modules each process role contributes. Later slices register here:
 * consumer (S-05), outbox (S-06), pending-reference (S-07).
 */
const ROLE_MODULES: Readonly<Record<AppRole, readonly RoleModule[]>> = {
  api: [WageringApiModule],
  consumer: [],
  outbox: [],
  "pending-reference": [],
};

export function modulesForRoles(roles: readonly AppRole[]): RoleModule[] {
  return roles.flatMap((role) => ROLE_MODULES[role]);
}
