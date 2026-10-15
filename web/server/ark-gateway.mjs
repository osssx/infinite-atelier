import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyMediaDownloadResponse } from "./media-download-policy.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const MAX_FILE_BYTES = Number(process.env.MEDIA_MAX_BYTES || 200 * 1024 * 1024);
const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 256 * 1024;
const MAX_API_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_ARK_HOSTS = ["ark.cn-beijing.volces.com"];
const ARK_ALLOWED_HOSTS = new Set((process.env.ARK_ALLOWED_HOSTS || DEFAULT_ARK_HOSTS.join(","))
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
const UPLOAD_URL = process.env.MEDIA_UPLOAD_URL || "";
const TRUSTED_LOOPBACK_BASES = (process.env.ARK_TRUSTED_BASE_URLS || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => parseTrustedLoopbackUrl(value));
const ARK_BASE_URL = parseArkBaseUrl(process.env.ARK_BASE_URL || DEFAULT_ARK_BASE_URL, ARK_ALLOWED_HOSTS);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";

if (!GATEWAY_TOKEN) throw new Error("GATEWAY_TOKEN is required");

function parseTrustedLoopbackUrl(raw) {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) || url.protocol !== "http:" || !url.port || url.username || url.password || url.search || url.hash || url.pathname === "/") {
        throw new Error("ARK_TRUSTED_BASE_URLS entries must be explicit loopback URLs with a port and API path");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
}
function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}
function parseArkBaseUrl(raw, allowedHosts) {
    let base;
    try { base = new URL(raw); } catch { throw new Error("Ark Base URL is invalid"); }
    if (base.username || base.password || base.search || base.hash) throw new Error("Ark Base URL cannot include credentials, query or fragment");
    base.pathname = base.pathname.replace(/\/+$/, "");
    if (base.protocol === "https:" && (!base.port || base.port === "443") && !isIP(base.hostname) && allowedHosts.has(base.hostname.toLowerCase())) return base;
    const trusted = TRUSTED_LOOPBACK_BASES.find((item) => item.href === base.href);
    if (trusted) return new URL(trusted.href);
    throw new Error("Ark Base URL must use an allowlisted HTTPS host or exactly match ARK_TRUSTED_BASE_URLS");
}

function arkBaseFromRequest(req) {
    const supplied = req.headers["x-ark-base-url"];
    if (supplied !== undefined && typeof supplied !== "string") throw Object.assign(new Error("x-ark-base-url must be a single URL"), { status: 400 });
    try { return supplied ? parseArkBaseUrl(supplied, ARK_ALLOWED_HOSTS) : ARK_BASE_URL; }
    catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : "invalid Ark base URL"), { status: 400 }); }
}

function arkRouteUrl(route, search = "", base = ARK_BASE_URL) {
    return new URL(`${base.pathname}/${route.replace(/^\/+/, "")}${search}`, base.origin);
}

function arkAuthorization(base, clientAuthorization) {
    const usesConfiguredDefault = base.origin === ARK_BASE_URL.origin && base.pathname === ARK_BASE_URL.pathname;
    if (usesConfiguredDefault && process.env.ARK_API_KEY) {
        return { value: `Bearer ${process.env.ARK_API_KEY}`, source: "server" };
    }
    if (typeof clientAuthorization === "string" && /^Bearer\s+\S+$/i.test(clientAuthorization)) {
        return { value: clientAuthorization, source: "client" };
    }
    return null;
}

function send(res, status, value) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(value));
}

function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || b === 88)) ||
            (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224);
    }
    const v = address.toLowerCase();
    if (v.startsWith("::ffff:")) {
        const mapped = v.slice("::ffff:".length);
        return isIP(mapped) === 4 && publicAddress(mapped);
    }
    return (v.startsWith("2") || v.startsWith("3")) && !v.startsWith("2001:db8:") && !v.startsWith("2001:10:");
}

async function validateHttpsUrl(raw, allowedHosts) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
        isIP(url.hostname) || !allowedHosts.has(url.hostname.toLowerCase())) throw new Error("configured destination is not allowlisted HTTPS");
    const ips = await lookup(url.hostname, { all: true, verbatim: true });
    if (!ips.length || ips.some(({ address }) => !publicAddress(address))) throw new Error("destination resolves to a non-public address");
    return { url, ips };
}

