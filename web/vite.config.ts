import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { isLocalProxyCaller, trustedLocalOrigin, validateProxyTarget } from "./server/api-proxy-policy.ts";

const webDir = dirname(fileURLToPath(import.meta.url));
const MAX_PROXY_BODY = 200 * 1024 * 1024;
function isLoopback(address: string) {
 const value=address.toLowerCase();
 return value==="::1"||value.startsWith("::ffff:127.")||(isIP(value)===4&&value.startsWith("127."));
}
/** Old Gateway routes must never silently fall through to the SPA page. */
function retiredGatewayRoutesPlugin(): Plugin {
 return {
  name:"atelier-retired-gateway-routes",apply:"serve",
  configureServer(server){
   server.middlewares.use((req,res,next)=>{
    const pathname=new URL(req.url||"/","http://vite.local").pathname;
    if(!["/api/comfy","/api/ark","/api/media/uploads","/api/media/ark","/media/ark"]
        .some(prefix=>pathname===prefix||pathname.startsWith(prefix+"/")))return next();
    res.statusCode=410;
    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    res.end(JSON.stringify({code:"gateway_removed",message:"Use the authenticated /api/v1 backend."}));
   });
  }
 };
}
function apiProxyPlugin(rawAllowedHosts: string | undefined, localOrigins: string[]): Plugin {
    const listedHosts = (rawAllowedHosts || "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    const policy = { allowedHosts: listedHosts.length ? new Set(listedHosts) : undefined, trustedLocalOrigins: new Set(localOrigins.map(trustedLocalOrigin)) };
    return {
        name: "canvas-api-proxy",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use("/api-proxy", (req, res) => {
                void (async () => {
                    try {
                        if (!isLocalProxyCaller({ remoteAddress: req.socket.remoteAddress || "", host: req.headers.host,
                            origin: req.headers.origin, fetchSite: typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : undefined })) {
                            res.statusCode = 403; res.end("API proxy requires a same-origin browser request from this computer"); return;
                        }
                        const url = new URL(req.url || "", "http://localhost");
                        const rawTarget = url.searchParams.get("target");
                        if (!rawTarget) throw new Error("missing target");
                        const { target, addresses } = await validateProxyTarget(rawTarget, policy);
                        const method = req.method || "GET";
                        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("method not allowed");
                        const body = ["POST", "PUT", "PATCH"].includes(method) ? await readRequestBody(req, MAX_PROXY_BODY) : undefined;
                        const headers: Record<string, string> = {};
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (!value || ["host", "connection", "content-length", "transfer-encoding", "cookie", "origin", "referer", "x-forwarded-for", "x-gateway-token"].includes(key) || key.startsWith("sec-fetch-")) continue;
                            headers[key] = Array.isArray(value) ? value.join(", ") : value;
                        }
                        headers.host = target.host;
                        headers["accept-encoding"] = "identity";
                        const upstream = await new Promise<IncomingMessage>((resolveResponse, reject) => {
                            const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
                            const request = transport(target, { method, headers,
                                lookup: (_hostname, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
                            }, resolveResponse);
                            request.setTimeout(120_000, () => request.destroy(new Error("upstream request timed out")));
                            request.on("error", reject);
                            res.on("close", () => request.destroy());
                            request.end(body);
                        });
                        if (upstream.statusCode && upstream.statusCode >= 300 && upstream.statusCode < 400) { upstream.resume(); throw new Error("upstream redirects are not allowed"); }
                        res.statusCode = upstream.statusCode || 502;
                        for (const [key, value] of Object.entries(upstream.headers)) {
                            if (value !== undefined && !["content-length", "transfer-encoding", "connection", "set-cookie", "location"].includes(key)) res.setHeader(key, value);
                        }
                        let size = 0;
                        upstream.on("data", (chunk: Buffer) => {
                            size += chunk.length;
                            if (size > MAX_PROXY_BODY) { upstream.destroy(); if (!res.headersSent) res.statusCode = 502; res.end("upstream response too large"); }
                        });
                        upstream.on("error", () => res.destroy());
                        upstream.pipe(res);
                    } catch (error) {
                        res.statusCode = error instanceof Error && /not allowed|non-public|require an HTTPS|outside loopback/.test(error.message) ? 403 : 400;
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


/** The new cookie/CSRF backend is opt-in. Keep the browser origin/Host intact
 * so Fastify can verify the actual same-origin request (changeOrigin:false).
 * Never proxy this private API to another machine, even on a LAN dev server.
 */
export function validateLocalBackendTarget(raw: string | undefined): string | null {
    if (!raw) return null;
    const u = new URL(raw);
    if (u.protocol !== "http:" || !u.port || !["127.0.0.1","[::1]"].includes(u.hostname) ||
        u.pathname !== "/" || u.username || u.password || u.search || u.hash)
        throw new Error("ATELIER_BACKEND_URL must be an exact loopback HTTP origin with an explicit port");
    return u.origin;
}

/** Without an explicit private backend target, serve a clear JSON diagnostic
 * instead of letting the SPA fallback answer /api/v1/session with index.html.
 */
function localBackendProxyDiagnostic(target: string | null): Plugin {
    return {
        name: "atelier-local-backend-proxy-diagnostic",
        apply: "serve",
        configureServer(server) {
            if (target) return;
            server.middlewares.use((req, res, next) => {
                const pathname = new URL(req.url || "/", "http://vite.local").pathname;
                if (pathname !== "/api/v1" && !pathname.startsWith("/api/v1/")) return next();
                res.statusCode = 503;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({
                    code: "backend_proxy_not_configured",
                    message: "Set ATELIER_BACKEND_URL to an explicit loopback backend origin and restart Vite",
                }));
            });
        },
    };
}
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, webDir, "");
    const backendTarget = validateLocalBackendTarget(process.env.ATELIER_BACKEND_URL || env.ATELIER_BACKEND_URL);
    const apiProxyAllowedHosts = process.env.VITE_API_PROXY_ALLOWED_HOSTS || env.VITE_API_PROXY_ALLOWED_HOSTS;
    const localProxyOrigins = (process.env.API_PROXY_TRUSTED_LOCAL_ORIGINS || env.API_PROXY_TRUSTED_LOCAL_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
    return {
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localBackendProxyDiagnostic(backendTarget), retiredGatewayRoutesPlugin(), apiProxyPlugin(apiProxyAllowedHosts, localProxyOrigins)],
        server: {
            proxy: {
                ...(backendTarget ? {"/api/v1": {
                    target: backendTarget,
                    changeOrigin: false,
                    timeout: 0,
                    proxyTimeout: 0,
                    configure(proxy) {
                        proxy.on("proxyReq", (upstreamRequest, req) => {
                            const origin = req.headers.origin;
                            const host = req.headers.host;
                            const site = req.headers["sec-fetch-site"];
                            let allowedOrigin = !origin;
                            if (origin && host) {
                                try { allowedOrigin = new URL(origin).host === host; }
                                catch { allowedOrigin = false; }
                            }
                            if (!isLoopback(req.socket.remoteAddress || "") || !allowedOrigin ||
                                (site && !["same-origin","none"].includes(String(site)))) {
                                upstreamRequest.destroy(new Error("Private backend proxy requires same-origin localhost"));
                            }
                        });
                    },
                }} : {}),

            },
        },
        resolve: { alias: { "@": resolve(webDir, "src") } },
    };
});
