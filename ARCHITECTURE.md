# Super Ecommerce — 下一代全栈超高性能电商引擎架构蓝图

> **定位**：融合 **Saleor**（严谨的多渠道与财务/折扣模型）、**Medusa v2**（持久化 Saga 工作流编排）、**Vendure**（强类型策略模式）、**Magento 2**（复杂 B2B/MSI 业务深度）与 **Shopify Functions**（WASM 毫秒级插件沙盒）之所长，同时彻底根除它们的历史包袱与性能瓶颈。

---

## 1. 核心痛点复盘与设计铁律

### 1.1 现有顶级开源电商的「基因缺陷」

| 系统 | 核心优势（我们要继承的） | 致命痛点（我们要根除的） | Super Ecommerce 的破局方案 |
| :--- | :--- | :--- | :--- |
| **Saleor** | `Channel-First` 多渠道模型、两阶段折扣分摊、库存预留、`Configurator` 声明式配置 | 1. 结账链路串行调外部同步 HTTP Webhook（税/运/付），P99 延迟高达 1~2s<br>2. Python + Graphene 在复杂购物车重算时 CPU 开销大 | **Rust 确定性计算内核 + WASM 进程内插件沙盒**（消灭同步 Webhook 网络开销，结账算价 < 1ms） |
| **Medusa v2** | 模块化架构、`Durable Workflows`（Saga 自动补偿工作流）、前端全栈亲和度高 | 1. 过度拆分的 Module Links 导致跨模块查询退化为内存拼接，列表复杂过滤性能差<br>2. 财务分摊、复杂多渠道税率模型偏浅 | **PostgreSQL 17 关系主表 + JSONB 强校验 + CQRS 读写分离投影宽表**（单次索引扫描，拒绝跨模块内存 JOIN） |
| **Vendure** | 强类型插件接口、清晰的后台/店面双 Schema 隔离 | 重度依赖 NestJS 装饰器、`reflect-metadata` 与传统 ORM 黑盒，冷启动慢，无法直接跑在 Edge Runtime | **Hono + oRPC/GraphQL 双协议 + Drizzle/Kysely SQL-first**（零反射魔法、对人类与 AI Agent 100% 透明） |
| **Magento 2** | 极其深厚的促销 AST 规则引擎、阶梯价、B2B 企业购、多源库存（MSI） | EAV（实体-属性-值）几十张表 JOIN 地狱；脆弱的异步 Indexer 锁表 | **ProductType JSON Schema + PG `JSONB` GIN 索引 + CDC 毫秒级宽表投影** |

---

### 1.2 五大架构铁律 (Architectural Invariants)

1. **零浮点财务确定性 (Zero-Float Financial Determinism)**
   * 严禁在 JavaScript/TypeScript 中直接使用 `number` 浮点运算处理任何金额。
   * 所有货币金额在存储与传输层一律使用 **最小货币单位整数（Minor Units / BigInt，如美分 `cents`）**，所有折扣计算、税率折算、跨行按比例分摊（Pro-rata Allocation）及尾差修正（Penny Remainder Distribution）全部交由 **Rust 编写的纯函数内核 (`commerce-kernel`)** 执行。
   * 同一份 Rust 内核通过 **N-API** 跑在服务端，同时编译为 **WASM** 跑在边缘节点与浏览器端，实现前后端 100% 算价同构。
2. **全链路多渠道一等公民 (Channel-First Everything)**
   * 系统中不存在脱离 `Channel` 的商品价格、库存可见性、税费策略或支付方式。
   * 一套实例天然同时驱动：北美 DTC 零售站（USD，不含税展示）、欧洲 B2C 站（EUR，含增值税 VAT 展示）、全球 B2B 批发门户（阶梯价、账期支付、审批流）及线下 POS 收银端。
