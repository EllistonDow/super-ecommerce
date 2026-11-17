/**
 * `@super-ecommerce/configurator` Standalone Commerce-as-Code CLI
 * (`packages/configurator/src/cli.ts`).
 *
 * Usage:
 *   npm run configurator -- introspect [--remote state.json] [--out store.config.ts] [--format json|ts] [--json]
 *   npm run configurator -- diff [--config desired.json] [--remote state.json] [--json]
 *   npm run configurator -- deploy [--config desired.json] [--remote state.json] [--dry-run] [--json]
 *   npm run configurator -- validate [--config desired.json] [--json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BASELINE_DESIRED_STORE_CONFIG,
  ConfigValidationError,
  deployStoreConfig,
  diffStoreConfig,
  parseStoreConfigJson,
  parseStoreConfigText,
  serializeStoreConfigJson,
  serializeStoreConfigYaml,
  validateStoreConfig,
  type ConfigDiffPlan,
  type StoreConfigDocument,
} from "./index.ts";

export { parseStoreConfigJson, serializeStoreConfigJson };

export interface CliRunOptions {
  readonly cwd?: string;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
  readonly jsonPayload?: unknown;
}

export function renderStoreConfigTypeScript(doc: StoreConfigDocument): string {
  const jsonBody = serializeStoreConfigJson(doc, true).replace(
    /"(priceAmount|compareAtAmount|unitAmount)":\s*"(\d+)"/g,
    '"$1": $2n'
  );
  return [
    `import type { StoreConfigDocument } from "@super-ecommerce/configurator";`,
    ``,
    `export const storeConfig: StoreConfigDocument = ${jsonBody};`,
    ``,
  ].join("\n");
}

function emptyStoreConfig(): StoreConfigDocument {
  return {
    warehouses: [],
    channels: [],
    productTypes: [],
    products: [],
  };
}

function parseCliFlags(args: readonly string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return {
    command: positional[0] ?? "help",
    flags,
  };
}

function formatTopologicalPlanText(plan: ConfigDiffPlan, header: string): string {
  const lines: string[] = [
    header,
    `Topological Order: warehouses -> channels -> productTypes -> products`,
    `Total Changes: ${plan.totalChanges}`,
  ];
  if (plan.entries.length === 0) {
    lines.push("  [OK] 0 Changes Detected (IDEMPOTENT_NOOP)");
    return lines.join("\n");
  }
  for (let i = 0; i < plan.entries.length; i++) {
    const e = plan.entries[i]!;
    lines.push(
      `  ${i + 1}. [${e.operation}] (${e.stage}) ${e.slug} :: ${e.summary}`
    );
  }
  return lines.join("\n");
}

export function runConfiguratorCli(
  argv: readonly string[],
  options?: CliRunOptions
): CliRunResult {
  const cwd = options?.cwd ?? process.cwd();
  const { command, flags } = parseCliFlags(argv);
  const asJson = Boolean(flags["json"]);

  if (command === "help" || flags["help"] === true) {
    const helpText = [
      "Super Ecommerce Configurator CLI (Commerce-as-Code GitOps)",
      "",
      "Commands:",
      "  introspect [--remote <file>] [--out <file>] [--format json|ts] [--json]",
      "  diff       [--config <file>] [--remote <file>] [--json]",
      "  deploy     [--config <file>] [--remote <file>] [--dry-run] [--json]",
      "  validate   [--config <file>] [--json]",
    ].join("\n");
    return { exitCode: 0, stdout: helpText, stderr: "", command };
  }

  const readDocOrDefault = (
    flagName: string,
    fallback: StoreConfigDocument
  ): StoreConfigDocument => {
    const pathVal = flags[flagName];
    if (typeof pathVal !== "string") return fallback;
    const absPath = resolve(cwd, pathVal);
    if (!existsSync(absPath)) {
      throw new Error(`Configuration file not found: ${absPath}`);
    }
    return parseStoreConfigText(readFileSync(absPath, "utf8")).document;
  };

  try {
    if (command === "introspect") {
      const remotePath = flags["remote"];
      const remoteDoc =
        typeof remotePath === "string" && existsSync(resolve(cwd, remotePath))
          ? parseStoreConfigJson(readFileSync(resolve(cwd, remotePath), "utf8"))
          : structuredClone(BASELINE_DESIRED_STORE_CONFIG);

      const format =
        flags["format"] === "ts" ||
        (typeof flags["out"] === "string" && flags["out"].endsWith(".ts"))
          ? "ts"
          : flags["format"] === "yaml" ||
            flags["format"] === "yml" ||
            (typeof flags["out"] === "string" &&
              (flags["out"].endsWith(".yaml") || flags["out"].endsWith(".yml")))
          ? "yaml"
          : "json";
      const rendered =
        format === "ts"
          ? renderStoreConfigTypeScript(remoteDoc)
          : format === "yaml"
          ? serializeStoreConfigYaml(remoteDoc)
          : serializeStoreConfigJson(remoteDoc, true);

      if (typeof flags["out"] === "string") {
        const outAbs = resolve(cwd, flags["out"]);
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, rendered + "\n", "utf8");
      }

      if (asJson) {
        const payload = {
          ok: true,
          command: "introspect",
          format,
          wroteFile: typeof flags["out"] === "string" ? flags["out"] : null,
          counts: {
            warehouses: remoteDoc.warehouses.length,
            channels: remoteDoc.channels.length,
            productTypes: remoteDoc.productTypes.length,
            products: remoteDoc.products.length,
          },
          storeConfig: remoteDoc,
        };
        return {
          exitCode: 0,
          stdout: serializeStoreConfigJson(payload, true),
          stderr: "",
          command,
          jsonPayload: payload,
        };
      }

      return {
        exitCode: 0,
        stdout:
          typeof flags["out"] === "string"
            ? `Introspected store config (${remoteDoc.warehouses.length} warehouses, ${remoteDoc.channels.length} channels, ${remoteDoc.productTypes.length} productTypes, ${remoteDoc.products.length} products) -> ${flags["out"]}`
            : rendered,
        stderr: "",
        command,
      };
    }

    if (command === "validate") {
      const desiredDoc = readDocOrDefault("config", BASELINE_DESIRED_STORE_CONFIG);
      validateStoreConfig(desiredDoc);
      const payload = {
        ok: true,
        command: "validate",
        counts: {
          warehouses: desiredDoc.warehouses.length,
          channels: desiredDoc.channels.length,
          productTypes: desiredDoc.productTypes.length,
          products: desiredDoc.products.length,
        },
      };
      return {
        exitCode: 0,
        stdout: asJson
          ? serializeStoreConfigJson(payload, true)
          : `PRE-FLIGHT VALIDATION PASSED (${desiredDoc.warehouses.length} warehouses, ${desiredDoc.channels.length} channels, ${desiredDoc.productTypes.length} productTypes, ${desiredDoc.products.length} products)`,
        stderr: "",
        command,
        jsonPayload: payload,
      };
    }

    if (command === "diff") {
      const desiredDoc = readDocOrDefault("config", BASELINE_DESIRED_STORE_CONFIG);
      const remotePath = flags["remote"];
      const remoteDoc =
        typeof remotePath === "string" && existsSync(resolve(cwd, remotePath))
          ? parseStoreConfigJson(readFileSync(resolve(cwd, remotePath), "utf8"))
          : emptyStoreConfig();

      const t0 = process.hrtime.bigint();
      const plan = diffStoreConfig(remoteDoc, desiredDoc);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

      const payload = {
        ok: true,
        command: "diff",
        durationUs,
        plan,
      };
      return {
        exitCode: 0,
        stdout: asJson
          ? serializeStoreConfigJson(payload, true)
          : formatTopologicalPlanText(
              plan,
              `CONFIGURATOR DIFF (${durationUs} us)`
            ),
        stderr: "",
        command,
        jsonPayload: payload,
      };
    }

    if (command === "deploy") {
      const desiredDoc = readDocOrDefault("config", BASELINE_DESIRED_STORE_CONFIG);
      const remotePath = flags["remote"];
      const remoteDoc =
        typeof remotePath === "string" && existsSync(resolve(cwd, remotePath))
          ? parseStoreConfigJson(readFileSync(resolve(cwd, remotePath), "utf8"))
          : emptyStoreConfig();

      const dryRun = Boolean(flags["dry-run"]);
      const t0 = process.hrtime.bigint();
      const { plan, nextState } = deployStoreConfig(remoteDoc, desiredDoc);
      const durationUs =
        Math.round((Number(process.hrtime.bigint() - t0) / 1_000) * 10) / 10;

      if (!dryRun && typeof remotePath === "string") {
        const remoteAbs = resolve(cwd, remotePath);
        mkdirSync(dirname(remoteAbs), { recursive: true });
        writeFileSync(remoteAbs, serializeStoreConfigJson(nextState, true) + "\n", "utf8");
      }

      const status =
        plan.totalChanges === 0
          ? "IDEMPOTENT_NOOP"
          : dryRun
          ? "DRY_RUN_PLANNED"
          : "APPLIED";
      const payload = {
        ok: true,
        command: "deploy",
        status,
        dryRun,
        durationUs,
        remoteStatePath: typeof remotePath === "string" ? remotePath : null,
        plan,
      };

      return {
        exitCode: 0,
        stdout: asJson
          ? serializeStoreConfigJson(payload, true)
          : formatTopologicalPlanText(
              plan,
              `CONFIGURATOR DEPLOY [${status}] (${durationUs} us)`
            ),
        stderr: "",
        command,
        jsonPayload: payload,
      };
    }

    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown configurator command '${command}'. Run with --help for usage.`,
      command,
    };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      const payload = {
        ok: false,
        command,
        error: "CONFIG_PREFLIGHT_VALIDATION_FAILED",
        issues: err.issues,
      };
      return {
        exitCode: 1,
        stdout: asJson ? serializeStoreConfigJson(payload, true) : "",
        stderr: asJson ? "" : err.message,
        command,
        jsonPayload: payload,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    const payload = { ok: false, command, error: msg };
    return {
      exitCode: 1,
      stdout: asJson ? serializeStoreConfigJson(payload, true) : "",
      stderr: asJson ? "" : `Configurator CLI error: ${msg}`,
      command,
      jsonPayload: payload,
    };
  }
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = runConfiguratorCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout + "\n");
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exitCode = result.exitCode;
}
