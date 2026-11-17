//! Multi-Source Inventory (MSI) Availability & Optimal Order Splitting Engine.
//!
//! Absorbs Saleor 3.23+ stock availability semantics (Direct Channel Warehouse mode vs
//! Shipping Zone Intersection mode) and Magento MSI multi-warehouse routing:
//! - `available = max(0, on_hand - reserved - allocated)`
//! - Supports `MinimizeSplitThenHighStock` (prefers fulfilling the entire order from a
//!   single warehouse when possible; otherwise greedily selects the warehouse covering
//!   the most remaining items, tie-breaking by total available stock and warehouse ID).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StockAvailabilityMode {
    /// Saleor 3.23+ default: A variant is purchasable if assigned to any warehouse linked to the channel.
    DirectChannelWarehouses,
    /// Legacy intersection: Warehouse must be linked to BOTH the channel AND a shipping zone covering the destination country.
    ShippingZoneIntersection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllocationStrategy {
    /// Prioritizes warehouses strictly by their `priority_rank` (ascending), then `warehouse_id`.
    PrioritizeRankOrder,
    /// Attempts single-warehouse fulfillment first; otherwise minimizes shipment splits and prefers high-stock warehouses.
    MinimizeSplitThenHighStock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarehouseStockSlot {
    pub warehouse_id: String,
    pub priority_rank: u32,
    pub linked_to_channel: bool,
    pub supports_shipping_zone: bool,
    pub variant_id: String,
    pub quantity_on_hand: i64,
    pub quantity_reserved: i64,
    pub quantity_allocated: i64,
}

impl WarehouseStockSlot {
    /// Orthogonal 3-tier stock formula: `Available = max(0, on_hand - reserved - allocated)`.
    #[inline]
    pub fn available_quantity(&self) -> u32 {
        let avail = self.quantity_on_hand - self.quantity_reserved - self.quantity_allocated;
        avail.max(0) as u32
    }

    #[inline]
    pub fn is_eligible(&self, mode: StockAvailabilityMode) -> bool {
        match mode {
            StockAvailabilityMode::DirectChannelWarehouses => self.linked_to_channel,
            StockAvailabilityMode::ShippingZoneIntersection => {
                self.linked_to_channel && self.supports_shipping_zone
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderLineDemand {
    pub line_id: String,
    pub variant_id: String,
    pub quantity_requested: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarehouseShipmentAllocation {
    pub warehouse_id: String,
    pub line_id: String,
    pub variant_id: String,
    pub quantity_allocated: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockShortfall {
    pub line_id: String,
    pub variant_id: String,
    pub quantity_requested: u32,
    pub quantity_available: u32,
    pub quantity_missing: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocationPlanResult {
    pub is_fully_allocated: bool,
    pub shipment_count: usize,
    pub allocations: Vec<WarehouseShipmentAllocation>,
    pub shortfalls: Vec<StockShortfall>,
}

/// Computes an optimal, deterministic warehouse allocation plan for a set of order lines.
pub fn plan_inventory_allocation(
    demands: &[OrderLineDemand],
    stock_slots: &[WarehouseStockSlot],
    availability_mode: StockAvailabilityMode,
    strategy: AllocationStrategy,
) -> AllocationPlanResult {
    let eligible_slots: Vec<&WarehouseStockSlot> = stock_slots
        .iter()
        .filter(|s| s.is_eligible(availability_mode) && s.available_quantity() > 0)
        .collect();

    // Collect distinct eligible warehouses with their metadata
    let mut warehouse_ids: Vec<(String, u32)> = Vec::new();
    for slot in &eligible_slots {
        if !warehouse_ids.iter().any(|(id, _)| id == &slot.warehouse_id) {
            warehouse_ids.push((slot.warehouse_id.clone(), slot.priority_rank));
        }
    }

    // Track remaining demand per line index
    let mut remaining_demand: Vec<u32> = demands.iter().map(|d| d.quantity_requested).collect();
    let mut allocations: Vec<WarehouseShipmentAllocation> = Vec::new();

    // Track mutable available stock per (warehouse_id, variant_id)
    let mut working_stock: Vec<(String, String, u32)> = eligible_slots
        .iter()
        .map(|s| (s.warehouse_id.clone(), s.variant_id.clone(), s.available_quantity()))
        .collect();

    let lookup_avail = |stock: &[(String, String, u32)], wh_id: &str, var_id: &str| -> u32 {
        stock
            .iter()
            .filter(|(w, v, _)| w == wh_id && v == var_id)
            .map(|(_, _, q)| *q)
            .sum()
    };

    let deduct_stock = |stock: &mut [(String, String, u32)], wh_id: &str, var_id: &str, mut qty: u32| {
        for (w, v, avail) in stock.iter_mut() {
            if w == wh_id && v == var_id && *avail > 0 && qty > 0 {
                let take = (*avail).min(qty);
                *avail -= take;
                qty -= take;
            }
        }
    };

    match strategy {
        AllocationStrategy::PrioritizeRankOrder => {
            warehouse_ids.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            for (wh_id, _) in &warehouse_ids {
                for (idx, demand) in demands.iter().enumerate() {
                    let rem = remaining_demand[idx];
                    if rem == 0 {
                        continue;
                    }
                    let avail = lookup_avail(&working_stock, wh_id, &demand.variant_id);
                    let take = rem.min(avail);
                    if take > 0 {
                        deduct_stock(&mut working_stock, wh_id, &demand.variant_id, take);
                        remaining_demand[idx] -= take;
                        allocations.push(WarehouseShipmentAllocation {
                            warehouse_id: wh_id.clone(),
                            line_id: demand.line_id.clone(),
                            variant_id: demand.variant_id.clone(),
                            quantity_allocated: take,
                        });
                    }
                }
            }
        }
        AllocationStrategy::MinimizeSplitThenHighStock => {
            let mut used_warehouses: Vec<String> = Vec::new();

            loop {
                let total_remaining: u32 = remaining_demand.iter().sum();
                if total_remaining == 0 {
                    break;
                }

                // Evaluate each unused warehouse on:
                // 1. How many of the currently remaining units it can fulfill right now
                // 2. Total available stock across requested variants (tie-breaker for high stock)
                // 3. Priority rank ASC, then warehouse_id ASC
                let best_wh = warehouse_ids
                    .iter()
                    .filter(|(wh_id, _)| !used_warehouses.contains(wh_id))
                    .map(|(wh_id, rank)| {
                        let mut coverable_units = 0u32;
                        let mut total_pool_stock = 0u32;
                        for (idx, demand) in demands.iter().enumerate() {
                            let rem = remaining_demand[idx];
                            if rem > 0 {
                                let avail = lookup_avail(&working_stock, wh_id, &demand.variant_id);
                                coverable_units += rem.min(avail);
                                total_pool_stock += avail;
                            }
                        }
                        (wh_id.clone(), *rank, coverable_units, total_pool_stock)
                    })
                    .filter(|(_, _, coverable, _)| *coverable > 0)
                    .max_by(|a, b| {
                        a.2.cmp(&b.2)
                            .then_with(|| a.3.cmp(&b.3))
                            .then_with(|| b.1.cmp(&a.1))
                            .then_with(|| b.0.cmp(&a.0))
                    });

                let Some((chosen_wh, _, _, _)) = best_wh else {
                    break;
                };

                used_warehouses.push(chosen_wh.clone());
                for (idx, demand) in demands.iter().enumerate() {
                    let rem = remaining_demand[idx];
                    if rem == 0 {
                        continue;
                    }
                    let avail = lookup_avail(&working_stock, &chosen_wh, &demand.variant_id);
                    let take = rem.min(avail);
                    if take > 0 {
                        deduct_stock(&mut working_stock, &chosen_wh, &demand.variant_id, take);
                        remaining_demand[idx] -= take;
                        allocations.push(WarehouseShipmentAllocation {
                            warehouse_id: chosen_wh.clone(),
                            line_id: demand.line_id.clone(),
                            variant_id: demand.variant_id.clone(),
                            quantity_allocated: take,
                        });
                    }
                }
            }
        }
    }

    let mut shortfalls = Vec::new();
    for (idx, demand) in demands.iter().enumerate() {
        let missing = remaining_demand[idx];
        if missing > 0 {
            shortfalls.push(StockShortfall {
                line_id: demand.line_id.clone(),
                variant_id: demand.variant_id.clone(),
                quantity_requested: demand.quantity_requested,
                quantity_available: demand.quantity_requested - missing,
                quantity_missing: missing,
            });
        }
    }

    let mut distinct_shipments: Vec<&str> = Vec::new();
    for alloc in &allocations {
        if !distinct_shipments.contains(&alloc.warehouse_id.as_str()) {
            distinct_shipments.push(alloc.warehouse_id.as_str());
        }
    }

    AllocationPlanResult {
        is_fully_allocated: shortfalls.is_empty(),
        shipment_count: distinct_shipments.len(),
        allocations,
        shortfalls,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_minimize_split_prefers_single_warehouse_over_higher_rank_partial() {
        let demands = vec![
            OrderLineDemand {
                line_id: "L1".into(),
                variant_id: "SKU-A".into(),
                quantity_requested: 2,
            },
            OrderLineDemand {
                line_id: "L2".into(),
                variant_id: "SKU-B".into(),
                quantity_requested: 2,
            },
        ];

        // Warehouse US-EAST (rank 1) only has SKU-A (2 units)
        // Warehouse US-CENTRAL (rank 2) has BOTH SKU-A (5 units) and SKU-B (5 units)
        let slots = vec![
            WarehouseStockSlot {
                warehouse_id: "US-EAST".into(),
                priority_rank: 1,
                linked_to_channel: true,
                supports_shipping_zone: true,
                variant_id: "SKU-A".into(),
                quantity_on_hand: 2,
                quantity_reserved: 0,
                quantity_allocated: 0,
            },
            WarehouseStockSlot {
                warehouse_id: "US-CENTRAL".into(),
                priority_rank: 2,
                linked_to_channel: true,
                supports_shipping_zone: true,
                variant_id: "SKU-A".into(),
                quantity_on_hand: 6,
                quantity_reserved: 1,
                quantity_allocated: 0,
            },
            WarehouseStockSlot {
                warehouse_id: "US-CENTRAL".into(),
                priority_rank: 2,
                linked_to_channel: true,
                supports_shipping_zone: true,
                variant_id: "SKU-B".into(),
                quantity_on_hand: 5,
                quantity_reserved: 0,
                quantity_allocated: 0,
            },
        ];

        let plan = plan_inventory_allocation(
            &demands,
            &slots,
            StockAvailabilityMode::DirectChannelWarehouses,
            AllocationStrategy::MinimizeSplitThenHighStock,
        );

        assert!(plan.is_fully_allocated);
        assert_eq!(plan.shipment_count, 1);
        assert!(plan.allocations.iter().all(|a| a.warehouse_id == "US-CENTRAL"));
    }
}
