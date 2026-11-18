/**
 * Edge / Browser WebAssembly (`WASM`) Pricing Kernel (`packages/kernel/src/wasm-kernel.ts`).
 *
 * Loads the genuine Rust-compiled `commerce_kernel.wasm` binary built from `crates/kernel-wasm`
 * (`wasm32-unknown-unknown`), sharing 100% single-source logic with `commerce_kernel.node` across:
 * - `applyBps` & `extractVatNet` & `currencyExponent`
 * - Full Two-Pass Hare-Niemeyer + Margin Floor Guard `calculateCart`
 * - `allocateProRata`, `calculateReturnRefund`, and `evaluateB2bPurchasePolicy`
 *
 * Retains a minimal inline WASM binary fallback if `commerce_kernel.wasm` is not present on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AllocatedShare,
  B2bPurchasePolicyInput,
  B2bPurchasePolicyResult,
  Bps,
  CartCalculationInput,
  CartCalculationResult,
  MinorUnits,
  RefundCalculationInput,
  RefundCalculationResult,
  WeightedItem,
} from "./index.ts";
import {
  decodeB2bPolicyPayload,
  decodeCartPayload,
  decodeProRataPayload,
  decodeReturnRefundPayload,
  encodeB2bPolicyPayload,
  encodeCartPayload,
  encodeProRataPayload,
  encodeReturnRefundPayload,
} from "./rust-bridge.ts";

function buildMinimalFallbackWasmBytes(): Uint8Array {
  const nameApplyBps = new TextEncoder().encode("apply_bps_wasm");
  const nameExtractVat = new TextEncoder().encode("extract_vat_net_wasm");
  const bodyApplyBps = [
    0x00, 0x20, 0x00, 0x20, 0x01, 0x7e, 0x42, 0x88, 0x27, 0x7c, 0x42, 0x90, 0xce, 0x00, 0x7f, 0x0b,
  ];
  const bodyExtractVat = [
    0x00, 0x20, 0x00, 0x42, 0x90, 0xce, 0x00, 0x7e, 0x42, 0x90, 0xce, 0x00, 0x20, 0x01, 0x7c,
    0x42, 0x02, 0x7f, 0x7c, 0x42, 0x90, 0xce, 0x00, 0x20, 0x01, 0x7c, 0x7f, 0x0b,
  ];
  const exportPayload = [
    0x02,
    nameApplyBps.length,
    ...nameApplyBps,
    0x00,
    0x00,
    nameExtractVat.length,
    ...nameExtractVat,
    0x00,
    0x01,
  ];
  const codePayload = [
    0x02,
    bodyApplyBps.length,
    ...bodyApplyBps,
    bodyExtractVat.length,
    ...bodyExtractVat,
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e,
    0x03, 0x03, 0x02, 0x00, 0x00,
    0x07, exportPayload.length, ...exportPayload,
    0x0a, codePayload.length, ...codePayload,
  ]);
}

let cachedCompiledWasmBytes: Uint8Array | null = null;

/**
 * Loads the compiled `crates/kernel-wasm` WebAssembly binary (`commerce_kernel.wasm`) once and
 * caches the bytes in memory, falling back to the minimal inline WASM binary in stripped environments.
 */
export function buildCommerceKernelWasmBytes(): Uint8Array {
  if (cachedCompiledWasmBytes) {
    return cachedCompiledWasmBytes;
  }
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const wasmPath = join(__dirname, "../native/commerce_kernel.wasm");
    if (existsSync(wasmPath)) {
      cachedCompiledWasmBytes = new Uint8Array(readFileSync(wasmPath));
      return cachedCompiledWasmBytes;
    }
  } catch {
    // Ignore FS errors in pure Edge/Browser runtimes
  }
  cachedCompiledWasmBytes = buildMinimalFallbackWasmBytes();
  return cachedCompiledWasmBytes;
}

export interface WasmPricingKernelInstance {
  readonly isCompiledFromRustCrate: boolean;
  applyBps(amount: MinorUnits, bps: Bps): MinorUnits;
  extractVatNet(grossAmount: MinorUnits, taxRateBps: Bps): MinorUnits;
  currencyExponent(currencyCode: string): number;
  calculateCart?(input: CartCalculationInput): CartCalculationResult;
  allocateProRata?(totalToAllocate: MinorUnits, items: readonly WeightedItem[]): AllocatedShare[];
  calculateReturnRefund?(input: RefundCalculationInput): RefundCalculationResult;
  evaluateB2bPurchasePolicy?(input: B2bPurchasePolicyInput): B2bPurchasePolicyResult;
}

