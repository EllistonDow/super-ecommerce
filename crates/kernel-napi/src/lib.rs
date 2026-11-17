//! Native Node-API (`N-API`) bridge exposing `commerce-kernel` directly to Node.js / Bun.
//!
//! Exports deterministic Rust kernel entrypoints:
//! - `rustApplyBps(amount: bigint, bps: number): bigint`
//! - `rustAllocateProRata(totalToAllocate: bigint, encodedItems: string): string`
//! - `rustCalculateCart(encodedCart: string): string`
//! - `rustPlanInventoryAllocation(encodedMsi: string): string`

use std::ffi::c_void;
use std::ptr;

use commerce_kernel::allocation::{allocate_pro_rata, WeightedItem};
use commerce_kernel::b2b::{
    evaluate_b2b_purchase_policy, B2bBuyerPolicyInput, B2bBuyerRole, B2bCompanyPolicyInput,
    B2bCostCenterPolicyInput, B2bPaymentTerms, B2bPolicyDecisionStatus, B2bPurchasePolicyInput,
};
use commerce_kernel::money::{apply_bps, Bps, MinorUnits, PriceTier};
use commerce_kernel::msi::{
    plan_inventory_allocation, AllocationStrategy, OrderLineDemand, StockAvailabilityMode,
    WarehouseStockSlot,
};
use commerce_kernel::pricing::{
    calculate_cart, CandidateLineDiscount, CandidateOrderDiscount, CartCalculationInput,
    CartLineInput, DiscountValue, LineDiscountKind, OrderDiscountKind, TaxInclusionMode,
};
use commerce_kernel::refund::{
    calculate_return_refund, RefundCalculationInput, RefundLineInput, RefundTenderPriority,
};

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiCallbackInfo = *mut c_void;

extern "C" {
    fn napi_create_function(
        env: NapiEnv,
        utf8name: *const u8,
        length: usize,
        cb: extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue,
        data: *mut c_void,
        result: *mut NapiValue,
    ) -> i32;

    fn napi_set_named_property(
        env: NapiEnv,
        object: NapiValue,
        utf8name: *const u8,
        value: NapiValue,
    ) -> i32;

    fn napi_get_cb_info(
        env: NapiEnv,
        cbinfo: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut c_void,
    ) -> i32;

    fn napi_get_value_bigint_int64(
        env: NapiEnv,
        value: NapiValue,
        result: *mut i64,
        lossless: *mut bool,
    ) -> i32;

    fn napi_create_bigint_int64(env: NapiEnv, value: i64, result: *mut NapiValue) -> i32;

    fn napi_get_value_uint32(env: NapiEnv, value: NapiValue, result: *mut u32) -> i32;

    fn napi_get_value_string_utf8(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut u8,
        bufsize: usize,
        result: *mut usize,
    ) -> i32;

    fn napi_create_string_utf8(
        env: NapiEnv,
        str_ptr: *const u8,
        length: usize,
        result: *mut NapiValue,
    ) -> i32;
}

unsafe fn extract_utf8_string(env: NapiEnv, val: NapiValue) -> String {
    let mut len: usize = 0;
    napi_get_value_string_utf8(env, val, ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len + 1];
    let mut written: usize = 0;
    napi_get_value_string_utf8(env, val, buf.as_mut_ptr(), buf.len(), &mut written);
    buf.truncate(written);
    String::from_utf8_lossy(&buf).into_owned()
}

unsafe fn create_utf8_string(env: NapiEnv, s: &str) -> NapiValue {
    let mut out: NapiValue = ptr::null_mut();
    napi_create_string_utf8(env, s.as_ptr(), s.len(), &mut out);
    out
}

/// `rustApplyBps(amount: bigint, bps: number): bigint`
extern "C" fn napi_apply_bps(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 2;
        let mut argv: [NapiValue; 2] = [ptr::null_mut(); 2];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let mut amount: i64 = 0;
        let mut lossless = false;
        let mut bps: u32 = 0;
        napi_get_value_bigint_int64(env, argv[0], &mut amount, &mut lossless);
        napi_get_value_uint32(env, argv[1], &mut bps);

        let res = apply_bps(amount, bps);
        let mut out: NapiValue = ptr::null_mut();
        napi_create_bigint_int64(env, res, &mut out);
        out
    }
}

