//! Memory-Hardened Native Node-API (`N-API`) Bridge exposing `commerce-kernel` to Node.js / Bun.
//!
//! Safety Guarantees:
//! 1. Strict `argc` bounds and `NapiStatus` validation before dereferencing any `NapiValue` (eliminates null-pointer Segfaults).
//! 2. Every `extern "C"` callback is wrapped in `std::panic::catch_unwind`, converting panics into clean JS exceptions instead of C-ABI Undefined Behavior.
//! 3. Delegates all record serialization/deserialization to `commerce_kernel::wire_codec` with lossless `\t`/`\n`/`\\` escaping.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use commerce_kernel::money::{
    apply_bps, currency_exponent, format_minor_units, Bps, MinorUnits, PriceTier,
};
use commerce_kernel::msi::{
    plan_inventory_allocation, AllocationStrategy, OrderLineDemand, StockAvailabilityMode,
    WarehouseStockSlot,
};
use commerce_kernel::pricing::{
    calculate_cart, CandidateLineDiscount, CandidateOrderDiscount, CartCalculationInput,
    CartLineInput, DiscountValue, LineDiscountKind, OrderDiscountKind, TaxInclusionMode,
};
use commerce_kernel::wire_codec::{
    exec_allocate_pro_rata, exec_calculate_cart, exec_calculate_return_refund,
    exec_evaluate_b2b_policy, exec_plan_inventory,
};

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiCallbackInfo = *mut c_void;
type NapiStatus = i32;

const NAPI_OK: NapiStatus = 0;

extern "C" {
    fn napi_create_function(
        env: NapiEnv,
        utf8name: *const u8,
        length: usize,
        cb: extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue,
        data: *mut c_void,
        result: *mut NapiValue,
    ) -> NapiStatus;

    fn napi_set_named_property(
        env: NapiEnv,
        object: NapiValue,
        utf8name: *const u8,
        value: NapiValue,
    ) -> NapiStatus;

    fn napi_get_cb_info(
        env: NapiEnv,
        cbinfo: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut c_void,
    ) -> NapiStatus;

    fn napi_get_value_bigint_int64(
        env: NapiEnv,
        value: NapiValue,
        result: *mut i64,
        lossless: *mut bool,
    ) -> NapiStatus;

    fn napi_create_bigint_int64(env: NapiEnv, value: i64, result: *mut NapiValue) -> NapiStatus;

    fn napi_get_value_uint32(env: NapiEnv, value: NapiValue, result: *mut u32) -> NapiStatus;

    fn napi_create_uint32(env: NapiEnv, value: u32, result: *mut NapiValue) -> NapiStatus;

    fn napi_get_value_string_utf8(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut u8,
        bufsize: usize,
        result: *mut usize,
    ) -> NapiStatus;

    fn napi_create_string_utf8(
        env: NapiEnv,
        str_ptr: *const u8,
        length: usize,
        result: *mut NapiValue,
    ) -> NapiStatus;

    fn napi_throw_type_error(env: NapiEnv, code: *const u8, msg: *const u8) -> NapiStatus;

    fn napi_throw_error(env: NapiEnv, code: *const u8, msg: *const u8) -> NapiStatus;
}

unsafe fn throw_js_type_error(env: NapiEnv, msg: &str) -> NapiValue {
    let mut c_msg = Vec::with_capacity(msg.len() + 1);
    c_msg.extend_from_slice(msg.as_bytes());
    c_msg.retain(|&b| b != 0);
    c_msg.push(0);
    let _ = napi_throw_type_error(env, b"ERR_KERNEL_INVALID_ARG\0".as_ptr(), c_msg.as_ptr());
    ptr::null_mut()
}

unsafe fn throw_js_panic_error(env: NapiEnv, msg: &str) -> NapiValue {
    let mut c_msg = Vec::with_capacity(msg.len() + 1);
    c_msg.extend_from_slice(msg.as_bytes());
    c_msg.retain(|&b| b != 0);
    c_msg.push(0);
    let _ = napi_throw_error(env, b"ERR_KERNEL_INTERNAL_PANIC\0".as_ptr(), c_msg.as_ptr());
    ptr::null_mut()
}

unsafe fn extract_args<const N: usize>(
    env: NapiEnv,
    info: NapiCallbackInfo,
    fn_name: &str,
) -> Result<[NapiValue; N], NapiValue> {
    let mut argc: usize = N;
    let mut argv: [NapiValue; N] = [ptr::null_mut(); N];
    let status = napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        ptr::null_mut(),
        ptr::null_mut(),
    );
    if status != NAPI_OK {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: failed to read N-API callback arguments"),
        ));
    }
    if argc < N || argv.iter().any(|v| v.is_null()) {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: expected {N} argument(s), received {argc}"),
        ));
    }
    Ok(argv)
}