3. **极简起步，无限水平扩展 (Single-PG Bootstrap, Infinite Scale-Out)**
   * **Day-1 极简模式**：本地开发与中小型生产部署仅需 **`1 × PostgreSQL 17 + 1 × Runtime 进程`**。持久化工作流、延时任务队列（`SKIP LOCKED`）、全文检索（PG BM25 / `tsvector`）、向量语义搜索（`pgvector`）全部由单个 PostgreSQL 原生承载，**零 Redis / RabbitMQ / Elasticsearch 强依赖**。
   * **Day-100 巨型集群模式**：通过配置无缝切换至 **Valkey（Redis 内存原子库存锁）+ Typesense/Meilisearch（独立搜索引擎）+ Cloudflare Workers 边缘渲染**。
4. **纳秒级安全扩展，拒绝同步 Webhook 阻塞 (Sub-5ms Sandboxed Extensibility)**
   * 同步扩展点（自定义促销、运费过滤、税费覆盖、结账校验）采用 **「编译期 TypeScript Strategy + 运行时 WebAssembly (Extism) 沙盒插件」** 双轨制，执行耗时严格限制在 `5ms` 内。
   * 异步副作用（发邮件、同步 ERP/WMS、上报分析）全部走 **Transactional Outbox（事务发件箱）** 异步投递，绝不阻塞主交易事务。
5. **AI 与声明式 GitOps 原生 (AI-Native & Commerce-as-Code)**
   * 整店配置（渠道、国家税率、商品类型、属性字典、运费模板）支持一键导出为声明式 TypeScript/YAML 配置，通过 `diff` 与 `deploy` 实现 GitOps 版本化管理。
   * 原生内置 **MCP (Model Context Protocol) Server** 与 **Agentic Checkout 协议**，让 AI 既能当后台超级运营，也能作为外部购物 Agent 直接完成询价与下单。

---

## 2. 全局系统拓扑与分层架构

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                         1. Client & Edge Layer (全渠道接入层)                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐  │
│  │   Storefront App     │  │   Linear-Style Admin │  │  AI Agents & CLI Tools  │  │
│  │ (TanStack Start SSR) │  │ (TanStack Router/Tbl)│  │ (MCP Client / GitOps)   │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └────────────┬────────────┘  │
└─────────────┼─────────────────────────┼───────────────────────────┼───────────────┘
              │ oRPC (端到端零代码生成类型) │ oRPC / Streaming          │ MCP / CLI
┌─────────────▼─────────────────────────▼───────────────────────────▼───────────────┐
│                      2. Dual-Protocol API & CQRS Gateway (网关层)                  │
│  • 内部极速通道：Hono + oRPC (TypeScript 原生类型穿透 + 自动生成 OpenAPI 3.1)          │
│  • 开放生态通道：GraphQL Yoga (兼容三方 Storefront 与外部集成)                        │
│  • 读写路由分流：Query 直走 Read Projection 宽表；Mutation 进入领域服务与工作流       │
└─────────────┬─────────────────────────────────────────────────────┬───────────────┘
              │ Query (Read Path)                                   │ Command (Write Path)
              ▼                                                     ▼
┌─────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│   3A. Fast Read Engine (极速读引擎)   │   │   3B. Durable Workflow & Domain Layer   │
│  • Catalog Channel Projections 宽表  │   │  • PG-Backed Saga Workflow Engine       │
│  • 预计算价格区间 / 库存状态 / 属性   │   │    (自动重试、状态持久化、逆向补偿回滚)   │
│  • 全文检索 + 向量混合搜索 (Hybrid)   │   │  • 核心领域：Catalog / Inventory /      │
│  • Edge SWR + Valkey 多级缓存        │   │    Cart / Checkout / Order / B2B        │
└─────────────────────────────────────┘   └────────────────────┬────────────────────┘
                                                               │
                                          ┌────────────────────▼────────────────────┐
                                          │   4. Rust Commerce Kernel & WASM Host   │
                                          │  • 定点数货币运算 (Minor Units + Decimal)│
                                          │  • Two-Pass 折扣分摊 + 最大余数法尾差修正 │
                                          │  • 促销规则 AST 评估器 (< 0.5ms)         │
                                          │  • MSI 多仓最优拆单算子                  │
                                          │  • Extism WASM 插件沙盒宿主 (限流 5ms)   │
                                          └────────────────────┬────────────────────┘
                                                               │
