import { useId, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";

export function InventoryOutboxPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const queryClient = useQueryClient();
  const slotsCaptionId = useId();
  const outboxCaptionId = useId();
  const [opsReport, setOpsReport] = useState<string | null>(null);

  const slotsQuery = useQuery({
    queryKey: ["inventory", "listSlots"],
    queryFn: () => rpc.inventory.listSlots(50),
  });

  const outboxQuery = useQuery({
    queryKey: ["outbox", "listPending"],
    queryFn: () => rpc.outbox.listPending(30),
  });

  const reapMutation = useMutation({
    mutationFn: () => rpc.inventory.reapExpired(),
    onSuccess: (res) => {
      setOpsReport(
        `TTL Reaper swept ${res.stockReap.reapedReservationCount} expired holds (${res.stockReap.totalUnitsReleased} units released)`
      );
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  const recoverMutation = useMutation({
    mutationFn: () => rpc.workflow.recoverOrphans(),
    onSuccess: (res) => {
      setOpsReport(
        `SagaRecoveryWorker scanned ${res.scannedCount} zombie leases, recovered ${res.recoveredCount} runs`
      );
    },
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>MSI Warehouse Slots, Saga Leases &amp; Outbox</h1>
          <p>
            Multi-warehouse stock availability, expired reservation reaping, zombie Saga lease
            recovery, and transactional outbox inspection.
          </p>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => reapMutation.mutate()}
            disabled={reapMutation.isPending}
          >
            Reap Expired TTL Holds
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => recoverMutation.mutate()}
            disabled={recoverMutation.isPending}
          >
            Recover Orphaned Saga Leases
          </button>
        </div>
      </header>

      {opsReport ? (
        <div className="card" role="status" style={{ marginTop: "1rem" }}>
          {opsReport}
        </div>
      ) : null}

      <div
        style={{ marginTop: "1.25rem" }}
        className="table-wrapper"
        tabIndex={0}
        role="region"
        aria-labelledby={slotsCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Warehouse"',
              "--col-3": '"On Hand"',
              "--col-4": '"Reserved / Allocated"',
              "--col-5": '"Available"',
            } as CSSProperties
          }
        >
          <caption id={slotsCaptionId}>Multi-Source Inventory (MSI) Warehouse Slots</caption>
          <thead>
            <tr>
              <th scope="col">Variant SKU</th>
              <th scope="col">Warehouse</th>
              <th scope="col">On Hand</th>
              <th scope="col">Reserved / Allocated</th>
              <th scope="col">Sellable Available</th>
            </tr>
          </thead>
          <tbody>
            {(slotsQuery.data ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NO_SLOTS
                </th>
                <td colSpan={4}>No warehouse stock slots configured.</td>
              </tr>
            ) : (
              slotsQuery.data!.map((slot) => {
                const sellable = Math.max(
                  0,
                  slot.quantityOnHand - slot.quantityReserved - slot.quantityAllocated
                );
                return (
                  <tr key={`${slot.warehouseId}:${slot.variantId}`}>
                    <th scope="row" className="mono">
                      {slot.variantId}
                    </th>
                    <td>
                      {slot.warehouseId} (P{slot.priorityRank})
                    </td>
                    <td className="mono">{slot.quantityOnHand}</td>
                    <td className="mono">
                      {slot.quantityReserved} rsv / {slot.quantityAllocated} alloc
                    </td>
                    <td>
                      <span className={`badge ${sellable > 0 ? "badge-ok" : "badge-danger"}`}>
                        {sellable} units
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{ marginTop: "1.5rem" }}
        className="table-wrapper"
        tabIndex={0}
        role="region"
        aria-labelledby={outboxCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Event Type"',
              "--col-3": '"Aggregate"',
              "--col-4": '"Status"',
              "--col-5": '"Attempts"',
            } as CSSProperties
          }
        >
          <caption id={outboxCaptionId}>Transactional Outbox Pending Queue</caption>
          <thead>
            <tr>
              <th scope="col">Event ID</th>
              <th scope="col">Event Type</th>
              <th scope="col">Aggregate</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {(outboxQuery.data ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  DRAINED
                </th>
                <td colSpan={4}>Outbox queue is completely drained (0 pending events).</td>
              </tr>
            ) : (
              outboxQuery.data!.map((evt) => (
                <tr key={evt.id}>
                  <th scope="row" className="mono">
                    {evt.id}
                  </th>
                  <td className="mono">{evt.eventType}</td>
                  <td className="mono">
                    {evt.aggregateType}:{evt.aggregateId}
                  </td>
                  <td>
                    <span className="badge badge-warn">{evt.status}</span>
                  </td>
                  <td className="mono">{evt.attempts}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
