#![forbid(unsafe_code)]
//! `commerce-kernel` — The zero-float, deterministic calculation core of Super Ecommerce.
//!
//! Exposes four primary subsystems:
//! - [`money`]: Integer minor-unit monetary arithmetic, basis points, and B2B tier pricing.
//! - [`allocation`]: Hare-Niemeyer largest-remainder pro-rata distribution.
//! - [`pricing`]: Two-pass discount calculation, Saleor-grade precedence, and tax derivation.
//! - [`msi`]: Multi-source inventory availability and minimum-split warehouse allocation.
//! - [`rules_ast`]: Sub-microsecond boolean AST evaluator for promotion eligibility rules.

pub mod allocation;
pub mod b2b;
pub mod money;
pub mod msi;
pub mod pricing;
pub mod refund;
pub mod rules_ast;