┌──────────────────────────────────────────────────────────────▼────────────────────┐
│                     5. Unified Data & Event Backbone (数据底座)                    │
│  • PostgreSQL 17 (ACID 交易主表 + JSONB 动态属性 + Transactional Outbox 发件箱)     │
│  • Valkey / Redis (可选：秒杀热点库存 Lua 原子扣减、分布式限流)                      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Monorepo 工程目录结构

采用 **Bun + Turborepo + Cargo Workspace** 混合管理 TypeScript 与 Rust 代码：

```text
super-ecommerce/
├── Cargo.toml                        # Rust Workspace 根配置
├── package.json                      # Bun / Turborepo 根配置
├── turbo.json                        # 构建流水线与缓存编排
│
├── crates/                           # 【Rust 核心层】100% 纯函数、零 I/O、确定性计算
│   ├── commerce-kernel/              # 核心算子库（Money、两阶段折扣分摊、税费、AST 规则引擎、MSI 拆单）
│   ├── kernel-napi/                  # 编译为 Node-API (.node) 供后端零拷贝调用
│   └── kernel-wasm/                  # 编译为 WebAssembly (.wasm) 供边缘节点与浏览器端同构运行
│
├── packages/                         # 【TypeScript 领域与基础设施层】
│   ├── db/                           # PostgreSQL 17 Schema (Drizzle ORM + Kysely)、迁移与 JSON Schema 校验
│   ├── workflow/                     # 基于 PostgreSQL 的持久化 Saga 工作流引擎 (Step / Compensate / Retry)
│   ├── plugin-sdk/                   # 双模扩展 SDK：TS Strategy 接口定义 + Extism WASM 插件宿主
│   ├── core/                         # 核心业务领域模块
│   │   ├── channel/                  # 多渠道、币种、区域配置
│   │   ├── catalog/                  # 商品、变体、ProductType 动态属性、分类与集合、CQRS 宽表投影器
│   │   ├── pricing/                  # 渠道价格表、B2B 阶梯价、促销活动与优惠券管理
│   │   ├── inventory/                # 多源仓库 (MSI)、可用量/预占量/锁定库存、防超卖预留锁
│   │   ├── cart-checkout/            # 高并发购物车、乐观锁结账流水线
│   │   ├── order-fulfillment/        # 订单状态机、拆单发货、部分退货/换货/退款重算
│   │   └── customer-b2b/             # 客户体系、B2B 公司组织架构、采购配额与审批流
│   ├── configurator/                 # Commerce-as-Code 声明式配置同步引擎 (introspect / diff / deploy)
│   └── mcp-server/                   # 原生 MCP Server（赋能 AI 运营与 Agentic 购物）
│
└── apps/                             # 【可独立部署的应用层】
    ├── api/                          # Hono 服务端（同时挂载 oRPC 路由、GraphQL Yoga 与 Outbox Worker）
    ├── storefront/                   # TanStack Start + React 19 + Tailwind v4 旗舰店面
    └── admin/                        # TanStack Router + Table + Form + Shadcn UI 极速管理后台
```

---

## 4. 核心数据模型与 CQRS 读写分离设计 (`packages/db`)

### 4.1 彻底终结 EAV：关系主表 + JSONB 强 Schema 动态属性

Magento 的 EAV 模型为了支持自定义属性，把一个商品拆散到 `varchar`、`int`、`decimal` 等十几张属性表；而我们采用 **PostgreSQL 17 原生关系列 + 受 `ProductType` 严格约束的 `JSONB` 列 + `GIN` 索引**：