/// `rustAllocateProRata(totalToAllocate: bigint, encodedItems: string): string`
/// Format in:  `id\tweight\n...`
/// Format out: `id\tallocated\n...`
extern "C" fn napi_allocate_pro_rata(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 2;
        let mut argv: [NapiValue; 2] = [ptr::null_mut(); 2];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let mut total: i64 = 0;
        let mut lossless = false;
        napi_get_value_bigint_int64(env, argv[0], &mut total, &mut lossless);
        let payload = extract_utf8_string(env, argv[1]);

        let mut items = Vec::new();
        for line in payload.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let id = parts.next().unwrap_or("").to_string();
            let weight: MinorUnits = parts.next().and_then(|w| w.parse().ok()).unwrap_or(0);
            items.push(WeightedItem { id, weight });
        }

        let shares = allocate_pro_rata(total, &items);
        let mut out_str = String::new();
        for (idx, share) in shares.iter().enumerate() {
            if idx > 0 {
                out_str.push('\n');
            }
            out_str.push_str(&format!("{}\t{}", share.id, share.allocated));
        }
        create_utf8_string(env, &out_str)
    }
}

fn parse_discount_value(kind_str: &str, val: i64) -> DiscountValue {
    if kind_str == "PERCENTAGE" {
        DiscountValue::Percentage(val.max(0) as Bps)
    } else {
        DiscountValue::Fixed(val)
    }
}

fn parse_line_discount_kind(s: &str) -> LineDiscountKind {
    match s {
        "MANUAL_LINE" => LineDiscountKind::ManualLine,
        "VOUCHER_LINE" => LineDiscountKind::VoucherLine,
        "ORDER_PROMOTION_GIFT" => LineDiscountKind::OrderPromotionGift,
        _ => LineDiscountKind::CataloguePromotion,
    }
}

fn parse_order_discount_kind(s: &str) -> OrderDiscountKind {
    match s {
        "MANUAL_ORDER" => OrderDiscountKind::ManualOrder,
        "ORDER_VOUCHER" => OrderDiscountKind::OrderVoucher,
        "SHIPPING_VOUCHER" => OrderDiscountKind::ShippingVoucher,
        _ => OrderDiscountKind::OrderPromotion,
    }
}

fn format_order_discount_kind(k: OrderDiscountKind) -> &'static str {
    match k {
        OrderDiscountKind::ManualOrder => "MANUAL_ORDER",
        OrderDiscountKind::OrderVoucher => "ORDER_VOUCHER",
        OrderDiscountKind::ShippingVoucher => "SHIPPING_VOUCHER",
        OrderDiscountKind::OrderPromotion => "ORDER_PROMOTION",
    }
}

