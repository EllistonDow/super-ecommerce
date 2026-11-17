//! Deterministic Pro-Rata Allocation using the Hare-Niemeyer Largest Remainder Method.
//!
//! Unlike naive implementations that dump all rounding error onto the last line
//! (which depends on DB iteration order and can distort a single line by `N - 1` cents),
//! this module distributes remainders 1 minor unit at a time ordered by:
//!   1. Exact rational remainder `(total_to_allocate * weight_i) % total_weight` DESC
//!   2. Line identifier `line_id` ASC (deterministic tie-breaker)
//!
//! Guarantees:
//! - Exact conservation of money: `sum(allocated_i) == min(total_to_allocate, sum(weight_i))`
//! - Order independence: permuting the input slice yields the exact same allocation per `line_id`
//! - Non-negativity and upper bound: `0 <= allocated_i <= weight_i`

use crate::money::MinorUnits;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeightedItem {
    pub id: String,
    pub weight: MinorUnits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedShare {
    pub id: String,
    pub allocated: MinorUnits,
}

/// Allocates `total_to_allocate` across `items` proportionally to each item's `weight`.
pub fn allocate_pro_rata(total_to_allocate: MinorUnits, items: &[WeightedItem]) -> Vec<AllocatedShare> {
    if items.is_empty() {
        return Vec::new();
    }

    let total_weight: i128 = items
        .iter()
        .map(|item| item.weight.max(0) as i128)
        .sum();

    if total_to_allocate <= 0 || total_weight <= 0 {
        return items
            .iter()
            .map(|item| AllocatedShare {
                id: item.id.clone(),
                allocated: 0,
            })
            .collect();
    }

    // Cap the total allocation at the available total weight so no item goes negative
    let capped_total = (total_to_allocate as i128).min(total_weight);

    struct WorkingSlot<'a> {
        original_index: usize,
        id: &'a str,
        floor_share: MinorUnits,
        remainder: i128,
    }

    let mut slots: Vec<WorkingSlot<'_>> = Vec::with_capacity(items.len());
    let mut sum_floors: i128 = 0;

    for (idx, item) in items.iter().enumerate() {
        let w = item.weight.max(0) as i128;
        let numerator = capped_total * w;
        let floor_val = (numerator / total_weight) as MinorUnits;
        let rem_val = numerator % total_weight;
        sum_floors += floor_val as i128;
        slots.push(WorkingSlot {
            original_index: idx,
            id: item.id.as_str(),
            floor_share: floor_val,
            remainder: rem_val,
        });
    }

    let remainder_units = (capped_total - sum_floors) as usize;
    debug_assert!(remainder_units < items.len());

    // Sort by (remainder DESC, id ASC) for 100% input-order independence
    slots.sort_by(|a, b| {
        b.remainder
            .cmp(&a.remainder)
            .then_with(|| a.id.cmp(b.id))
    });

    for slot in slots.iter_mut().take(remainder_units) {
        slot.floor_share += 1;
    }

    // Restore original input order
    slots.sort_by_key(|s| s.original_index);

    slots
        .into_iter()
        .map(|s| AllocatedShare {
            id: s.id.to_string(),
            allocated: s.floor_share,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_three_way_penny_split_is_exact_and_order_independent() {
        // $10.00 (1000 cents) discount across 3 equal $10.00 lines -> 334, 333, 333
        let items_a = vec![
            WeightedItem { id: "line-b".into(), weight: 1000 },
            WeightedItem { id: "line-a".into(), weight: 1000 },
            WeightedItem { id: "line-c".into(), weight: 1000 },
        ];
        let items_b = vec![
            WeightedItem { id: "line-c".into(), weight: 1000 },
            WeightedItem { id: "line-b".into(), weight: 1000 },
            WeightedItem { id: "line-a".into(), weight: 1000 },
        ];

        let res_a = allocate_pro_rata(1000, &items_a);
        let res_b = allocate_pro_rata(1000, &items_b);

        let sum_a: MinorUnits = res_a.iter().map(|s| s.allocated).sum();
        assert_eq!(sum_a, 1000);

        // "line-a" wins the tie-breaker in both permutations
        let a_in_a = res_a.iter().find(|s| s.id == "line-a").unwrap().allocated;
        let a_in_b = res_b.iter().find(|s| s.id == "line-a").unwrap().allocated;
        assert_eq!(a_in_a, 334);
        assert_eq!(a_in_b, 334);
    }

    #[test]
    fn test_allocation_never_exceeds_weight() {
        let items = vec![
            WeightedItem { id: "line-1".into(), weight: 300 },
            WeightedItem { id: "line-2".into(), weight: 200 },
        ];
        // $50.00 discount on a $5.00 cart caps at $5.00
        let res = allocate_pro_rata(5000, &items);
        assert_eq!(res[0].allocated, 300);
        assert_eq!(res[1].allocated, 200);
    }
}