```sql
-- 1. 渠道表：所有业务规则的顶层锚点
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,                    -- 如 'us-retail', 'eu-b2b'
    name TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,               -- ISO 4217: 'USD', 'EUR', 'JPY'
    default_country CHAR(2) NOT NULL,             -- ISO 3166-1 alpha-2
    prices_entered_with_tax BOOLEAN NOT NULL DEFAULT false,
    tax_calculation_strategy TEXT NOT NULL DEFAULT 'FLAT_RATES', -- 'FLAT_RATES' | 'WASM_PLUGIN' | 'EXTERNAL_APP'
    allocation_strategy TEXT NOT NULL DEFAULT 'PRIORITIZE_HIGH_STOCK',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 商品类型表：定义动态属性的强类型 JSON Schema（取代 EAV 元数据表）
CREATE TABLE product_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,                    -- 如 'apparel', 'laptop'
    name TEXT NOT NULL,
    is_shipping_required BOOLEAN NOT NULL DEFAULT true,
    product_attributes_schema JSONB NOT NULL,     -- 约束 SPU 级属性（如材质、品牌、上市年份）
    variant_attributes_schema JSONB NOT NULL      -- 约束 SKU 级属性（如颜色、尺码、内存容量）
);

-- 3. 商品主表 (SPU) 與变体表 (SKU)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_type_id UUID NOT NULL REFERENCES product_types(id),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description JSONB,
    tax_class_id UUID,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb, -- SPU 动态属性，写入时由 Zod/JSON Schema 强校验
    search_vector tsvector,                        -- 原生全文检索向量
    embedding halfvec(1536),                       -- pgvector 语义搜索向量
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_attributes_gin ON products USING GIN (attributes jsonb_path_ops);

CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku TEXT UNIQUE NOT NULL,
    barcode TEXT,
    name TEXT NOT NULL,
    weight_grams INTEGER,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb, -- SKU 动态属性，如 {"color": "obsidian", "size": "XL"}
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_variants_attributes_gin ON product_variants USING GIN (attributes jsonb_path_ops);

-- 4. 变体在各渠道的独立上市与定价表（支持基础价、划线价与 B2B 阶梯价）
CREATE TABLE variant_channel_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    is_published BOOLEAN NOT NULL DEFAULT false,
    price_amount BIGINT NOT NULL,                 -- 最小货币单位整数（如 $19.99 -> 1999）
    compare_at_amount BIGINT,                     -- 原价/划线价
    cost_amount BIGINT,                           -- 成本价（用于毛利保护校验）
    tier_prices JSONB NOT NULL DEFAULT '[]'::jsonb, -- B2B 阶梯价: [{"min_qty": 10, "amount": 1800}, {"min_qty": 100, "amount": 1500}]
    UNIQUE (variant_id, channel_id)
);
```

### 4.2 极速读模型投影宽表 (`catalog_channel_projections`)

店面（Storefront）的流量 95% 是浏览、筛选与搜索。为了彻底避免实时 JOIN 10 张表并重算目录折扣，系统内置 **CQRS 投影器**：每当商品属性、渠道价格、目录促销或库存水位发生变更，在同一事务（或毫秒级 Outbox 消费者）中更新预计算宽表：

```sql
CREATE TABLE catalog_channel_projections (
    product_id UUID NOT NULL,
    channel_slug TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    min_effective_price BIGINT NOT NULL,          -- 已叠加上生效 Catalog Discount 后的最低 SKU 价
    max_effective_price BIGINT NOT NULL,
    is_in_stock BOOLEAN NOT NULL,                 -- 该渠道绑定仓库下是否有可用库存
    total_available_qty INTEGER NOT NULL,
    merged_attributes JSONB NOT NULL,             -- 聚合 SPU + 所有在售 SKU 的属性，用于 Faceted Search 极速分面聚合
    variants_snapshot JSONB NOT NULL,             -- 预组装好的变体卡片数组，商品详情页 (PDP) 单行读取直出！
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_slug, product_id)
);
CREATE INDEX idx_proj_filter ON catalog_channel_projections (channel_slug, is_in_stock, min_effective_price);
CREATE INDEX idx_proj_facets ON catalog_channel_projections USING GIN (merged_attributes jsonb_path_ops);
```
> **收益**：无论商品模型多复杂，店面渲染 PDP（商品详情页）和 PLP（分类筛选列表页）永远是 **单表主键/索引点查**，数据库耗时 `< 2ms`。