/// `rustCalculateCart(encodedCart: string): string`
///
/// Line-oriented record protocol:
/// - `CART\t<currency>\t<taxMode>\t<shippingBase>\t<shippingTaxBps>`
/// - `LINE\t<lineId>\t<variantId>\t<qty>\t<baseUnitPrice>\t<taxRateBps>\t<isGift:0|1>`
/// - `TIER\t<lineId>\t<minQty>\t<unitAmount>`
/// - `LDISC\t<lineId>\t<discountId>\t<name>\t<kind>\t<valType:FIXED|PERCENTAGE>\t<val>`
/// - `ODISC\t<discountId>\t<name>\t<kind>\t<valType:FIXED|PERCENTAGE>\t<val>`
extern "C" fn napi_calculate_cart(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let payload = extract_utf8_string(env, argv[0]);

        let mut currency_code = String::from("USD");
        let mut tax_mode = TaxInclusionMode::TaxExclusive;
        let mut shipping_base_amount: MinorUnits = 0;
        let mut shipping_tax_rate_bps: Bps = 0;
        let mut lines: Vec<CartLineInput> = Vec::new();
        let mut candidate_order_discounts: Vec<CandidateOrderDiscount> = Vec::new();

        for raw in payload.lines() {
            if raw.trim().is_empty() {
                continue;
            }
            let cols: Vec<&str> = raw.split('\t').collect();
            match cols.first().copied().unwrap_or("") {
                "CART" if cols.len() >= 5 => {
                    currency_code = cols[1].to_string();
                    tax_mode = if cols[2] == "TAX_INCLUSIVE" {
                        TaxInclusionMode::TaxInclusive
                    } else {
                        TaxInclusionMode::TaxExclusive
                    };
                    shipping_base_amount = cols[3].parse().unwrap_or(0);
                    shipping_tax_rate_bps = cols[4].parse().unwrap_or(0);
                }
                "LINE" if cols.len() >= 7 => {
                    lines.push(CartLineInput {
                        line_id: cols[1].to_string(),
                        variant_id: cols[2].to_string(),
                        quantity: cols[3].parse().unwrap_or(1),
                        base_unit_price: cols[4].parse().unwrap_or(0),
                        tier_prices: Vec::new(),
                        tax_rate_bps: cols[5].parse().unwrap_or(0),
                        is_gift: cols[6] == "1",
                        candidate_line_discounts: Vec::new(),
                    });
                }
                "TIER" if cols.len() >= 4 => {
                    let target_line_id = cols[1];
                    if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                        line.tier_prices.push(PriceTier {
                            min_quantity: cols[2].parse().unwrap_or(1),
                            unit_amount: cols[3].parse().unwrap_or(0),
                        });
                    }
                }
                "LDISC" if cols.len() >= 7 => {
                    let target_line_id = cols[1];
                    if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                        line.candidate_line_discounts.push(CandidateLineDiscount {
                            discount_id: cols[2].to_string(),
                            name: cols[3].to_string(),
                            kind: parse_line_discount_kind(cols[4]),
                            value: parse_discount_value(cols[5], cols[6].parse().unwrap_or(0)),
                        });
                    }
                }
                "ODISC" if cols.len() >= 6 => {
                    candidate_order_discounts.push(CandidateOrderDiscount {
                        discount_id: cols[1].to_string(),
                        name: cols[2].to_string(),
                        kind: parse_order_discount_kind(cols[3]),
                        value: parse_discount_value(cols[4], cols[5].parse().unwrap_or(0)),
                    });
                }
                _ => {}
            }
        }

        let res = calculate_cart(&CartCalculationInput {
            currency_code,
            tax_mode,
            shipping_base_amount,
            shipping_tax_rate_bps,
            lines,
            candidate_order_discounts,
        });

        let mut out = String::new();
        out.push_str(&format!(
            "TOTALS\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            res.currency_code,
            res.shipping_undiscounted_amount,
            res.shipping_discount_amount,
            res.shipping_net_amount,
            res.shipping_tax_amount,
            res.shipping_gross_amount,
            res.total_net_amount,
            res.total_tax_amount,
            res.total_gross_amount
        ));

        for od in &res.applied_order_discounts {
            out.push_str(&format!(
                "APPLIED_ODISC\t{}\t{}\t{}\t{}\n",
                od.discount_id,
                od.name,
                format_order_discount_kind(od.kind),
                od.total_amount
            ));
        }

        for line in &res.lines {
            out.push_str(&format!(
                "LINE_RES\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                line.line_id,
                line.variant_id,
                line.quantity,
                if line.is_gift { 1 } else { 0 },
                line.effective_base_unit_price,
                line.undiscounted_line_subtotal,
                line.line_level_discount_amount,
                line.subtotal_after_line_discount,
                line.allocated_order_discount_amount,
                line.total_net_amount,
                line.total_tax_amount,
                line.total_gross_amount
            ));
            for attr in &line.discount_attributions {
                out.push_str(&format!(
                    "LINE_ATTR\t{}\t{}\t{}\t{}\t{}\n",
                    line.line_id,
                    attr.discount_id,
                    attr.name,
                    if attr.is_order_level { 1 } else { 0 },
                    attr.amount
                ));
            }
        }

        create_utf8_string(env, &out)
    }
}

