import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./env";
import { checkDatabase } from "./db/client";
import { AppError } from "./lib/http";
import { loadSession } from "./lib/context";
import { MAX_UPLOAD_BYTES } from "./lib/storage";

import authRoutes from "./modules/auth/routes";
import orgRoutes from "./modules/org/routes";
import memberRoutes from "./modules/members/routes";
import fileRoutes from "./modules/files/routes";
import auditRoutes from "./modules/audit/routes";
import devRoutes from "./modules/dev/routes";
import overviewRoutes from "./modules/overview/routes";
import peopleRoutes from "./modules/people/routes";
import recruitmentRoutes from "./modules/recruitment/routes";
import careersRoutes from "./modules/careers/routes";
import crmRoutes from "./modules/crm/routes";
import workflowRoutes from "./modules/workflows/routes";
import documentRoutes from "./modules/documents/routes";
import importRoutes from "./modules/imports/routes";
import insightRoutes from "./modules/insights/routes";
import adminRoutes from "./modules/admin/routes";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(cors, { origin: [env.appUrl, env.siteUrl], credentials: true });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    await loadSession(req);
  });

  // Cookie-based auth: block cross-site state-changing requests from unknown origins.
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && ![env.appUrl, env.siteUrl].includes(origin) && !env.isTest) {
      throw new AppError(403, "bad_origin", "Request blocked.");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "Some details need fixing." } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts. Please wait a minute and try again." } });
    if (status === 413) return reply.status(413).send({ error: { code: "file_too_large", message: "That file is too large." } });
    if (status < 500) return reply.status(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    // Unexpected: log details server-side, never leak them to the client.
    req.log.error({ err }, "Unexpected error");
    if (!env.isTest) console.error(err);
    return reply.status(500).send({ error: { code: "server_error", message: "Something went wrong on our side. Please try again." } });
  });

  app.get("/api/health", async (_req, reply) => {
    const dbOk = await checkDatabase();
    return reply.status(dbOk ? 200 : 503).send({ status: dbOk ? "ok" : "degraded", database: dbOk ? "up" : "down", time: new Date().toISOString() });
  });

  for (const routes of [
    authRoutes, orgRoutes, memberRoutes, fileRoutes, auditRoutes, devRoutes, overviewRoutes,
    peopleRoutes, recruitmentRoutes, careersRoutes, crmRoutes, workflowRoutes, documentRoutes, importRoutes, insightRoutes, adminRoutes,
  ]) {
    await app.register(routes);
  }

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}` } }));
  return app;
}
