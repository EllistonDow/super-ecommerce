import { useId, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRpcClient } from "../api/rpc-client.ts";
import { formatMinorUnits } from "../lib/money.ts";

export function CartsPaymentsPage({ rpc }: { readonly rpc: AdminRpcClient }) {
  const queryClient = useQueryClient();
  const cartsCaptionId = useId();
  const piCaptionId = useId();
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const cartsQuery = useQuery({
    queryKey: ["carts", "listRecent"],
    queryFn: () => rpc.carts.listRecent(25),
  });

  const intentsQuery = useQuery({
    queryKey: ["payments", "listRecent"],
    queryFn: () => rpc.payments.listRecent(25),
  });

  const complete3dsMutation = useMutation({
    mutationFn: (piId: string) => rpc.payments.complete3ds(piId),
    onSuccess: (pi) => {
      setActionStatus(`3DS2 challenge completed for ${pi.paymentIntentId} -> ${pi.status}`);
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
  });

  const captureMutation = useMutation({
    mutationFn: (piId: string) => rpc.payments.captureIntent(piId),
    onSuccess: (pi) => {
      setActionStatus(`Captured manual authorization for ${pi.paymentIntentId} -> ${pi.status}`);
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>C-End Persistent Carts &amp; Stripe PaymentIntents</h1>
          <p>
            Multi-channel guest/member cart hydration and dual-mode Stripe 3DS2 / manual-capture
            state machine.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void cartsQuery.refetch();
            void intentsQuery.refetch();
          }}
        >
          Refresh Carts &amp; Intents
        </button>
      </header>

      {actionStatus ? (
        <div className="card" role="status" style={{ marginTop: "1rem" }}>
          {actionStatus}
        </div>
      ) : null}

      <div
        style={{ marginTop: "1.25rem" }}
        className="table-wrapper"
        tabIndex={0}
        role="region"
        aria-labelledby={cartsCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Channel"',
              "--col-3": '"Owner"',
              "--col-4": '"Status"',
              "--col-5": '"Hydrated Gross"',
            } as CSSProperties
          }
        >
          <caption id={cartsCaptionId}>Persistent Multi-Channel Carts (PostgreSQL + Rust Pricing)</caption>
          <thead>
            <tr>
              <th scope="col">Cart ID</th>
              <th scope="col">Channel</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Hydrated Gross</th>
            </tr>
          </thead>
          <tbody>
            {(cartsQuery.data ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NO_CARTS
                </th>
                <td colSpan={4}>No persistent carts created yet.</td>
              </tr>
            ) : (
              cartsQuery.data!.map((cart) => (
                <tr key={cart.cartId}>
                  <th scope="row" className="mono">
                    {cart.cartId}
                  </th>
                  <td>{cart.channelSlug}</td>
                  <td className="mono">
                    {cart.customerId ?? (cart.guestToken ? `guest:${cart.guestToken}` : "anon")}
                  </td>
                  <td>
                    <span className={`badge ${cart.status === "ACTIVE" ? "badge-ok" : "badge-warn"}`}>
                      {cart.status}
                    </span>
                  </td>
                  <td className="mono">
                    {formatMinorUnits(cart.pricing.totalGrossAmount, cart.currencyCode)} (
                    {cart.lines.length} lines)
                  </td>
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
        aria-labelledby={piCaptionId}
      >
        <table
          className="data-table"
          style={
            {
              "--col-2": '"Mode"',
              "--col-3": '"Status"',
              "--col-4": '"Amount"',
              "--col-5": '"Action"',
            } as CSSProperties
          }
        >
          <caption id={piCaptionId}>Stripe PaymentIntents State Machine</caption>
          <thead>
            <tr>
              <th scope="col">PaymentIntent ID</th>
              <th scope="col">Mode / Method</th>
              <th scope="col">Status</th>
              <th scope="col">Amount / Captured</th>
              <th scope="col">Operator Action</th>
            </tr>
          </thead>
          <tbody>
            {(intentsQuery.data ?? []).length === 0 ? (
              <tr>
                <th scope="row" className="mono">
                  NO_INTENTS
                </th>
                <td colSpan={4}>No PaymentIntents recorded yet.</td>
              </tr>
            ) : (
              intentsQuery.data!.map((pi) => (
                <tr key={pi.paymentIntentId}>
                  <th scope="row" className="mono">
                    {pi.paymentIntentId}
                  </th>
                  <td>
                    {pi.providerMode} ({pi.captureMethod})
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        pi.status === "succeeded"
                          ? "badge-ok"
                          : pi.status.startsWith("requires_")
                            ? "badge-warn"
                            : "badge-danger"
                      }`}
                    >
                      {pi.status}
                    </span>
                  </td>
                  <td className="mono">
                    {formatMinorUnits(pi.amount, pi.currencyCode)} / rcvd{" "}
                    {formatMinorUnits(pi.amountReceived, pi.currencyCode)}
                  </td>
                  <td>
                    {pi.status === "requires_action" ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => complete3dsMutation.mutate(pi.paymentIntentId)}
                      >
                        Complete 3DS2
                      </button>
                    ) : pi.status === "requires_capture" ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => captureMutation.mutate(pi.paymentIntentId)}
                      >
                        Capture Funds
                      </button>
                    ) : (
                      <span className="kpi-meta">Settled</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
