#!/usr/bin/env node
// Review a running perf build without project dependencies: node scripts/canvas-perf-review.mjs --url http://127.0.0.1:3107 --filter 'drag|resize' --repeats 3 --output C:/absolute/path/review.json
// PLAYWRIGHT_MODULE may point at an absolute Playwright entry file; otherwise playwright-core is resolved normally.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "http://127.0.0.1:3107";
const EXPECTED_HARNESS_VERSION = "5";
// Absorb only IEEE-754 representation noise at strict threshold comparisons.
const STRICT_TARGET_FLOAT_EPSILON = 1e-6;
const VIEWPORT = { width: 1920, height: 1080 };

function parseArgs(argv) {
    const options = { url: DEFAULT_URL, filter: null, repeats: 3, output: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--help" || token === "-h") { options.help = true; continue; }
        if (!["--url", "--filter", "--repeats", "--output"].includes(token)) throw new Error(`Unknown option: ${token}`);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
        index += 1;
        if (token === "--url") options.url = value;
        else if (token === "--filter") options.filter = value;
        else if (token === "--repeats") options.repeats = Number(value);
        else if (token === "--output") options.output = value;
    }
    if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error("--repeats must be a positive integer");
    if (options.output && !isAbsolute(options.output)) throw new Error("--output must be an absolute path");
    new URL(options.url);
    if (options.filter) new RegExp(options.filter);
    return options;
}

function printHelp() {
    process.stdout.write([
        "Canvas perf review runner (render-only, browser backend calls are intercepted).",
        "",
        "Usage: node scripts/canvas-perf-review.mjs [--url http://127.0.0.1:3107] [--filter REGEXP] [--repeats 3] [--output ABSOLUTE.json]",
        "Set PLAYWRIGHT_MODULE to an absolute Playwright module entry file, or install playwright-core in the calling environment.",
        "The blank-page rAF baseline is environmental context, never an application pass/fail override.",
        "",
    ].join("\n"));
}

function percentile(sorted, fraction) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] : 0;
}

function summarizeIntervals(intervals) {
    const sorted = [...intervals].sort((left, right) => left - right);
    const durationMs = intervals.reduce((total, interval) => total + interval, 0);
    return {
        frames: intervals.length,
        durationMs,
        fps: durationMs > 0 ? intervals.length * 1000 / durationMs : 0,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted.at(-1) ?? 0,
    };
}

function assessStrictTargets(report, expectedRepeats, idleScenarioId) {
    const idle = report.summaries.find((summary) => summary.scenarioId === idleScenarioId);
    return report.summaries
        .filter((summary) => summary.scenarioId !== idle?.scenarioId)
        .map((summary) => {
            const rounds = report.results.filter((round) => round.scenarioId === summary.scenarioId);
            const invalid = report.invalid.filter((sample) => sample.scenarioId === summary.scenarioId);
            const assessedRounds = rounds.map((round) => ({
                round: round.round,
                fps: round.frames.fps,
                p95Ms: round.frames.p95,
                p99Ms: round.frames.p99,
                longTaskCount: round.longTasks.count,
                longTaskMaxMs: round.longTasks.maxMs,
                passed: round.frames.fps + STRICT_TARGET_FLOAT_EPSILON >= 58
                    && round.frames.p95 <= 18 + STRICT_TARGET_FLOAT_EPSILON
                    && round.frames.p99 <= 33.4 + STRICT_TARGET_FLOAT_EPSILON
                    && round.longTasks.count === 0,
            }));
            const complete = assessedRounds.length === expectedRepeats && invalid.length === 0;
            return {
                scenarioId: summary.scenarioId,
                targets: { fpsMin: 58, p95MsMax: 18, p99MsMax: 33.4, longTasksMax: 0 },
                status: complete && assessedRounds.every((round) => round.passed) ? "pass" : complete ? "below-target" : "incomplete",
                passed: complete && assessedRounds.every((round) => round.passed),
                measuredRounds: assessedRounds.length,
                expectedRounds: expectedRepeats,
                rounds: assessedRounds,
                invalidSamples: invalid,
                relativeToIdle: idle ? {
                    diagnosticOnly: true,
                    fpsMedianDifference: summary.fps.median - idle.fps.median,
                    p95MedianDifferenceMs: summary.p95.median - idle.p95.median,
                    note: "Descriptive difference only; not normalized and does not change strict target status.",
                } : null,
            };
        });
}