export async function instantiateWasmPricingKernel(
  customBytes?: Uint8Array
): Promise<WasmPricingKernelInstance> {
  const bytes = customBytes ?? buildCommerceKernelWasmBytes();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;

  const applyBpsFn = exports["apply_bps_wasm"] as (amount: bigint, bps: bigint) => bigint;
  const extractVatFn = exports["extract_vat_net_wasm"] as (gross: bigint, rateBps: bigint) => bigint;
  const currencyExpFn = exports["currency_exponent_wasm"] as
    | ((c0: number, c1: number, c2: number) => number)
    | undefined;
  const memory = exports["memory"] as WebAssembly.Memory | undefined;
  const allocFn = exports["wasm_alloc"] as ((size: number) => number) | undefined;
  const deallocFn = exports["wasm_dealloc"] as ((ptr: number, cap: number) => void) | undefined;
  const calcCartFn = exports["wasm_calculate_cart"] as
    | ((ptr: number, len: number) => bigint)
    | undefined;
  const allocProRataFn = exports["wasm_allocate_pro_rata"] as
    | ((total: bigint, ptr: number, len: number) => bigint)
    | undefined;
  const calcRefundFn = exports["wasm_calculate_return_refund"] as
    | ((ptr: number, len: number) => bigint)
    | undefined;
  const evalB2bFn = exports["wasm_evaluate_b2b_policy"] as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function invokeLinearMemoryCodec(
    inputPayload: string,
    callFn: (ptr: number, len: number) => bigint
  ): string {
    if (!memory || !allocFn || !deallocFn) {
      throw new Error("Full Rust WASM linear memory exports unavailable");
    }
    const encoded = encoder.encode(inputPayload);
    const inPtr = encoded.length > 0 ? allocFn(encoded.length) : 0;
    try {
      if (encoded.length > 0) {
        new Uint8Array(memory.buffer, inPtr, encoded.length).set(encoded);
      }
      const packed = callFn(inPtr, encoded.length);
      const outPtr = Number((packed >> 32n) & 0xffff_ffffn);
      const outLen = Number(packed & 0xffff_ffffn);
      if (outLen === 0 || outPtr === 0) {
        return "";
      }
      try {
        const outSlice = new Uint8Array(memory.buffer, outPtr, outLen);
        return decoder.decode(outSlice);
      } finally {
        deallocFn(outPtr, outLen);
      }
    } finally {
      if (encoded.length > 0 && inPtr !== 0) {
        deallocFn(inPtr, encoded.length);
      }
    }
  }

  const isCompiledFromRustCrate = Boolean(memory && allocFn && deallocFn && calcCartFn);

  return {
    isCompiledFromRustCrate,
    applyBps(amount, bps) {
      if (amount <= 0n || bps <= 0) return 0n;
      const clamped = BigInt(Math.min(Math.floor(bps), 10_000));
      return applyBpsFn(amount, clamped);
    },
    extractVatNet(grossAmount, taxRateBps) {
      if (grossAmount <= 0n || taxRateBps <= 0) return grossAmount > 0n ? grossAmount : 0n;
      return extractVatFn(grossAmount, BigInt(Math.floor(taxRateBps)));
    },
    currencyExponent(currencyCode) {
      const trimmed = currencyCode.trim().toUpperCase();
      if (trimmed.length !== 3) return 2;
      if (currencyExpFn) {
        return currencyExpFn(
          trimmed.charCodeAt(0),
          trimmed.charCodeAt(1),
          trimmed.charCodeAt(2)
        );
      }
      return 2;
    },
    calculateCart: isCompiledFromRustCrate
      ? (input) => {
          const raw = invokeLinearMemoryCodec(encodeCartPayload(input), calcCartFn!);
          return decodeCartPayload(raw, input.currencyCode);
        }
      : undefined,
    allocateProRata:
      isCompiledFromRustCrate && allocProRataFn
        ? (total, items) => {
            if (items.length === 0) return [];
            const raw = invokeLinearMemoryCodec(encodeProRataPayload(items), (p, l) =>
              allocProRataFn(total, p, l)
            );
            return decodeProRataPayload(raw);
          }
        : undefined,
    calculateReturnRefund:
      isCompiledFromRustCrate && calcRefundFn
        ? (input) => {
            const raw = invokeLinearMemoryCodec(encodeReturnRefundPayload(input), calcRefundFn);
            return decodeReturnRefundPayload(raw, input.currencyCode);
          }
        : undefined,
    evaluateB2bPurchasePolicy:
      isCompiledFromRustCrate && evalB2bFn
        ? (input) => {
            const raw = invokeLinearMemoryCodec(encodeB2bPolicyPayload(input), evalB2bFn);
            return decodeB2bPolicyPayload(raw, input.cart.currencyCode);
          }
        : undefined,
  };
}