/// `rustPlanInventoryAllocation(encodedMsi: string): string`
extern "C" fn napi_plan_inventory(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let payload = extract_utf8_string(env, argv[0]);

        let mut avail_mode = StockAvailabilityMode::DirectChannelWarehouses;
        let mut strategy = AllocationStrategy::MinimizeSplitThenHighStock;
        let mut demands = Vec::new();
        let mut slots = Vec::new();

        for raw in payload.lines() {
            if raw.trim().is_empty() {
                continue;
            }
            let cols: Vec<&str> = raw.split('\t').collect();
            match cols.first().copied().unwrap_or("") {
                "CFG" if cols.len() >= 3 => {
                    avail_mode = if cols[1] == "SHIPPING_ZONE_INTERSECTION" {
                        StockAvailabilityMode::ShippingZoneIntersection
                    } else {
                        StockAvailabilityMode::DirectChannelWarehouses
                    };
                    strategy = if cols[2] == "PRIORITIZE_RANK_ORDER" {
                        AllocationStrategy::PrioritizeRankOrder
                    } else {
                        AllocationStrategy::MinimizeSplitThenHighStock
                    };
                }
                "DEMAND" if cols.len() >= 4 => {
                    demands.push(OrderLineDemand {
                        line_id: cols[1].to_string(),
                        variant_id: cols[2].to_string(),
                        quantity_requested: cols[3].parse().unwrap_or(0),
                    });
                }
                "SLOT" if cols.len() >= 9 => {
                    slots.push(WarehouseStockSlot {
                        warehouse_id: cols[1].to_string(),
                        priority_rank: cols[2].parse().unwrap_or(100),
                        linked_to_channel: cols[3] == "1",
                        supports_shipping_zone: cols[4] == "1",
                        variant_id: cols[5].to_string(),
                        quantity_on_hand: cols[6].parse().unwrap_or(0),
                        quantity_reserved: cols[7].parse().unwrap_or(0),
                        quantity_allocated: cols[8].parse().unwrap_or(0),
                    });
                }
                _ => {}
            }
        }

        let plan = plan_inventory_allocation(&demands, &slots, avail_mode, strategy);
        let mut out = String::new();
        out.push_str(&format!(
            "PLAN\t{}\t{}\n",
            if plan.is_fully_allocated { 1 } else { 0 },
            plan.shipment_count
        ));
        for a in &plan.allocations {
            out.push_str(&format!(
                "ALLOC\t{}\t{}\t{}\t{}\n",
                a.warehouse_id, a.line_id, a.variant_id, a.quantity_allocated
            ));
        }
        for s in &plan.shortfalls {
            out.push_str(&format!(
                "SHORTFALL\t{}\t{}\t{}\t{}\t{}\n",
                s.line_id, s.variant_id, s.quantity_requested, s.quantity_available, s.quantity_missing
            ));
        }

        create_utf8_string(env, &out)
    }
}

/// `rustBenchmarkKernel(iterations: number): string`
/// Runs `iterations` full 4-line Two-Pass Hare-Niemeyer Cart Calculations + 3-warehouse MSI
/// allocation plans inside compiled Rust, returning `"total_ns\tper_op_ns\tops_per_sec\tchecksum"`.
extern "C" fn napi_benchmark_kernel(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let mut raw_iters_u32: u32 = 1000;
        napi_get_value_uint32(env, argv[0], &mut raw_iters_u32);
        let raw_iters = (raw_iters_u32.max(1)) as usize;

        let cart_input = CartCalculationInput {
            currency_code: "USD".to_string(),
            tax_mode: TaxInclusionMode::TaxExclusive,
            shipping_base_amount: 1500,
            shipping_tax_rate_bps: 825,
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

        let out = format!("{}\t{}\t{}\t{}", elapsed_ns, per_op_ns, ops_per_sec, checksum);
        create_utf8_string(env, &out)
    }
}