### 4.3 多源库存 (MSI) 与防超卖三级库存模型

借鉴 Saleor 3.23+ 与 Magento MSI，库存分为三个严格正交的水位：
* `quantity_on_hand`（实物在库总量）
* `quantity_reserved`（结账中临时预留锁，带 `expires_at` TTL，超时未支付自动释放）
* `quantity_allocated`（已生成正式订单但尚未出库扣减的锁定库存）
* **公式**：`可用库存 (Available) = quantity_on_hand - quantity_reserved - quantity_allocated`

---

## 5. Rust 确定性计算内核 (`crates/commerce-kernel`)

这是 Super Ecommerce 区别于所有纯 Node.js / Python 电商引擎的核心护城河。

### 5.1 为什么必须解决「两阶段折扣分摊与 1 分钱尾差」？

在电商实战（尤其是吸收自 Saleor Core 的生产经验）中，最容易引发财务对账崩溃的场景是：
* 购物车有 3 件商品：A（$10.00）、B（$10.00）、C（$10.00），总额 $30.00。
* 使用了一张「整单立减 $10.00」的优惠券，实付 $20.00。
* **如果不在行级别精确分摊这 $10.00**：当用户申请仅退掉商品 A 时，系统不知道该退多少钱！如果简单除以 3（`1000 / 3 = 333.33...` 美分），就会丢失 `1` 美分（`333 * 3 = 999 != 1000`），支付网关（Stripe/Adyen）会因为行汇总金额与订单总金额相差 1 美分而直接拒绝退款请求！

### 5.2 Rust 内核算法规范：Two-Pass Calculation + 最大余数法 (Largest Remainder Method)

```rust
// crates/commerce-kernel/src/pricing.rs

/// 金额一律使用最小货币单位整数 (i64)，彻底杜绝 IEEE 754 浮点数误差
pub type MinorUnits = i64;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LineInput {
    pub line_id: String,
    pub variant_id: String,
    pub quantity: u32,
    pub base_unit_price: MinorUnits,
    /// Pass 1: 目录级折扣或单品级优惠券立减总额
    pub catalog_and_line_discount: MinorUnits,
    pub tax_rate_bps: u32, // 基点表示的税率，如 8.25% -> 825 bps
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CalculatedLine {
    pub line_id: String,
    pub subtotal_before_order_discount: MinorUnits,
    /// Pass 2: 使用最大余数法 (Hare-Niemeyer) 精确分摊到该行的整单级折扣
    pub allocated_order_discount: MinorUnits,
    pub final_net_amount: MinorUnits,
    pub tax_amount: MinorUnits,
    pub final_gross_amount: MinorUnits,
}
```

**两阶段核心流水线**：
1. **Pass 1（行级折算）**：计算每行扣除 `Catalog Promotion`、B2B 阶梯价与 `Specific-Product Voucher` 后的小计 `subtotal_i`。
2. **Pass 2（整单折扣 Pro-rata 分摊）**：
   * 设整单满减/优惠券总额为 $D$，参与分摊的各行小计之和为 $S = \sum subtotal_i$。
   * 每行理论分摊额为精确有理数 $d_i = D \times \frac{subtotal_i}{S}$。
   * 先取整数部分 $\lfloor d_i \rfloor$，计算剩余尾差 $R = D - \sum \lfloor d_i \rfloor$（必满足 $0 \le R < N$）。
   * 按余数 $(D \times subtotal_i) \bmod S$ 从大到小排序（余数相同时按 `line_id` 字典序确定性破平局），前 $R$ 行各补 `1` 个最小货币单位。
   * **数学不变量保证**：$\sum \text{allocated\_order\_discount}_i \equiv D$ 恒成立，且结果 100% 确定可复现。