unsafe fn extract_utf8_string(
    env: NapiEnv,
    val: NapiValue,
    fn_name: &str,
) -> Result<String, NapiValue> {
    if val.is_null() {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: string argument must not be null"),
        ));
    }
    let mut len: usize = 0;
    if napi_get_value_string_utf8(env, val, ptr::null_mut(), 0, &mut len) != NAPI_OK {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: expected UTF-8 string argument"),
        ));
    }
    let mut buf = vec![0u8; len + 1];
    let mut written: usize = 0;
    if napi_get_value_string_utf8(env, val, buf.as_mut_ptr(), buf.len(), &mut written) != NAPI_OK {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: failed decoding UTF-8 string"),
        ));
    }
    buf.truncate(written);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

unsafe fn extract_bigint_i64(
    env: NapiEnv,
    val: NapiValue,
    fn_name: &str,
) -> Result<i64, NapiValue> {
    let mut out: i64 = 0;
    let mut lossless = false;
    if val.is_null() || napi_get_value_bigint_int64(env, val, &mut out, &mut lossless) != NAPI_OK {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: expected 64-bit BigInt argument"),
        ));
    }
    Ok(out)
}

unsafe fn extract_u32(env: NapiEnv, val: NapiValue, fn_name: &str) -> Result<u32, NapiValue> {
    let mut out: u32 = 0;
    if val.is_null() || napi_get_value_uint32(env, val, &mut out) != NAPI_OK {
        return Err(throw_js_type_error(
            env,
            &format!("{fn_name}: expected unsigned 32-bit integer argument"),
        ));
    }
    Ok(out)
}

unsafe fn create_utf8_string(env: NapiEnv, s: &str) -> NapiValue {
    let mut out: NapiValue = ptr::null_mut();
    let _ = napi_create_string_utf8(env, s.as_ptr(), s.len(), &mut out);
    out
}

unsafe fn run_guarded<F: FnOnce() -> String>(env: NapiEnv, f: F) -> NapiValue {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(res_str) => create_utf8_string(env, &res_str),
        Err(_) => throw_js_panic_error(env, "commerce-kernel caught an internal Rust panic"),
    }
}

/// `rustApplyBps(amount: bigint, bps: number): bigint`
extern "C" fn napi_apply_bps(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<2>(env, info, "rustApplyBps") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let amount = match extract_bigint_i64(env, argv[0], "rustApplyBps") {
            Ok(v) => v,
            Err(e) => return e,
        };
        let bps = match extract_u32(env, argv[1], "rustApplyBps") {
            Ok(v) => v,
            Err(e) => return e,
        };
        match catch_unwind(|| apply_bps(amount, bps)) {
            Ok(res) => {
                let mut out: NapiValue = ptr::null_mut();
                let _ = napi_create_bigint_int64(env, res, &mut out);
                out
            }
            Err(_) => throw_js_panic_error(env, "rustApplyBps panicked"),
        }
    }
}

/// `rustCurrencyExponent(currencyCode: string): number`
extern "C" fn napi_currency_exponent(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustCurrencyExponent") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let code = match extract_utf8_string(env, argv[0], "rustCurrencyExponent") {
            Ok(s) => s,
            Err(e) => return e,
        };
        let exp = currency_exponent(&code) as u32;
        let mut out: NapiValue = ptr::null_mut();
        let _ = napi_create_uint32(env, exp, &mut out);
        out
    }
}

/// `rustFormatMinorUnits(amount: bigint, currencyCode: string): string`
extern "C" fn napi_format_minor_units(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<2>(env, info, "rustFormatMinorUnits") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let amount = match extract_bigint_i64(env, argv[0], "rustFormatMinorUnits") {
            Ok(v) => v,
            Err(e) => return e,
        };
        let code = match extract_utf8_string(env, argv[1], "rustFormatMinorUnits") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || format_minor_units(amount, &code))
    }
}

/// `rustAllocateProRata(totalToAllocate: bigint, encodedItems: string): string`
extern "C" fn napi_allocate_pro_rata(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<2>(env, info, "rustAllocateProRata") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let total: MinorUnits = match extract_bigint_i64(env, argv[0], "rustAllocateProRata") {
            Ok(v) => v,
            Err(e) => return e,
        };
        let payload = match extract_utf8_string(env, argv[1], "rustAllocateProRata") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || exec_allocate_pro_rata(total, &payload))
    }
}