/// `rustCalculateReturnRefund(encodedRma: string): string`
extern "C" fn napi_calculate_return_refund(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let payload = extract_utf8_string(env, argv[0]);

        let mut currency_code = String::from("USD");
        let mut refund_shipping = false;
        let mut shipping_original_net_amount: MinorUnits = 0;
        let mut shipping_original_tax_amount: MinorUnits = 0;
        let mut shipping_original_gross_amount: MinorUnits = 0;
        let mut shipping_already_refunded_gross_amount: MinorUnits = 0;
        let mut payment_gateway_originally_captured: MinorUnits = 0;
        let mut payment_gateway_already_refunded: MinorUnits = 0;
        let mut store_credit_originally_redeemed: MinorUnits = 0;
        let mut store_credit_already_refunded: MinorUnits = 0;
        let mut tender_priority = RefundTenderPriority::GatewayCashFirst;
        let mut lines: Vec<RefundLineInput> = Vec::new();

        for raw in payload.lines() {
            if raw.trim().is_empty() {
                continue;
            }
            let cols: Vec<&str> = raw.split('\t').collect();
            match cols.first().copied().unwrap_or("") {
                "RMA_CFG" if cols.len() >= 12 => {
                    currency_code = cols[1].to_string();
                    refund_shipping = cols[2] == "1";
                    shipping_original_net_amount = cols[3].parse().unwrap_or(0);
                    shipping_original_tax_amount = cols[4].parse().unwrap_or(0);
                    shipping_original_gross_amount = cols[5].parse().unwrap_or(0);
                    shipping_already_refunded_gross_amount = cols[6].parse().unwrap_or(0);
                    payment_gateway_originally_captured = cols[7].parse().unwrap_or(0);
                    payment_gateway_already_refunded = cols[8].parse().unwrap_or(0);
                    store_credit_originally_redeemed = cols[9].parse().unwrap_or(0);
                    store_credit_already_refunded = cols[10].parse().unwrap_or(0);
                    tender_priority = if cols[11] == "STORE_CREDIT_FIRST" {
                        RefundTenderPriority::StoreCreditFirst
                    } else {
                        RefundTenderPriority::GatewayCashFirst
                    };
                }
                "RMA_LINE" if cols.len() >= 14 => {
                    lines.push(RefundLineInput {
                        line_id: cols[1].to_string(),
                        variant_id: cols[2].to_string(),
                        original_quantity: cols[3].parse().unwrap_or(0),
                        already_returned_quantity: cols[4].parse().unwrap_or(0),
                        return_quantity_requested: cols[5].parse().unwrap_or(0),
                        is_gift: cols[6] == "1",
                        original_net_amount: cols[7].parse().unwrap_or(0),
                        original_tax_amount: cols[8].parse().unwrap_or(0),
                        original_gross_amount: cols[9].parse().unwrap_or(0),
                        already_refunded_net_amount: cols[10].parse().unwrap_or(0),
                        already_refunded_tax_amount: cols[11].parse().unwrap_or(0),
                        already_refunded_gross_amount: cols[12].parse().unwrap_or(0),
                        restocking_fee_bps: cols[13].parse().unwrap_or(0),
                    });
                }
                _ => {}
            }
        }

        let res = calculate_return_refund(&RefundCalculationInput {
            currency_code,
            lines,
            refund_shipping,
            shipping_original_net_amount,
            shipping_original_tax_amount,
            shipping_original_gross_amount,
            shipping_already_refunded_gross_amount,
            payment_gateway_originally_captured,
            payment_gateway_already_refunded,
            store_credit_originally_redeemed,
            store_credit_already_refunded,
            tender_priority,
        });

        let mut out = String::new();
        out.push_str(&format!(
            "RMA_TOTALS\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            res.currency_code,
            res.shipping_refund_net_amount,
            res.shipping_refund_tax_amount,
            res.shipping_refund_gross_amount,
            res.total_gross_ceiling_consumed,
            res.total_restocking_fee_amount,
            res.total_refund_net_amount,
            res.total_refund_tax_amount,
            res.total_refund_gross_amount,
            res.payment_gateway_refund_amount,
            res.store_credit_refund_amount,
            res.unallocated_refund_overflow
        ));

        for line in &res.lines {
            out.push_str(&format!(
                "RMA_LINE_RES\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                line.line_id,
                line.variant_id,
                if line.is_gift { 1 } else { 0 },
                line.original_quantity,
                line.already_returned_quantity,
                line.accepted_return_quantity,
                line.remaining_returnable_quantity,
                if line.is_final_unit_reconciliation { 1 } else { 0 },
                line.net_ceiling_consumed,
                line.tax_ceiling_consumed,
                line.gross_ceiling_consumed,
                line.restocking_fee_amount,
                line.refund_net_amount,
                line.refund_tax_amount,
                line.refund_gross_amount
            ));
        }

        create_utf8_string(env, &out)
    }
}