3. **Pass 3（含税/不含税双向推导与尾差对齐）**：支持美国模式（Net + Tax = Gross）与欧洲/中国 VAT 模式（Gross 内含税逆推 Net 与 Tax）。

---

## 6. 持久化工作流引擎 (`packages/workflow`)

吸取 Medusa v2 与 DBOS 的精华，任何跨服务或带副作用的操作（结账、拆单、退货退款）都封装为 **基于 PostgreSQL 的持久化 Saga 状态机**，无需额外部署 Temporal 集群：

### 6.1 核心结账工作流 (`completeCheckoutWorkflow`)

```typescript
// packages/core/src/cart-checkout/workflows/complete-checkout.ts
import { createWorkflow, createStep } from "@super-ecommerce/workflow";

export const completeCheckoutWorkflow = createWorkflow(
  "complete-checkout",
  async (input: { checkoutId: string; idempotencyKey: string }, ctx) => {
    // Step 1: 使用 Rust 内核做最终价格/折扣/税费验签，防止前端篡改或促销过期
    const verifiedTotals = await ctx.run(verifyPricingStep, input);

    // Step 2: 锁定多源仓库库存（将 Reservation 转为 Allocation）
    // 若后续任何步骤失败，自动逆向执行 releaseAllocation 补偿函数
    const allocation = await ctx.run(allocateInventoryStep, {
      checkoutId: input.checkoutId,
      lines: verifiedTotals.lines,
    });

    // Step 3: 扣减礼品卡/账户余额（带逆向充值补偿）
    await ctx.run(redeemGiftCardsStep, { checkoutId: input.checkoutId });

    // Step 4: 调用支付网关验证或 Capture 授权资金（带自动 Void/Refund 补偿）
    const paymentTx = await ctx.run(capturePaymentStep, {
      checkoutId: input.checkoutId,
      expectedAmount: verifiedTotals.totalGrossAmount,
    });

    // Step 5: 在同一 PG 事务内创建正式订单、写入财务流水并投递 Outbox 事件
    const order = await ctx.run(commitOrderRecordStep, {
      checkoutId: input.checkoutId,
      verifiedTotals,
      allocation,
      paymentTx,
    });

    return order;
  }
);
```

### 6.2 崩溃恢复与零掉单保证
* 每个 `ctx.run(step, payload)` 执行完毕后，其输出立刻写入 `workflow_step_logs` 表。
* 如果进程在 `Step 4`（支付成功）后、`Step 5`（生成订单）前因容器重启或断电崩溃，后台守护协程扫描到未完成的 Workflow，会**自动跳过已成功的 Step 1~4（直接读取持久化输出），从 Step 5 继续执行**，从根源上消灭「扣了钱没生成单」的电商顽疾。

---

## 7. 双模扩展体系：TypeScript Strategy + WASM 插件沙盒 (`packages/plugin-sdk`)

为了兼顾「自研团队极致开发效率」与「第三方生态绝对安全高速」，系统提供两层扩展接口：

### 7.1 模式 A：进程内强类型 Strategy（适合自建团队）
直接实现 TypeScript 接口并注册到引擎配置中，零序列化成本：
```typescript
export interface ShippingFilterStrategy {
  filterMethods(ctx: CheckoutContext, methods: ShippingMethod[]): Promise<ShippingMethod[]>;
}
```

