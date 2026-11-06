import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly imports: readonly string[];
}

function sources(layer: string): SourceFile[] {
  return [...new Glob(`${layer}/**/*.ts`).scanSync({ cwd: SRC })].map((file) => {
    const path = join(SRC, file);
    const content = readFileSync(path, "utf8");
    const imports = [...content.matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? "");
    return { path, content, imports };
  });
}

/** Returns the src-relative target of a relative import, or the bare specifier for packages. */
function target(file: SourceFile, specifier: string): string {
  return specifier.startsWith(".") ? relative(SRC, resolve(dirname(file.path), specifier)) : specifier;
}

function violations(layer: string, allowed: (target: string) => boolean): string[] {
  return sources(layer).flatMap((file) =>
    file.imports
      .map((specifier) => target(file, specifier))
      .filter((resolved) => !allowed(resolved))
      .map((resolved) => `${relative(ROOT, file.path)} -> ${resolved}`),
  );
}

describe("architecture (P-1.2)", () => {
  test("the domain imports only the domain", () => {
    expect(violations("domain", (resolved) => resolved.startsWith("domain/"))).toEqual([]);
  });

  test("the application imports only the domain, the application and node:* modules", () => {
    expect(
      violations(
        "application",
        (resolved) =>
          resolved.startsWith("domain/") || resolved.startsWith("application/") || resolved.startsWith("node:"),
      ),
    ).toEqual([]);
  });

  test("no inner layer depends on infrastructure, interfaces or the composition root", () => {
    const outer = (resolved: string) =>
      /^(infrastructure|interfaces)\//.test(resolved) || /^(app\.module|main|roles|bootstrap)$/.test(resolved);
    expect([...violations("domain", (r) => !outer(r)), ...violations("application", (r) => !outer(r))]).toEqual([]);
  });
});

describe("static acceptance checks", () => {
  test("E-01: money code never uses JavaScript numbers", () => {
    const offenders = sources("domain/money").filter((file) =>
      /parseFloat|parseInt|Number\(|:\s*number\b/.test(file.content),
    );
    expect(offenders.map((file) => relative(ROOT, file.path))).toEqual([]);
  });

  test("E-06: only the event publisher and the DLQ gateway may send SQS messages", () => {
    const allowed = new Set(["infrastructure/sqs/sqs-event-publisher.ts", "infrastructure/sqs/sqs-queue-gateway.ts"]);
    const senders = ["domain", "application", "infrastructure", "interfaces"]
      .flatMap((layer) => sources(layer))
      .filter((file) => /SendMessage(Batch)?Command/.test(file.content))
      .map((file) => relative(SRC, file.path))
      .filter((path) => !allowed.has(path));
    expect(senders).toEqual([]);
  });
});