function formatStrictTargets(assessment) {
    const lines = ["", "## Strict targets and idle comparison", "", "Per measured round: fps >=58, p95 <=18 ms, p99 <=33.4 ms, and zero long tasks. A 1e-6 comparison tolerance handles floating-point boundary representation only; raw measurements remain unchanged and values beyond that tolerance fail. Environment limits do not alter these outcomes.", ""];
    lines.push("| scenario | strict status | rounds | fps-p95-p99-longtasks by round | relative to idle (diagnostic) |", "| --- | --- | --- | --- | --- |");
    for (const item of assessment) {
        const rounds = item.rounds.map((round) => `${round.round}: ${round.fps.toFixed(2)} fps / ${round.p95Ms.toFixed(2)} / ${round.p99Ms.toFixed(2)} ms / ${round.longTaskCount} LT (max ${round.longTaskMaxMs.toFixed(1)} ms)${round.passed ? " pass" : " below"}`).join("; ");
        const relative = item.relativeToIdle ? `fps ${item.relativeToIdle.fpsMedianDifference >= 0 ? "+" : ""}${item.relativeToIdle.fpsMedianDifference.toFixed(2)}, p95 ${item.relativeToIdle.p95MedianDifferenceMs >= 0 ? "+" : ""}${item.relativeToIdle.p95MedianDifferenceMs.toFixed(2)} ms` : "n/a";
        lines.push(`| ${item.scenarioId} | ${item.status} | ${item.measuredRounds}/${item.expectedRounds} | ${rounds || "no valid rounds"} | ${relative} |`);
    }
    lines.push("", "Idle comparison is diagnostic only. A slow blank-page or idle baseline does not normalize application measurements or mark a strict target as passed.");
    return lines.join("\n");
}

async function readHarnessAsset() {
    const assetsDir = join(WEB_ROOT, "dist", "assets");
    const assets = await readdir(assetsDir);
    const bundle = assets.find((name) => name.startsWith("canvas-perf-harness-") && name.endsWith(".js"));
    if (!bundle) throw new Error(`No canvas-perf-harness bundle found under ${assetsDir}; run the perf build first.`);
    const html = await readFile(join(WEB_ROOT, "dist", "index.html"), "utf8").catch(() => "");
    const discoveredByHtml = html.includes(bundle);
    return { bundle, discoveredByHtml, assetsDir };
}

async function loadPlaywright() {
    const modulePath = process.env.PLAYWRIGHT_MODULE;
    return modulePath
        ? import(pathToFileURL(resolve(modulePath)).href)
        : import("playwright-core");
}

async function measureBlankPageBaseline(page, frameCount = 600) {
    await page.goto("about:blank");
    return page.evaluate(async (count) => {
        const timestamps = [];
        for (let index = 0; index < count; index += 1) {
            timestamps.push(await new Promise((resolve) => requestAnimationFrame(resolve)));
        }
        const deltasMs = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
        const sorted = [...deltasMs].sort((left, right) => left - right);
        const at = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] : 0;
        const durationMs = deltasMs.reduce((total, interval) => total + interval, 0);
        return {
            source: "about:blank",
            requestedFrames: count,
            timestamps,
            deltasMs,
            summary: {
                frames: deltasMs.length,
                durationMs,
                fps: durationMs > 0 ? deltasMs.length * 1000 / durationMs : 0,
                p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? 0,
            },
        };
    }, frameCount);
}

