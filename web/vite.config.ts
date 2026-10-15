import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));
const MAX_PROXY_BODY = 200 * 1024 * 1024;
const DEFAULT_HOSTS = ["ark.cn-beijing.volces.com", "api.openai.com", "generativelanguage.googleapis.com"];
const LOCAL_BODY_LIMIT = 200 * 1024 * 1024 + 256 * 1024;
const LOCAL_RESPONSE_LIMIT = 200 * 1024 * 1024;

type LocalRouter = { protocol: "http:" | "https:"; hostname: string; port: number; origin: string };

function parseLocalRouter(raw: string | undefined): LocalRouter | null {
    if (!raw) return null;
    const portMatch = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(?:\/|$)/i.exec(raw);
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(portMatch?.[1] || url.port);
    if (!portMatch || port < 1 || port > 65535 || !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
        !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("ARK_LOCAL_ROUTER_URL must be an explicit http(s) loopback origin with a port and no path");
    }
    return { protocol: url.protocol as LocalRouter["protocol"], hostname, port, origin: url.origin };
}

function loopback(address: string): boolean {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return loopback(normalized.slice("::ffff:".length));
    return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

function localRouterPlugin(rawRouterUrl: string): Plugin {
    const router = parseLocalRouter(rawRouterUrl);
    return {
        name: "local-ark-router-proxy",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use("/api/router-local", (req, res) => {
                void (async () => {
                    if (!router) { res.statusCode = 503; res.end("ARK_LOCAL_ROUTER_URL is not configured"); return; }
                    if (!loopback(req.socket.remoteAddress || "")) { res.statusCode = 403; res.end("loopback client required"); return; }
                    const origin = req.headers.origin;
                    const fetchSite = req.headers["sec-fetch-site"];
                    if (req.headers["x-router-origin"] !== router.origin) { res.statusCode = 403; res.end("router origin does not match configuration"); return; }
                    let sameOrigin = false;
                    if (origin && req.headers.host) {
                        try {
                            const originUrl = new URL(origin);
                            sameOrigin = ["http:", "https:"].includes(originUrl.protocol) && !originUrl.username && !originUrl.password &&
                                originUrl.host.toLowerCase() === req.headers.host.toLowerCase() && originUrl.origin === origin;
                        } catch { sameOrigin = false; }
                    }
                    if ((origin && !sameOrigin) || (fetchSite && !["same-origin", "none"].includes(fetchSite)) || (!origin && !fetchSite)) {
                        res.statusCode = 403; res.end("same-origin request required"); return;
                    }

                    const incoming = new URL(req.url || "/", "http://vite.local");
                    let upstreamPath: string | null = null;
                    const isDownload = incoming.pathname === "/download";
                    const method = req.method || "GET";
                    if (incoming.pathname === "/ready" && method === "GET") upstreamPath = "/ready";
                    else if (incoming.pathname === "/api/v3/media/uploads" && method === "POST") upstreamPath = incoming.pathname + incoming.search;
                    else if (incoming.pathname === "/api/v3/contents/generations/tasks" && method === "POST") upstreamPath = incoming.pathname + incoming.search;
                    else if (/^\/api\/v3\/contents\/generations\/tasks\/[A-Za-z0-9_-]+$/.test(incoming.pathname) && ["GET", "DELETE"].includes(method)) upstreamPath = incoming.pathname + incoming.search;
                    else if (incoming.pathname === "/download" && method === "GET") upstreamPath = await signedMediaPath(incoming.searchParams, router, res);
                    if (!upstreamPath) { if (!res.writableEnded) { res.statusCode = 404; res.end("route not allowed"); } return; }

                    try {
                        const routerIpFamily = isIP(router.hostname);
                        const addresses = routerIpFamily
                            ? [{ address: router.hostname, family: routerIpFamily }]
                            : await lookup(router.hostname, { all: true, verbatim: true });
                        if (!addresses.length || addresses.some(({ address }) => !loopback(address))) throw new Error("router DNS must resolve only to loopback addresses");
                        const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRequestBody(req, LOCAL_BODY_LIMIT) : undefined;
                        const headers: Record<string, string> = {};
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (!value || ["host", "connection", "content-length", "transfer-encoding", "cookie", "origin", "referer", "x-forwarded-for", "x-router-origin", "x-router-target", "x-gateway-token"].includes(key)) continue;
                            headers[key] = Array.isArray(value) ? value.join(", ") : value;
                        }
                        headers["accept-encoding"] = "identity";
                        if (body) headers["content-length"] = String(body.length);
                        const transport = router.protocol === "https:" ? httpsRequest : httpRequest;
                        const response = await new Promise<{ statusCode: number; headers: Record<string, string | string[] | number | undefined>; body: Buffer }>((resolveResponse, reject) => {
                            const request = transport({ protocol: router.protocol, hostname: router.hostname, port: router.port, path: upstreamPath!, method, headers,
                                lookup: (_hostname, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) }, (upstream) => {
                                const statusCode = upstream.statusCode || 502;
                                if (statusCode >= 300 && statusCode < 400) { upstream.resume(); reject(new Error("local router redirects are blocked")); return; }
                                const chunks: Buffer[] = [];
                                let size = 0;
                                upstream.on("data", (chunk: Buffer) => {
                                    size += chunk.length;
                                    if (size > LOCAL_RESPONSE_LIMIT) request.destroy(new Error("local router response too large"));
                                    else chunks.push(chunk);
                                });
                                upstream.on("end", () => resolveResponse({ statusCode, headers: upstream.headers, body: Buffer.concat(chunks, size) }));
                                upstream.on("error", reject);
                            });
                            request.setTimeout(120_000, () => request.destroy(new Error("local router timed out")));
                            request.on("error", reject);
                            request.end(body);
                        });
                        if (isDownload) {
                            if (response.statusCode === 404 || response.statusCode === 410) {
                                res.statusCode = response.statusCode;
                                res.setHeader("content-type", "application/json; charset=utf-8");
                                res.end(JSON.stringify({ code: "MEDIA_URL_EXPIRED", error: "Media URL expired or is no longer available." }));
                                return;
                            }
                            if (response.statusCode < 200 || response.statusCode >= 300) {
                                res.statusCode = 502;
                                res.setHeader("content-type", "application/json; charset=utf-8");
                                res.end(JSON.stringify({ code: "MEDIA_DOWNLOAD_FAILED", error: `Media source failed (${response.statusCode}).` }));
                                return;
                            }
                            const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
                            if (!/^(?:video|audio|image)\/[a-z0-9.+-]+$|^application\/octet-stream$/.test(contentType)) {
                                res.statusCode = 502;
                                res.setHeader("content-type", "application/json; charset=utf-8");
                                res.end(JSON.stringify({ code: "MEDIA_NOT_MEDIA", error: "Media source returned an unsupported content type." }));
                                return;
                            }
                        }
                        res.statusCode = response.statusCode;
                        for (const [key, value] of Object.entries(response.headers)) {
                            if (value && !["set-cookie", "location", "connection", "transfer-encoding", "content-encoding"].includes(key.toLowerCase())) res.setHeader(key, value);
                        }
                        res.end(response.body);
                    } catch (error) {
                        res.statusCode = 502;
                        res.end(error instanceof Error ? error.message : "local router proxy failed");
                    }
                })();
            });
        },
    };
}

