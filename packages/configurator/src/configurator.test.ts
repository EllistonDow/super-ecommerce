import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfflinePgPool, runMigrations } from "@super-ecommerce/db";
import {
  BASELINE_DESIRED_STORE_CONFIG,
  ConfigValidationError,
  deployStoreConfig,
  diffStoreConfig,
  parseStoreConfigText,
  PgStoreConfigurator,
  serializeStoreConfigYaml,
  StatefulStoreConfigurator,
  type StoreConfigDocument,
} from "./index.ts";
import { parseStoreConfigJson, runConfiguratorCli } from "./cli.ts";

describe("@super-ecommerce/configurator", () => {
  const emptyStore: StoreConfigDocument = {
    warehouses: [],
    channels: [],
    productTypes: [],
    products: [],
  };

  const targetConfig: StoreConfigDocument = {
    warehouses: [
      { slug: "us-east", name: "US East Warehouse", countryCode: "US" },
    ],
    channels: [
      {
        slug: "us-retail",
        name: "US Retail Store",
        currencyCode: "USD",
        defaultCountry: "US",
        warehouseSlugs: ["us-east"],
      },
    ],
    productTypes: [
      {
        slug: "mechanical-keyboard",
        name: "Mechanical Keyboard",
        productAttributesSchema: [
          { slug: "layout", name: "Layout", type: "ENUM", required: true, allowedValues: ["65%", "75%", "TKL"] },
        ],
        variantAttributesSchema: [
          { slug: "switch", name: "Switch Type", type: "ENUM", required: true, allowedValues: ["linear", "tactile"] },
        ],
      },
    ],
    products: [
      {
        slug: "cyber-board-75",
        name: "CyberBoard 75",
        productTypeSlug: "mechanical-keyboard",
        attributes: { layout: "75%" },
        variants: [
          {
            sku: "CB75-LIN",
            name: "Linear Switch",
            attributes: { switch: "linear" },
            channelListings: [
              { channelSlug: "us-retail", isPublished: true, priceAmount: 29_900n },
            ],
          },
        ],
      },
    ],
  };

  it("plans topological deployment order and guarantees zero-diff idempotency on second run", () => {
    const firstDeploy = deployStoreConfig(emptyStore, targetConfig);
    assert.equal(firstDeploy.plan.totalChanges, 4);
    assert.deepEqual(
      firstDeploy.plan.entries.map((e) => `${e.stage}:${e.operation}:${e.slug}`),
      [
        "warehouses:CREATE:us-east",
        "channels:CREATE:us-retail",
        "productTypes:CREATE:mechanical-keyboard",
        "products:CREATE:cyber-board-75",
      ]
    );

    // Second deploy with identical config produces 0 changes (strict idempotency)
    const secondDiff = diffStoreConfig(firstDeploy.nextState, targetConfig);
    assert.equal(secondDiff.totalChanges, 0);

    // Renaming a ProductType's display name (keeping its slug) produces an in-place UPDATE, NOT a duplicate!
    const renamedConfig: StoreConfigDocument = {
      ...targetConfig,
      productTypes: [
        {
          ...targetConfig.productTypes[0]!,
          name: "Custom Mechanical Keyboard Pro",
        },
      ],
    };
    const renameDiff = diffStoreConfig(firstDeploy.nextState, renamedConfig);
    assert.equal(renameDiff.totalChanges, 1);
    assert.equal(renameDiff.entries[0]?.operation, "UPDATE");
    assert.equal(renameDiff.entries[0]?.slug, "mechanical-keyboard");
  });

  it("aborts pre-flight validation on broken cross-references or invalid dynamic attributes", () => {
    const brokenConfig: StoreConfigDocument = {
      ...targetConfig,
      channels: [
        {
          ...targetConfig.channels[0]!,
          warehouseSlugs: ["non-existent-warehouse"],
        },
      ],
    };

    assert.throws(
      () => diffStoreConfig(emptyStore, brokenConfig),
      (err: unknown) =>
        err instanceof ConfigValidationError &&
        err.issues.some((i) => i.includes("unknown warehouse 'non-existent-warehouse'"))
    );
  });

  it("coordinates StatefulStoreConfigurator DAG deployment, 0-diff idempotency, in-place slug UPDATE, and Stage 1 guard", () => {
    const coord = new StatefulStoreConfigurator();
    assert.equal(coord.getCurrentDiffPlan().totalChanges, 5);

    const first = coord.deployDesiredConfig();
    assert.equal(first.plan.totalChanges, 5);
    assert.equal(first.audit.status, "APPLIED");
    assert.equal(coord.getRevision(), 1);

    const second = coord.deployDesiredConfig();
    assert.equal(second.plan.totalChanges, 0);
    assert.equal(second.audit.status, "IDEMPOTENT_NOOP");

    const driftPlan = coord.stageSlugRenameAndExpansionDrift();
    assert.equal(driftPlan.totalChanges, 4);
    assert.equal(
      driftPlan.entries.some(
        (e) => e.stage === "productTypes" && e.operation === "UPDATE" && e.slug === "precision-hardware"
      ),
      true
    );

    const guard = coord.simulatePreflightValidationGuard();
    assert.equal(guard.blocked, true);
    assert.equal(guard.issues.length >= 2, true);
    assert.equal(coord.listDeploymentHistory().length, 4);
  });

  it("runs standalone CLI introspect, validate, diff, and idempotent deploy preserving BigInt minor units", () => {
    const workDir = mkdtempSync(join(tmpdir(), "super-cfg-cli-"));
    try {
      const cfgJsonPath = join(workDir, "desired.json");
      const cfgTsPath = join(workDir, "store.config.ts");
      const remotePath = join(workDir, "remote-state.json");

      // 1. Introspect baseline store config to JSON & TypeScript
      const introspectJson = runConfiguratorCli(
        ["introspect", "--out", cfgJsonPath, "--json"],
        { cwd: workDir }
      );
      assert.equal(introspectJson.exitCode, 0);
      assert.equal(existsSync(cfgJsonPath), true);
      const parsedDesired = parseStoreConfigJson(readFileSync(cfgJsonPath, "utf8"));
      assert.equal(
        typeof parsedDesired.products[0]?.variants[0]?.channelListings[0]?.priceAmount,
        "bigint"
      );

      const introspectTs = runConfiguratorCli(
        ["introspect", "--out", cfgTsPath, "--format", "ts"],
        { cwd: workDir }
      );
      assert.equal(introspectTs.exitCode, 0);
      assert.match(readFileSync(cfgTsPath, "utf8"), /"priceAmount": 39000n/);

      // 2. Validate desired config
      const validateOk = runConfiguratorCli(
        ["validate", "--config", cfgJsonPath, "--json"],
        { cwd: workDir }
      );
      assert.equal(validateOk.exitCode, 0);

      // Broken config fails validation with exitCode 1
      const brokenPath = join(workDir, "broken.json");
      writeFileSync(
        brokenPath,
        JSON.stringify({
          warehouses: [],
          channels: [
            {
              slug: "bad-ch",
              name: "Bad",
              currencyCode: "USD",
              defaultCountry: "US",
              warehouseSlugs: ["missing-wh"],
            },
          ],
          productTypes: [],
          products: [],
        }),
        "utf8"
      );
      const validateFail = runConfiguratorCli(
        ["validate", "--config", brokenPath, "--json"],
        { cwd: workDir }
      );
      assert.equal(validateFail.exitCode, 1);

      // 3. Diff against empty remote state -> 5 topological changes
      const diffRes = runConfiguratorCli(
        ["diff", "--config", cfgJsonPath, "--remote", remotePath, "--json"],
        { cwd: workDir }
      );
      assert.equal(diffRes.exitCode, 0);
      assert.equal(
        (diffRes.jsonPayload as { plan: { totalChanges: number } }).plan.totalChanges,
        5
      );

      // 4. Dry-run deploy does NOT write remote-state.json
      const dryRun = runConfiguratorCli(
        ["deploy", "--config", cfgJsonPath, "--remote", remotePath, "--dry-run", "--json"],
        { cwd: workDir }
      );
      assert.equal(dryRun.exitCode, 0);
      assert.equal(
        (dryRun.jsonPayload as { status: string }).status,
        "DRY_RUN_PLANNED"
      );
      assert.equal(existsSync(remotePath), false);

      // 5. Real deploy writes remote-state.json; second deploy is IDEMPOTENT_NOOP (0 changes)
      const applyRun = runConfiguratorCli(
        ["deploy", "--config", cfgJsonPath, "--remote", remotePath, "--json"],
        { cwd: workDir }
      );
      assert.equal(applyRun.exitCode, 0);
      assert.equal((applyRun.jsonPayload as { status: string }).status, "APPLIED");
      assert.equal(existsSync(remotePath), true);

      const noopRun = runConfiguratorCli(
        ["deploy", "--config", cfgJsonPath, "--remote", remotePath, "--json"],
        { cwd: workDir }
      );
      assert.equal(noopRun.exitCode, 0);
      assert.equal((noopRun.jsonPayload as { status: string }).status, "IDEMPOTENT_NOOP");
      assert.equal(
        (noopRun.jsonPayload as { plan: { totalChanges: number } }).plan.totalChanges,
        0
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("round-trips StoreConfigDocument via native dependency-free YAML serializer & parser and supports online custom diff/deploy", () => {
    const yamlText = serializeStoreConfigYaml(BASELINE_DESIRED_STORE_CONFIG);
    assert.match(yamlText, /warehouses:/);
    assert.match(yamlText, /kronos-cnc-keyboard/);

    const parsed = parseStoreConfigText(yamlText);
    assert.equal(parsed.format, "yaml");
    assert.equal(parsed.document.warehouses.length, 2);
    assert.equal(
      parsed.document.products[0]?.variants[0]?.channelListings[0]?.priceAmount,
      39_000n
    );

    const diffCheck = diffStoreConfig(BASELINE_DESIRED_STORE_CONFIG, parsed.document);
    assert.equal(diffCheck.totalChanges, 0);

    const coord = new StatefulStoreConfigurator();
    coord.deployDesiredConfig();

    const customYaml = yamlText.replace(
      "Precision Hardware",
      "Precision Hardware YAML v3"
    );
    const preview = coord.previewCustomConfigText(customYaml);
    assert.equal(preview.ok, true);
    assert.equal(preview.format, "yaml");
    assert.equal(preview.plan?.totalChanges, 1);
    assert.equal(preview.plan?.entries[0]?.operation, "UPDATE");

    const deployed = coord.deployCustomConfigText(customYaml);
    assert.equal(deployed.ok, true);
    assert.equal(deployed.audit.status, "APPLIED");
    assert.equal(coord.getRevision(), 2);

    const brokenYaml = customYaml.replace("us-central", "nonexistent-wh");
    const rejected = coord.deployCustomConfigText(brokenYaml);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.audit.status, "BLOCKED_PREFLIGHT");
    assert.equal(coord.getRevision(), 2);
  });

  it("persists Store Configurator state, revisions, BigInt prices, and deployment audit logs across restarts in PostgreSQL", async () => {
    const pg = new OfflinePgPool();
    await runMigrations(pg);
    try {
      const cfgA = new PgStoreConfigurator(pg);
      assert.equal(await cfgA.getRevision(), 0);
      assert.equal((await cfgA.getCurrentDiffPlan()).totalChanges, 5);

      const first = await cfgA.deployDesiredConfig("alice@kronos.io");
      assert.equal(first.plan.totalChanges, 5);
      assert.equal(first.audit.status, "APPLIED");
      assert.equal(await cfgA.getRevision(), 1);

      const second = await cfgA.deployDesiredConfig("alice@kronos.io");
      assert.equal(second.plan.totalChanges, 0);
      assert.equal(second.audit.status, "IDEMPOTENT_NOOP");
      assert.equal(await cfgA.getRevision(), 1);

      // Fresh instance reads rev 1 and stages drift update
      const cfgB = new PgStoreConfigurator(pg);
      assert.equal(await cfgB.getRevision(), 1);
      const driftPlan = await cfgB.stageSlugRenameAndExpansionDrift("alice@kronos.io");
      assert.equal(driftPlan.totalChanges, 4);

      // Custom YAML deploy preserving BigInt minor units bumps to rev 2
      const baseYaml = await cfgB.getDesiredConfigYaml();
      const customYaml = baseYaml.replace("39000", "41500");
      const customRes = await cfgB.deployCustomConfigText(customYaml, "bob@kronos.io");
      assert.equal(customRes.ok, true);
      assert.equal(customRes.audit.status, "APPLIED");
      assert.equal(await cfgB.getRevision(), 2);

      // Broken config rejected at Stage 1 pre-flight without incrementing revision
      const brokenRes = await cfgB.deployCustomConfigText(
        customYaml.replace("us-central", "ghost-wh"),
        "bob@kronos.io"
      );
      assert.equal(brokenRes.ok, false);
      assert.equal(brokenRes.audit.status, "BLOCKED_PREFLIGHT");
      assert.equal(await cfgB.getRevision(), 2);

      // Brand-new instance reads persisted remoteState BigInt & full deployment history directly from PG
      const cfgC = new PgStoreConfigurator(pg);
      const remote = await cfgC.getRemoteState();
      const kbPrice = remote.products[0]?.variants[0]?.channelListings[0]?.priceAmount;
      assert.equal(typeof kbPrice, "bigint");
      assert.equal(kbPrice, 41_500n);

      const history = await cfgC.listDeploymentHistory(10);
      assert.equal(history.length, 5);
      assert.equal(history[0]?.status, "BLOCKED_PREFLIGHT");
      assert.equal(history[1]?.status, "APPLIED");
      assert.equal(history[1]?.revision, 2);
    } finally {
      await pg.close();
    }
  });
});