function mockBackendResponse(url, method, postData) {
    const pathname = url.pathname;
    if (pathname.endsWith("/session")) return { csrfToken: "canvas-perf-review" };
    if (pathname === "/api/v1/projects" && method === "GET") return { projects: [] };
    if (pathname.endsWith("/presets")) return { presets: [] };
    if (pathname.endsWith("/projects") && method === "POST") {
        let input = {};
        try { input = JSON.parse(postData || "{}"); } catch { /* keep an empty synthetic response */ }
        return { id: input.id, revision: 1, document: input.document ?? {} };
    }
    if (pathname.includes("/projects/") && method === "PATCH") {
        let input = {};
        try { input = JSON.parse(postData || "{}"); } catch { /* keep an empty synthetic response */ }
        return { revision: 1, document: input.document ?? {} };
    }
    if (pathname.includes("/projects/") && method === "GET") return { id: pathname.split("/").at(-1), revision: 1, document: {} };
    if (method === "DELETE") return { deleted: true };
    return { ok: true, instances: [], channels: [], assets: [], jobs: [], skills: [], settings: {}, presets: [] };
}

async function runReview(options) {
    const asset = await readHarnessAsset();
    const playwright = await loadPlaywright();
    if (!playwright.chromium) throw new Error("The selected Playwright module does not export chromium.");
    const browser = await playwright.chromium.launch({ headless: true, channel: "chrome" });
    const base = new URL(options.url);
    const moduleUrl = new URL(`/assets/${asset.bundle}`, base.origin).href;
    const appUrl = new URL(base.href);
    appUrl.searchParams.set("perfNodes", "300");
    const label = `review-v${EXPECTED_HARNESS_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const apiCalls = [];
    const externalRequestsBlocked = [];
    const pageErrors = [];
    const result = {
        runnerVersion: 1,
        harnessVersionExpected: EXPECTED_HARNESS_VERSION,
        label,
        url: base.href,
        filter: options.filter,
        repeats: options.repeats,
        viewport: { ...VIEWPORT, deviceScaleFactor: 1 },
        executionMode: {
            mode: "render-only",
            backend: "all /api/v1/* requests are intercepted with synthetic empty/session responses; no user projects are read or written",
            modelExecution: "excluded; external network requests are blocked",
            autoSave: "real backend persistence is excluded and cannot be reached from this runner",
        },
        harnessAsset: { filename: asset.bundle, moduleUrl, htmlReferencesBundleDirectly: asset.discoveredByHtml },
        blankPageRafBaseline: null,
        application: null,
        apiCalls,
        externalRequestsBlocked,
        pageErrors,
        environmentalNote: null,
    };

    try {
        const baselineContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
        const baselinePage = await baselineContext.newPage();
        result.blankPageRafBaseline = await measureBlankPageBaseline(baselinePage, 600);
        await baselineContext.close();
        if (result.blankPageRafBaseline.summary.fps < 58) {
            result.environmentalNote = `Blank-page rAF baseline was ${result.blankPageRafBaseline.summary.fps.toFixed(2)} fps. This is environmental context only: app scenarios remain reported with their original results and thresholds.`;
        }

        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const appOrigin = base.origin;
        await page.route("**/*", async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.origin !== appOrigin) {
                externalRequestsBlocked.push({ origin: requestUrl.origin, path: requestUrl.pathname });
                await route.abort("blockedbyclient");
                return;
            }
            if (!requestUrl.pathname.startsWith("/api/v1/")) {
                await route.continue();
                return;
            }
            const method = route.request().method();
            apiCalls.push({ method, path: requestUrl.pathname });
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(mockBackendResponse(requestUrl, method, route.request().postData())),
            });
        });

        await page.goto(appUrl.href, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Run 300 mixed + minimap", exact: true }).waitFor({ state: "visible", timeout: 120_000 });
        const available = await page.evaluate(async (url) => {
            const harness = await import(url);
            window.__canvasPerfReviewHarness = harness;
            return {
                version: harness.HARNESS_VERSION,
                scenarios: harness.CANVAS_300_SCENARIOS.map((scenario) => ({ id: scenario.id, label: scenario.label })),
                state: harness.getPerfSessionState(),
            };
        }, moduleUrl);
        if (available.version != null && String(available.version) !== EXPECTED_HARNESS_VERSION) {
            throw new Error(`Expected harness v${EXPECTED_HARNESS_VERSION}; found v${available.version} in ${asset.bundle}.`);
        }

        const matching = options.filter
            ? available.scenarios.filter((scenario) => new RegExp(options.filter).test(scenario.id))
            : available.scenarios;
        if (!matching.length) throw new Error(`--filter matched no scenarios. Available: ${available.scenarios.map((scenario) => scenario.id).join(", ")}`);
        const idleScenario = available.scenarios[0];
        result.selectedScenarios = matching.map(({ id, label: scenarioLabel }) => ({ id, label: scenarioLabel }));
        result.calibrationScenario = idleScenario.id;

        await page.evaluate(({ selectedIds, repeats, sessionLabel }) => {
            const harness = window.__canvasPerfReviewHarness;
            const idle = harness.CANVAS_300_SCENARIOS[0];
            const targets = harness.CANVAS_300_SCENARIOS
                .filter((scenario) => selectedIds.includes(scenario.id) && scenario.id !== idle.id)
                .map((scenario) => ({ ...scenario, repeats }));
            const scenarios = [{ ...idle, repeats: 3 }, ...targets];
            harness.setPerfSessionLabel(sessionLabel);
            void harness.startPerfSession(scenarios);
        }, { selectedIds: matching.map((scenario) => scenario.id), repeats: options.repeats, sessionLabel: label });

        let lastProgress = "";
        while (true) {
            const state = await page.evaluate(() => {
                const current = window.__canvasPerfReviewHarness.getPerfSessionState();
                return { status: current.status, phase: current.phase, progress: current.progress, error: current.error };
            });
            const progress = [state.status, state.phase, state.progress].filter(Boolean).join(" | ");
            if (progress && progress !== lastProgress) {
                process.stdout.write(`${progress}\n`);
                lastProgress = progress;
            }
            if (state.status === "done" || state.status === "error") break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        const { finalState, formattedReport } = await page.evaluate(() => {
            const current = window.__canvasPerfReviewHarness.getPerfSessionState();
            return {
                finalState: current,
                formattedReport: current.report ? window.__canvasPerfReviewHarness.formatBaselineReport(current.report) : null,
            };
        });
        const report = finalState.report;
        const reportedVersion = report?.env?.harnessVersion == null ? null : String(report.env.harnessVersion);
        if (report && reportedVersion !== EXPECTED_HARNESS_VERSION) {
            throw new Error(`Expected session harness v${EXPECTED_HARNESS_VERSION}; report recorded v${reportedVersion ?? "missing"}.`);
        }
        if (finalState.status === "done" && !report) throw new Error("Perf session finished without a report.");
        result.harnessVersionReported = reportedVersion;
        const strictTargetAssessment = report ? assessStrictTargets(report, options.repeats, idleScenario.id) : [];
        result.application = {
            status: finalState.status,
            error: finalState.error,
            report,
            strictTargetAssessment,
            formattedSummary: report && formattedReport ? `${formattedReport}\n${formatStrictTargets(strictTargetAssessment)}` : null,
        };
        result.environmentalNote ??= "Blank-page rAF results do not alter application scenario metrics or pass/fail thresholds.";
        await context.close();
    } finally {
        await browser.close();
    }
    return result;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { printHelp(); return; }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = options.output ?? join(WEB_ROOT, "artifacts", `canvas-perf-review-${timestamp}.json`);
    let result;
    try {
        result = await runReview(options);
    } catch (error) {
        result = {
            runnerVersion: 1,
            harnessVersionExpected: EXPECTED_HARNESS_VERSION,
            url: options.url,
            filter: options.filter,
            repeats: options.repeats,
            fatalError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
        process.exitCode = 1;
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    const markdown = result.application?.formattedSummary ?? `# Canvas perf review failed\n\n${result.fatalError ?? result.application?.error ?? "No report was produced."}\n`;
    const markdownPath = /\.json$/i.test(outputPath) ? outputPath.replace(/\.json$/i, ".md") : `${outputPath}.md`;
    await writeFile(markdownPath, markdown, "utf8");
    process.stdout.write(`JSON: ${outputPath}\nSummary: ${markdownPath}\n`);
    if (result.environmentalNote) process.stdout.write(`Environment: ${result.environmentalNote}\n`);
    if (result.application?.status !== "done") process.exitCode = 1;
    if (result.pageErrors?.length) process.exitCode = 1;
    if (result.application?.strictTargetAssessment?.some((assessment) => !assessment.passed)) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
});
