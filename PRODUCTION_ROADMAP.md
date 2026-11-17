# Super Ecommerce — 生产级深化迭代路线图 (Phase 5 – Phase 8)

> **基线状态**：Phase 1 – Phase 4 核心架构蓝图已完成（19,328 行 Rust + TypeScript 代码，8 项 Rust 单元测试 + 33 项 TS 全链路测试 100% 通过）。
> **迭代目标**：将系统从「架构基准与核心闭环完备（95%）」推向「100% 生产级商业化交付（Enterprise Production-Ready）」，补齐售后逆向财务重算、B2B 企业采购审批、混合检索与过期锁自动回收、以及独立 CLI 与多路由前后台工程化。

---

## 迭代全景矩阵

| 阶段 | 迭代主题 | 核心涉及模块 | 解决的生产级痛点 | 验收标准 (DoD) |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 5** | **售后履约、拆单发货与部分退换货 (RMA) 逆向算价内核** | `crates/commerce-kernel/src/refund.rs`<br>`crates/kernel-napi`<br>`packages/core/src/rma-fulfillment-workflow.ts` | 多行订单叠加整单优惠券后，部分退货（如 3 件退 1 件、分批退完）极易产生 1 分钱超退或少退，导致 Stripe/Adyen 拒付或财务平账失败。 | • Rust 内核支持按行累计已退数量与已退金额追踪，最后一件退货时 100% 严丝合缝退还尾差<br>• 持久化 RMA Saga 支持原路退储值卡 + 退支付网关 + MSI 回库及 LIFO 补偿 |
| **Phase 6** | **B2B 企业组织架构、授信账期与采购审批流** | `packages/core/src/b2b-organization.ts`<br>`packages/mcp-server`<br>`apps/api` | 大型工业/批发客户需要「公司 -> 成本中心 -> 采购员」多级配额、Net-30 授信额度校验及超限额主管审批单（PO Approval）。 | • 支持单笔采购限额、月度部门预算与企业授信池（`MinorUnits`）原子扣减<br>• 超额自动挂起为 `PENDING_APPROVAL` 并延长 MSI 预留锁，审批通过自动触发 Saga 结账 |
| **Phase 7** | **混合向量检索 (RRF)、预留锁 TTL 回收守护与 Configurator CLI** | `packages/db/src/hybrid-search.ts`<br>`packages/core/src/reservation-reaper.ts`<br>`packages/configurator/src/cli.ts` | 1. 关键词搜索无法召回语义同义词；<br>2. 弃单的 `quantity_reserved` 预留锁需毫秒级自动释放；<br>3. 缺少独立 `introspect/diff/deploy` CLI 入口。 | • 实现 BM25 + 向量余弦相似度 `Reciprocal Rank Fusion (RRF)` 混合检索<br>• 预留锁到期自动释放压测零超卖、零死锁<br>• `npm run configurator -- diff/deploy` CLI 可直接运行 |
| **Phase 8** | **多路由店面闭环 (PDP/Checkout/Order) 与后台 SSE 实时遥测** | `apps/storefront/src/`<br>`apps/admin/src/`<br>`apps/api/src/dev-server.ts` | 店面需补齐商品详情页（PDP）、独立结账与自助售后申请页；后台需支持实时 Server-Sent Events (SSE) 事件流推送。 | • 店面支持 `/products/:slug`、`/orders/:id` 自助退货交互<br>• 后台支持实时 SSE 订单/Outbox/RBAC 流水推送与在线 YAML/JSON 配置 Diff 编辑器 |

---

## Phase 5：售后履约与部分退换货 (RMA) 逆向财务内核（第一优先级）

### 5.1 核心架构设计
在 [crates/commerce-kernel/src/pricing.rs](crates/commerce-kernel/src/pricing.rs) 已经实现了正向两阶段折扣分摊（`allocated_order_discount`）的基础上，新增 **[crates/commerce-kernel/src/refund.rs](crates/commerce-kernel/src/refund.rs)**：

1. **行级可退余额不变量 (Line Refundable Ceiling Invariant)**：
   * 设某行原始购买数量为 $Q$，扣除所有目录折扣与分摊整单折扣后的最终实付净额为 $N_{\text{line}}$、税额为 $T_{\text{line}}$、含税总额为 $G_{\text{line}}$。
   * 历史已退数量为 $q_{\text{prev}}$，历史已退总额为 $g_{\text{prev}}$；本次申请退货数量为 $q_{\text{now}}$（满足 $q_{\text{prev}} + q_{\text{now}} \le Q$）。
   * **非末尾部分退货**（$q_{\text{prev}} + q_{\text{now}} < Q$）：按 Hare-Niemeyer 单位分摊计算本次应退金额；
   * **清零退货**（$q_{\text{prev}} + q_{\text{now}} == Q$）：直接取剩余未退额度 $G_{\text{line}} - g_{\text{prev}}$，从数学上保证**多次部分退货累加恒等于原始行实付金额**（$\sum g_k \equiv G_{\text{line}}$），彻底杜绝 1 分钱尾差泄漏。