async function signedMediaPath(params: URLSearchParams, router: LocalRouter, res: import("node:http").ServerResponse): Promise<string | null> {
    const raw = params.get("url");
    if (!raw) { res.statusCode = 400; res.end("missing url"); return null; }
    try {
        const url = new URL(raw);
        const sameOrigin = url.protocol === router.protocol && url.hostname.replace(/^\[|\]$/g, "").toLowerCase() === router.hostname &&
            Number(url.port || (url.protocol === "https:" ? 443 : 80)) === router.port;
        const keys = [...url.searchParams.keys()].sort();
        if (!sameOrigin || url.username || url.password || url.hash || !/^\/media\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
            keys.length !== 2 || keys[0] !== "exp" || keys[1] !== "sig" || !url.searchParams.get("exp") || !url.searchParams.get("sig")) {
            throw new Error("signed media URL is not for the configured router");
        }
        return url.pathname + url.search;
    } catch (error) {
        res.statusCode = 403;
        res.end(error instanceof Error ? error.message : "invalid signed media URL");
        return null;
    }
}

function allowedHosts(): Set<string> {
    return new Set((process.env.VITE_API_PROXY_ALLOWED_HOSTS || DEFAULT_HOSTS.join(","))
        .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function isPublicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168 || b === 88)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
            (a === 203 && b === 0) || a >= 224);
    }
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
        const mapped = value.slice("::ffff:".length);
        return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    return value.startsWith("2") && !value.startsWith("2001:db8:") && !value.startsWith("2001:10:");
}

