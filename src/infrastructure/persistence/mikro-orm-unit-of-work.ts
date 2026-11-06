import { RequestContext } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../application/ports/unit-of-work.port";
import { withDatabaseErrors } from "./pg-error-classifier";

/**
 * `em` is the context-resolved EntityManager: inside `transactional` every repository resolves the transaction's
 * fork, so a nested `run` joins the outer transaction (REQUIRED propagation) instead of opening a separate one.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return withDatabaseErrors(() => this.em.transactional(() => work()));
  }

  isolated<T>(work: () => Promise<T>): Promise<T> {
    return RequestContext.create(this.em, work);
  }
}
