/**
 * Edge / Browser WebAssembly (`WASM`) Pricing Kernel (`packages/kernel/src/wasm-kernel.ts`).
 *
 * Compiles and instantiates a portable WebAssembly binary that executes 64-bit integer
 * Round-Half-Up basis-point pricing (`apply_bps_wasm`) and VAT extraction (`extract_vat_net_wasm`)
 * identically across Cloudflare Workers, Deno, Bun, Node 22+, and browsers.
 */

import type { Bps, MinorUnits } from "./index.ts";

/**
 * Assembles the portable WebAssembly module exporting:
 * - `apply_bps_wasm(amount: i64, bps: i64) -> i64`: `((amount * bps) + 5000) / 10000`
 * - `extract_vat_net_wasm(gross: i64, rate_bps: i64) -> i64`: `((gross * 10000) + ((10000 + rate) / 2)) / (10000 + rate)`
 */
export function buildCommerceKernelWasmBytes(): Uint8Array {
  const nameApplyBps = new TextEncoder().encode("apply_bps_wasm");
  const nameExtractVat = new TextEncoder().encode("extract_vat_net_wasm");

  // Function 0 body: apply_bps_wasm(param 0: i64, param 1: i64) -> i64
  // ((local.get 0 * local.get 1) + 5000) / 10000
  // 5000 in signed LEB128 = [0x88, 0x27]
  // 10000 in signed LEB128 = [0x90, 0xce, 0x00] (3 bytes because bit 6 of 0x4e is 1)
  const bodyApplyBps = [
    0x00, // 0 locals
    0x20, 0x00, // local.get 0 (amount)
    0x20, 0x01, // local.get 1 (bps)
    0x7e, // i64.mul
    0x42, 0x88, 0x27, // i64.const 5000
    0x7c, // i64.add
    0x42, 0x90, 0xce, 0x00, // i64.const 10000
    0x7f, // i64.div_s
    0x0b, // end
  ];

  // Function 1 body: extract_vat_net_wasm(param 0: gross i64, param 1: rate_bps i64) -> i64
  // ((gross * 10000) + ((10000 + rate_bps) / 2)) / (10000 + rate_bps)
  const bodyExtractVat = [
    0x00, // 0 locals
    0x20, 0x00, // local.get 0 (gross)
    0x42, 0x90, 0xce, 0x00, // i64.const 10000
    0x7e, // i64.mul
    0x42, 0x90, 0xce, 0x00, // i64.const 10000
    0x20, 0x01, // local.get 1 (rate_bps)
    0x7c, // i64.add
    0x42, 0x02, // i64.const 2
    0x7f, // i64.div_s
    0x7c, // i64.add
    0x42, 0x90, 0xce, 0x00, // i64.const 10000
    0x20, 0x01, // local.get 1 (rate_bps)
    0x7c, // i64.add
    0x7f, // i64.div_s
    0x0b, // end
  ];

  const exportPayload = [
    0x02, // 2 exports
    nameApplyBps.length,
    ...nameApplyBps,
    0x00,
    0x00, // func 0
    nameExtractVat.length,
    ...nameExtractVat,
    0x00,
    0x01, // func 1
  ];

  const codePayload = [
    0x02, // 2 function bodies
    bodyApplyBps.length,
    ...bodyApplyBps,
    bodyExtractVat.length,
    ...bodyExtractVat,
  ];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // Type section: 1 type (i64, i64) -> i64
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e,
    // Function section: 2 funcs of type 0
    0x03, 0x03, 0x02, 0x00, 0x00,
    // Export section
    0x07,
    exportPayload.length,
    ...exportPayload,
    // Code section
    0x0a,
    codePayload.length,
    ...codePayload,
  ]);
}

export interface WasmPricingKernelInstance {
  applyBps(amount: MinorUnits, bps: Bps): MinorUnits;
  extractVatNet(grossAmount: MinorUnits, taxRateBps: Bps): MinorUnits;
}

export async function instantiateWasmPricingKernel(): Promise<WasmPricingKernelInstance> {
  const bytes = buildCommerceKernelWasmBytes();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const applyBpsFn = instance.exports["apply_bps_wasm"] as (
    amount: bigint,
    bps: bigint
  ) => bigint;
  const extractVatFn = instance.exports["extract_vat_net_wasm"] as (
    gross: bigint,
    rateBps: bigint
  ) => bigint;

  return {
    applyBps(amount, bps) {
      if (amount <= 0n || bps <= 0) return 0n;
      const clamped = BigInt(Math.min(Math.floor(bps), 10_000));
      return applyBpsFn(amount, clamped);
    },
    extractVatNet(grossAmount, taxRateBps) {
      if (grossAmount <= 0n || taxRateBps <= 0) return grossAmount > 0n ? grossAmount : 0n;
      return extractVatFn(grossAmount, BigInt(Math.floor(taxRateBps)));
    },
  };
}
