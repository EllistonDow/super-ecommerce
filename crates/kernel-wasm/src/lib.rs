//! WebAssembly (`wasm32-unknown-unknown`) bindings compiled directly from `commerce-kernel`.
//!
//! Eliminates hand-coded bytecode divergence by compiling the exact same Rust `commerce-kernel`
//! crate into `packages/kernel/native/commerce_kernel.wasm` for Edge Workers, Deno, Bun,
//! Node.js, and Browser optimistic cart/RMA calculation.

use std::mem;
use std::slice;

use commerce_kernel::money::{apply_bps, currency_exponent, extract_vat_net, Bps, MinorUnits};
use commerce_kernel::wire_codec::{
    exec_allocate_pro_rata, exec_calculate_cart, exec_calculate_return_refund,
    exec_evaluate_b2b_policy,
};

/// Allocates `size` bytes inside WASM linear memory for host UTF-8 input transfer.
#[no_mangle]
pub extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// Frees a buffer previously allocated by `wasm_alloc` or returned by a `wasm_*` codec function.
///
/// # Safety
/// `ptr` and `capacity` must originate from `wasm_alloc` or a `pack_output` Vec in this module.
#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, capacity: usize) {
    if !ptr.is_null() && capacity > 0 {
        drop(Vec::from_raw_parts(ptr, 0, capacity));
    }
}

fn pack_string_to_u64(s: String) -> u64 {
    let mut bytes = s.into_bytes().into_boxed_slice();
    let len = bytes.len() as u32;
    let ptr = bytes.as_mut_ptr() as usize as u32;
    mem::forget(bytes);
    ((ptr as u64) << 32) | (len as u64)
}

unsafe fn read_utf8_slice<'a>(ptr: *const u8, len: usize) -> &'a str {
    if ptr.is_null() || len == 0 {
        return "";
    }
    let bytes = slice::from_raw_parts(ptr, len);
    std::str::from_utf8(bytes).unwrap_or("")
}

#[no_mangle]
pub extern "C" fn apply_bps_wasm(amount: i64, bps: i64) -> i64 {
    if amount <= 0 || bps <= 0 {
        return 0;
    }
    let clamped = bps.min(10_000) as Bps;
    apply_bps(amount as MinorUnits, clamped)
}

#[no_mangle]
pub extern "C" fn extract_vat_net_wasm(gross: i64, rate_bps: i64) -> i64 {
    if gross <= 0 {
        return 0;
    }
    if rate_bps <= 0 {
        return gross;
    }
    extract_vat_net(gross as MinorUnits, rate_bps as Bps)
}

#[no_mangle]
pub extern "C" fn currency_exponent_wasm(c0: u32, c1: u32, c2: u32) -> u32 {
    let bytes = [c0 as u8, c1 as u8, c2 as u8];
    let code = std::str::from_utf8(&bytes).unwrap_or("USD");
    currency_exponent(code) as u32
}

/// Runs full Two-Pass Hare-Niemeyer + Margin Floor Guard `calculate_cart` inside WASM!
/// Returns `(out_ptr << 32) | out_len`; caller frees via `wasm_dealloc(out_ptr, out_len)`.
///
/// # Safety
/// `ptr` must point to `len` valid bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_calculate_cart(ptr: *const u8, len: usize) -> u64 {
    let payload = read_utf8_slice(ptr, len);
    pack_string_to_u64(exec_calculate_cart(payload))
}

/// Runs `allocate_pro_rata` inside WASM!
///
/// # Safety
/// `ptr` must point to `len` valid bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_allocate_pro_rata(total: i64, ptr: *const u8, len: usize) -> u64 {
    let payload = read_utf8_slice(ptr, len);
    pack_string_to_u64(exec_allocate_pro_rata(total, payload))
}

/// Runs multi-wave partial RMA refund reconciliation inside WASM!
///
/// # Safety
/// `ptr` must point to `len` valid bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_calculate_return_refund(ptr: *const u8, len: usize) -> u64 {
    let payload = read_utf8_slice(ptr, len);
    pack_string_to_u64(exec_calculate_return_refund(payload))
}

/// Runs B2B purchase policy evaluation inside WASM!
///
/// # Safety
/// `ptr` must point to `len` valid bytes in WASM linear memory.
#[no_mangle]
pub unsafe extern "C" fn wasm_evaluate_b2b_policy(ptr: *const u8, len: usize) -> u64 {
    let payload = read_utf8_slice(ptr, len);
    pack_string_to_u64(exec_evaluate_b2b_policy(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wasm_exports_match_commerce_kernel() {
        assert_eq!(apply_bps_wasm(1999, 825), 165);
        assert_eq!(extract_vat_net_wasm(4000, 2000), 3333);
        assert_eq!(currency_exponent_wasm(b'J' as u32, b'P' as u32, b'Y' as u32), 0);
        assert_eq!(currency_exponent_wasm(b'K' as u32, b'W' as u32, b'D' as u32), 3);
    }
}
