#![forbid(unsafe_code)]
//! `commerce-kernel` — The zero-float, deterministic calculation core of Super Ecommerce.
//!
//! Exposes primary subsystems:
//! - [`money`]: Integer minor-unit monetary arithmetic, ISO-4217 currency precision, VAT derivation, and B2B tier pricing.
//! - [`allocation`]: Hare-Niemeyer largest-remainder pro-rata distribution.
//! - [`pricing`]: Two-pass discount calculation, Saleor-grade precedence, Gross Margin Floor Guard, and tax derivation.
//! - [`msi`]: Multi-source inventory availability and minimum-split warehouse allocation.
//! - [`rules_ast`]: Sub-microsecond boolean & action AST solver for promotion rules (including BOGO).
//! - [`wire_codec`]: Injection-safe record wire codec shared across N-API and WebAssembly targets.

pub mod allocation;
pub mod b2b;
pub mod money;
pub mod msi;
pub mod pricing;
pub mod refund;
pub mod rules_ast;
pub mod wire_codec;