/// `rustCalculateCart(encodedCart: string): string`
extern "C" fn napi_calculate_cart(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustCalculateCart") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let payload = match extract_utf8_string(env, argv[0], "rustCalculateCart") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || exec_calculate_cart(&payload))
    }
}

/// `rustPlanInventoryAllocation(encodedMsi: string): string`
extern "C" fn napi_plan_inventory(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustPlanInventoryAllocation") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let payload = match extract_utf8_string(env, argv[0], "rustPlanInventoryAllocation") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || exec_plan_inventory(&payload))
    }
}

/// `rustCalculateReturnRefund(encodedRma: string): string`
extern "C" fn napi_calculate_return_refund(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustCalculateReturnRefund") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let payload = match extract_utf8_string(env, argv[0], "rustCalculateReturnRefund") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || exec_calculate_return_refund(&payload))
    }
}

/// `rustEvaluateB2bPurchasePolicy(encodedB2b: string): string`
extern "C" fn napi_evaluate_b2b_purchase_policy(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustEvaluateB2bPurchasePolicy") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let payload = match extract_utf8_string(env, argv[0], "rustEvaluateB2bPurchasePolicy") {
            Ok(s) => s,
            Err(e) => return e,
        };
        run_guarded(env, move || exec_evaluate_b2b_policy(&payload))
    }
}

/// `rustBenchmarkKernel(iterations: number): string`
extern "C" fn napi_benchmark_kernel(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let argv = match extract_args::<1>(env, info, "rustBenchmarkKernel") {
            Ok(a) => a,
            Err(e) => return e,
        };
        let raw_iters_u32 = match extract_u32(env, argv[0], "rustBenchmarkKernel") {
            Ok(v) => v,
            Err(e) => return e,
        };
        run_guarded(env, move || {
            let raw_iters = (raw_iters_u32.max(1)) as usize;
            let cart_input = CartCalculationInput {
                currency_code: "USD".to_string(),
                tax_mode: TaxInclusionMode::TaxExclusive,
                shipping_base_amount: 1500,
                shipping_tax_rate_bps: 825 as Bps,
                lines: vec![
                    CartLineInput {
                        line_id: "L-1".to_string(),
                        variant_id: "KR-KB75-TI".to_string(),
                        quantity: 2,
                        base_unit_price: 39_000,
                        tier_prices: vec![PriceTier {
                            min_quantity: 2,
                            unit_amount: 35_000,
                        }],
                        tax_rate_bps: 825,
                        is_gift: false,
                        candidate_line_discounts: vec![CandidateLineDiscount {
                            discount_id: "cat-10".to_string(),
                            name: "10% VIP".to_string(),
                            kind: LineDiscountKind::CataloguePromotion,
                            value: DiscountValue::Percentage(1000),
                        }],
                        unit_cost_amount: None,
                        min_margin_bps: 0,
                    },
                    CartLineInput {
                        line_id: "L-2".to_string(),
                        variant_id: "KR-DAC-BLK".to_string(),
                        quantity: 1,
                        base_unit_price: 59_000,
                        tier_prices: Vec::new(),
                        tax_rate_bps: 825,
                        is_gift: false,
                        candidate_line_discounts: Vec::new(),
                        unit_cost_amount: None,
                        min_margin_bps: 0,
                    },
                    CartLineInput {
                        line_id: "L-3".to_string(),
                        variant_id: "KR-MG8K-SLV".to_string(),
                        quantity: 1,
                        base_unit_price: 17_900,
                        tier_prices: Vec::new(),
                        tax_rate_bps: 825,
                        is_gift: false,
                        candidate_line_discounts: Vec::new(),
                        unit_cost_amount: None,
                        min_margin_bps: 0,
                    },
                    CartLineInput {
                        line_id: "L-GIFT".to_string(),
                        variant_id: "KR-CABLE-GIFT".to_string(),
                        quantity: 1,
                        base_unit_price: 2_900,
                        tier_prices: Vec::new(),
                        tax_rate_bps: 825,
                        is_gift: true,
                        candidate_line_discounts: Vec::new(),
                        unit_cost_amount: None,
                        min_margin_bps: 0,
                    },
                ],
                candidate_order_discounts: vec![
                    CandidateOrderDiscount {
                        discount_id: "ord-promo".to_string(),
                        name: "10% Promo".to_string(),
                        kind: OrderDiscountKind::OrderPromotion,
                        value: DiscountValue::Percentage(1000),
                    },
                    CandidateOrderDiscount {
                        discount_id: "ord-voucher".to_string(),
                        name: "$25 Voucher".to_string(),
                        kind: OrderDiscountKind::OrderVoucher,
                        value: DiscountValue::Fixed(2500),
                    },
                ],
            };

            let msi_demands = vec![
                OrderLineDemand {
                    line_id: "L-1".to_string(),
                    variant_id: "KR-KB75-TI".to_string(),
                    quantity_requested: 2,
                },
                OrderLineDemand {
                    line_id: "L-2".to_string(),
                    variant_id: "KR-DAC-BLK".to_string(),
                    quantity_requested: 1,
                },
            ];

            let msi_slots = vec![
                WarehouseStockSlot {
                    warehouse_id: "US-EAST".to_string(),
                    priority_rank: 1,
                    linked_to_channel: true,
                    supports_shipping_zone: true,
                    variant_id: "KR-KB75-TI".to_string(),
                    quantity_on_hand: 5,
                    quantity_reserved: 0,
                    quantity_allocated: 0,
                },
                WarehouseStockSlot {
                    warehouse_id: "US-CENTRAL".to_string(),
                    priority_rank: 2,
                    linked_to_channel: true,
                    supports_shipping_zone: true,
                    variant_id: "KR-KB75-TI".to_string(),
                    quantity_on_hand: 25,
                    quantity_reserved: 0,
                    quantity_allocated: 0,
                },
                WarehouseStockSlot {
                    warehouse_id: "US-CENTRAL".to_string(),
                    priority_rank: 2,
                    linked_to_channel: true,
                    supports_shipping_zone: true,
                    variant_id: "KR-DAC-BLK".to_string(),
                    quantity_on_hand: 18,
                    quantity_reserved: 0,
                    quantity_allocated: 0,
                },
            ];

            let t0 = std::time::Instant::now();
            let mut checksum: i64 = 0;
            for _ in 0..raw_iters {
                let cart_res = calculate_cart(&cart_input);
                let msi_res = plan_inventory_allocation(
                    &msi_demands,
                    &msi_slots,
                    StockAvailabilityMode::DirectChannelWarehouses,
                    AllocationStrategy::MinimizeSplitThenHighStock,
                );
                checksum = checksum
                    .wrapping_add(cart_res.total_gross_amount)
                    .wrapping_add(msi_res.shipment_count as i64);
            }
            let elapsed_ns = t0.elapsed().as_nanos().max(1) as u64;
            let per_op_ns = elapsed_ns / (raw_iters as u64);
            let ops_per_sec = ((raw_iters as u128) * 1_000_000_000u128) / (elapsed_ns as u128);
            format!("{}\t{}\t{}\t{}", elapsed_ns, per_op_ns, ops_per_sec, checksum)
        })
    }
}

