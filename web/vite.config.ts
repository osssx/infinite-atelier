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
type TrustedBase = { protocol: "http:" | "https:"; hostname: string; port: number; origin: string; pathname: string };

function parseTrustedBases(raw: string | undefined): TrustedBase[] {
    return (raw || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
        const url = new URL(value);
        const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        const loopback = hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
        if (!loopback || url.protocol !== "http:" || !url.port || url.username || url.password || url.search || url.hash || url.pathname === "/") throw new Error("ARK_TRUSTED_BASE_URLS entries must be explicit loopback URLs with port and API path");
        return { protocol: url.protocol as TrustedBase["protocol"], hostname, port: Number(url.port), origin: url.origin, pathname: url.pathname.replace(/\/+$/, "") };
    });
}
function isLoopback(address: string) { const value = address.toLowerCase(); return value === "::1" || value.startsWith("::ffff:127.") || (isIP(value) === 4 && value.startsWith("127.")); }

function configuredDevGatewayPlugin(rawBases: string | undefined, uploadUrl: string | undefined): Plugin {
    const bases = parseTrustedBases(rawBases);
    const upload = uploadUrl ? new URL(uploadUrl) : null;
    return {
        name: "configured-media-gateway-dev",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const incoming = new URL(req.url || "/", "http://vite.local");
                if (!incoming.pathname.startsWith("/api/ark/") && incoming.pathname !== "/api/ark" && incoming.pathname !== "/api/media/uploads") return next();
                void (async () => {
                    if (!isLoopback(req.socket.remoteAddress || "")) { res.statusCode = 403; res.end("loopback client required"); return; }
                    const origin = req.headers.origin;
                    const fetchSite = req.headers["sec-fetch-site"];
                    let sameOrigin = false;
                    if (origin && req.headers.host) { try { const parsedOrigin = new URL(origin); sameOrigin = parsedOrigin.host.toLowerCase() === req.headers.host.toLowerCase() && parsedOrigin.origin === origin; } catch { sameOrigin = false; } }
                    if ((origin && !sameOrigin) || (fetchSite && !["same-origin", "none"].includes(fetchSite)) || (!origin && !fetchSite)) { res.statusCode = 403; res.end("same-origin request required"); return; }
                    const method = req.method || "GET";
                    let target: URL | null = null;
                    let addresses: Array<{ address: string; family: number }> = [];
                    if (incoming.pathname === "/api/media/uploads" && method === "POST") {
                        if (!upload) { res.statusCode = 503; res.end("MEDIA_UPLOAD_URL is not configured"); return; }
                        target = upload;
                    } else if (incoming.pathname === "/api/ark/download" && method === "GET") {
                        const raw = incoming.searchParams.get("url");
                        if (!raw) { res.statusCode = 400; res.end("missing signed media URL"); return; }
                        const mediaUrl = new URL(raw);
                        const base = bases.find((item) => item.origin === mediaUrl.origin) || (upload && upload.origin === mediaUrl.origin ? { protocol: upload.protocol as TrustedBase["protocol"], hostname: upload.hostname, port: Number(upload.port), origin: upload.origin, pathname: upload.pathname.split("/contents/")[0] } satisfies TrustedBase : null);
                        if (!base) {
                            const publicHosts = new Set((process.env.MEDIA_DOWNLOAD_ALLOWED_HOSTS || "ark.cn-beijing.volces.com,ark-content-generation-cn-beijing.tos-cn-beijing.volces.com").split(",").map((host) => host.trim().toLowerCase()));
                            if (mediaUrl.protocol === "https:" && publicHosts.has(mediaUrl.hostname.toLowerCase())) return next();
                            res.statusCode = 403; res.end("untrusted signed media URL"); return;
                        }
                        if (!/^\/(?:uploads\/[A-Fa-f0-9-]{36}(?:\.(?:png|jpg|webp|mp4|mov|webm|wav|mp3|flac|m4a))?|last-frame\/[A-Za-z0-9_-]+|media\/[A-Za-z0-9_-]+)$/.test(mediaUrl.pathname) || !mediaUrl.searchParams.get("exp") || !mediaUrl.searchParams.get("sig")) { res.statusCode = 403; res.end("untrusted signed media URL"); return; }
                        target = mediaUrl;
                    } else {
                        const rawBase = req.headers["x-ark-base-url"];
                        if (typeof rawBase !== "string") { res.statusCode = 503; res.end("Configure ARK_TRUSTED_BASE_URLS for direct local generation"); return; }
                        let requestedBase: URL;
                        try { requestedBase = new URL(rawBase); } catch { return next(); }
                        const base = bases.find((item) => requestedBase.href.replace(/\/$/, "") === `${item.origin}${item.pathname}`);
                        if (!base) {
                            const candidate = new URL(rawBase);
                            if (candidate.protocol === "http:" || isLoopback(candidate.hostname)) { res.statusCode = 403; res.end("Ark Base URL is not an exact trusted loopback URL"); return; }
                            return next();
                        }
                        let suffix = incoming.pathname.slice("/api/ark".length);
                        if (suffix === "/health") suffix = "/contents/generations/tasks/codex-connectivity-check-never-created";
                        if (suffix === "/download") { res.statusCode = 400; res.end("invalid route"); return; }
                        const collection = suffix === "/contents/generations/tasks" && method === "POST";
                        const task = /^\/contents\/generations\/tasks\/[A-Za-z0-9_-]+$/.test(suffix) && ["GET", "DELETE"].includes(method);
                        if (!collection && !task && !(suffix.endsWith("codex-connectivity-check-never-created") && method === "GET")) { res.statusCode = 404; res.end("route not found"); return; }
                        target = new URL(`${base.pathname}${suffix}${incoming.search}`, base.origin);
                    }
                    if (!target) return;
                    const hostname = target.hostname.replace(/^\[|\]$/g, "");
                    const ips = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
                    if (!ips.length || ips.some(({ address }) => !isLoopback(address))) { res.statusCode = 403; res.end("configured target must resolve to loopback"); return; }
                    addresses = ips;
                    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRequestBody(req, LOCAL_BODY_LIMIT) : undefined;
                    const headers: Record<string, string> = {};
                    for (const [key, value] of Object.entries(req.headers)) {
                        if (!value || ["host", "connection", "content-length", "transfer-encoding", "cookie", "origin", "referer", "x-forwarded-for", "x-gateway-token", "x-ark-base-url"].includes(key)) continue;
                        headers[key] = Array.isArray(value) ? value.join(", ") : value;
                    }
                    if (body) headers["content-length"] = String(body.length);
                    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
                    const response = await new Promise<{ statusCode: number; headers: Record<string, string | string[] | number | undefined>; body: Buffer }>((resolveResponse, reject) => {
                        const request = transport({ protocol: target!.protocol, hostname: target!.hostname, port: target!.port, path: `${target!.pathname}${target!.search}`, method, headers, lookup: (_host, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) }, (upstream) => {
                            const statusCode = upstream.statusCode || 502;
                            if (statusCode >= 300 && statusCode < 400) { upstream.resume(); reject(new Error("configured destination redirects are blocked")); return; }
                            const chunks: Buffer[] = []; let size = 0;
                            upstream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > LOCAL_RESPONSE_LIMIT) request.destroy(new Error("configured response too large")); else chunks.push(chunk); });
                            upstream.on("end", () => resolveResponse({ statusCode, headers: upstream.headers, body: Buffer.concat(chunks, size) })); upstream.on("error", reject);
                        });
                        request.setTimeout(120_000, () => request.destroy(new Error("configured request timed out"))); request.on("error", reject); request.end(body);
                    });
                    res.statusCode = response.statusCode;
                    if (incoming.pathname === "/api/ark/health" && response.statusCode === 404) {
                        res.statusCode = 200;
                        res.setHeader("content-type", "application/json; charset=utf-8");
                        res.end(JSON.stringify({ reachable: true, authenticated: true }));
                        return;
                    }
                    if (incoming.pathname === "/api/media/uploads" && response.statusCode >= 200 && response.statusCode < 300) {
                        let payload: { url?: string; expiresAt?: string };
                        try { payload = JSON.parse(response.body.toString("utf8")); } catch { res.statusCode = 502; res.end("upload service returned invalid JSON"); return; }
                        if (typeof payload.url !== "string") { res.statusCode = 502; res.end("upload service returned no URL"); return; }
                        let returned: URL;
                        try { returned = new URL(payload.url); } catch { res.statusCode = 502; res.end("upload service returned invalid URL"); return; }
                        const publicHosts = new Set((process.env.MEDIA_PUBLIC_ALLOWED_HOSTS || upload!.hostname).split(",").map((host) => host.trim().toLowerCase()));
                        const publicHttps = returned.protocol === "https:" && !returned.username && !returned.password && publicHosts.has(returned.hostname.toLowerCase());
                        const localSigned = returned.origin === upload!.origin && isLoopback(returned.hostname) && /^\/uploads\/[A-Fa-f0-9-]{36}(?:\.(?:png|jpg|webp|mp4|mov|webm|wav|mp3|flac|m4a))?$/.test(returned.pathname) && Boolean(returned.searchParams.get("exp") && returned.searchParams.get("sig"));
                        if (!publicHttps && !localSigned) { res.statusCode = 502; res.end("upload service returned an untrusted URL"); return; }
                        response.body = Buffer.from(JSON.stringify({ url: returned.href, ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {}) }));
                    }
                    const contentType = response.headers["content-type"]; if (contentType) res.setHeader("content-type", contentType);
                    res.setHeader("cache-control", "no-store"); res.end(response.body);
                })().catch((error) => { if (!res.headersSent) res.statusCode = 502; res.end(error instanceof Error ? error.message : "configured gateway error"); });
            });
        },
    };
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

function allowedHosts(): Set<string> { return new Set((process.env.VITE_API_PROXY_ALLOWED_HOSTS || "ark.cn-beijing.volces.com,api.openai.com,generativelanguage.googleapis.com").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)); }

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
    const env = loadEnv(mode, webDir, "");
    const trustedBases = process.env.ARK_TRUSTED_BASE_URLS || env.ARK_TRUSTED_BASE_URLS;
    const mediaUploadUrl = process.env.MEDIA_UPLOAD_URL || env.MEDIA_UPLOAD_URL;
    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), configuredDevGatewayPlugin(trustedBases, mediaUploadUrl), apiProxyPlugin()],
        server: {
            proxy: {
                "/media/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 90_000 },
                "/api/media/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 90_000 },
                "/api/media/uploads": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 130_000 },
                "/api/ark": { target: process.env.MEDIA_GATEWAY_URL || "http://127.0.0.1:8787", changeOrigin: true, timeout: 130_000 },
            },
        },
        resolve: { alias: { "@": resolve(webDir, "src") } },
    };
});