/// `rustEvaluateB2bPurchasePolicy(encodedB2b: string): string`
extern "C" fn napi_evaluate_b2b_purchase_policy(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    unsafe {
        let mut argc: usize = 1;
        let mut argv: [NapiValue; 1] = [ptr::null_mut(); 1];
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let payload = extract_utf8_string(env, argv[0]);

        let mut company = B2bCompanyPolicyInput {
            company_id: String::from("comp-default"),
            payment_terms: B2bPaymentTerms::Net30,
            credit_limit: 0,
            credit_used: 0,
            credit_reserved: 0,
            contract_discount_bps: 0,
            tax_exempt_verified: false,
        };
        let mut cost_center = B2bCostCenterPolicyInput {
            cost_center_id: String::from("cc-default"),
            monthly_budget: 0,
            monthly_spent: 0,
            monthly_reserved: 0,
        };
        let mut buyer = B2bBuyerPolicyInput {
            buyer_id: String::from("buyer-default"),
            role: B2bBuyerRole::Buyer,
            single_order_auto_approve_limit: 0,
        };

        let mut currency_code = String::from("USD");
        let mut tax_mode = TaxInclusionMode::TaxExclusive;
        let mut shipping_base_amount: MinorUnits = 0;
        let mut shipping_tax_rate_bps: Bps = 0;
        let mut lines: Vec<CartLineInput> = Vec::new();
        let mut candidate_order_discounts: Vec<CandidateOrderDiscount> = Vec::new();

        for raw in payload.lines() {
            if raw.trim().is_empty() {
                continue;
            }
            let cols: Vec<&str> = raw.split('\t').collect();
            match cols.first().copied().unwrap_or("") {
                "B2B_COMPANY" if cols.len() >= 8 => {
                    company.company_id = cols[1].to_string();
                    company.payment_terms = match cols[2] {
                        "NET_60" => B2bPaymentTerms::Net60,
                        "PREPAID_ONLY" => B2bPaymentTerms::PrepaidOnly,
                        _ => B2bPaymentTerms::Net30,
                    };
                    company.credit_limit = cols[3].parse().unwrap_or(0);
                    company.credit_used = cols[4].parse().unwrap_or(0);
                    company.credit_reserved = cols[5].parse().unwrap_or(0);
                    company.contract_discount_bps = cols[6].parse().unwrap_or(0);
                    company.tax_exempt_verified = cols[7] == "1";
                }
                "B2B_CC" if cols.len() >= 5 => {
                    cost_center.cost_center_id = cols[1].to_string();
                    cost_center.monthly_budget = cols[2].parse().unwrap_or(0);
                    cost_center.monthly_spent = cols[3].parse().unwrap_or(0);
                    cost_center.monthly_reserved = cols[4].parse().unwrap_or(0);
                }
                "B2B_BUYER" if cols.len() >= 4 => {
                    buyer.buyer_id = cols[1].to_string();
                    buyer.role = match cols[2] {
                        "APPROVER" => B2bBuyerRole::Approver,
                        "COMPANY_ADMIN" => B2bBuyerRole::CompanyAdmin,
                        _ => B2bBuyerRole::Buyer,
                    };
                    buyer.single_order_auto_approve_limit = cols[3].parse().unwrap_or(0);
                }
                "CART" if cols.len() >= 5 => {
                    currency_code = cols[1].to_string();
                    tax_mode = if cols[2] == "TAX_INCLUSIVE" {
                        TaxInclusionMode::TaxInclusive
                    } else {
                        TaxInclusionMode::TaxExclusive
                    };
                    shipping_base_amount = cols[3].parse().unwrap_or(0);
                    shipping_tax_rate_bps = cols[4].parse().unwrap_or(0);
                }
                "LINE" if cols.len() >= 7 => {
                    lines.push(CartLineInput {
                        line_id: cols[1].to_string(),
                        variant_id: cols[2].to_string(),
                        quantity: cols[3].parse().unwrap_or(1),
                        base_unit_price: cols[4].parse().unwrap_or(0),
                        tier_prices: Vec::new(),
                        tax_rate_bps: cols[5].parse().unwrap_or(0),
                        is_gift: cols[6] == "1",
                        candidate_line_discounts: Vec::new(),
                    });
                }
                "TIER" if cols.len() >= 4 => {
                    let target_line_id = cols[1];
                    if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                        line.tier_prices.push(PriceTier {
                            min_quantity: cols[2].parse().unwrap_or(1),
                            unit_amount: cols[3].parse().unwrap_or(0),
                        });
                    }
                }
                "LDISC" if cols.len() >= 7 => {
                    let target_line_id = cols[1];
                    if let Some(line) = lines.iter_mut().find(|l| l.line_id == target_line_id) {
                        line.candidate_line_discounts.push(CandidateLineDiscount {
                            discount_id: cols[2].to_string(),
                            name: cols[3].to_string(),
                            kind: parse_line_discount_kind(cols[4]),
                            value: parse_discount_value(cols[5], cols[6].parse().unwrap_or(0)),
                        });
                    }
                }
                "ODISC" if cols.len() >= 6 => {
                    candidate_order_discounts.push(CandidateOrderDiscount {
                        discount_id: cols[1].to_string(),
                        name: cols[2].to_string(),
                        kind: parse_order_discount_kind(cols[3]),
                        value: parse_discount_value(cols[4], cols[5].parse().unwrap_or(0)),
                    });
                }
                _ => {}
            }
        }

        let b2b_res = evaluate_b2b_purchase_policy(&B2bPurchasePolicyInput {
            company,
            cost_center,
            buyer,
            cart: CartCalculationInput {
                currency_code,
                tax_mode,
                shipping_base_amount,
                shipping_tax_rate_bps,
                lines,
                candidate_order_discounts,
            },
        });

        let decision_str = match b2b_res.decision {
            B2bPolicyDecisionStatus::ApprovedAuto => "APPROVED_AUTO",
            B2bPolicyDecisionStatus::PendingApproval => "PENDING_APPROVAL",
            B2bPolicyDecisionStatus::RejectedCompanyCreditExceeded => {
                "REJECTED_COMPANY_CREDIT_EXCEEDED"
            }
        };

        let mut out = String::new();
        out.push_str(&format!(
            "B2B_DECISION\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            decision_str,
            b2b_res.standard_tax_amount_without_exemption,
            b2b_res.tax_exempt_savings_amount,
            b2b_res.available_company_credit_before,
            b2b_res.available_company_credit_after,
            b2b_res.available_cost_center_budget_before,
            b2b_res.available_cost_center_budget_after,
            b2b_res.net_terms_due_days,
            b2b_res.recommended_reservation_ttl_seconds
        ));
        for reason in &b2b_res.approval_reasons {
            out.push_str(&format!("B2B_REASON\t{}\n", reason));
        }

        let res = &b2b_res.pricing;
        out.push_str(&format!(
            "TOTALS\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            res.currency_code,
            res.shipping_undiscounted_amount,
            res.shipping_discount_amount,
            res.shipping_net_amount,
            res.shipping_tax_amount,
            res.shipping_gross_amount,
            res.total_net_amount,
            res.total_tax_amount,
            res.total_gross_amount
        ));

        for od in &res.applied_order_discounts {
            out.push_str(&format!(
                "APPLIED_ODISC\t{}\t{}\t{}\t{}\n",
                od.discount_id,
                od.name,
                format_order_discount_kind(od.kind),
                od.total_amount
            ));
        }

        for line in &res.lines {
            out.push_str(&format!(
                "LINE_RES\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                line.line_id,
                line.variant_id,
                line.quantity,
                if line.is_gift { 1 } else { 0 },
                line.effective_base_unit_price,
                line.undiscounted_line_subtotal,
                line.line_level_discount_amount,
                line.subtotal_after_line_discount,
                line.allocated_order_discount_amount,
                line.total_net_amount,
                line.total_tax_amount,
                line.total_gross_amount
            ));
            for attr in &line.discount_attributions {
                out.push_str(&format!(
                    "LINE_ATTR\t{}\t{}\t{}\t{}\t{}\n",
                    line.line_id,
                    attr.discount_id,
                    attr.name,
                    if attr.is_order_level { 1 } else { 0 },
                    attr.amount
                ));
            }
        }

        create_utf8_string(env, &out)
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
    napi_create_function(
        env,
        name_with_nul.as_ptr(),
        len_without_nul,
        cb,
        ptr::null_mut(),
        &mut fn_val,
    );
    napi_set_named_property(env, exports, name_with_nul.as_ptr(), fn_val);
}

#[no_mangle]
pub extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    unsafe {
        register_fn(env, exports, b"rustApplyBps\0", napi_apply_bps);
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