async function validateTarget(raw: string): Promise<URL> {
    const target = new URL(raw);
    const hosts = allowedHosts();
    if (target.protocol !== "https:" || target.username || target.password || target.port && target.port !== "443" ||
        !hosts.has(target.hostname.toLowerCase()) || isIP(target.hostname)) {
        throw new Error("target host is not allowed");
    }
    const addresses = await lookup(target.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("target resolves to a non-public address");
    return target;
}

function apiProxyPlugin(): Plugin {
    return {
        name: "canvas-api-proxy",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use("/api-proxy", (req, res) => {
                void (async () => {
                    try {
                        const url = new URL(req.url || "", "http://localhost");
                        const rawTarget = url.searchParams.get("target");
                        if (!rawTarget) throw new Error("missing target");
                        const target = await validateTarget(rawTarget);
                        const method = req.method || "GET";
                        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("method not allowed");
                        const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRequestBody(req, MAX_PROXY_BODY) : undefined;
                        const headers: Record<string, string> = {};
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (!value || ["host", "connection", "content-length", "transfer-encoding", "cookie", "origin", "referer"].includes(key)) continue;
                            headers[key] = Array.isArray(value) ? value.join(", ") : value;
                        }
                        headers.host = target.host;
                        const upstream = await fetch(target, { method, headers, body: body ? new Uint8Array(body) : undefined,
                            redirect: "manual", signal: AbortSignal.timeout(120_000) });
                        if (upstream.status >= 300 && upstream.status < 400) throw new Error("upstream redirects are not allowed");
                        res.statusCode = upstream.status;
                        upstream.headers.forEach((value, key) => {
                            if (!["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "location"].includes(key)) res.setHeader(key, value);
                        });
                        if (upstream.body) {
                            const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
                            let size = 0;
                            stream.on("data", (chunk: Buffer) => {
                                size += chunk.length;
                                if (size > MAX_PROXY_BODY) { stream.destroy(); if (!res.headersSent) res.statusCode = 502; res.end("upstream response too large"); }
                            });
                            stream.pipe(res);
                        } else res.end();
                    } catch (error) {
                        res.statusCode = error instanceof Error && error.message === "target host is not allowed" ? 403 : 400;
                        res.end(error instanceof Error ? error.message : "proxy error");
                    }
                })();
            });
        },
    };
}

function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer | string) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += data.length;
            if (size > limit) { reject(new Error("request body too large")); req.destroy(); return; }
            chunks.push(data);
        });
        req.on("end", () => resolveBody(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, webDir, "ARK_LOCAL_ROUTER_URL");
    const localRouterUrl = process.env.ARK_LOCAL_ROUTER_URL || env.ARK_LOCAL_ROUTER_URL || "http://127.0.0.1:8189";
    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localRouterPlugin(localRouterUrl), apiProxyPlugin()],
        server: {
            proxy: {
                "/media/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 90_000 },
                "/api/media/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 90_000 },
                "/api/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 130_000 },
            },
        },
        resolve: { alias: { "@": resolve(webDir, "src") } },
    };
});
