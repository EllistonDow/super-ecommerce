import { useId, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import type { AdminRpcClient, OrderSummaryDto } from "../api/rpc-client.ts";
import { formatMinorUnits, parseBigIntMinor, parseDecimalToMinorUnits } from "../lib/money.ts";
import { LightDismissDialog } from "../components/LightDismissDialog.tsx";

const columnHelper = createColumnHelper<OrderSummaryDto>();

export function OrdersOmsPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const queryClient = useQueryClient();
  const ordersCaptionId = useId();
  const editsCaptionId = useId();
  const [searchText, setSearchText] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [sortStatusMessage, setSortStatusMessage] = useState("");
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [mutationBanner, setMutationBanner] = useState<string | null>(null);

  // OMS Edit form fields
  const [targetLineId, setTargetLineId] = useState("L-ADDED");
  const [targetVariantId, setTargetVariantId] = useState("SKU-ADDON-STAND");
  const [targetQty, setTargetQty] = useState("1");
  const [targetUnitPriceMajor, setTargetUnitPriceMajor] = useState("25.00");
  const [editReason, setEditReason] = useState("Pre-fulfillment customer line modification");

  const ordersQuery = useQuery({
    queryKey: ["orders", "list", searchText, cursor],
    queryFn: () =>
      rpc.orders.list({
        limit: 20,
        q: searchText.trim() || undefined,
        cursor,
      }),
  });

  const selectedOrderQuery = useQuery({
    queryKey: ["orders", "detail", editingOrderId],
    queryFn: () => rpc.orders.get(editingOrderId!),
    enabled: Boolean(editingOrderId),
  });

  const editsQuery = useQuery({
    queryKey: ["orders", "edits"],
    queryFn: () => rpc.orders.listEdits(),
  });

  const editMutation = useMutation({
    mutationFn: async (params: {
      orderId: string;
      lineId: string;
      variantId: string;
      quantity: number;
      baseUnitPriceMinor: string;
      reason: string;
    }) => {
      const editId = `oe_${Date.now()}`;
      return rpc.orders.edit({
        idempotencyKey: `spa-edit-${editId}`,
        input: {
          editId,
          orderId: params.orderId,
          editedBy: "admin-spa@kronos.io",
          reason: params.reason,
          paymentTokenForIncrementalCapture: "pm_card_visa_incremental",
          lineMutations: [
            {
              lineId: params.lineId,
              variantId: params.variantId,
              quantity: params.quantity,
              baseUnitPrice: params.baseUnitPriceMinor,
              taxRateBps: 1000,
            },
          ],
        },
      });
    },
    onSuccess: (res) => {
      setMutationBanner(
        res.status === "COMPLETED" && res.output
          ? `OMS Edit ${res.output.editId} committed (${res.output.settlementKind}, delta ${res.output.deltaGrossAmount} minor units)`
          : `OMS Edit finished with status: ${res.status}`
      );
      setEditingOrderId(null);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["ledger"] });
    },
    onError: (err) => {
      setMutationBanner(`OMS Edit failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  const rmaMutation = useMutation({
    mutationFn: async (params: { orderId: string; lineId: string }) => {
      const rmaId = `rma_${Date.now()}`;
      return rpc.rma.processReturn({
        idempotencyKey: `spa-rma-${rmaId}`,
        input: {
          rmaId,
          orderId: params.orderId,
          reason: "Admin SPA 1-unit RMA return",
          linesToReturn: [{ lineId: params.lineId, quantity: 1, condition: "RESELLABLE" }],
        },
      });
    },
    onSuccess: (res) => {
      setMutationBanner(`RMA Saga completed with status: ${res.status}`);
      setEditingOrderId(null);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["ledger"] });
    },
  });

  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    []
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor("orderId", {
        header: "Order ID",
        sortingFn: (a, b) => collator.compare(a.original.orderId, b.original.orderId),
        cell: (info) => <span className="mono">{info.getValue()}</span>,
      }),
      columnHelper.accessor("channelSlug", {
        header: "Channel",
        sortingFn: (a, b) => collator.compare(a.original.channelSlug, b.original.channelSlug),
      }),
      columnHelper.accessor("paymentStatus", {
        header: "Payment",
        enableSorting: false,
        cell: (info) => (
          <span
            className={`badge ${
              info.getValue() === "CAPTURED"
                ? "badge-ok"
                : info.getValue() === "PARTIALLY_REFUNDED"
                  ? "badge-warn"
                  : "badge-danger"
            }`}
          >
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("fulfillmentStatus", {
        header: "Fulfillment",
        enableSorting: false,
        cell: (info) => <span className="badge">{info.getValue() ?? "UNFULFILLED"}</span>,
      }),
      columnHelper.accessor("totalGrossAmount", {
        header: "Total Gross",
        sortingFn: (a, b) => {
          const diff =
            parseBigIntMinor(a.original.totalGrossAmount) -
            parseBigIntMinor(b.original.totalGrossAmount);
          return diff < 0n ? -1 : diff > 0n ? 1 : 0;
        },
        cell: (info) => (
          <span className="mono">
            {formatMinorUnits(info.getValue(), info.row.original.currencyCode)}
          </span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: "OMS Actions",
        enableSorting: false,
        cell: ({ row }) => (
          <button
            type="button"
            className="btn"
            onClick={() => {
              const firstLine = row.original.pricing?.lines?.[0];
              if (firstLine) {
                setTargetLineId(firstLine.lineId);
                setTargetVariantId(firstLine.variantId);
                setTargetQty(String(firstLine.quantity + 1));
                setTargetUnitPriceMajor("25.00");
              }
              setEditingOrderId(row.original.orderId);
            }}
          >
            Inspect / Edit OMS
          </button>
        ),
      }),
    ],
    [collator]
  );

  const ordersData = useMemo(
    () => [...(ordersQuery.data?.items ?? [])],
    [ordersQuery.data?.items]
  );

  const table = useReactTable({
    data: ordersData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const handleEditSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingOrderId) return;
    const currency = selectedOrderQuery.data?.currencyCode ?? "USD";
    const minor = parseDecimalToMinorUnits(targetUnitPriceMajor, currency);
    editMutation.mutate({
      orderId: editingOrderId,
      lineId: targetLineId.trim(),
      variantId: targetVariantId.trim(),
      quantity: Number(targetQty),
      baseUnitPriceMinor: minor.toString(),
      reason: editReason.trim(),
    });
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Orders & Pre-Fulfillment OMS Studio</h1>
          <p>
            TanStack Table ledger with keyset pagination, live pre-fulfillment Order Editing Saga,
            and multi-wave RMA triggers.
          </p>
        </div>
        <div className="btn-row">
          <input
            type="search"
            placeholder="Filter order ID or customer..."
            aria-label="Filter orders by ID or customer"
            value={searchText}
            onChange={(e) => {
              setCursor(undefined);
              setSearchText(e.target.value);
            }}
            style={{
              minBlockSize: "36px",
              padding: "0.4rem 0.7rem",
              borderRadius: "0.45rem",
              border: "1px solid var(--border-subtle)",
              background: "var(--surface-card)",
              color: "var(--text-primary)",
            }}
          />
          {ordersQuery.data?.nextCursor ? (
            <button
              type="button"
              className="btn"
              onClick={() => setCursor(ordersQuery.data?.nextCursor ?? undefined)}
            >
              Next Cursor Page
            </button>
          ) : null}
          {cursor ? (
            <button type="button" className="btn" onClick={() => setCursor(undefined)}>
              Reset First Page
            </button>
          ) : null}
        </div>
      </header>

      {mutationBanner ? (
        <div className="card" role="status" style={{ marginTop: "1rem" }}>
          {mutationBanner}
        </div>
      ) : null}

      {/* Single polite status region for sort announcements (`sortable-table`) */}
      <div role="status" className="visually-hidden">
        {sortStatusMessage}
      </div>

      <div
        style={{ marginTop: "1.25rem" }}
        className="table-wrapper"
        tabIndex={0}
        role="region"
        aria-labelledby={ordersCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Channel"',
              "--col-3": '"Payment"',
              "--col-4": '"Fulfillment"',
              "--col-5": '"Total Gross"',
            } as CSSProperties
          }
        >
          <caption id={ordersCaptionId}>Keyset-Paginated Orders Ledger</caption>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortedDir = header.column.getIsSorted();
                  const ariaSort =
                    sortedDir === "asc"
                      ? "ascending"
                      : sortedDir === "desc"
                        ? "descending"
                        : undefined;
                  const labelText = String(header.column.columnDef.header ?? header.id);
                  return (
                    <th key={header.id} scope="col" aria-sort={ariaSort}>
                      {canSort ? (
                        <button
                          type="button"
                          className="sort-btn"
                          onClick={() => {
                            const nextDir = sortedDir === "asc" ? "desc" : "asc";
                            setSorting([{ id: header.column.id, desc: nextDir === "desc" }]);
                            setSortStatusMessage(
                              `Sorted by ${labelText}, ${
                                nextDir === "asc" ? "ascending" : "descending"
                              }, ${ordersData.length} rows`
                            );
                          }}
                        >
                          <span>{labelText}</span>
                          <span className="sort-icon" aria-hidden="true">
                            ▲
                          </span>
                        </button>
                      ) : (
                        labelText
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NO_ORDERS
                </th>
                <td colSpan={5}>No matching orders in PostgreSQL ledger.</td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.original.orderId}>
                  {row.getVisibleCells().map((cell, idx) =>
                    idx === 0 ? (
                      <th key={cell.id} scope="row">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </th>
                    ) : (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{ marginTop: "1.5rem" }}
        className="table-wrapper"
        tabIndex={0}
        role="region"
        aria-labelledby={editsCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Order"',
              "--col-3": '"Delta"',
              "--col-4": '"Settlement"',
              "--col-5": '"Reason"',
            } as CSSProperties
          }
        >
          <caption id={editsCaptionId}>OMS Pre-Fulfillment Order Edit Audit Trail</caption>
          <thead>
            <tr>
              <th scope="col">Edit ID</th>
              <th scope="col">Order</th>
              <th scope="col">Financial Delta</th>
              <th scope="col">Settlement</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {(editsQuery.data ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NONE
                </th>
                <td colSpan={4}>No OMS pre-fulfillment edits recorded yet.</td>
              </tr>
            ) : (
              editsQuery.data!.map((ed) => (
                <tr key={ed.editId}>
                  <th scope="row" className="mono">
                    {ed.editId}
                  </th>
                  <td className="mono">{ed.orderId}</td>
                  <td className="mono">{formatMinorUnits(ed.deltaGrossAmount, "USD")}</td>
                  <td>
                    <span className="badge badge-ok">{ed.settlementKind}</span>
                  </td>
                  <td>{ed.reason}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <LightDismissDialog
        open={Boolean(editingOrderId)}
        title={`OMS Studio: ${editingOrderId ?? ""}`}
        onClose={() => setEditingOrderId(null)}
      >
        {selectedOrderQuery.data ? (
          <div style={{ marginBottom: "1rem" }}>
            <div className="kpi-meta">
              Status: <strong>{selectedOrderQuery.data.fulfillmentStatus ?? "UNFULFILLED"}</strong>{" "}
              | Current Gross:{" "}
              <strong className="mono">
                {formatMinorUnits(
                  selectedOrderQuery.data.totalGrossAmount,
                  selectedOrderQuery.data.currencyCode
                )}
              </strong>
            </div>
            {(selectedOrderQuery.data.pricing?.lines ?? []).length > 0 ? (
              <div style={{ marginTop: "0.75rem" }} className="btn-row">
                {selectedOrderQuery.data.pricing!.lines.map((ln) => (
                  <button
                    key={ln.lineId}
                    type="button"
                    className="btn"
                    onClick={() =>
                      rmaMutation.mutate({
                        orderId: selectedOrderQuery.data!.orderId,
                        lineId: ln.lineId,
                      })
                    }
                  >
                    Trigger 1u RMA ({ln.lineId}: {ln.variantId})
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <form onSubmit={handleEditSubmit}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="oms-line-id">Line ID</label>
              <span id="oms-line-hint" className="hint">
                Existing line ID to adjust, or new line ID to append
              </span>
              <input
                id="oms-line-id"
                name="lineId"
                required
                aria-describedby="oms-line-hint"
                data-error="oms-line-err"
                value={targetLineId}
                onChange={(e) => setTargetLineId(e.target.value)}
              />
              <div id="oms-line-err" className="error-msg">
                <span role="img" aria-label="Error">
                  !
                </span>{" "}
                Enter a non-empty order line ID.
              </div>
            </div>

            <div className="field">
              <label htmlFor="oms-variant-id">Variant SKU</label>
              <span id="oms-sku-hint" className="hint">
                Warehouse-stocked SKU code
              </span>
              <input
                id="oms-variant-id"
                name="variantId"
                required
                aria-describedby="oms-sku-hint"
                data-error="oms-sku-err"
                value={targetVariantId}
                onChange={(e) => setTargetVariantId(e.target.value)}
              />
              <div id="oms-sku-err" className="error-msg">
                <span role="img" aria-label="Error">
                  !
                </span>{" "}
                Enter a valid Variant SKU identifier.
              </div>
            </div>

            <div className="field">
              <label htmlFor="oms-qty">New Quantity (0 = remove)</label>
              <span id="oms-qty-hint" className="hint">
                Whole integer &gt;= 0
              </span>
              <input
                id="oms-qty"
                name="quantity"
                type="number"
                min={0}
                required
                aria-describedby="oms-qty-hint"
                data-error="oms-qty-err"
                value={targetQty}
                onChange={(e) => setTargetQty(e.target.value)}
              />
              <div id="oms-qty-err" className="error-msg">
                <span role="img" aria-label="Error">
                  !
                </span>{" "}
                Enter an integer quantity of 0 or greater.
              </div>
            </div>

            <div className="field">
              <label htmlFor="oms-unit-price">Unit Price (Major Units)</label>
              <span id="oms-price-hint" className="hint">
                Exact decimal, e.g. 25.00
              </span>
              <input
                id="oms-unit-price"
                name="unitPrice"
                required
                pattern="^\d+(\.\d{1,4})?$"
                aria-describedby="oms-price-hint"
                data-error="oms-price-err"
                value={targetUnitPriceMajor}
                onChange={(e) => setTargetUnitPriceMajor(e.target.value)}
              />
              <div id="oms-price-err" className="error-msg">
                <span role="img" aria-label="Error">
                  !
                </span>{" "}
                Enter a valid decimal price such as 25.00.
              </div>
            </div>
          </div>

          <div className="field" style={{ marginTop: "0.9rem" }}>
            <label htmlFor="oms-reason">Audit Reason</label>
            <span id="oms-reason-hint" className="hint">
              Recorded in order_edits &amp; ORDER_EDIT_DELTA subledger journal
            </span>
            <input
              id="oms-reason"
              name="reason"
              required
              minLength={4}
              aria-describedby="oms-reason-hint"
              data-error="oms-reason-err"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
            />
            <div id="oms-reason-err" className="error-msg">
              <span role="img" aria-label="Error">
                !
              </span>{" "}
              Provide an audit reason of at least 4 characters.
            </div>
          </div>

          <div className="btn-row" style={{ marginTop: "1.25rem", justifyContent: "flex-end" }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={editMutation.isPending}
            >
              {editMutation.isPending
                ? "Executing OMS Saga..."
                : "Commit Pre-Fulfillment Order Edit"}
            </button>
          </div>
        </form>
      </LightDismissDialog>
    </div>
  );
}