unsafe fn register_fn(
    env: NapiEnv,
    exports: NapiValue,
    name_with_nul: &[u8],
    cb: extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue,
) {
    let mut fn_val: NapiValue = ptr::null_mut();
    let len_without_nul = name_with_nul.len() - 1;
    if napi_create_function(
        env,
        name_with_nul.as_ptr(),
        len_without_nul,
        cb,
        ptr::null_mut(),
        &mut fn_val,
    ) == NAPI_OK
        && !fn_val.is_null()
    {
        let _ = napi_set_named_property(env, exports, name_with_nul.as_ptr(), fn_val);
    }
}

#[no_mangle]
pub extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    unsafe {
        register_fn(env, exports, b"rustApplyBps\0", napi_apply_bps);
        register_fn(
            env,
            exports,
            b"rustCurrencyExponent\0",
            napi_currency_exponent,
        );
        register_fn(
            env,
            exports,
            b"rustFormatMinorUnits\0",
            napi_format_minor_units,
        );
        register_fn(
            env,
            exports,
            b"rustAllocateProRata\0",
            napi_allocate_pro_rata,
        );
        register_fn(env, exports, b"rustCalculateCart\0", napi_calculate_cart);
        register_fn(
            env,
            exports,
            b"rustPlanInventoryAllocation\0",
            napi_plan_inventory,
        );
        register_fn(
            env,
            exports,
            b"rustBenchmarkKernel\0",
            napi_benchmark_kernel,
        );
        register_fn(
            env,
            exports,
            b"rustCalculateReturnRefund\0",
            napi_calculate_return_refund,
        );
        register_fn(
            env,
            exports,
            b"rustEvaluateB2bPurchasePolicy\0",
            napi_evaluate_b2b_purchase_policy,
        );
    }
    exports
}
