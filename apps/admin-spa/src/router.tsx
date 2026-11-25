import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { AdminRpcClient } from "./api/rpc-client.ts";
import { ValidationAriaSync } from "./components/ValidationSync.tsx";
import { OverviewPage } from "./routes/OverviewPage.tsx";
import { OrdersOmsPage } from "./routes/OrdersOmsPage.tsx";
import { CartsPaymentsPage } from "./routes/CartsPaymentsPage.tsx";
import { InventoryOutboxPage } from "./routes/InventoryOutboxPage.tsx";
import { McpCopilotPage } from "./routes/McpCopilotPage.tsx";
import { PimIntegrationPage } from "./routes/PimIntegrationPage.tsx";

export interface AdminRouterContext {
  readonly rpc: AdminRpcClient;
  readonly queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<AdminRouterContext>()({
  component: function AdminRootLayout() {
    return (
      <div className="admin-shell">
        <ValidationAriaSync />
        <aside className="admin-sidebar" aria-label="Merchant Backoffice Navigation">
          <div className="brand-lockup">
            <span className="brand-title">Super Ecommerce</span>
            <span className="brand-subtitle">v0.4.0 React 19 + TanStack</span>
          </div>
          <nav aria-label="Primary sections">
            <ul className="nav-list">
              <li>
                <Link
                  to="/"
                  className="nav-link"
                  activeOptions={{ exact: true }}
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>Overview &amp; Ledger</span>
                </Link>
              </li>
              <li>
                <Link
                  to="/orders"
                  className="nav-link"
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>Orders &amp; OMS Studio</span>
                </Link>
              </li>
              <li>
                <Link
                  to="/carts-payments"
                  className="nav-link"
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>Carts &amp; PaymentIntents</span>
                </Link>
              </li>
              <li>
                <Link
                  to="/inventory"
                  className="nav-link"
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>MSI &amp; Saga Outbox</span>
                </Link>
              </li>
              <li>
                <Link
                  to="/mcp"
                  className="nav-link"
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>MCP Copilot</span>
                </Link>
              </li>
              <li>
                <Link
                  to="/pim"
                  className="nav-link"
                  activeProps={{ "aria-current": "page" }}
                >
                  <span>PIM Integration</span>
                </Link>
              </li>
            </ul>
          </nav>
        </aside>
        <main className="admin-main">
          <Outlet />
        </main>
      </div>
    );
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function OverviewRouteComponent() {
    const { rpc } = overviewRoute.useRouteContext();
    return <OverviewPage rpc={rpc} />;
  },
});

const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orders",
  component: function OrdersRouteComponent() {
    const { rpc } = ordersRoute.useRouteContext();
    return <OrdersOmsPage rpc={rpc} />;
  },
});

const cartsPaymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/carts-payments",
  component: function CartsPaymentsRouteComponent() {
    const { rpc } = cartsPaymentsRoute.useRouteContext();
    return <CartsPaymentsPage rpc={rpc} />;
  },
});

const inventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inventory",
  component: function InventoryRouteComponent() {
    const { rpc } = inventoryRoute.useRouteContext();
    return <InventoryOutboxPage rpc={rpc} />;
  },
});

const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mcp",
  component: function McpRouteComponent() {
    const { rpc } = mcpRoute.useRouteContext();
    return <McpCopilotPage rpc={rpc} />;
  },
});

const pimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pim",
  component: function PimRouteComponent() {
    const { rpc } = pimRoute.useRouteContext();
    return <PimIntegrationPage rpc={rpc} />;
  },
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  ordersRoute,
  cartsPaymentsRoute,
  inventoryRoute,
  mcpRoute,
  pimRoute,
]);

export function buildAdminRouter(options: {
  readonly rpc: AdminRpcClient;
  readonly queryClient: QueryClient;
  readonly basepath?: string;
  readonly initialEntries?: string[];
}) {
  const history: RouterHistory = options.initialEntries
    ? createMemoryHistory({ initialEntries: options.initialEntries })
    : createBrowserHistory();

  return createRouter({
    routeTree,
    basepath: options.basepath ?? "/admin-spa",
    history,
    context: {
      rpc: options.rpc,
      queryClient: options.queryClient,
    },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof buildAdminRouter>;
  }
}