2. **折旧/退仓手续费（Restocking Fee BPS）与运费退还策略**：
   * 支持按基点（如 `1500 bps = 15%`）扣除退仓损耗费，且赠品行（`is_gift = true`）退款金额恒为 `0`。
3. **RMA 持久化 Saga 工作流 (`processReturnRefundWorkflow`)**：
   * `Step 1 (verify-rma-calculation)`：调用 Rust 内核验算本次可退净额、税额、储值卡优先退回额与外部网关应退额。
   * `Step 2 (restock-msi-inventory)`：将合格退货品加回指定仓库 `quantity_on_hand`（残次品进入隔离仓不加可用量），失败自动逆向扣回。
   * `Step 3 (refund-store-credit)`：退还订单曾抵扣的礼品卡/储值余额。
   * `Step 4 (refund-payment-gateway)`：调用支付网关 `voidOrRefund` 退还实付现金。
   * `Step 5 (commit-rma-and-outbox)`：持久化 `ReturnRecord`、更新订单状态为 `PARTIALLY_REFUNDED` / `REFUNDED`，并投递 `order.refunded.v1` Outbox 事件。

---

## Phase 6：B2B 企业组织架构、授信账期与采购审批流

### 6.1 核心架构设计 (`packages/core/src/b2b-organization.ts`)
1. **三层企业组织模型**：
   * `B2bCompany`（授信总额度 `creditLimit`、已用额度 `creditUsed`、账期类型 `NET_30 | NET_60`、专属价格等级）
   * `B2bCostCenter`（部门月度预算上限 `monthlyBudget`、已消耗预算 `monthlySpent`）
   * `B2bBuyerMember`（角色：`BUYER` | `APPROVER` | `COMPANY_ADMIN`，单笔免审额度 `autoApproveThreshold`）
2. **采购审批与 MSI 预留锁联动**：
   * 当 `BUYER` 下单金额 $\le \text{autoApproveThreshold}$ 且未超部门预算与公司授信额度时，直接进入 `completeCheckoutWorkflow` 完成下单。
   * 当订单金额超出免审阈值时，生成 `PurchaseOrderApprovalRequest`（状态 `PENDING_APPROVAL`），同时在 MSI 库存服务中将该购物车的 `Reservation` TTL 延长至审批窗口期（如 72 小时）；待 `APPROVER` 批准后一键转化为正式订单。

---

## Phase 7：混合向量检索 (RRF)、预留锁 TTL 回收与 Configurator CLI

### 7.1 核心架构设计
1. **BM25 + Vector RRF 混合检索 (`packages/db/src/hybrid-search.ts`)**：
   * 结合词法相关性得分（BM25 / `tsvector` 权重）与确定性特征向量余弦相似度，使用 **Reciprocal Rank Fusion** 公式：
     $$\text{RRF\_Score}(d) = \frac{1}{k + \text{rank}_{\text{lexical}}(d)} + \frac{1}{k + \text{rank}_{\text{vector}}(d)} \quad (k = 60)$$
   * 赋能 MCP `search_catalog_hybrid` 同时具备精确 SKU/型号匹配与模糊语义导购能力。
2. **MSI 预留锁过期自动回收器 (`packages/core/src/inventory-service.ts`)**：
   * 支持基于时间戳的确定性 `reapExpiredReservations(nowMs)` 批处理，将超时未支付结账单的 `quantity_reserved` 原子归还至可用库存，并同步写入 PostgreSQL `stock_quants`。
3. **Configurator 独立 CLI (`packages/configurator/src/cli.ts`)**：
   * 在根 `package.json` 暴露 `npm run configurator -- introspect | diff | deploy`，支持终端彩色拓扑执行计划输出与 JSON 审计报告导出。

---

## Phase 8：多路由店面闭环与后台实时遥测升级

### 8.1 核心架构设计
1. **店面多视图体验 (`apps/storefront`)**：
   * 新增商品详情抽屉/路由（展示 SKU 级变体矩阵、B2B 阶梯价对照表、各仓实时库存分布）与订单自助售后 RMA 试算器。
2. **后台控制平面 (`apps/admin` & `apps/api`)**：
   * 在 `/admin` 集成 Phase 5（RMA 部分退货与 1 分钱尾差演练舱）与 Phase 6（B2B 授信额度与采购审批台），并提供一键复现与实测指标看板。
