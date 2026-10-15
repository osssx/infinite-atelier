import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { classifyMediaDownloadResponse } from "./media-download-policy.mjs";

const serverPath = fileURLToPath(new URL("./ark-gateway.mjs", import.meta.url));
const children = [];
let origin;
let routerOrigin;
let viteOrigin;
let routerServer;
const routerRequests = [];
let localProxyQueue = Promise.resolve();

async function withLocalProxyLock(work) {
    const previous = localProxyQueue;
    let release;
    localProxyQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { await work(); } finally { release(); }
}

async function startGateway(overrides = {}) {
    const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, PORT: "0", GATEWAY_HOST: "127.0.0.1", GATEWAY_TOKEN: "gateway-test-token", ...overrides },
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 5000;
    while (!/Ark gateway listening on (\d+)/.test(output)) {
        if (child.exitCode !== null) throw new Error(`gateway exited: ${output}`);
        if (Date.now() > deadline) throw new Error(`gateway did not start: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { child, origin: `http://127.0.0.1:${output.match(/Ark gateway listening on (\d+)/)[1]}` };
}

before(async () => {
    ({ origin } = await startGateway({
        MEDIA_UPLOAD_URL: "https://127.0.0.1/upload",
        MEDIA_UPLOAD_ALLOWED_HOSTS: "127.0.0.1",
    }));
    routerServer = createServer(async (req, res) => {
        for await (const _chunk of req) { /* consume request bodies before replying */ }
        routerRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
        if (req.url === "/ready") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ready: true }));
        } else if (req.url?.startsWith("/media/")) {
            res.writeHead(200, { "content-type": "video/mp4" });
            res.end(Buffer.from("fake-media"));
        } else if (req.url === "/api/v3/contents/uploads") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ url: `${routerOrigin}/uploads/00000000-0000-0000-0000-000000000000.mp4?exp=2000000000&sig=test` }));
        } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ method: req.method, url: req.url }));
        }
    });
    await new Promise((resolve) => routerServer.listen(0, "127.0.0.1", resolve));
    routerOrigin = `http://127.0.0.1:${routerServer.address().port}`;
    const vitePort = await reservePort();
    viteOrigin = `http://127.0.0.1:${vitePort}`;
    const viteCli = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
    const vite = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, ARK_TRUSTED_BASE_URLS: `${routerOrigin}/api/v3`, MEDIA_UPLOAD_URL: `${routerOrigin}/api/v3/contents/uploads` },
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(vite);
    let viteOutput = "";
    vite.stdout.setEncoding("utf8");
    vite.stdout.on("data", (chunk) => { viteOutput += chunk; });
    vite.stderr.setEncoding("utf8");
    vite.stderr.on("data", (chunk) => { viteOutput += chunk; });
    const deadline = Date.now() + 15_000;
    while (true) {
        if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteOutput}`);
        try { if ((await fetch(viteOrigin)).ok) break; } catch { /* wait for Vite startup */ }
        if (Date.now() > deadline) throw new Error(`Vite did not start: ${viteOutput}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
});

after(async () => {
    for (const child of children) {
        if (child.exitCode === null) {
            child.kill();
            await once(child, "exit");
        }
    }
    if (routerServer?.listening) await new Promise((resolve) => routerServer.close(resolve));
});

async function reservePort() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function localHeaders(overrides = {}) {
    return { origin: viteOrigin, "sec-fetch-site": "same-origin", "x-ark-base-url": `${routerOrigin}/api/v3`, ...overrides };
}

