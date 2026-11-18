# syntax=docker/dockerfile:1.7

# ==============================================================================
# Stage 1: Compile Native Rust N-API (`.node`) & WebAssembly (`.wasm`) Kernels
# ==============================================================================
FROM rust:1-bookworm AS rust-builder

WORKDIR /build

RUN rustup target add wasm32-unknown-unknown

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN cargo build --release -p kernel-napi --locked \
    && cargo build --release --target wasm32-unknown-unknown -p kernel-wasm --locked

# ==============================================================================
# Stage 2: Minimal Node 22 Runtime (glibc-matched to rust:1-bookworm)
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100 \
    SUPER_PG_USE_WIRE=1 \
    SUPER_PG_HOST=postgres \
    SUPER_PG_PORT=5432 \
    SUPER_PG_USER=super \
    SUPER_PG_DB=super_ecommerce

# Copy workspace manifests & TypeScript sources (zero external npm runtime deps)
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

# Place freshly compiled Linux native Rust N-API addon & WASM binary for @super-ecommerce/kernel
RUN mkdir -p /app/packages/kernel/native
COPY --from=rust-builder /build/target/release/libkernel_napi.so /app/packages/kernel/native/commerce_kernel.node
COPY --from=rust-builder /build/target/wasm32-unknown-unknown/release/kernel_wasm.wasm /app/packages/kernel/native/commerce_kernel.wasm

# Create npm workspace symlinks (node_modules/@super-ecommerce/*) deterministically
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && chown -R node:node /app

USER node

EXPOSE 4100

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4100) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--experimental-strip-types", "apps/api/src/prod-server.ts"]