### 7.2 模式 B：WebAssembly (Extism) 隔离沙盒（适合多租户/三方插件/动态热加载）
借鉴 **Shopify Functions**：
* 插件开发者可用 Rust / TypeScript (Javy) / Go 编写自定义促销、运费计算或欺诈风控逻辑，编译成 `.wasm` 文件上传至后台。
* 引擎通过 **Extism / Wasmtime** 在进程内调用：
  * **内存完全隔离**：插件无法访问宿主文件系统、环境变量或数据库；
  * **CPU Fuel 熔断**：单次调用强制限制在 `5ms` CPU 时间内，死循环插件会被纳秒级终止并降级到默认策略，绝不拖垮结账主链路。

---

## 8. AI-Native 与 Commerce-as-Code 设计

### 8.1 `packages/configurator`（声明式商店配置 GitOps）
继承并强化 `saleor-configurator` 的理念，解决多环境配置同步难题：
```bash
# 从线上环境逆向导出当前所有渠道、商品类型、税区与运费模板
bun run configurator introspect --url https://api.shop.com --out store.config.ts

# 对比本地 Git 仓库配置与目标环境的差异（输出可视化变更计划）
bun run configurator diff --config store.config.ts

# 幂等部署配置变更（严格遵循：Channels -> TaxClasses -> ProductTypes -> Warehouses -> ShippingZones 依赖拓扑序）
bun run configurator deploy --config store.config.ts
```

### 8.2 `packages/mcp-server`（内置 Model Context Protocol）
系统原生暴露两套 MCP 工具集：
1. **Merchant Copilot MCP（后台运营态）**：
   * `simulate_promotion_rule`：AI 根据运营自然语言生成促销 AST 规则，并在真实历史订单样本上沙盒试算毛利影响，确认无误后一键发布。
   * `diagnose_price_breakdown`：输入任意订单号或购物车 ID，输出 Rust 内核每一层折扣与尾差的分摊解释树。
2. **Agentic Storefront MCP（消费者购物态）**：
   * 外部 AI 助手可直接调用 `search_catalog_hybrid`、`calculate_cart_preview`、`create_agentic_checkout_session`，无需爬取 HTML 即可毫秒级完成精准导购与结账。

---

## 9. 分阶段实施路线图 (Implementation Roadmap)

为了稳步将这套蓝图落地为可运行的工程代码，建议按以下四个阶段递进实施：

* **Phase 1：Monorepo 底座与 Rust 确定性计算内核 (`crates/commerce-kernel` + `packages/db`)**
  * 搭建 Bun + Turborepo + Cargo 工作区；
  * 实现 Rust 核心计价引擎（定点数运算、Two-Pass 折扣分摊、最大余数法尾差分配、税费正逆算）并通过完备的属性测试（Property-based Testing）；
  * 编写 PostgreSQL 17 核心 Schema（Channels、ProductTypes、Products/Variants JSONB、MSI 库存、Workflow 状态表）。
* **Phase 2：持久化工作流引擎与核心交易链路 (`packages/workflow` + `packages/core`)**
  * 实现基于 PG 的 Saga 工作流执行器（支持正向执行、幂等恢复与逆向 `compensate`）；
  * 实现 Catalog CQRS 宽表投影器、三级库存预留锁与 `completeCheckoutWorkflow` 完整闭环。
* **Phase 3：双协议网关、WASM 插件宿主与工具链 (`apps/api` + `packages/plugin-sdk` + `packages/configurator` + `packages/mcp-server`)**
  * 使用 Hono + oRPC + GraphQL Yoga 暴露 API；
  * 集成 Extism WASM 插件沙盒、实现 `configurator` 声明式同步 CLI 与 MCP Server。
* **Phase 4：边缘优先店面与 Linear 风格极速后台 (`apps/storefront` + `apps/admin`)**
  * 基于 TanStack Start 构建秒开店面；
  * 基于 TanStack Router + Table + Query + Shadcn UI 构建全键盘快捷键、虚拟滚动表格的现代化管理后台。