function pinnedRequest(url, ips, maxBytes, timeoutMs, { method = "GET", headers = {}, body, allowHttpErrors = false } = {}) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const request = transport(url, {
            method,
            headers,
            lookup: (_hostname, options, callback) => {
                if (options?.all) callback(null, ips);
                else callback(null, ips[0].address, ips[0].family);
            },
        }, (response) => {
            if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
                response.resume(); reject(new Error("media source redirects are blocked")); return;
            }
            if (!allowHttpErrors && ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300)) {
                response.resume(); reject(new Error(`media source failed (${response.statusCode})`)); return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) { request.destroy(new Error("media source response too large")); return; }
                chunks.push(chunk);
            });
            response.on("end", () => resolve({ body: Buffer.concat(chunks, size), statusCode: response.statusCode || 200,
                headers: response.headers, contentType: response.headers["content-type"] || "application/octet-stream" }));
            response.on("error", reject);
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error("media source timed out")));
        request.on("error", reject);
        request.end(body);
    });
}

async function validateArkTarget(base, target) {
    if (base.protocol === "https:") return validateHttpsUrl(target.href, ARK_ALLOWED_HOSTS);
    if (!TRUSTED_LOOPBACK_BASES.some((item) => item.href === base.href) || target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/`)) throw new Error("Ark route escaped its trusted base URL");
    const hostname = base.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isLoopbackHost(address))) throw new Error("trusted Ark destination resolved outside loopback");
    return { url: target, ips: addresses };
}
async function validateConfiguredTarget(raw) {
    const endpoint = new URL(raw);
    if (endpoint.protocol === "https:") {
        const allowedHosts = new Set((process.env.MEDIA_UPLOAD_ALLOWED_HOSTS || endpoint.hostname).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
        return validateHttpsUrl(endpoint.href, allowedHosts);
    }
    const uploadConfigured = UPLOAD_URL && new URL(UPLOAD_URL).href === endpoint.href;
    const trustedBase = TRUSTED_LOOPBACK_BASES.some((item) => item.origin === endpoint.origin);
    if (endpoint.protocol !== "http:" || !isLoopbackHost(endpoint.hostname) || (!uploadConfigured && !trustedBase) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("HTTP destinations must match an explicitly trusted loopback configuration");
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isLoopbackHost(address))) throw new Error("trusted loopback destination resolved outside loopback");
    return { url: endpoint, ips: addresses };
}
async function validateMediaUrl(raw, publicHosts) {
    const url = new URL(raw);
    try { return await validateHttpsUrl(url.href, publicHosts); } catch (error) {
        const uploadOrigin = UPLOAD_URL ? new URL(UPLOAD_URL).origin : "";
        const trustedArkOrigin = TRUSTED_LOOPBACK_BASES.some((item) => item.origin === url.origin);
        if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || (url.origin !== uploadOrigin && !trustedArkOrigin) || url.username || url.password || url.hash) throw error;
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(({ address }) => !isLoopbackHost(address))) throw new Error("signed media URL resolves outside loopback");
        return { url, ips: addresses };
    }
}

async function readBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}

async function readResponse(response, maxBytes) {
    const chunks = [];
    let size = 0;
    if (!response.body) return Buffer.alloc(0);
    for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > maxBytes) throw new Error("upstream response too large");
        chunks.push(data);
    }
    return Buffer.concat(chunks, size);
}

function authenticate(req) {
    return req.headers["x-gateway-token"] === GATEWAY_TOKEN;
}

async function arkApi(req, res, requestUrl) {
    const suffix = requestUrl.pathname.slice("/api/ark".length);
    const collection = suffix === "/contents/generations/tasks";
    const task = /^\/contents\/generations\/tasks\/[A-Za-z0-9_-]+$/.test(suffix);
    if (!(collection && req.method === "POST") && !(task && ["GET", "DELETE"].includes(req.method || ""))) return send(res, 404, { error: "route not found" });
    const base = arkBaseFromRequest(req);
    const target = arkRouteUrl(suffix.slice(1), requestUrl.search, base);
    // The Ark destination and route prefix are constants; incoming input can only select task IDs.
    const body = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readBody(req, MAX_API_BYTES) : undefined;
    const headers = { "content-type": req.headers["content-type"] || "application/json" };
    const authorization = arkAuthorization(base, req.headers.authorization);
    if (authorization) headers.authorization = authorization.value;
    else return send(res, 401, { error: "Ark API key is not configured for this destination" });
    const { url, ips } = await validateArkTarget(base, target);
    const upstream = await pinnedRequest(url, ips, MAX_RESPONSE_BYTES, 120_000, { method: req.method, headers, body, allowHttpErrors: true });
    res.writeHead(upstream.statusCode, { "content-type": upstream.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(upstream.body);
}

async function uploadMedia(req, res) {
    if (!UPLOAD_URL) return send(res, 503, { error: "media upload is not configured" });
    const type = req.headers["content-type"] || "";
    const boundary = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(type);
    if (!boundary) return send(res, 415, { error: "multipart/form-data is required" });
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const boundaryValue = boundary[1] || boundary[2];
    const filePart = findFilePart(body, boundaryValue);
    if (!filePart) {
        return send(res, 400, { error: 'multipart field "file" is required' });
    }
    if (filePart.length > MAX_FILE_BYTES) return send(res, 413, { error: "file exceeds the upload size limit" });
    const { url: target, ips } = await validateConfiguredTarget(UPLOAD_URL);
    const method = process.env.MEDIA_UPLOAD_METHOD || "POST";
    if (!["POST", "PUT"].includes(method)) return send(res, 500, { error: "MEDIA_UPLOAD_METHOD must be POST or PUT" });
    const upstream = await pinnedRequest(target, ips, 256 * 1024, Number(process.env.MEDIA_UPLOAD_TIMEOUT_MS || 60_000), {
        method,
        headers: { "content-type": type, ...(process.env.MEDIA_UPLOAD_TOKEN ? { authorization: `Bearer ${process.env.MEDIA_UPLOAD_TOKEN}` } : process.env.MEDIA_UPLOAD_FORWARD_CLIENT_AUTH === "1" && typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}) },
        body,
        allowHttpErrors: true,
    });
    const payload = upstream.body;
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) return send(res, 502, { error: `upload service failed (${upstream.statusCode})` });
    let result;
    try { result = JSON.parse(payload.toString("utf8")); } catch { return send(res, 502, { error: "upload service returned invalid JSON" }); }
    if (typeof result?.url !== "string") return send(res, 502, { error: "upload service response must contain a url" });
    const publicUrl = new URL(result.url);
    const publicHosts = new Set((process.env.MEDIA_PUBLIC_ALLOWED_HOSTS || target.hostname).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
    const signedLocalUpload = target.protocol === "http:" && publicUrl.origin === target.origin && /^\/uploads\/[A-Fa-f0-9-]{36}(?:\.(?:png|jpg|webp|mp4|mov|webm|wav|mp3|flac|m4a))?$/.test(publicUrl.pathname) && Boolean(publicUrl.searchParams.get("exp") && publicUrl.searchParams.get("sig"));
    try { if (!signedLocalUpload) await validateMediaUrl(publicUrl.href, publicHosts); }
    catch { return send(res, 502, { error: "upload service returned an untrusted media URL" }); }
    send(res, 200, { url: publicUrl.href, ...(typeof result.expiresAt === "string" ? { expiresAt: result.expiresAt } : {}) });
}

async function downloadMedia(req, res, requestUrl) {
    const raw = requestUrl.searchParams.get("url");
    if (!raw) return send(res, 400, { error: "missing url" });
    const parsed = new URL(raw);
    const trustedLoopback = TRUSTED_LOOPBACK_BASES.some((item) => item.origin === parsed.origin) || (UPLOAD_URL && new URL(UPLOAD_URL).origin === parsed.origin);
    if (trustedLoopback && (!/^\/(?:uploads\/[A-Fa-f0-9-]{36}(?:\.(?:png|jpg|webp|mp4|mov|webm|wav|mp3|flac|m4a))?|last-frame\/[A-Za-z0-9_-]+|media\/[A-Za-z0-9_-]+)$/.test(parsed.pathname) || !parsed.searchParams.get("exp") || !parsed.searchParams.get("sig"))) return send(res, 400, { error: "invalid signed media URL" });
    const hosts = new Set((process.env.MEDIA_DOWNLOAD_ALLOWED_HOSTS || "ark.cn-beijing.volces.com,ark-content-generation-cn-beijing.tos-cn-beijing.volces.com").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
    const { url, ips } = await validateMediaUrl(raw, hosts);
    const result = await pinnedRequest(url, ips, Number(process.env.MEDIA_DOWNLOAD_MAX_BYTES || 200 * 1024 * 1024), Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || 60_000), { allowHttpErrors: true });
    const decision = classifyMediaDownloadResponse({ statusCode: result.statusCode, contentType: result.contentType });
    if (!decision.ok) return send(res, decision.status, decision.body);
    res.writeHead(200, { "content-type": decision.contentType, "content-length": result.body.length, "content-disposition": "attachment", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(result.body);
}

function findFilePart(body, boundary) {
    const delimiter = Buffer.from(`--${boundary}`);
    let cursor = 0;
    let found = null;
    while (cursor < body.length) {
        const start = body.indexOf(delimiter, cursor);
        if (start < 0) break;
        let partStart = start + delimiter.length;
        if (body.subarray(partStart, partStart + 2).equals(Buffer.from("--"))) break;
        if (body.subarray(partStart, partStart + 2).equals(Buffer.from("\r\n"))) partStart += 2;
        const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
        if (headerEnd < 0) break;
        const headers = body.toString("latin1", partStart, headerEnd);
        const dataStart = headerEnd + 4;
        const next = body.indexOf(delimiter, dataStart);
        if (next < 0) break;
        const dataEnd = next >= 2 && body.subarray(next - 2, next).equals(Buffer.from("\r\n")) ? next - 2 : next;
        if (/content-disposition:\s*form-data;[^\r\n]*\bname="file"[^\r\n]*\bfilename="[^"\r\n]*"/i.test(headers)) {
            if (found) return null;
            found = { length: dataEnd - dataStart };
        }
        cursor = next;
    }
    return found;
}

async function arkHealth(req, res) {
    const base = arkBaseFromRequest(req);
    const auth = arkAuthorization(base, req.headers.authorization);
    if (!auth) return send(res, 401, { error: "ark_key_missing" });
    const url = arkRouteUrl("contents/generations/tasks/codex-connectivity-check-never-created", "", base);
    const { ips } = await validateArkTarget(base, url);
    const upstream = await pinnedRequest(url, ips, MAX_RESPONSE_BYTES, 15_000, { headers: { authorization: auth.value }, allowHttpErrors: true });
    if ([401, 403].includes(upstream.statusCode)) return send(res, 401, { error: "ark_auth_failed" });
    // This task ID is intentionally never created. Ark's 404 confirms the API
    // route is reachable without creating a billable task.
    if (upstream.statusCode === 404 || (upstream.statusCode >= 200 && upstream.statusCode < 300)) {
        return send(res, 200, { reachable: true, authenticated: true, apiKeySource: auth.source });
    }
    return send(res, 502, { error: "ark_upstream_unexpected_status", status: upstream.statusCode });
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", "http://gateway.local");
        const uploadRoute = req.method === "POST" && ["/media/ark", "/api/media/ark", "/api/media/uploads"].includes(url.pathname);
        const bearerGatewayToken = req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`;
        if (!authenticate(req) && !(uploadRoute && bearerGatewayToken)) return send(res, 401, { error: "unauthorized" });
        if (req.method === "GET" && url.pathname === "/api/ark/health") return await arkHealth(req, res);
        if ((req.method === "POST" && ["/media/ark", "/api/media/ark", "/api/media/uploads"].includes(url.pathname))) return await uploadMedia(req, res);
        if (req.method === "GET" && url.pathname === "/api/ark/download") return await downloadMedia(req, res, url);
        if (["GET", "POST", "DELETE"].includes(req.method || "") && url.pathname.startsWith("/api/ark/")) return await arkApi(req, res, url);
        send(res, 404, { error: "route not found" });
    } catch (error) {
        send(res, error?.status || 502, { error: error instanceof Error ? error.message : "gateway error" });
    }
});

server.headersTimeout = 15_000;
server.requestTimeout = 90_000;
server.listen(PORT, HOST, () => console.log(`Ark gateway listening on ${server.address().port}`));
