import type { AppContext } from "./context.ts";
import { createApp } from "./http/app.ts";

export interface RunningServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function startServer(ctx: AppContext, opts: { port?: number; host?: string } = {}): RunningServer {
  const app = createApp(ctx);
  const server = Bun.serve({
    port: opts.port ?? ctx.config.server.port,
    hostname: opts.host ?? ctx.config.server.host,
    fetch: (req, srv) => app.fetch(req, srv),
    maxRequestBodySize: 50 * 1024 * 1024,
    idleTimeout: 120,
  });
  const scheduler = ctx.services.scheduler as { start(): void; stop(): Promise<void> } | undefined;
  scheduler?.start();
  ctx.logger.info("server started", { url: ctx.config.server.public_url, port: server.port });
  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port ?? 0,
    async stop() {
      await scheduler?.stop();
      await server.stop();
    },
  };
}
