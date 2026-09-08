import { ZodError } from "zod";
import { AppError } from "../shared/model.js";
import Fastify from "fastify";
import { createVerifier } from "./auth.js";
import type { AppConfig } from "./config.js";
import { createToolVerifier } from "./tool-auth.js";

declare module "fastify" {
  interface FastifyContextConfig {
    mochiCallback?: boolean;
  }
}

interface AppOptions {
  config: AppConfig;
  verify?: (authorization: string | undefined) => Promise<void>;
  verifyTools?: (authorization: string | undefined) => Promise<"mochi-write">;
  checkStorage: () => Promise<void>;
}

export async function createApp({
  config,
  verify = createVerifier(config.auth),
  verifyTools = config.toolAuth
    ? createToolVerifier(config.toolAuth)
    : undefined,
  checkStorage,
}: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/")) return;
    reply.header("cache-control", "no-store");
    if (
      route === "/api/auth-config" &&
      ["GET", "HEAD"].includes(request.method)
    )
      return;
    if (request.routeOptions.config.mochiCallback) {
      try {
        if (
          !verifyTools ||
          (await verifyTools(request.headers.authorization)) !== "mochi-write"
        )
          throw new Error();
      } catch {
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ error: "工具调用身份无效" });
      }
      if (
        request.method === "POST" &&
        request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
      )
        return reply.code(415).send({ error: "工具请求必须使用 JSON" });
      return;
    }
    try {
      await verify(request.headers.authorization);
    } catch {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ error: "请登录本人账号后重试" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== config.origin)
        return reply.code(403).send({ error: "请求来源不匹配" });
      if (
        request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        return reply.code(415).send({ error: "写入请求必须使用 JSON" });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError)
      return reply
        .code(error.statusCode)
        .send({ error: error.message, diagnostics: error.diagnostics });
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "请求字段无效" });
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "请求格式无效" });
    }
    return reply
      .code(503)
      .send({ error: "服务暂不可用，请保留当前内容后重试" });
  });
  app.get("/api/auth-config", async () => ({
    tenantId: config.auth.tenantId,
    spaClientId: config.auth.spaClientId,
    scope: `api://${config.auth.apiClientId}/Write.Access`,
  }));
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/api/session", async () => ({ authorized: true }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await checkStorage();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  return app;
}
