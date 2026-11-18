/**
 * Stateless Production Headless API Server (`apps/api/src/prod-server.ts`).
 *
 * Cleanly decoupled from `dev-server.ts` (zero demo seed bloat, zero embedded lab HTML).
 * Exposes:
 * - `GET  /healthz`         -> Database & Rust kernel readiness probe
 * - `GET  /openapi.json`    -> OpenAPI 3.1.0 contract specification
 * - `POST /rpc/:procedure`  -> Strongly-typed oRPC procedures
 * - `POST /mcp`             -> Streamable HTTP Model Context Protocol (JSON-RPC 2.0)
 * - `POST /webhooks/stripe` -> Constant-time HMAC-SHA256 verified Stripe webhooks
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { OfflinePgPool, PgPool, type PgPoolLike } from "@super-ecommerce/db";
import { createSuperCommerceGateway, type SuperCommerceGatewayOptions } from "./index.ts";

async function readNodeRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createProductionNodeListener(gatewayOptions: SuperCommerceGatewayOptions = {}) {
  const gateway = createSuperCommerceGateway(gatewayOptions);

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const host = req.headers.host ?? "127.0.0.1:4100";
      const url = `http://${host}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }

      const hasBody = method !== "GET" && method !== "HEAD";
      const bodyBuf = hasBody ? await readNodeRequestBody(req) : undefined;
      const webReq = new Request(url, {
        method,
        headers,
        body: bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
      });

      const webRes = await gateway.fetch(webReq);
      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });
      const arrayBuf = await webRes.arrayBuffer();
      res.end(Buffer.from(arrayBuf));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  };

  return { gateway, listener };
}

export async function startProductionApiServer(options?: {
  port?: number;
  host?: string;
  pgPool?: PgPoolLike;
}) {
  const port = options?.port ?? Number(process.env["PORT"] ?? "4100");
  const host = options?.host ?? process.env["HOST"] ?? "0.0.0.0";
  const pgPool =
    options?.pgPool ??
    (process.env["SUPER_PG_USE_WIRE"] === "1" ? PgPool.fromEnv() : new OfflinePgPool());

  const { gateway, listener } = createProductionNodeListener({ pgPool });
  await gateway.ready();

  const server = createServer((req, res) => {
    void listener(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    gateway,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pgPool.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startProductionApiServer().then(({ close }) => {
    const port = process.env["PORT"] ?? "4100";
    process.stdout.write(`[super-ecommerce/api] Production headless server listening on :${port}\n`);
    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
