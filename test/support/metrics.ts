import type { HttpClient } from "./test-app";

/**
 * The value of the first `name` series whose labels contain `label` (other labels, such as the instance, are ignored),
 * or 0 when the instance has not exposed that series yet.
 */
export async function metricValue(instance: HttpClient, name: string, label = ""): Promise<number> {
  const response = await fetch(`${instance.baseUrl}/metrics`);
  const line = (await response.text())
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{`) && candidate.includes(label));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}
