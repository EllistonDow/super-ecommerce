import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildShippingSurchargeWasm,
  runWasmSandboxStressBenchmark,
  WasmPluginSandboxHost,
} from "./index.ts";

describe("@super-ecommerce/plugin-sdk — WASM Sandbox Host", () => {
  it("executes a sandboxed WASM shipping surcharge function in < 5ms with zero host imports", async () => {
    const host = new WasmPluginSandboxHost();
    await host.registerWasmPlugin({
      pluginId: "heavy-freight-surcharge",
      name: "Heavy Freight Surcharge WASM Function",
      maxExecutionMs: 5,
      wasmBytes: buildShippingSurchargeWasm("RETURN_1200"),
    });

    const res = await host.executeShippingSurchargeWasm({
      pluginId: "heavy-freight-surcharge",
      fallbackSurcharge: 0n,
      ctx: {
        channelSlug: "us-retail",
        countryCode: "US",
        currencyCode: "USD",
        cartSubtotalAmount: 15_000n,
        totalWeightGrams: 12_500,
        isB2bCustomer: false,
      },
    });

    assert.equal(res.usedFallback, false);
    assert.equal(res.faultKind, "NONE");
    assert.equal(res.output, 1200n); // $12.00 surcharge from WASM
    assert.ok(res.durationMs < 5);
  });

  it("isolates WASM runtime traps (unreachable, div-by-zero, OOB memory) and falls back gracefully without crashing checkout", async () => {
    const host = new WasmPluginSandboxHost();
    await host.registerWasmPlugin({
      pluginId: "faulty-unreachable",
      name: "Faulty Unreachable Plugin",
      maxExecutionMs: 5,
      wasmBytes: buildShippingSurchargeWasm("TRAP_UNREACHABLE"),
    });
    await host.registerWasmPlugin({
      pluginId: "faulty-div-zero",
      name: "Faulty DivByZero Plugin",
      maxExecutionMs: 5,
      wasmBytes: buildShippingSurchargeWasm("TRAP_DIV_ZERO"),
    });
    await host.registerWasmPlugin({
      pluginId: "faulty-oob-memory",
      name: "Faulty OOB Memory Plugin",
      maxExecutionMs: 5,
      maxMemoryPages: 1,
      wasmBytes: buildShippingSurchargeWasm("TRAP_OOB_MEMORY"),
    });

    const ctx = {
      channelSlug: "us-retail",
      countryCode: "US",
      currencyCode: "USD",
      cartSubtotalAmount: 10_000n,
      totalWeightGrams: 1000,
      isB2bCustomer: false,
    };

    const r1 = await host.executeShippingSurchargeWasm({
      pluginId: "faulty-unreachable",
      fallbackSurcharge: 500n,
      ctx,
    });
    assert.equal(r1.usedFallback, true);
    assert.equal(r1.faultKind, "WASM_TRAP_UNREACHABLE");
    assert.equal(r1.output, 500n);

    const r2 = await host.executeShippingSurchargeWasm({
      pluginId: "faulty-div-zero",
      fallbackSurcharge: 500n,
      ctx,
    });
    assert.equal(r2.usedFallback, true);
    assert.equal(r2.faultKind, "WASM_TRAP_DIV_BY_ZERO");
    assert.equal(r2.output, 500n);

    const r3 = await host.executeShippingSurchargeWasm({
      pluginId: "faulty-oob-memory",
      fallbackSurcharge: 500n,
      ctx,
    });
    assert.equal(r3.usedFallback, true);
    assert.equal(r3.faultKind, "WASM_TRAP_OOB_MEMORY");
    assert.equal(r3.output, 500n);
  });

  it("blocks malicious host import declarations and enforces sub-millisecond SLA budget with multi-workload stress suite", async () => {
    const report = await runWasmSandboxStressBenchmark({
      scale: 0.2,
      forceRefresh: true,
    });

    assert.equal(report.hostEscapeCount, 0);
    assert.equal(report.workloads.length, 4);
    assert.equal(report.chaosCatalog.length, 5);
    assert.ok(report.peakOpsPerSec > 50_000);
    for (const c of report.chaosCatalog) {
      assert.equal(c.usedFallback, true);
    }
  });

  it("preemptively kills a true infinite WASM loop (br 0) in a worker isolate without blocking the main event loop", async () => {
    const host = new WasmPluginSandboxHost();
    try {
      await host.registerWasmPlugin({
        pluginId: "rogue-infinite-loop",
        name: "Rogue Infinite Loop WASM",
        maxExecutionMs: 25,
        wasmBytes: buildShippingSurchargeWasm("INFINITE_LOOP"),
      });
      await host.registerWasmPlugin({
        pluginId: "healthy-after-kill",
        name: "Healthy Weight Surcharge WASM",
        maxExecutionMs: 50,
        wasmBytes: buildShippingSurchargeWasm("DYNAMIC_WEIGHT_SURCHARGE"),
      });

      let mainThreadHeartbeats = 0;
      const heartbeatTimer = setInterval(() => {
        mainThreadHeartbeats += 1;
      }, 5);

      const ctx = {
        channelSlug: "us-retail",
        countryCode: "US",
        currencyCode: "USD",
        cartSubtotalAmount: 20_000n,
        totalWeightGrams: 3_000,
        isB2bCustomer: false,
      };

      const killedRes = await host.executePreemptiveShippingSurchargeWasm({
        pluginId: "rogue-infinite-loop",
        fallbackSurcharge: 999n,
        ctx,
      });
      clearInterval(heartbeatTimer);

      assert.equal(killedRes.usedFallback, true);
      assert.equal(killedRes.faultKind, "BUDGET_TIMEOUT_EXCEEDED");
      assert.equal(killedRes.output, 999n);
      assert.ok(
        mainThreadHeartbeats >= 1,
        "Main Node.js event loop remained responsive during WASM infinite loop"
      );

      //FAIL_CLOSED policy throws instead of silently falling back
      await assert.rejects(() =>
        host.executePreemptiveShippingSurchargeWasm({
          pluginId: "rogue-infinite-loop",
          fallbackSurcharge: 999n,
          failurePolicy: "FAIL_CLOSED",
          ctx,
        })
      );

      // Sandbox automatically respawns a fresh clean worker for subsequent healthy plugins!
      const healthyRes = await host.executePreemptiveShippingSurchargeWasm({
        pluginId: "healthy-after-kill",
        fallbackSurcharge: 0n,
        ctx,
      });
      assert.equal(healthyRes.usedFallback, false);
      assert.equal(healthyRes.output, 750n); // (3000 / 10) + 450 = 750
    } finally {
      await host.close();
    }
  });
});
