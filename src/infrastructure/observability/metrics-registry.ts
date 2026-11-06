import { collectDefaultMetrics, Registry } from "prom-client";

/** One registry per process; components register their own metrics on it. */
export function createMetricsRegistry(instanceId: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance_id: instanceId });
  collectDefaultMetrics({ register: registry });
  return registry;
}