async function localFetch(label, url, options) {
    // Isolate requests from Undici's idle socket reuse while the Vite fixture
    // starts/restarts its development middleware.
    try { return await fetch(url, { ...options, headers: { ...options?.headers, connection: "close" } }); }
    catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}; router requests=${JSON.stringify(routerRequests)}`); }
}

test("gateway rejects requests without its token and denies unknown routes after authentication", async () => {
    const unauthorized = await fetch(`${origin}/api/ark/contents/generations/tasks`);
    assert.equal(unauthorized.status, 401);
    const unknown = await fetch(`${origin}/private`, { headers: { "x-gateway-token": "gateway-test-token" } });
    assert.equal(unknown.status, 404);
});

test("Ark connection check reports missing credentials without making an upstream request", async () => {
    const response = await fetch(`${origin}/api/ark/health`, { headers: { "x-gateway-token": "gateway-test-token" } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "ark_key_missing" });
});

test("custom Ark base startup requires an exact allowlisted HTTPS hostname", async () => {
    const { child } = await startGateway({
        ARK_BASE_URL: "https://custom-ark.example.test/api/v3",
        ARK_ALLOWED_HOSTS: "custom-ark.example.test",
    });
    assert.equal(child.exitCode, null);
});

test("request-supplied Ark base URL cannot escape the configured host allowlist", async () => {
    const { origin: customOrigin } = await startGateway({
        ARK_BASE_URL: "https://custom-ark.example.test/api/v3",
        ARK_ALLOWED_HOSTS: "custom-ark.example.test",
        ARK_API_KEY: "test-server-key",
    });
    const response = await fetch(`${customOrigin}/api/ark/health`, {
        headers: {
            "x-gateway-token": "gateway-test-token",
            "x-ark-base-url": "https://evil.example.test/api/v3",
        },
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /ARK_BASE_URL|ARK_TRUSTED_BASE_URLS/);
});

test("server Ark key is not available to request-selected custom destinations", async () => {
    const configured = await startGateway({
        ARK_API_KEY: "server-only-key",
        ARK_ALLOWED_HOSTS: "ark.cn-beijing.volces.com,custom.example",
    });
    const response = await fetch(`${configured.origin}/api/ark/contents/generations/tasks/task-1`, {
        headers: {
            "x-gateway-token": "gateway-test-token",
            "x-ark-base-url": "https://custom.example/api/v3",
        },
    });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /not configured for this destination/);
});

test("Vite dev gateway has no Router-specific client route", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    assert.match(config, /ARK_TRUSTED_BASE_URLS/);
    assert.match(config, /MEDIA_UPLOAD_URL/);
    assert.doesNotMatch(config, /api\/router-local|ARK_LOCAL_ROUTER_URL|x-router-origin/);
});

test("media upload rejects a private IP even when its hostname appears in configuration", async () => {
    const form = new FormData();
    form.append("file", new Blob(["tiny test file"]), "sample.mp4");
    const response = await fetch(`${origin}/media/ark`, {
        method: "POST", headers: { "x-gateway-token": "gateway-test-token" }, body: form,
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /allowlisted HTTPS/);
});

test("result downloads reject IP literals, credentials, HTTP and unlisted hosts", async () => {
    const token = { "x-gateway-token": "gateway-test-token" };
    const urls = [
        "https://127.0.0.1/private",
        "https://user:pass@ark.cn-beijing.volces.com/result",
        "http://ark.cn-beijing.volces.com/result",
        "https://example.com/result",
    ];
    for (const url of urls) {
        const response = await fetch(`${origin}/api/ark/download?url=${encodeURIComponent(url)}`, { headers: token });
        assert.ok([400, 502].includes(response.status), `${url} status=${response.status}`);
    }
});

test("upload route reports missing storage configuration", async () => {
    const { origin: unconfiguredOrigin } = await startGateway({ MEDIA_UPLOAD_URL: "" });
    const response = await fetch(`${unconfiguredOrigin}/media/ark`, {
        method: "POST", headers: { "x-gateway-token": "gateway-test-token", "content-type": "multipart/form-data; boundary=sample" },
        body: "--sample--\r\n",
    });
    assert.equal(response.status, 503);
});

test("media download policy preserves expired 404/410 statuses", () => {
    for (const statusCode of [404, 410]) {
        const decision = classifyMediaDownloadResponse({ statusCode, contentType: "application/json" });
        assert.equal(decision.ok, false);
        assert.equal(decision.status, statusCode);
        assert.equal(decision.body.code, "MEDIA_URL_EXPIRED");
        assert.match(decision.body.error, /expired/i);
    }
});

test("media download policy accepts media bytes and rejects HTML or JSON", () => {
    assert.deepEqual(classifyMediaDownloadResponse({ statusCode: 200, contentType: "video/mp4; charset=binary" }), {
        ok: true, contentType: "video/mp4",
    });
    assert.deepEqual(classifyMediaDownloadResponse({ statusCode: 200, contentType: "image/jpeg" }), {
        ok: true, contentType: "image/jpeg",
    });
    for (const contentType of ["text/html", "application/json", "text/plain", ""] ) {
        const decision = classifyMediaDownloadResponse({ statusCode: 200, contentType });
        assert.equal(decision.ok, false, contentType);
        assert.equal(decision.status, 502);
        assert.equal(decision.body.code, "MEDIA_NOT_MEDIA");
    }
});

test("configured generic gateway uses exact trusted loopback Ark and upload targets", async () => withLocalProxyLock(async () => {
    const task = await localFetch("task create", `${viteOrigin}/api/ark/contents/generations/tasks`, {
        method: "POST", headers: localHeaders({ "content-type": "application/json", authorization: "Bearer selected-channel-key" }), body: JSON.stringify({ model: "sample" }),
    });
    assert.equal(task.status, 200, await task.clone().text());
    assert.deepEqual(await task.json(), { method: "POST", url: "/api/v3/contents/generations/tasks" });
    const form = new FormData();
    form.append("file", new Blob(["image-bytes"], { type: "image/png" }), "sample.png");
    const upload = await localFetch("generic media upload", `${viteOrigin}/api/media/uploads`, {
        method: "POST", headers: localHeaders({ authorization: "Bearer selected-channel-key" }), body: form,
    });
    assert.equal(upload.status, 200, await upload.text());
    assert.equal(routerRequests.at(-1).url, "/api/v3/contents/uploads");
    assert.equal(routerRequests.at(-1).authorization, "Bearer selected-channel-key");
    const beforeUnknown = routerRequests.length;
    const unknown = await localFetch("unknown route", `${viteOrigin}/api/ark/arbitrary?target=http://127.0.0.1`, { headers: localHeaders() });
    assert.equal(unknown.status, 404);
    assert.equal(routerRequests.length, beforeUnknown);
    const wrongBase = await localFetch("untrusted base", `${viteOrigin}/api/ark/contents/generations/tasks`, { headers: localHeaders({ "x-ark-base-url": "http://127.0.0.1:1/api/v3" }) });
    assert.equal(wrongBase.status, 403);
    const crossOrigin = await localFetch("cross origin", `${viteOrigin}/api/ark/contents/generations/tasks`, { headers: localHeaders({ origin: "https://attacker.example" }) });
    assert.equal(crossOrigin.status, 403);
}));

test("generic signed media download only accepts a configured loopback origin", async () => withLocalProxyLock(async () => {
    const signedUrl = `${routerOrigin}/media/video-1?exp=2000000000&sig=signature`;
    const valid = await localFetch("signed media download", `${viteOrigin}/api/ark/download?url=${encodeURIComponent(signedUrl)}`, { headers: localHeaders() });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("content-type"), "video/mp4");
    assert.equal(await valid.text(), "fake-media");
    const invalidUrl = `https://example.com/media/video-1?exp=2000000000&sig=signature`;
    const invalid = await localFetch("invalid signed URL", `${viteOrigin}/api/ark/download?url=${encodeURIComponent(invalidUrl)}`, { headers: localHeaders() });
    assert.equal(invalid.status, 403);
}));
