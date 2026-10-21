import perfPixelUrl from "@/assets/perf-pixel.svg?no-inline";

import { router } from "@/router";
import { canvasPerfBridgeState, drainPipelineTimings, type PipelineTimings } from "@/lib/canvas/canvas-perf-bridge-state";
import { buildCanvasFixture } from "@/lib/canvas/canvas-fixtures";
import { PERF_MODE } from "@/lib/perf-mode";
import { drainPersistTimings, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

/** Bumped whenever the harness changes in a way that invalidates earlier measurements. */
export const HARNESS_VERSION = "1";

/** Every measured tree must use this seed so the three groups see the same graph. */
export const PERF_SEED = 7;

export const PERF_PROJECT_PREFIX = "perf-fixture";
export const PERF_PROJECT_TITLE = "[perf] fixture";

/**
 * Shared fixture image. Imported with `?no-inline` on purpose: Vite would otherwise inline this small
 * SVG as a `data:` URL, and `hydrateCanvasImages` sends any `data:image/` content through
 * `uploadImage` — one blob write per image node. The acceptance check is that the built URL is a real
 * same-origin HTTP URL, not a data URL.
 */
export const PERF_MEDIA_URL = perfPixelUrl;
/** Kept in the perf module across per-round project remounts. */
let perfFixtureMediaMode: "static" | "decoded" = "static";

const HYDRATE_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 10_000;
const UNMOUNT_TIMEOUT_MS = 10_000;
/** Frames sampled after the last scripted input, so its work lands inside the measured window. */
const SETTLE_FRAMES = 3;

/** A sample that must not be counted. `reason` is recorded verbatim in the report. */
export class PerfInvalidSampleError extends Error {
    constructor(
        readonly reason: string,
        readonly detail?: string,
    ) {
        super(detail ? `${reason}: ${detail}` : reason);
        this.name = "PerfInvalidSampleError";
    }
}

export function isCanvasPerfEnabled(): boolean {
    return PERF_MODE;
}

// ---------------------------------------------------------------------------
// Pointer capture shim
// ---------------------------------------------------------------------------

// Synthetic PointerEvents have no active pointer behind them, so `setPointerCapture` throws
// NotFoundError before the gesture state is assigned and the gesture never starts. The shim keeps
// the fix out of application source: both measured trees get byte-identical behaviour, whereas a
// source patch applied to only one of them would silently make one side unable to pan.
let savedPointerCapture: { capture: typeof Element.prototype.setPointerCapture; has: typeof Element.prototype.hasPointerCapture; release: typeof Element.prototype.releasePointerCapture } | null = null;

export function installPointerCaptureShim(): void {
    if (!PERF_MODE || savedPointerCapture) return;
    savedPointerCapture = {
        capture: Element.prototype.setPointerCapture,
        has: Element.prototype.hasPointerCapture,
        release: Element.prototype.releasePointerCapture,
    };
    Element.prototype.setPointerCapture = function setPointerCapture() {};
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
        return false;
    };
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
}

export function restorePointerCapture(): void {
    if (!savedPointerCapture) return;
    Element.prototype.setPointerCapture = savedPointerCapture.capture;
    Element.prototype.hasPointerCapture = savedPointerCapture.has;
    Element.prototype.releasePointerCapture = savedPointerCapture.release;
    savedPointerCapture = null;
}

// ---------------------------------------------------------------------------
// Fixture project
// ---------------------------------------------------------------------------

export function perfProjectId(nodeCount: number): string {
    return `${PERF_PROJECT_PREFIX}-${nodeCount}`;
}

/**
 * Injects the fixture as its own project. `replaceProjects` swaps the entire list, so the projects
 * that are not ours are passed straight back through — replacing with just the fixture would delete
 * the user's work. Re-running replaces rather than appends.
 */
export function provisionPerfProject(nodeCount: number, seed = PERF_SEED, mediaMode: "static" | "decoded" = perfFixtureMediaMode, layout: "spread" | "clustered" = "spread"): string {
    const { nodes, connections } = buildCanvasFixture({
        nodeCount, seed, mediaMode, layout,
        staticMediaUrl: mediaMode === "decoded" ? "/perf-media/sample-photo.jpg" : PERF_MEDIA_URL,
        staticVideoUrl: "/perf-media/sample-video.mp4",
        staticAudioUrl: "/perf-media/sample-audio.mp3",
    });
    const id = perfProjectId(nodeCount);
    const now = new Date().toISOString();
    const project: CanvasProject = {
        id,
        title: `${PERF_PROJECT_TITLE} ${nodeCount}`,
        createdAt: now,
        updatedAt: now,
        nodes,
        connections,
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        // The load path assigns this with no fallback, so it must be a valid transform.
        viewport: { x: 0, y: 0, k: 1 },
    };
    const others = useCanvasStore.getState().projects.filter((candidate) => !candidate.id.startsWith(PERF_PROJECT_PREFIX));
    useCanvasStore.getState().replaceProjects([...others, project]);
    return id;
}

/**
 * Waits for the real hydrate. Never fakes `hydrated: true` as a shortcut: a hydrate arriving after
 * the fixture was injected replaces `projects` wholesale and would silently drop it.
 */
export async function waitForHydration(timeoutMs = HYDRATE_TIMEOUT_MS): Promise<void> {
    if (useCanvasStore.getState().hydrated) return;
    await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            unsubscribe();
            reject(new PerfInvalidSampleError("hydrate-timeout", `store did not hydrate within ${timeoutMs}ms`));
        }, timeoutMs);
        const unsubscribe = useCanvasStore.subscribe((state) => {
            if (!state.hydrated) return;
            window.clearTimeout(timer);
            unsubscribe();
            resolve();
        });
    });
}

/** Waits until the canvas page reports a load newer than `afterToken`. Returns the new token. */
export async function waitForCanvasReady(afterToken: number, timeoutMs = READY_TIMEOUT_MS): Promise<number> {
    await waitUntil(() => canvasPerfBridgeState.readyToken > afterToken, timeoutMs, "ready-timeout", `canvas did not become ready within ${timeoutMs}ms`);
    return canvasPerfBridgeState.readyToken;
}

/** Waits until the canvas page has unmounted, so the next round provably remounts. */
export async function waitForCanvasUnmount(timeoutMs = UNMOUNT_TIMEOUT_MS): Promise<void> {
    await waitUntil(() => !canvasPerfBridgeState.container, timeoutMs, "unmount-timeout", `canvas did not unmount within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

export function nextFrame(): Promise<number> {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Polls `predicate` once per frame until it holds.
 *
 * The abort flag is not optional: every wait in this harness used to be bounded only by a
 * `performance.now()` comparison inside its own loop, which can never fire when rAF itself is
 * throttled (hidden or occluded tab). The whole session would then hang with no visible reason. The
 * deadline is therefore owned by a timer, and it flips this flag so the detached loop stops.
 */
async function pollUntil(predicate: () => boolean, signal: { aborted: boolean }): Promise<void> {
    for (;;) {
        if (predicate()) return;
        if (signal.aborted) throw new PerfInvalidSampleError("aborted", "wait was abandoned by its deadline");
        await nextFrame();
    }
}

/** Rejects from a `setTimeout` rather than from the polling loop, so it still fires if rAF stalls. */
function withDeadline<T>(work: Promise<T>, timeoutMs: number, reason: string, detail: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new PerfInvalidSampleError(reason, detail)), timeoutMs);
        work.then(
            (value) => {
                window.clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/** rAF is paused in a hidden tab, which would silently freeze every wait and inflate every gap. */
function assertPageVisible(): void {
    if (document.visibilityState !== "visible") throw new PerfInvalidSampleError("page-not-visible", `document.visibilityState is "${document.visibilityState}"`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, reason: string, detail: string): Promise<void> {
    const signal = { aborted: false };
    try {
        await withDeadline(pollUntil(predicate, signal), timeoutMs, reason, detail);
    } catch (error) {
        signal.aborted = true;
        throw error;
    }
}

/**
 * Runs `fn` once per animation frame. Pacing input from inside rAF is what makes the input sequence
 * reproducible: the same frame index carries the same event in every group. It does not make frame
 * *timing* comparable — that is what the statistics are for.
 */
export async function pumpFrames(count: number, fn: (index: number) => void): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        const frameStart = await nextFrame();
        // A hidden tab pauses rAF; without this the sequence would stall silently instead of failing.
        assertPageVisible();
        // Time the main thread actually spends inside this frame's callback. Compared against the gap
        // between callbacks, this separates two very different causes of a slow frame: the main thread
        // being busy, versus the main thread being idle while the browser produces frames slowly. Only
        // the first is something the application code or an index could fix.
        const busyStart = performance.now();
        fn(index);
        frameBusyMs += performance.now() - busyStart;
        if (frameStart > 0) void frameStart;
    }
}

/** Main-thread time spent inside sampled frame callbacks, accumulated for the current round. */
let frameBusyMs = 0;

export function drainFrameBusyMs(): number {
    const value = frameBusyMs;
    frameBusyMs = 0;
    return value;
}

// ---------------------------------------------------------------------------
// Synthetic input
// ---------------------------------------------------------------------------

export function requireContainer(): HTMLElement {
    const container = canvasPerfBridgeState.container;
    if (!container) throw new PerfInvalidSampleError("no-container", "canvas container is not mounted");
    return container;
}

function pointerInit(clientX: number, clientY: number, overrides: PointerEventInit = {}): PointerEventInit {
    return { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse", ...overrides };
}

export function dispatchPointer(target: EventTarget, type: string, clientX: number, clientY: number, overrides: PointerEventInit = {}): void {
    target.dispatchEvent(new PointerEvent(type, pointerInit(clientX, clientY, overrides)));
}

export function dispatchMouse(target: EventTarget, type: string, clientX: number, clientY: number, overrides: MouseEventInit = {}): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1, ...overrides }));
}

export function dispatchWheel(target: EventTarget, deltaY: number, clientX: number, clientY: number): void {
    target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, composed: true, clientX, clientY, deltaY, deltaMode: 0 }));
}

/**
 * Resolves the element a synthetic pointer press would actually hit. Asserted before every script so
 * a scenario cannot silently drive the wrong element — a mistargeted press still "dispatches fine"
 * and produces a plausible-looking frame number.
 */
export function hitTest(clientX: number, clientY: number, predicate: (element: Element) => boolean, description: string): Element {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) throw new PerfInvalidSampleError("hit-test-miss", `nothing at (${clientX}, ${clientY}) for ${description}`);
    if (!predicate(element)) throw new PerfInvalidSampleError("hit-test-wrong-target", `${description} hit <${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}> instead`);
    return element;
}

// ---------------------------------------------------------------------------
// Live counts
// ---------------------------------------------------------------------------

export type LiveCounts = {
    /** Mounted node elements — NOT the same as nodes intersecting the viewport (culling adds padding). */
    mountedNodes: number;
    mountedEdges: number;
    svgPaths: number;
    domNodes: number;
    mediaElements: number;
};

/**
 * Heavy DOM snapshots. Kept out of the sampling window on purpose: `querySelectorAll` over the whole
 * canvas every frame would cost more than the thing being measured.
 */
export function snapshotCounts(): LiveCounts {
    const container = requireContainer();
    const batchedEdges = container.querySelector("[data-canvas-overview-edge-count]");
    return {
        mountedNodes: container.querySelectorAll("[data-node-id]").length,
        mountedEdges: batchedEdges ? Number(batchedEdges.getAttribute("data-canvas-overview-edge-count")) : container.querySelectorAll("[data-connection-id]").length,
        svgPaths: container.querySelectorAll("svg path").length,
        domNodes: container.querySelectorAll("*").length,
        mediaElements: container.querySelectorAll("img[src], video[src], audio[src]").length,
    };
}

/** Cheap per-frame count, safe to sample inside the sampling window. */
export function mountedNodeCount(): number {
    return canvasPerfBridgeState.container?.querySelectorAll("[data-node-id]").length ?? 0;
}

/** How many node elements a subtree contributes — 1 if it is one, otherwise however many it holds. */
function countNodeElements(root: Node): number {
    if (!(root instanceof Element)) return 0;
    if (root.matches("[data-node-id]")) return 1;
    return root.querySelectorAll("[data-node-id]").length;
}

let mountedCounter: { container: HTMLElement; count: number; observer: MutationObserver } | null = null;

/**
 * Mounted-node count maintained incrementally, for use inside the sampling window.
 *
 * Calling `querySelectorAll` once per frame — which this originally did — scans the whole canvas
 * every frame and its cost lands inside the very interval being measured. The plan calls that out
 * explicitly. So the count is seeded once, outside the window, and then adjusted by a MutationObserver.
 */
export function mountedNodeCountFast(): number {
    const container = canvasPerfBridgeState.container;
    if (!container) return 0;
    if (mountedCounter?.container === container) return mountedCounter.count;

    mountedCounter?.observer.disconnect();
    const state = { container, count: container.querySelectorAll("[data-node-id]").length, observer: null as unknown as MutationObserver };
    state.observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const added of record.addedNodes) state.count += countNodeElements(added);
            for (const removed of record.removedNodes) state.count -= countNodeElements(removed);
        }
    });
    state.observer.observe(container, { childList: true, subtree: true });
    mountedCounter = state;
    return state.count;
}

export function readViewport(): ViewportTransform {
    return canvasPerfBridgeState.viewport;
}

export function applyViewport(viewport: ViewportTransform): void {
    const setViewport = canvasPerfBridgeState.setViewport;
    if (!setViewport) throw new PerfInvalidSampleError("no-set-viewport", "the canvas has not published its viewport setter");
    setViewport(viewport);
}

// ---------------------------------------------------------------------------
// Idle protocol
// ---------------------------------------------------------------------------

export type IdleOptions = {
    stableFrames?: number;
    quietMs?: number;
    timeoutMs?: number;
};

/**
 * Waits for a round to actually finish.
 *
 * A quiet DOM is not proof: after a gesture stops, the save chain is a 500ms viewport timer, then
 * `updateProject`, then a 400ms store debounce, then an async write. So this requires the DOM to stop
 * changing AND a quiet window long enough to cover those timers, with a hard timeout so a stalled
 * 5000-node round aborts instead of hanging.
 */
/**
 * The idle deadline scales with the scenario's node count.
 *
 * A fixed 10s is fine at 1000 nodes but not at 3000, where a single frame measured 780ms and three
 * stable frames plus the quiet window cannot fit — the round was rejected as `idle-timeout` even
 * though it was making progress. The ceiling keeps a genuinely wedged round failing.
 */
function idleTimeoutFor(nodeCount: number): number {
    return Math.min(60_000, Math.max(10_000, nodeCount * 12));
}

export async function waitForIdle({ stableFrames = 3, quietMs = 1200, timeoutMs = IDLE_TIMEOUT_MS }: IdleOptions = {}): Promise<void> {
    let stable = 0;
    let lastSignature = "";
    let quietSince = performance.now();
    await waitUntil(
        () => {
            const recovering = Boolean(canvasPerfBridgeState.container?.querySelector("[data-canvas-lod-recovering]"));
            const signature = `${mountedNodeCountFast()}|${canvasPerfBridgeState.selectedNodeIds.size}|${canvasPerfBridgeState.viewport.x}|${canvasPerfBridgeState.viewport.y}|${canvasPerfBridgeState.viewport.k}|${recovering}`;
            if (signature === lastSignature) {
                stable += 1;
            } else {
                stable = 0;
                lastSignature = signature;
                quietSince = performance.now();
            }
            return !recovering && stable >= stableFrames && performance.now() - quietSince >= quietMs;
        },
        timeoutMs,
        "idle-timeout",
        `round did not settle within ${timeoutMs}ms`,
    );
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export type FrameStats = {
    frames: number;
    durationMs: number;
    fps: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    /** Frames slower than `jankThresholdMs`, which comes from the idle baseline, not this sample. */
    jank: number;
    jankThresholdMs: number;
};

function percentile(sorted: readonly number[], fraction: number): number {
    if (!sorted.length) return 0;
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank];
}

export function summariseFrames(deltas: readonly number[], durationMs: number, jankThresholdMs: number): FrameStats {
    const sorted = [...deltas].sort((a, b) => a - b);
    const mean = deltas.length ? deltas.reduce((total, value) => total + value, 0) / deltas.length : 0;
    return {
        frames: deltas.length,
        durationMs,
        fps: durationMs > 0 ? (deltas.length / durationMs) * 1000 : 0,
        mean,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        jank: deltas.filter((delta) => delta > jankThresholdMs).length,
        jankThresholdMs,
    };
}

export type LongTaskSummary = { count: number; totalMs: number; maxMs: number };

export type RoundResult = {
    scenarioId: string;
    nodeCount: number;
    frames: FrameStats;
    longTasks: LongTaskSummary;
    mountedNodes: { min: number; median: number; max: number };
    counts: LiveCounts;
    viewportBefore: ViewportTransform;
    viewportAfter: ViewportTransform;
    selectedBefore: number;
    selectedAfter: number;
    /**
     * Raw frame intervals. Retained so the idle baseline's jank count can be recomputed once its own
     * measurement has established the threshold — it runs first, so judging it against the initial 0
     * marked every single frame as jank.
     */
    deltasMs: number[];
    /** Scenario-specific facts that belong in the report regardless of the verdict. */
    notes: string[];
    /** Which measured round this is, e.g. "2/3". Filled in by the session runner. */
    round: string;
    /**
     * Persistence writes dispatched during this round, split into stringify and write time.
     * Only collected in perf mode; empty otherwise.
     */
    persist: { writes: number; maxStringifyMs: number; totalStringifyMs: number; maxWriteMs: number; totalWriteMs: number; maxBytes: number };
    /**
     * Main-thread time inside sampled frame callbacks. Compare with `frames.durationMs`: if this is a
     * small fraction, the thread was idle while the browser took its time producing frames, and no
     * amount of application-code optimisation will move it.
     */
    frameBusyMs: number;
    /**
     * Where the main thread's time went during this round. The frame timings say how slow a frame was;
     * only this says what made it slow, which is the difference between building an index and not.
     */
    pipeline: PipelineTimings;
};

export type Scenario = {
    id: string;
    label: string;
    nodeCount: number;
    /** Optional alternate geometry for dense LOD recovery workloads. */
    fixtureLayout?: "spread" | "clustered";
    /** Frames of scripted input. */
    frames: number;
    /** Set the viewport once the round is ready. */
    setup?: () => Promise<void> | void;
    /** One input event per frame. */
    script: (frameIndex: number) => void;
    /** Throw a PerfInvalidSampleError when the interaction demonstrably did not take effect. */
    assert?: (context: RoundContext) => void;
    /** The scenario provides its own jank threshold (the idle baseline does). */
    measuresIdleBaseline?: boolean;
    /**
     * Measured rounds, after the discarded warm-up. Defaults to `DEFAULT_REPEATS`.
     *
     * The fit-all-zoom scenarios set this to 1 on purpose: at ~2s a frame a single round already
     * characterises them, and repeating them would cost minutes per session while adding nothing —
     * the repeat budget is better spent on the scenarios whose A/B difference is actually in doubt.
     */
    repeats?: number;
    /**
     * Facts the round should carry into the report even when it passes — the achieved density when a
     * target was unreachable, how many zoom frames were clamped at a limit, expected vs actual drag
     * distance. These must not live only in the pass/fail verdict.
     */
    notes?: () => string[];
    /**
     * Diagnostic hook: runs once the round is ready and before sampling, and may return a function to
     * undo whatever it changed.
     *
     * Exists for causal experiments — mutating one suspected cause in a way that provably leaves the
     * painted output unchanged, then re-measuring. That answers "what should change", which an
     * observational trace cannot, and it is the independent A/B the design doc asked for on the
     * world-layer SVG.
     */
    mutateDom?: () => (() => void) | undefined;
};

/** State captured immediately before the scripted input, handed to `assert` so it needs no globals. */
export type RoundContext = {
    viewportBefore: ViewportTransform;
    selectedBefore: number;
};

export type ScenarioOutcome = { ok: true; result: RoundResult } | { ok: false; reason: string; detail?: string };

/** Median of an already-sorted-friendly list, used to aggregate repeats. */
function medianOf(values: readonly number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianCounts(values: readonly number[]): { min: number; median: number; max: number } {
    return { min: values.length ? Math.min(...values) : 0, median: medianOf(values), max: values.length ? Math.max(...values) : 0 };
}

// ---------------------------------------------------------------------------
// Round orchestration
// ---------------------------------------------------------------------------

/** Where a round currently is. Surfaced to the panel so a slow round never looks like a frozen one. */
export type RoundPhase = "resetting" | "waiting-ready" | "settling" | "setup" | "sampling" | "asserting";

/**
 * Runs one measured round: reset (navigate away and back so the page provably remounts), wait for
 * ready, settle, run the script, assert it took effect, settle again.
 *
 * Returning a value object instead of throwing keeps an invalid sample out of the aggregates without
 * aborting the whole session.
 */
export async function runRound(scenario: Scenario, jankThresholdMs: number, onPhase?: (phase: string) => void): Promise<ScenarioOutcome> {
    const phase = (next: RoundPhase) => onPhase?.(`${scenario.id}: ${next}`);
    let undoDom: (() => void) | undefined;
    try {
        assertPageVisible();
        phase("resetting");
        const projectId = perfProjectId(scenario.nodeCount);
        const tokenBefore = canvasPerfBridgeState.readyToken;
        await router.navigate("/canvas");
        await waitForCanvasUnmount();
        provisionPerfProject(scenario.nodeCount, PERF_SEED, perfFixtureMediaMode, scenario.fixtureLayout ?? "spread");
        await router.navigate(`/canvas/${projectId}`);
        phase("waiting-ready");
        const token = await waitForCanvasReady(tokenBefore);
        if (token <= tokenBefore) throw new PerfInvalidSampleError("stale-ready-token", "ready token did not advance");
        // The default quiet window (1200ms) is deliberate: it has to outlast the save chain of a
        // 500ms viewport timer, then `updateProject`, then a 400ms store debounce. A shorter window
        // would start sampling with a write still pending and attribute its cost to the scenario.
        phase("settling");
        await waitForIdle({ stableFrames: 2, timeoutMs: idleTimeoutFor(scenario.nodeCount) });

        // After the reset has settled, so the DOM being mutated is this round's, and before sampling,
        // so the mutation is in place for every measured frame.
        undoDom = scenario.mutateDom?.();

        // Drop anything queued before this round so the write timings below belong to it alone.
        drainPersistTimings();
        drainPipelineTimings();
        drainFrameBusyMs();

        phase("setup");
        await scenario.setup?.();
        await waitForIdle({ stableFrames: 2, timeoutMs: idleTimeoutFor(scenario.nodeCount) });

        const viewportBefore = { ...readViewport() };
        const selectedBefore = canvasPerfBridgeState.selectedNodeIds.size;

        const deltas: number[] = [];
        const mounted: number[] = [];
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: false });

        let previous = performance.now();
        const startedAt = previous;
        const sample = () => {
            const now = performance.now();
            deltas.push(now - previous);
            previous = now;
            mounted.push(mountedNodeCountFast());
        };

        phase("sampling");
        // The deadline lives outside the loop on purpose: a frame-paced loop cannot time itself out
        // when rAF is what stopped. The budget is generous because the fit-all-zoom case really can
        // take hundreds of ms a frame — that is a measurement, not a hang.
        const frameBudgetMs = Math.max(20_000, scenario.frames * 3000);
        try {
            await withDeadline(
                pumpFrames(scenario.frames, (index) => {
                    sample();
                    scenario.script(index);
                }),
                frameBudgetMs,
                "frame-stall",
                `scripted input did not complete within ${frameBudgetMs}ms`,
            );
        } catch (error) {
            // A stall IS the measurement. Report how far it got and how slow the frames were, rather
            // than discarding the slowest scenario as a bare timeout — that loses the only number the
            // scenario exists to produce. The sample still stays out of every median.
            if (error instanceof PerfInvalidSampleError && error.reason === "frame-stall") {
                const sorted = [...deltas].sort((a, b) => a - b);
                const medianFrame = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
                const worstFrame = sorted.length ? sorted[sorted.length - 1] : 0;
                throw new PerfInvalidSampleError(
                    "frame-stall",
                    `${deltas.length}/${scenario.frames} frames in ${frameBudgetMs}ms; median frame ${medianFrame.toFixed(1)}ms, max ${worstFrame.toFixed(1)}ms — slower than the budget, not hung`,
                );
            }
            throw error;
        }

        // Let the work the final input triggered land inside the window rather than after it.
        await pumpFrames(SETTLE_FRAMES, sample);
        observer.disconnect();

        // The first delta spans the gap between the setup idle and the first scripted frame, so it
        // measures the harness's own scheduling rather than the app's.
        deltas.shift();

        // A single frame this long is not the app being slow: it is the tab having been suspended, the
        // machine having slept, or the process being descheduled. One such round produced a 176s "frame"
        // and a p99 of 854ms while its median stayed at 16.7ms. Rejecting it keeps that contamination
        // out of the aggregates rather than relying on the median to absorb it.
        const worstFrame = deltas.length ? Math.max(...deltas) : 0;
        if (worstFrame > 30_000) {
            throw new PerfInvalidSampleError("frame-suspended", `a single frame lasted ${(worstFrame / 1000).toFixed(1)}s — the tab was suspended or the machine slept, so this is not a frame-time measurement`);
        }

        const durationMs = performance.now() - startedAt;

        phase("asserting");
        scenario.assert?.({ viewportBefore, selectedBefore });

        const writes = drainPersistTimings();
        const persist = {
            writes: writes.length,
            maxStringifyMs: writes.length ? Math.max(...writes.map((write) => write.stringifyMs)) : 0,
            totalStringifyMs: writes.reduce((total, write) => total + write.stringifyMs, 0),
            maxWriteMs: writes.length ? Math.max(...writes.map((write) => write.writeMs)) : 0,
            totalWriteMs: writes.reduce((total, write) => total + write.writeMs, 0),
            maxBytes: writes.length ? Math.max(...writes.map((write) => write.bytes)) : 0,
        };

        const viewportAfter = { ...readViewport() };
        return {
            ok: true,
            result: {
                scenarioId: scenario.id,
                nodeCount: scenario.nodeCount,
                frames: summariseFrames(deltas, durationMs, jankThresholdMs),
                longTasks: { count: longTasks.length, totalMs: longTasks.reduce((total, value) => total + value, 0), maxMs: longTasks.length ? Math.max(...longTasks) : 0 },
                mountedNodes: medianCounts(mounted),
                counts: snapshotCounts(),
                viewportBefore,
                viewportAfter,
                selectedBefore,
                selectedAfter: canvasPerfBridgeState.selectedNodeIds.size,
                deltasMs: deltas,
                notes: scenario.notes?.() ?? [],
                round: "",
                persist,
                pipeline: drainPipelineTimings(),
                frameBusyMs: drainFrameBusyMs(),
            },
        };
    } catch (error) {
        if (error instanceof PerfInvalidSampleError) return { ok: false, reason: error.reason, detail: error.detail };
        return { ok: false, reason: "unexpected-error", detail: error instanceof Error ? error.message : String(error) };
    } finally {
        // Always restored: the next round remounts the page anyway, but a diagnostic variant must not
        // leak into a subsequently measured scenario within the same run.
        undoDom?.();
    }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type PerfEnv = {
    harnessVersion: string;
    userAgent: string;
    devicePixelRatio: number;
    viewportWidth: number;
    viewportHeight: number;
    hardwareConcurrency: number;
    canvasRect: { width: number; height: number } | null;
    /** Reported because rAF is quantised to it, which is what the idle baseline measures. */
    idleFrameMs: number | null;
    /**
     * Free-text session label, e.g. "A-1" for the first session on the pre-optimisation build.
     *
     * A browser session cannot detect which of three interleaved sessions it is, and a fresh
     * `--user-data-dir` per session wipes anything that could count them — so the label is typed in.
     * Without it the per-session results in CANVAS_BASELINE.md cannot be attributed or interleaved.
     */
    sessionLabel: string;
};

const SESSION_LABEL_KEY = "infinite-canvas-perf:session-label";

export function getPerfSessionLabel(): string {
    try {
        return window.localStorage.getItem(SESSION_LABEL_KEY) ?? "";
    } catch {
        return "";
    }
}

export function setPerfSessionLabel(value: string): void {
    try {
        window.localStorage.setItem(SESSION_LABEL_KEY, value);
    } catch {
        // A blocked storage backend only costs us the label surviving navigation within the session.
    }
}

export function snapshotEnvironment(idleFrameMs: number | null = null): PerfEnv {
    const rect = canvasPerfBridgeState.container?.getBoundingClientRect() ?? null;
    return {
        harnessVersion: HARNESS_VERSION,
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
        canvasRect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        idleFrameMs,
        sessionLabel: getPerfSessionLabel(),
    };
}

// ---------------------------------------------------------------------------
// Viewport solving
// ---------------------------------------------------------------------------

const MIN_K = 0.05;
const MAX_K = 5;
const CULL_PADDING = 280;

function graphBounds() {
    const nodes = canvasPerfBridgeState.nodes;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const node of nodes) {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    }
    if (!Number.isFinite(left)) return { left: 0, top: 0, right: 0, bottom: 0 };
    return { left, top, right, bottom };
}

function canvasSize(): { width: number; height: number } {
    const rect = requireContainer().getBoundingClientRect();
    return { width: rect.width, height: rect.height };
}

/**
 * Counts nodes whose padded bounding box overlaps the viewport — the same predicate the app's culling
 * uses. Computed from graph data, not measured in the DOM, so it can drive a binary search without
 * applying a viewport first.
 */
function countInViewport(viewport: ViewportTransform, size: { width: number; height: number }): number {
    const viewLeft = -viewport.x / viewport.k - CULL_PADDING;
    const viewTop = -viewport.y / viewport.k - CULL_PADDING;
    const viewRight = viewLeft + size.width / viewport.k + CULL_PADDING * 2;
    const viewBottom = viewTop + size.height / viewport.k + CULL_PADDING * 2;
    let count = 0;
    for (const node of canvasPerfBridgeState.nodes) {
        if (node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom) count += 1;
    }
    return count;
}

/** Viewport centred on the graph's bounding box at a given zoom. */
export function centredViewport(k: number): ViewportTransform {
    const bounds = graphBounds();
    const size = canvasSize();
    const centreX = (bounds.left + bounds.right) / 2;
    const centreY = (bounds.top + bounds.bottom) / 2;
    return { x: size.width / 2 - centreX * k, y: size.height / 2 - centreY * k, k };
}

/** Smallest zoom that still fits the whole graph, clamped by the app's own ceiling. */
export function fitViewport(): ViewportTransform {
    const bounds = graphBounds();
    const size = canvasSize();
    const width = Math.max(bounds.right - bounds.left, 1);
    const height = Math.max(bounds.bottom - bounds.top, 1);
    const k = Math.min(Math.max(Math.min(size.width / width, size.height / height), MIN_K), MAX_K);
    return centredViewport(k);
}

export type SolvedViewport = { viewport: ViewportTransform; predicted: number; achieved: boolean };

/**
 * Binary-searches the zoom that mounts roughly `target` nodes. Reports the predicted count and
 * whether the target was reachable at all — the plan is explicit that a scenario must report the
 * real number rather than force the target by adjusting the fixture.
 */
export function solveViewport(targetMounted: number): SolvedViewport {
    const size = canvasSize();
    let low = MIN_K;
    let high = MAX_K;
    let best = fitViewport();
    for (let step = 0; step < 40; step += 1) {
        const mid = (low + high) / 2;
        const candidate = centredViewport(mid);
        const predicted = countInViewport(candidate, size);
        best = candidate;
        if (predicted === targetMounted) return { viewport: candidate, predicted, achieved: true };
        if (predicted > targetMounted) low = mid;
        else high = mid;
    }
    const predicted = countInViewport(best, size);
    return { viewport: best, predicted, achieved: Math.abs(predicted - targetMounted) <= Math.max(25, targetMounted * 0.15) };
}

// ---------------------------------------------------------------------------
// Input targets
// ---------------------------------------------------------------------------

/**
 * True for elements the canvas would treat as background. A connection's transparent hit path counts
 * as foreground: pressing it selects the edge rather than starting a pan or marquee.
 */
function isBackgroundElement(element: Element): boolean {
    return !element.closest("[data-node-id], [data-connection-id]");
}

/** A point inside the canvas that a press would actually land on the background, not on a node or edge. */
export function findBackgroundPoint(): { x: number; y: number } {
    const container = requireContainer();
    const rect = container.getBoundingClientRect();
    // A grid, not a handful of fixed candidates. This fixture mounts hundreds of nodes and — more to
    // the point — the connection hit paths are 16px wide with 600+ edges crossing the view, so they
    // cover most of the canvas. A few candidate points reliably landed on one and the round was
    // rejected; scanning finds a genuinely free pixel instead of weakening the predicate.
    const columns = 24;
    const rows = 16;
    for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
            const point = { x: rect.left + (rect.width * column) / columns, y: rect.top + (rect.height * row) / rows };
            const element = document.elementFromPoint(point.x, point.y);
            if (element && container.contains(element) && isBackgroundElement(element)) return point;
        }
    }
    throw new PerfInvalidSampleError("no-background-point", `no free pixel on a ${columns}x${rows} grid over ${Math.round(rect.width)}x${Math.round(rect.height)}`);
}

/**
 * Centre of a mounted image node. The drag handler is bound to the node's inner body, while
 * `data-node-id` and the selection capture handler sit on the outer element — dispatching at the
 * outer element only bubbles *up*, so it never reaches the handler that starts a drag.
 */
export function findDraggableNodeTarget(): { nodeId: string; x: number; y: number; target: Element } {
    const container = requireContainer();
    const nodes = [...container.querySelectorAll<HTMLElement>("[data-node-id]")];
    for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const element = document.elementFromPoint(x, y);
        if (!element || !node.contains(element)) continue;
        // Skip handles, dots, toolbars and editors: only the plain content body starts a drag.
        if (element.closest("button, input, textarea, [data-canvas-no-zoom], [contenteditable='true']")) continue;
        const nodeId = node.dataset.nodeId;
        if (!nodeId) continue;
        return { nodeId, x, y, target: element };
    }
    throw new PerfInvalidSampleError("no-draggable-node", "no mounted node offered a draggable body point");
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const GENERAL_ZOOM_TARGET = 200;

/** No input at all. Establishes the idle frame interval that the jank threshold is fixed against. */
export function createIdleBaselineScenario(nodeCount = 1000): Scenario {
    return {
        id: "idle-baseline",
        label: "idle (no input)",
        nodeCount,
        frames: 180,
        script: () => {},
        measuresIdleBaseline: true,
    };
}

/** A point inside the canvas plus the element a press there would actually hit. */
function pointInsideContainer(): { x: number; y: number; element: Element } {
    const container = requireContainer();
    const rect = container.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const element = document.elementFromPoint(point.x, point.y);
    if (!element || !container.contains(element)) throw new PerfInvalidSampleError("no-canvas-point", "the canvas centre is not inside the container — is an overlay covering it?");
    return { ...point, element };
}

/**
 * Background drag, with the MIDDLE button.
 *
 * The app pans on `button === 1` regardless of what is under the cursor, and that matters here: at the
 * zoom this scenario solves for, the viewport is genuinely covered — nodes plus 600-odd edges whose
 * transparent hit paths are 16px wide. A 24x16 grid search found no free pixel, because there is not
 * one; left-dragging empty space is not a gesture a user could perform at this density. Middle-drag
 * is, and it takes exactly the same code path.
 */
export function createPanScenario(nodeCount = 1000, frames = 180): Scenario {
    let origin: { x: number; y: number } | null = null;
    return {
        id: "pan-general",
        label: "pan (middle drag), general zoom",
        nodeCount,
        frames,
        setup: () => {
            const solved = solveViewport(GENERAL_ZOOM_TARGET);
            applyViewport(solved.viewport);
        },
        script: (frame) => {
            if (frame === 0) {
                const start = pointInsideContainer();
                origin = { x: start.x, y: start.y };
                dispatchPointer(start.element, "pointerdown", start.x, start.y, { button: 1, buttons: 4 });
                return;
            }
            if (!origin) throw new PerfInvalidSampleError("pan-not-started", "frame 0 did not establish a drag origin");
            const x = origin.x + frame * 2;
            dispatchPointer(window, "pointermove", x, origin.y, { buttons: 4 });
            if (frame === frames - 1) dispatchPointer(window, "pointerup", x, origin.y, { button: 1, buttons: 0 });
        },
        assert: ({ viewportBefore }) => {
            const viewport = readViewport();
            if (viewport.x === viewportBefore.x && viewport.y === viewportBefore.y) throw new PerfInvalidSampleError("pan-had-no-effect", "viewport did not move");
        },
    };
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function nodePosition(nodeId: string): { x: number; y: number } | null {
    const node = canvasPerfBridgeState.nodes.find((candidate) => candidate.id === nodeId);
    return node ? { x: node.position.x, y: node.position.y } : null;
}

/** id -> rounded position, for "did anything else move?" comparisons. */
function positionSignatures(): Map<string, string> {
    return new Map(canvasPerfBridgeState.nodes.map((node) => [node.id, `${Math.round(node.position.x)},${Math.round(node.position.y)}`]));
}

function movedNodeIds(before: Map<string, string>): string[] {
    const moved: string[] = [];
    for (const node of canvasPerfBridgeState.nodes) {
        const previous = before.get(node.id);
        if (previous !== undefined && previous !== `${Math.round(node.position.x)},${Math.round(node.position.y)}`) moved.push(node.id);
    }
    return moved;
}

/** World point under a client coordinate, using the same convention as the app's screenToCanvas. */
function worldUnder(clientX: number, clientY: number): { x: number; y: number } {
    const rect = requireContainer().getBoundingClientRect();
    const viewport = readViewport();
    return { x: (clientX - rect.left - viewport.x) / viewport.k, y: (clientY - rect.top - viewport.y) / viewport.k };
}

// ---------------------------------------------------------------------------
// Zoom scenarios
// ---------------------------------------------------------------------------

/** One wheel notch is `1.1^(-deltaY/100)`; a quarter notch keeps a 180-frame sweep inside 0.05–5. */
const ZOOM_DELTA_PER_FRAME = 25;

/**
 * Anchor for wheel events: a coordinate that matters, plus the element to dispatch on.
 *
 * The element is deliberately the container, never whatever `elementFromPoint` returns at that
 * coordinate. A hit-tested element can be culled away mid-sequence as the zoom changes, and an event
 * dispatched on a detached node never reaches React's root listener — so the wheel events would stop
 * being delivered and the round would fail with a small, baffling drift instead of a clear cause. The
 * container is always mounted, and the app's own wheel guard (`closest("[data-canvas-no-zoom],...")`)
 * passes for it exactly as it would for a genuinely empty pixel.
 */
function zoomAnchor(): { x: number; y: number; element: Element } {
    const container = requireContainer();
    const rect = container.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.4, y: rect.top + rect.height * 0.35, element: container };
}

/**
 * Wheel zoom in, then the same distance back out.
 *
 * Two things are asserted, and both would have caught the wheel bug this harness was partly written to
 * measure: k must return to where it started (a dropped delta would not cancel), and the world point
 * under the anchor must not drift (that is what anchored zoom means). Frames where k did not move
 * because a limit was reached are counted separately rather than averaged into the zoom cost.
 */
export function createZoomScenario(nodeCount = 1000, frames = 180): Scenario {
    const half = Math.floor(frames / 2);
    let anchor: { x: number; y: number; element: Element } | null = null;
    let baseK = 0;
    let anchorWorld: { x: number; y: number } | null = null;
    let previousK: number | null = null;
    let stalledFrames = 0;
    let kAtTurn = 0;
    let stepsUp = 0;
    let stepsDown = 0;

    const drift = () => (anchor && anchorWorld ? Math.hypot(worldUnder(anchor.x, anchor.y).x - anchorWorld.x, worldUnder(anchor.x, anchor.y).y - anchorWorld.y) : 0);
    const expectedTurn = () => baseK * Math.pow(1.1, (ZOOM_DELTA_PER_FRAME / 100) * half);
    /** How many zoom steps the turn reading is behind. A lagged read, not a lost event. */
    const turnLagSteps = () => (kAtTurn > 0 && baseK > 0 ? Math.log(expectedTurn() / kAtTurn) / Math.log(Math.pow(1.1, ZOOM_DELTA_PER_FRAME / 100)) : 0);

    return {
        id: "zoom-general",
        label: "wheel zoom in then out, general density",
        nodeCount,
        frames,
        setup: () => {
            applyViewport(solveViewport(GENERAL_ZOOM_TARGET).viewport);
        },
        script: (frame) => {
            if (frame === 0) {
                anchor = zoomAnchor();
                baseK = readViewport().k;
                anchorWorld = worldUnder(anchor.x, anchor.y);
                previousK = baseK;
                stalledFrames = 0;
                kAtTurn = 0;
                stepsUp = 0;
                stepsDown = 0;
            }
            if (!anchor) throw new PerfInvalidSampleError("zoom-not-started", "frame 0 did not establish an anchor");
            const kAtStart = readViewport().k;
            // The app flushes one wheel step per frame, so a frame whose k did not move was clamped.
            const moved = previousK !== null && Math.abs(kAtStart - previousK) > 1e-9;
            if (previousK !== null && !moved) stalledFrames += 1;
            if (moved) {
                if (frame < half) stepsUp += 1;
                else stepsDown += 1;
            }
            previousK = kAtStart;
            // The zoom-in half must have been fully applied by now. Checking here turns "the deltas
            // were not delivered" into a precise diagnosis instead of a vague percentage shortfall.
            if (frame === half) kAtTurn = kAtStart;
            dispatchWheel(anchor.element, frame < half ? -ZOOM_DELTA_PER_FRAME : ZOOM_DELTA_PER_FRAME, anchor.x, anchor.y);
        },
        assert: () => {
            // Asymmetric bound: a lagged read can only make this lower, never higher. The bridge
            // republishes its snapshot from a layout effect, and at ~200ms a frame that read can sit a
            // couple of steps behind — a measurement lag, not a lost event.
            const turn = expectedTurn();
            if (kAtTurn > 0 && (kAtTurn > turn * 1.02 || kAtTurn < turn * 0.8)) {
                throw new PerfInvalidSampleError("zoom-half-mismatch", `after ${half} zoom-in frames k is ${kAtTurn.toFixed(4)}, expected ~${turn.toFixed(4)} — wheel events were not delivered`);
            }
            // Tolerance of 3% (about one step) rather than 1%: this scenario has intermittently come
            // back one step short, on identical code, and a single step is not worth burning a round
            // over — the pre-fix bug this guards against lost more than half the deltas. The phase step
            // counts in the notes are what localise the discrepancy.
            const after = readViewport();
            if (baseK > 0 && Math.abs(after.k - baseK) / baseK > 0.03) throw new PerfInvalidSampleError("zoom-did-not-return", `k went ${baseK.toFixed(4)} -> ${after.k.toFixed(4)}; wheel deltas were lost`);
            const movedWorld = drift();
            if (movedWorld > 1) throw new PerfInvalidSampleError("zoom-anchor-drifted", `the anchored world point moved ${movedWorld.toFixed(3)} world units`);
        },
        notes: () => [
            `k ${baseK.toFixed(4)} -> ${kAtTurn.toFixed(4)} at the turn (expected ~${expectedTurn().toFixed(4)}, ~${turnLagSteps().toFixed(1)} steps of read lag) -> ${readViewport().k.toFixed(4)}`,
            // Deliberately worded as "did not advance" rather than "clamped", and labelled unreliable:
            // the count comes from comparing k between consecutive frame starts, so at ~200ms a frame
            // several applied steps can merge into one observed change and the count only ever
            // UNDER-reports. The round trip above is the trustworthy check — this is a hint, not proof.
            `unreliable hint: frames where k did not advance ${stalledFrames}/${frames}; observed steps up ${stepsUp}, down ${stepsDown} (${half} dispatched each phase)`,
            `anchor drift ${drift().toFixed(4)} world units`,
        ],
    };
}

/**
 * Several wheel events inside ONE frame.
 *
 * This is the shape the old handler got wrong: it read `viewport` from props, so every event in a
 * batch computed from the same base and only the last one survived. The composed zoom must equal the
 * product of all of them.
 */
export function createZoomBurstScenario(nodeCount = 1000, frames = 20): Scenario {
    const eventsPerFrame = 5;
    const deltaPerEvent = -20; // 1.1^0.2 per event, so 1.1 per frame
    let anchor: { x: number; y: number; element: Element } | null = null;
    let baseK = 0;
    return {
        id: "zoom-burst",
        label: "wheel burst (5 events per frame)",
        nodeCount,
        frames,
        setup: () => {
            applyViewport(solveViewport(GENERAL_ZOOM_TARGET).viewport);
        },
        script: (frame) => {
            if (frame === 0) {
                anchor = zoomAnchor();
                baseK = readViewport().k;
            }
            if (!anchor) throw new PerfInvalidSampleError("zoom-not-started", "frame 0 did not establish an anchor");
            for (let index = 0; index < eventsPerFrame; index += 1) dispatchWheel(anchor.element, deltaPerEvent, anchor.x, anchor.y);
        },
        assert: () => {
            const expected = baseK * Math.pow(1.1, (-deltaPerEvent / 100) * eventsPerFrame * frames);
            const actual = readViewport().k;
            if (expected > 0 && Math.abs(actual - expected) / expected > 0.02) throw new PerfInvalidSampleError("zoom-burst-lost-deltas", `expected ~${expected.toFixed(4)}, got ${actual.toFixed(4)} — wheel events in one frame are overwriting each other`);
        },
        notes: () => [`k ${baseK.toFixed(4)} -> ${readViewport().k.toFixed(4)}`, `${eventsPerFrame} wheel events per frame`],
    };
}

// ---------------------------------------------------------------------------
// Zoom diagnostics: a causal experiment on the world-layer SVG
// ---------------------------------------------------------------------------

/**
 * The world layer — the one element in the canvas sized `10000x10000`, which the connections are
 * drawn into. Found by class rather than by a `data-` attribute so this diagnostic needs no change to
 * application source (which would have to be mirrored into every measured tree).
 */
function worldLayerSvg(): SVGSVGElement {
    const container = requireContainer();
    for (const candidate of container.querySelectorAll("svg")) {
        const classes = typeof candidate.className === "string" ? candidate.className : candidate.className.baseVal;
        if (classes.includes("10000px")) return candidate as SVGSVGElement;
    }
    throw new PerfInvalidSampleError("no-world-layer", "could not find the 10000x10000 SVG inside the canvas");
}

export type ZoomDiagnosticVariant = "baseline" | "no-translatez" | "small-box" | "both" | "svg-hidden" | "nt-no-strokes" | "nt-no-visual-strokes" | "nt-no-hit-strokes";

/** Sets an inline stroke-width on matching paths; returns an undo that clears it again. */
function setStrokeWidths(svg: SVGSVGElement, matches: (path: SVGPathElement) => boolean, width: string): () => void {
    const touched: SVGPathElement[] = [];
    for (const candidate of svg.querySelectorAll("path")) {
        const path = candidate as SVGPathElement;
        if (!matches(path)) continue;
        touched.push(path);
        // Inline style beats the presentation attribute, which is how the app sets these.
        path.style.strokeWidth = width;
    }
    return () => {
        for (const path of touched) path.style.strokeWidth = "";
    };
}

/**
 * Each variant changes exactly one thing about the world layer, then the zoom scenario is re-measured.
 *
 * The first three are chosen to leave the painted output **identical**: the element is
 * `overflow-visible`, so shrinking its own box to 1x1 changes nothing that is drawn — every path is
 * still painted at the same world coordinates. `svg-hidden` is the exception and is labelled as such:
 * it removes the edges entirely, so it does not isolate a cause, it only upper-bounds the whole
 * layer's contribution. Compare each variant's `paths` count against the baseline to confirm the
 * comparison was fair.
 *
 * The `nt-*` group decomposes what is left *after* `translateZ(0)` is removed — the largest remaining
 * share was ~62%, and the question is whether that is the visible strokes or the 16px transparent hit
 * paths. The hit paths are the more interesting answer, because they are pure implementation detail:
 * nothing about them is visible, so they could be made cheaper without any visual change.
 */
function applyZoomVariant(variant: ZoomDiagnosticVariant): () => void {
    const svg = worldLayerSvg();
    const undos: (() => void)[] = [];
    const original = { transform: svg.style.transform, width: svg.style.width, height: svg.style.height, display: svg.style.display };
    undos.push(() => {
        svg.style.transform = original.transform;
        svg.style.width = original.width;
        svg.style.height = original.height;
        svg.style.display = original.display;
    });

    const isHitPath = (path: SVGPathElement) => path.getAttribute("stroke") === "transparent";

    if (variant === "no-translatez" || variant === "both" || variant.startsWith("nt-")) svg.style.transform = "none";
    if (variant === "small-box" || variant === "both") {
        svg.style.width = "1px";
        svg.style.height = "1px";
    }
    if (variant === "svg-hidden") svg.style.display = "none";
    if (variant === "nt-no-strokes") undos.push(setStrokeWidths(svg, () => true, "0"));
    if (variant === "nt-no-visual-strokes") undos.push(setStrokeWidths(svg, (path) => !isHitPath(path), "0"));
    if (variant === "nt-no-hit-strokes") undos.push(setStrokeWidths(svg, isHitPath, "0"));

    return () => {
        for (const undo of undos) undo();
    };
}

/**
 * Frame count deliberately matches `createZoomScenario`'s default.
 *
 * An earlier version of this diagnostic used 40 frames to save time, and that silently changed the
 * regime being measured: the zoom only reached k≈0.52 instead of k≈2.91, and the frame time was 26ms
 * instead of 227ms. The cost of zooming is not a per-frame constant — it grows sharply with how far
 * the view is zoomed — so a variant has to be compared at the same excursion as the measurement it is
 * meant to explain. `zoom-diag:baseline` reproducing the measured `zoom-general` figure is the
 * check that this diagnostic is not perturbing anything.
 */
export function createZoomDiagnosticScenario(variant: ZoomDiagnosticVariant, nodeCount = 1000): Scenario {
    const base = createZoomScenario(nodeCount);
    return {
        ...base,
        id: `zoom-diag:${variant}`,
        label: `zoom diagnostic — ${variant}`,
        repeats: 1,
        mutateDom: () => applyZoomVariant(variant),
    };
}

/**
 * Run all variants and compare `p50` (and `paths`, to confirm the comparison was output-preserving).
 *
 * There is no `idle-baseline` in this set, so the jank threshold stays at its initial value and the
 * `jank` column is meaningless here — the p50 and p95 columns are what to read.
 *
 * `small-box` and `both` have been dropped: they were measured and showed no benefit, which is a
 * result (the fixed 10000x10000 box is not a cost), so re-running them only spends time. `baseline`
 * and `no-translatez` are kept as references — they must reproduce the earlier figures, which is the
 * check that this diagnostic is not perturbing the measurement.
 */
export const ZOOM_DIAGNOSTIC_SCENARIOS: Scenario[] = [
    createZoomDiagnosticScenario("baseline"),
    createZoomDiagnosticScenario("no-translatez"),
    createZoomDiagnosticScenario("nt-no-strokes"),
    createZoomDiagnosticScenario("nt-no-visual-strokes"),
    createZoomDiagnosticScenario("nt-no-hit-strokes"),
];

// ---------------------------------------------------------------------------
// Drag scenario
// ---------------------------------------------------------------------------

/**
 * Drags one image node.
 *
 * Mouse events only, never pointerdown: a pointerdown on a node also reaches AtelierCanvas and could
 * start a pan, which would make this measure the wrong gesture. The press targets the node's inner
 * body — the drag handler lives there, so dispatching at the `data-node-id` root would bubble upwards
 * and never reach it.
 */
export function createDragScenario(nodeCount = 1000, frames = 180): Scenario {
    const perFramePx = 3;
    let draggable: { nodeId: string; x: number; y: number; target: Element } | null = null;
    let before: Map<string, string> | null = null;
    let startPosition: { x: number; y: number } | null = null;
    let expectedDx = 0;
    let moved: string[] = [];
    return {
        id: "drag-single",
        label: "drag one image node",
        nodeCount,
        frames,
        setup: () => {
            applyViewport(solveViewport(GENERAL_ZOOM_TARGET).viewport);
        },
        script: (frame) => {
            if (frame === 0) {
                const found = findDraggableNodeTarget();
                draggable = found;
                before = positionSignatures();
                startPosition = nodePosition(found.nodeId);
                expectedDx = ((frames - 1) * perFramePx) / readViewport().k;
                dispatchMouse(found.target, "mousedown", found.x, found.y);
                return;
            }
            const active = draggable;
            if (!active) throw new PerfInvalidSampleError("drag-not-started", "frame 0 did not find a draggable node");
            const x = active.x + frame * perFramePx;
            dispatchMouse(window, "mousemove", x, active.y);
            if (frame === frames - 1) dispatchMouse(window, "mouseup", x, active.y, { buttons: 0 });
        },
        assert: () => {
            const active = draggable;
            const snapshot = before;
            const start = startPosition;
            if (!active || !snapshot || !start) throw new PerfInvalidSampleError("drag-assert-missing", "no drag context was captured");
            const after = nodePosition(active.nodeId);
            if (!after) throw new PerfInvalidSampleError("drag-node-vanished", active.nodeId);
            if (after.x === start.x && after.y === start.y) throw new PerfInvalidSampleError("drag-had-no-effect", `${active.nodeId} did not move`);
            moved = movedNodeIds(snapshot);
            // Dropping into a group legitimately re-positions the node, so the distance is reported
            // rather than asserted. What is asserted is that the intended node moved and no other did.
            if (!moved.includes(active.nodeId)) throw new PerfInvalidSampleError("drag-wrong-node", `moved [${moved.join(", ")}] but not ${active.nodeId}`);
            if (moved.length > 1) throw new PerfInvalidSampleError("drag-moved-extra-nodes", `also moved [${moved.filter((id) => id !== active.nodeId).join(", ")}]`);
        },
        notes: () => {
            const active = draggable;
            const start = startPosition;
            const after = active ? nodePosition(active.nodeId) : null;
            const actualDx = after && start ? after.x - start.x : 0;
            return [`drag dx: expected ${expectedDx.toFixed(1)}, actual ${actualDx.toFixed(1)} (group snapping may adjust)`, `nodes moved: ${moved.length}`];
        },
    };
}

// ---------------------------------------------------------------------------
// Resize scenario
// ---------------------------------------------------------------------------

/**
 * The bottom-right resize handle of the node the setup centred on, located in the DOM.
 *
 * The node is chosen from the graph data by `findIsolatedResizeNode`, so this only has to find the
 * element and confirm the press really reaches it — a cheap final check that the paint agrees with the
 * geometry. The handle carries no `data-` attribute and adding one would be an app-source change made
 * purely for the harness, so its cursor class is the identifier.
 */
function findResizeHandle(): { nodeId: string; x: number; y: number; element: Element } {
    const container = requireContainer();
    const mounted = [...container.querySelectorAll<HTMLElement>("[data-node-id]")];
    let sawHandle = false;
    for (const node of mounted) {
        const nodeId = node.dataset.nodeId;
        if (!nodeId) continue;
        const handle = node.querySelector(".cursor-nwse-resize");
        if (!handle) continue;
        sawHandle = true;
        const rect = handle.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        if (document.elementFromPoint(x, y) !== handle) continue;
        return { nodeId, x, y, element: handle };
    }
    throw new PerfInvalidSampleError(
        "no-resize-handle",
        sawHandle ? `handles are mounted but none is reachable among ${mounted.length} nodes` : `no resize handle is mounted among ${mounted.length} nodes`,
    );
}

/**
 * A normal-sized node whose bottom-right corner nothing else can cover.
 *
 * Picked from the graph data rather than by hit-testing, because the reason every earlier attempt failed
 * is geometric, not a threshold:
 *
 * - A node root carries `transform`, which creates a stacking context. The resize handle's `z-50` is
 *   therefore scoped *inside* its own node and cannot lift it above a sibling node — so any overlapping
 *   neighbour, painted later, covers the handle outright.
 * - The handle sits 14px outside the node's corner, so it is the easiest part to cover, and the
 *   fixture's extreme nodes (4000-8000 wide) reach across the whole viewport.
 *
 * So the only reliable way is to require that no other node's rectangle reaches into the corner region
 * at all. `handleMargin` covers the 14px overhang plus the 28px handle itself.
 */
function findIsolatedResizeNode(handleMargin = 24): CanvasNodeData {
    const nodes = canvasPerfBridgeState.nodes;
    const isNormal = (node: CanvasNodeData) => node.type !== CanvasNodeType.Group && node.width >= 120 && node.width <= 600 && node.height >= 80 && node.height <= 500;
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    for (const candidate of nodes) {
        if (!isNormal(candidate)) continue;
        // The corner region: the node's own box plus the handle overhang, and nothing else may enter it.
        const corner = {
            left: candidate.position.x - handleMargin,
            top: candidate.position.y - handleMargin,
            right: candidate.position.x + candidate.width + handleMargin,
            bottom: candidate.position.y + candidate.height + handleMargin,
        };
        const obstructed = nodes.some(
            (other) =>
                other.id !== candidate.id &&
                overlaps(corner, { left: other.position.x, top: other.position.y, right: other.position.x + other.width, bottom: other.position.y + other.height }),
        );
        if (!obstructed) return candidate;
    }
    throw new PerfInvalidSampleError("no-isolated-node", `no normally-sized node among ${nodes.length} had an unobstructed bottom-right corner`);
}

function nodeSize(nodeId: string): { width: number; height: number } | null {
    const node = canvasPerfBridgeState.nodes.find((candidate) => candidate.id === nodeId);
    return node ? { width: node.width, height: node.height } : null;
}

/**
 * Drags a node's bottom-right resize handle.
 *
 * Its own scenario rather than a drag variant because resize takes a different code path: the handle
 * stops propagation, so the capture handler still selects the node but no node-drag begins. It is
 * also the gesture that until now had neither rAF coalescing nor a history pause.
 */
export function createResizeScenario(nodeCount = 1000, frames = 60): Scenario {
    const perFramePx = 2;
    let handle: { nodeId: string; x: number; y: number; element: Element } | null = null;
    let before: { width: number; height: number } | null = null;
    let after: { width: number; height: number } | null = null;
    let expectedGrow = 0;
    return {
        id: "resize-single",
        label: "resize one node from its bottom-right handle",
        nodeCount,
        frames,
        setup: async () => {
            // Centre on an isolated normal-sized node at k=1.
            //
            // Not a dense view: this scenario needs exactly one usable handle, and the fixture's extreme
            // nodes (4000-8000 wide) blanket the viewport at k=1, covering everything's corners. Picking
            // from the graph data instead — a node nothing else reaches into the corner of — is the only
            // way that is not luck.
            const target = findIsolatedResizeNode();
            const size = canvasSize();
            applyViewport({ x: size.width / 2 - (target.position.x + target.width / 2), y: size.height / 2 - (target.position.y + target.height / 2), k: 1 });
            // Two frames so React commits and paints before the handle is hit-tested.
            await nextFrame();
            await nextFrame();
        },
        script: (frame) => {
            if (frame === 0) {
                const found = findResizeHandle();
                handle = found;
                before = nodeSize(found.nodeId);
                expectedGrow = ((frames - 1) * perFramePx) / readViewport().k;
                dispatchMouse(found.element, "mousedown", found.x, found.y);
                return;
            }
            const active = handle;
            if (!active) throw new PerfInvalidSampleError("resize-not-started", "frame 0 did not find a resize handle");
            const x = active.x + frame * perFramePx;
            const y = active.y + frame * perFramePx;
            dispatchMouse(window, "mousemove", x, y);
            if (frame === frames - 1) dispatchMouse(window, "mouseup", x, y, { buttons: 0 });
        },
        assert: () => {
            const active = handle;
            const start = before;
            if (!active || !start) throw new PerfInvalidSampleError("resize-assert-missing", "no resize context was captured");
            after = nodeSize(active.nodeId);
            if (!after) throw new PerfInvalidSampleError("resize-node-vanished", active.nodeId);
            if (after.width === start.width && after.height === start.height) {
                throw new PerfInvalidSampleError("resize-had-no-effect", `${active.nodeId} stayed ${start.width}x${start.height}`);
            }
            // Direction is deliberately not asserted. Aspect-locked nodes derive the other dimension
            // from whichever axis moved more, so an outward drag can legitimately change a node in a
            // way that is not monotonic in width — asserting "must grow" rejected three good rounds.
            // What matters for the measurement is that the gesture drove geometry at all.
        },
        notes: () => {
            const start = before;
            const end = after;
            if (!start || !end) return [];
            return [`size ${start.width}x${start.height} -> ${Math.round(end.width)}x${Math.round(end.height)} (dispatched +${expectedGrow.toFixed(0)} world units)`];
        },
    };
}

/**
 * The same gesture at 3000 total nodes, to answer one question the 1000-node scenarios cannot: whether
 * the per-frame O(N+E) rebuilds (graph index, visible nodes, connection culling) cost anything. At 1000
 * nodes pan and marquee already sit on the vsync ceiling, so a spatial index would have no headroom to
 * win; if 3000 is also flat, a spatial index is not worth building.
 *
 * Only the pan variant is kept. `drag-single-3000` was removed: at this density a single frame reached
 * **13.6s**, so the settle wait could not complete inside any sane deadline and the round was only ever
 * rejected as `idle-timeout`. It can be run on demand (`createDragScenario(3000)`) when the machine is
 * free of the other scenarios; shipping it in the default set just wastes minutes.
 */
export const SCALE_SCENARIOS: Scenario[] = [{ ...createPanScenario(3000), id: "pan-general-3000", label: "pan, 3000 total nodes", repeats: 1 }];

// ---------------------------------------------------------------------------
// Marquee scenario
// ---------------------------------------------------------------------------

/**
 * Marquee selection.
 *
 * Unlike pan this genuinely needs an empty pixel, because the app only starts a marquee on a
 * background click (`isBackgroundClick`), and at pan's density the viewport is fully covered. So the
 * setup steps the zoom down until a free pixel exists and reports the density it had to settle for,
 * rather than quietly changing what the gesture means.
 *
 * Also note the gesture is mixed: it starts on `pointerdown` but ends on `mouseup`.
 */
export function createMarqueeScenario(nodeCount = 1000, frames = 180): Scenario {
    const perFrameX = 6;
    const perFrameY = 3;
    let start: { x: number; y: number; element: Element } | null = null;
    let mountedAtStart = 0;
    let achievedTarget = 0;
    let usedFallback = false;
    return {
        id: "marquee",
        label: "marquee selection",
        nodeCount,
        frames,
        setup: async () => {
            for (const target of [GENERAL_ZOOM_TARGET, 120, 80, 50, 30, 15]) {
                applyViewport(solveViewport(target).viewport);
                // Two frames so React commits and paints before hit-testing; without this the
                // elementFromPoint below would still see the previous layout.
                await nextFrame();
                await nextFrame();
                try {
                    const point = findBackgroundPoint();
                    const element = document.elementFromPoint(point.x, point.y);
                    if (!element) continue;
                    start = { ...point, element };
                    mountedAtStart = mountedNodeCount();
                    achievedTarget = target;
                    return;
                } catch {
                    // No genuinely free pixel at this density; try a lower one.
                }
            }

            // Recorded fallback. This fixture covers the viewport at every density — nodes get fewer
            // but much larger as the zoom rises, so shrinking the mounted count does not open a gap.
            // Targeting the container reproduces exactly what the app does for a real background
            // click: its test is `target.closest("[data-node-id],[data-connection-id]")`, which the
            // container satisfies the same way an empty pixel would. The marquee still runs and is
            // still measured; what is lost is the claim that a user could have started it there.
            applyViewport(solveViewport(GENERAL_ZOOM_TARGET).viewport);
            await nextFrame();
            await nextFrame();
            const container = requireContainer();
            const rect = container.getBoundingClientRect();
            start = { x: rect.left + rect.width * 0.15, y: rect.top + rect.height * 0.15, element: container };
            mountedAtStart = mountedNodeCount();
            achievedTarget = GENERAL_ZOOM_TARGET;
            usedFallback = true;
        },
        script: (frame) => {
            if (!start) throw new PerfInvalidSampleError("marquee-not-started", "setup did not find a background point");
            if (frame === 0) {
                // ctrl flips the temporary tool to "select", which is what routes this to the marquee
                // branch instead of the pan branch.
                dispatchPointer(start.element, "pointerdown", start.x, start.y, { button: 0, buttons: 1, ctrlKey: true });
                return;
            }
            const x = start.x + frame * perFrameX;
            const y = start.y + frame * perFrameY;
            dispatchPointer(window, "pointermove", x, y, { buttons: 1 });
            if (frame === frames - 1) dispatchMouse(window, "mouseup", x, y, { buttons: 0 });
        },
        assert: () => {
            if (canvasPerfBridgeState.selectedNodeIds.size === 0) throw new PerfInvalidSampleError("marquee-selected-nothing", "the selection is still empty after the marquee");
        },
        notes: () => [
            `mounted at start ${mountedAtStart} (target ${achievedTarget})`,
            usedFallback ? "start press targeted the container: no density offered a genuinely free pixel" : "start press landed on a genuinely free pixel",
            `selected ${canvasPerfBridgeState.selectedNodeIds.size}`,
        ],
    };
}

// ---------------------------------------------------------------------------
// Overview scenarios
// ---------------------------------------------------------------------------

/**
 * Drag at the fit-all zoom, where every node in the fixture is mounted at once.
 *
 * 60 frames, not 180: at this density frames cost hundreds of milliseconds each, so a 180-frame script
 * cannot finish inside any sane budget and would only ever report a stall. 60 frames is ample to
 * characterise the frame time. If it still stalls, the stall message carries the frames completed and
 * the measured median.
 */
export function createOverviewPanScenario(nodeCount = 3000, frames = 40): Scenario {
    let origin: { x: number; y: number } | null = null;
    return {
        id: "overview-pan",
        label: "pan at fit-all zoom",
        nodeCount,
        frames,
        repeats: 1,
        setup: () => {
            applyViewport(fitViewport());
        },
        script: (frame) => {
            if (frame === 0) {
                const start = pointInsideContainer();
                origin = { x: start.x, y: start.y };
                dispatchPointer(start.element, "pointerdown", start.x, start.y, { button: 1, buttons: 4 });
                return;
            }
            if (!origin) throw new PerfInvalidSampleError("pan-not-started", "frame 0 did not establish a drag origin");
            const x = origin.x + frame * 2;
            dispatchPointer(window, "pointermove", x, origin.y, { buttons: 4 });
            if (frame === frames - 1) dispatchPointer(window, "pointerup", x, origin.y, { button: 1, buttons: 0 });
        },
        assert: ({ viewportBefore }) => {
            const viewport = readViewport();
            if (viewport.x === viewportBefore.x && viewport.y === viewportBefore.y) throw new PerfInvalidSampleError("pan-had-no-effect", "viewport did not move");
            if (mountedNodeCount() === 0) throw new PerfInvalidSampleError("overview-mounted-nothing", "nothing is mounted at the fit-all zoom");
        },
        notes: () => [`mounted ${mountedNodeCount()}`, `k ${readViewport().k.toFixed(4)}`],
    };
}

/** Zooms out towards the 0.05 floor. Frames that no-op against the floor are counted, not averaged. */
export function createOverviewZoomScenario(nodeCount = 3000, frames = 40): Scenario {
    const deltaPerFrame = 18;
    let anchor: { x: number; y: number; element: Element } | null = null;
    let startK = 0;
    let previousK: number | null = null;
    let clampedFrames = 0;
    return {
        id: "overview-zoom",
        label: "zoom out towards the floor, all nodes mounted",
        nodeCount,
        frames,
        repeats: 1,
        setup: () => {
            applyViewport(centredViewport(0.12));
        },
        script: (frame) => {
            if (frame === 0) {
                anchor = zoomAnchor();
                startK = readViewport().k;
                previousK = startK;
                clampedFrames = 0;
            }
            if (!anchor) throw new PerfInvalidSampleError("zoom-not-started", "frame 0 did not establish an anchor");
            const kAtStart = readViewport().k;
            if (previousK !== null && Math.abs(kAtStart - previousK) < 1e-9) clampedFrames += 1;
            previousK = kAtStart;
            dispatchWheel(anchor.element, deltaPerFrame, anchor.x, anchor.y);
        },
        assert: () => {
            const after = readViewport().k;
            if (!(after < startK * 0.9)) throw new PerfInvalidSampleError("overview-zoom-had-no-effect", `k stayed at ${after.toFixed(4)} from ${startK.toFixed(4)}`);
            if (clampedFrames > frames / 2) throw new PerfInvalidSampleError("overview-zoom-mostly-clamped", `${clampedFrames}/${frames} frames hit the floor`);
        },
        notes: () => [`k ${startK.toFixed(4)} -> ${readViewport().k.toFixed(4)}`, `clamped frames ${clampedFrames}/${frames}`, `mounted ${mountedNodeCount()}`],
    };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * The core set: one silent scenario to fix the jank threshold, then one per interaction the plan calls
 * out — zoom, pan, drag, marquee, and pan with every node mounted. `zoom-burst` is here because it
 * directly exercises the wheel-composition fix; a single event per frame would not distinguish it.
 */
/**
 * Every scenario the harness can run, including the two fit-all-zoom ones.
 */
export const ALL_SCENARIOS: Scenario[] = [
    createIdleBaselineScenario(),
    createZoomScenario(),
    createZoomBurstScenario(),
    createOverviewZoomScenario(),
    createPanScenario(),
    createDragScenario(),
    createMarqueeScenario(),
    createOverviewPanScenario(),
];

/**
 * The set used for the A/B baseline runs.
 *
 * The two `overview-*` scenarios are deliberately excluded. They measure a different problem — at
 * ~2s a frame with every node mounted, A and B are both so far past usable that no change P0 made
 * could show up as a difference, while together they consumed roughly a third of a session's
 * runtime. Including them would dilute the comparison with two rows that cannot answer it. Their
 * implementations are kept intact in `ALL_SCENARIOS` and in §3 of CANVAS_BASELINE.md.
 */
export const BASELINE_SCENARIOS: Scenario[] = [
    createIdleBaselineScenario(),
    createZoomScenario(),
    createZoomBurstScenario(),
    createPanScenario(),
    createDragScenario(),
    createResizeScenario(),
    createMarqueeScenario(),
    ...SCALE_SCENARIOS,
];

/**
 * 200-total-element acceptance workload. Each round opens the minimap after the normal project
 * reset, so it measures the bitmap implementation under pan/zoom/drag/resize rather than silently
 * benchmarking with the minimap closed (the app's default). The same mixed-media graph fixture,
 * repeat/warm-up rules and invalid-sample checks as the baseline are reused.
 */
function with200NodeMinimap(scenario: Scenario): Scenario {
    const originalSetup = scenario.setup;
    const originalAssert = scenario.assert;
    return {
        ...scenario,
        id: `${scenario.id}-200-minimap`,
        label: `${scenario.label} (200 total nodes, minimap open)`,
        setup: async () => {
            const button = document.querySelector<HTMLButtonElement>("[data-canvas-minimap-toggle]");
            if (!button) throw new PerfInvalidSampleError("minimap-toggle-missing", "no minimap toggle in current canvas");
            button.click();
            await originalSetup?.();
        },
        assert: (context) => {
            if (!document.querySelector("canvas[data-canvas-minimap-bitmap]")) {
                throw new PerfInvalidSampleError("minimap-missing", "the minimap did not render during the scenario");
            }
            originalAssert?.(context);
        },
    };
}

export const CANVAS_200_SCENARIOS: Scenario[] = [
    createIdleBaselineScenario(200),
    createPanScenario(200),
    createZoomScenario(200),
    createZoomBurstScenario(200),
    createDragScenario(200),
    createResizeScenario(200),
    createMarqueeScenario(200),
].map(with200NodeMinimap);

/**
 * Repeatable 200-node LOD tail-frame measurement.
 *
 * The input is finished by frame 20, but the sample deliberately continues
 * for 190 more rAFs: it includes the wheel-idle debounce, gesture quiet period,
 * staged full-node hydration and the final paint. The old 20-frame zoom-burst
 * scenario stops too early to see this work.
 */
export function createDenseZoomRecoveryScenario(nodeCount = 200, frames = 210): Scenario {
    const burstFrames = 10;
    let anchor: ReturnType<typeof zoomAnchor> | null = null;
    let baseScale = 1;
    let minFull = Number.POSITIVE_INFINITY;
    let maxFull = 0;
    let settledAt: number | null = null;
    return {
        id: "dense-zoom-recovery",
        label: "200 dense nodes: wheel out/back + post-gesture hydration",
        nodeCount,
        fixtureLayout: "clustered",
        frames,
        repeats: 3,
        setup: () => applyViewport({ x: 0, y: 0, k: 1 }),
        script: (frame) => {
            if (frame === 0) {
                anchor = zoomAnchor();
                baseScale = readViewport().k;
                minFull = Number.POSITIVE_INFINITY;
                maxFull = 0;
                settledAt = null;
            }
            if (!anchor) throw new PerfInvalidSampleError("no-zoom-anchor", "missing zoom anchor");
            if (frame < burstFrames * 2) {
                const delta = frame < burstFrames ? 145 : -145;
                dispatchWheel(anchor.element, delta, anchor.x, anchor.y);
                return;
            }
            const full = requireContainer().querySelectorAll("[data-canvas-full-node]").length;
            minFull = Math.min(minFull, full);
            maxFull = Math.max(maxFull, full);
            if (settledAt === null && full >= 80 && !requireContainer().querySelector("[data-canvas-lod-recovering]")) {
                settledAt = frame;
            }
        },
        assert: () => {
            const current = readViewport().k;
            if (Math.abs(current - baseScale) / baseScale > 0.04) {
                throw new PerfInvalidSampleError("zoom-not-restored", `scale ${baseScale.toFixed(3)} -> ${current.toFixed(3)} after wheel roundtrip`);
            }
            if (settledAt === null || requireContainer().querySelector("[data-canvas-lod-recovering]")) {
                throw new PerfInvalidSampleError("lod-not-settled", `LOD still recovering after ${frames} sampled frames`);
            }
        },
        notes: () => [
            `full-node range during recovery ${Number.isFinite(minFull) ? minFull : 0}..${maxFull}`,
            `LOD settled at scripted frame ${settledAt ?? "unsettled"}/${frames}, after wheel input ended at frame ${burstFrames * 2}`,
        ],
    };
}

/** Separate from the existing spread-layout 200-node/minimap regression set. */
export const CANVAS_200_DENSE_RECOVERY_SCENARIOS: Scenario[] = [
    // A matching dense idle baseline is necessary: otherwise the jank threshold
    // defaults to zero and incorrectly marks every ordinary 16.7ms frame as jank.
    { ...createIdleBaselineScenario(200), fixtureLayout: "clustered", label: "dense idle baseline" },
    createDenseZoomRecoveryScenario(),
];

/** Measured rounds per scenario unless the scenario overrides it. */
export const DEFAULT_REPEATS = 3;

export type MetricSpread = { median: number; min: number; max: number };

export type ScenarioSummary = {
    scenarioId: string;
    nodeCount: number;
    /** Measured rounds that passed. Zero means every round was rejected. */
    rounds: number;
    fps: MetricSpread;
    p50: MetricSpread;
    p95: MetricSpread;
    p99: MetricSpread;
    maxFrame: MetricSpread;
    jank: MetricSpread;
    longTasks: MetricSpread;
    /**
     * Total and worst long-task duration. Printed alongside the count because the count alone can be
     * self-contradictory: 179 tasks of >50ms cannot fit in a 5.5s window whose p50 frame is 28.6ms.
     * Either the count is wrong or the durations are far below the long-task threshold; only these
     * two make that distinguishable.
     */
    longTaskMs: MetricSpread;
    longTaskMaxMs: MetricSpread;
    mounted: MetricSpread;
    notes: string[];
};

function spread(values: readonly number[]): MetricSpread {
    return { median: medianOf(values), min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0 };
}

function summariseScenario(scenario: Scenario, rounds: readonly RoundResult[]): ScenarioSummary {
    const notes = rounds.flatMap((round) => round.notes).filter((note, position, all) => all.indexOf(note) === position);
    return {
        scenarioId: scenario.id,
        nodeCount: scenario.nodeCount,
        rounds: rounds.length,
        fps: spread(rounds.map((round) => round.frames.fps)),
        p50: spread(rounds.map((round) => round.frames.p50)),
        p95: spread(rounds.map((round) => round.frames.p95)),
        p99: spread(rounds.map((round) => round.frames.p99)),
        maxFrame: spread(rounds.map((round) => round.frames.max)),
        jank: spread(rounds.map((round) => round.frames.jank)),
        longTasks: spread(rounds.map((round) => round.longTasks.count)),
        longTaskMs: spread(rounds.map((round) => round.longTasks.totalMs)),
        longTaskMaxMs: spread(rounds.map((round) => round.longTasks.maxMs)),
        mounted: spread(rounds.map((round) => round.mountedNodes.median)),
        notes,
    };
}

export type InvalidSample = { scenarioId: string; round: string; reason: string; detail?: string };

export type SessionReport = {
    env: PerfEnv;
    /** Per-round detail, kept so the spread can be checked rather than trusted. */
    results: RoundResult[];
    summaries: ScenarioSummary[];
    invalid: InvalidSample[];
};

export type SessionProgress = { scenarioId: string; round: string; index: number; total: number; ok: boolean; reason?: string };

export type SessionCallbacks = {
    /** Fired when a round finishes. */
    onRound?: (progress: SessionProgress) => void;
    /**
     * Fired while a round is in flight. A round takes long enough (remount + settle + 180 frames)
     * that silence is indistinguishable from a hang, so the panel gets a live phase instead.
     */
    onPhase?: (phase: string) => void;
};

/**
 * Warm-up plus `repeats` measured rounds per scenario, then the next scenario.
 *
 * Every interaction scenario is run once and discarded first: the first touch of a graph pays JIT,
 * first-paint of newly mounted nodes and cold caches, none of which the comparison is about. The
 * idle baseline runs first and fixes the jank threshold from the median of its own rounds, before any
 * interactive scenario is judged.
 */
export async function runSession(scenarios: Scenario[] = BASELINE_SCENARIOS, callbacks: SessionCallbacks = {}): Promise<SessionReport> {
    const results: RoundResult[] = [];
    const summaries: ScenarioSummary[] = [];
    const invalid: InvalidSample[] = [];
    let jankThresholdMs = 1;
    let idleFrameMs: number | null = null;

    for (const [index, scenario] of scenarios.entries()) {
        const repeats = Math.max(1, scenario.repeats ?? DEFAULT_REPEATS);

        // Discarded. Failures here are not recorded: a warm-up that cannot even start is reported by
        // the measured rounds that follow it.
        callbacks.onPhase?.(`${scenario.id}: warm-up (discarded)`);
        await runRound(scenario, jankThresholdMs, callbacks.onPhase);

        const rounds: RoundResult[] = [];
        for (let attempt = 0; attempt < repeats; attempt += 1) {
            const label = `${attempt + 1}/${repeats}`;
            const outcome = await runRound(scenario, jankThresholdMs, callbacks.onPhase);
            if (outcome.ok) {
                outcome.result.round = label;
                rounds.push(outcome.result);
            } else invalid.push({ scenarioId: scenario.id, round: label, reason: outcome.reason, detail: outcome.detail });
            // One update per round, never per frame — the panel must not perturb what it measures.
            callbacks.onRound?.({ scenarioId: scenario.id, round: label, index, total: scenarios.length, ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
        }

        if (scenario.measuresIdleBaseline && rounds.length) {
            idleFrameMs = medianOf(rounds.map((round) => round.frames.p50));
            jankThresholdMs = Math.max(idleFrameMs * 1.5, 1);
            // These rounds ran before the threshold existed (against 1, which counted nearly every
            // frame). Now that it is known, re-judge them so their jank numbers mean something.
            for (const round of rounds) round.frames = summariseFrames(round.deltasMs, round.frames.durationMs, jankThresholdMs);
        }

        results.push(...rounds);
        summaries.push(summariseScenario(scenario, rounds));
    }

    return { env: snapshotEnvironment(idleFrameMs), results, summaries, invalid };
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type PerfSessionState = {
    status: "idle" | "running" | "done" | "error";
    phase: string;
    progress: string;
    report: SessionReport | null;
    error: string | null;
};

/**
 * Module-level, not panel state, and that is load-bearing.
 *
 * The reset protocol navigates to the project list and back, which unmounts the whole canvas page —
 * taking the panel with it. Anything the panel owns is destroyed mid-run (and its setState calls are
 * silently dropped), so progress and the finished report have to outlive the component. A module
 * singleton survives route changes within the same page load, and the panel just reads it.
 */
let sessionState: PerfSessionState = { status: "idle", phase: "", progress: "", report: null, error: null };
const sessionListeners = new Set<() => void>();

function setSessionState(patch: Partial<PerfSessionState>): void {
    sessionState = { ...sessionState, ...patch };
    for (const listener of sessionListeners) listener();
}

export function getPerfSessionState(): PerfSessionState {
    return sessionState;
}

export function subscribePerfSession(listener: () => void): () => void {
    sessionListeners.add(listener);
    return () => {
        sessionListeners.delete(listener);
    };
}

/**
 * Starts a session. Lives here rather than in the panel so that a remount mid-run neither restarts
 * nor loses it; the guard also makes a double click harmless.
 */
export async function startPerfSession(scenarios: Scenario[] = BASELINE_SCENARIOS): Promise<void> {
    if (sessionState.status === "running") return;
    setSessionState({ status: "running", phase: "starting", progress: "", report: null, error: null });
    try {
        const report = await runSession(scenarios, {
            onPhase: (phase) => setSessionState({ phase }),
            onRound: ({ scenarioId, round, index, total, ok }) => setSessionState({ phase: "", progress: `${index + 1}/${total} ${scenarioId} · round ${round}${ok ? "" : " (rejected)"}` }),
        });
        setSessionState({ status: "done", report, phase: "", progress: "" });
    } catch (thrown) {
        setSessionState({ status: "error", error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown), phase: "", progress: "" });
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const DEFAULT_NODE_COUNT = 1000;

/**
 * Entry point from `main.tsx`. Installs the shim, waits for the store's real hydrate, injects the
 * fixture project and navigates to it — in that order, because the canvas page redirects away when
 * the route id does not resolve, and because the route id has to resolve before it mounts.
 */
export async function bootstrapCanvasPerf(nodeCount = DEFAULT_NODE_COUNT, mediaMode: "static" | "decoded" = "static", layout: "spread" | "clustered" = "spread"): Promise<void> {
    if (!PERF_MODE) return;
    installPointerCaptureShim();
    perfFixtureMediaMode = mediaMode;
    await waitForHydration();
    const id = provisionPerfProject(nodeCount, PERF_SEED, mediaMode, layout);
    await router.navigate(`/canvas/${id}`);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fixed(value: number, digits = 1): string {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

export function formatBaselineReport(report: SessionReport): string {
    const lines: string[] = [];
    lines.push(`# Canvas perf session${report.env.sessionLabel ? ` — ${report.env.sessionLabel}` : ""}`);
    lines.push("");
    if (!report.env.sessionLabel) lines.push(`> **No session label was set.** Per-session results cannot be attributed or interleaved without one; fill the field in the panel before running.`);
    lines.push(`- harness: v${report.env.harnessVersion}, seed ${PERF_SEED}`);
    lines.push(`- UA: ${report.env.userAgent}`);
    lines.push(`- window: ${report.env.viewportWidth}x${report.env.viewportHeight} @${report.env.devicePixelRatio}x, canvas ${report.env.canvasRect ? `${report.env.canvasRect.width}x${report.env.canvasRect.height}` : "n/a"}`);
    lines.push(`- cores: ${report.env.hardwareConcurrency}; idle frame: ${report.env.idleFrameMs === null ? "n/a" : `${fixed(report.env.idleFrameMs, 2)} ms`}`);
    lines.push("");
    lines.push(`## Per-scenario summary`);
    lines.push("");
    lines.push(`Median across the measured rounds, with the observed range in brackets — read the range before believing a difference.`);
    lines.push("");
    lines.push(`| scenario | total | rounds | mounted (med) | fps (med) | p50 med [range] | p95 med [range] | jank (med) | longtasks (med) | longtask ms (med) |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const summary of report.summaries) {
        const range = (metric: MetricSpread, digits = 2) => `${fixed(metric.median, digits)} [${fixed(metric.min, digits)}–${fixed(metric.max, digits)}]`;
        lines.push(
            `| ${summary.scenarioId} | ${summary.nodeCount} | ${summary.rounds} | ${fixed(summary.mounted.median, 0)} | ${fixed(summary.fps.median)} | ${range(summary.p50)} | ${range(summary.p95)} | ${fixed(summary.jank.median, 0)} | ${fixed(summary.longTasks.median, 0)} | ${fixed(summary.longTaskMs.median, 1)} |`,
        );
    }
    lines.push("");
    lines.push(`## Per-round detail`);
    lines.push("");
    lines.push(`| scenario | round | node | mounted min/med/max | edges | paths | dom | media | fps | p50 | p95 | p99 | max | jank | longtasks | longtask total ms | longtask max ms | persist writes | stringify max ms |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const result of report.results) {
        const m = result.mountedNodes;
        lines.push(
            `| ${result.scenarioId} | ${result.round} | ${result.nodeCount} | ${m.min}/${fixed(m.median, 0)}/${m.max} | ${result.counts.mountedEdges} | ${result.counts.svgPaths} | ${result.counts.domNodes} | ${result.counts.mediaElements} | ${fixed(result.frames.fps)} | ${fixed(result.frames.p50, 2)} | ${fixed(result.frames.p95, 2)} | ${fixed(result.frames.p99, 2)} | ${fixed(result.frames.max, 2)} | ${result.frames.jank} | ${result.longTasks.count} | ${fixed(result.longTasks.totalMs, 1)} | ${fixed(result.longTasks.maxMs, 1)} | ${result.persist.writes} | ${fixed(result.persist.maxStringifyMs, 2)} |`,
        );
    }
    if (report.invalid.length) {
        lines.push("");
        lines.push(`## Rejected samples (excluded from every figure above)`);
        for (const item of report.invalid) lines.push(`- ${item.scenarioId} round ${item.round}: ${item.reason}${item.detail ? ` — ${item.detail}` : ""}`);
    }
    const withNotes = report.summaries.filter((summary) => summary.notes.length);
    if (withNotes.length) {
        lines.push("");
        lines.push(`## Scenario notes`);
        for (const summary of withNotes) lines.push(`- **${summary.scenarioId}**: ${summary.notes.join("; ")}`);
    }

    // Answers "what made the frames slow", which the frame timings alone cannot. See CANVAS_BASELINE.md
    // §9.3 for the question this was added to settle.
    const measured = report.results.filter((result) => result.frames.frames > 0);
    if (measured.length) {
        lines.push("");
        lines.push(`## Main-thread attribution`);
        lines.push("");
        lines.push(`Totals across the whole round, not per frame. \`frame total\` is the sampled window's own duration, so the columns should be read against it.`);
        lines.push("");
        lines.push(`| scenario | round | frame total ms | frames | busy ms (share) | renders | render ms | graphIndex ms | visibleNodes ms (count) | visibleConnections ms (count) | sidePanel ms (count) | longtask ms | write ms | in-pipeline % |`);
        lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
        for (const result of measured) {
            const p = result.pipeline;
            const pipelineMs = p.renderMs + p.graphIndexMs + p.visibleNodesMs + p.visibleConnectionsMs + p.sidePanelMs;
            const share = result.frames.durationMs > 0 ? `${((pipelineMs / result.frames.durationMs) * 100).toFixed(1)}%` : "n/a";
            const busyShare = result.frames.durationMs > 0 ? `${((result.frameBusyMs / result.frames.durationMs) * 100).toFixed(1)}%` : "n/a";
            lines.push(
                `| ${result.scenarioId} | ${result.round} | ${fixed(result.frames.durationMs, 0)} | ${result.frames.frames} | ${fixed(result.frameBusyMs, 0)} (${busyShare}) | ${p.renders} | ${fixed(p.renderMs, 1)} | ${fixed(p.graphIndexMs, 1)} | ${fixed(p.visibleNodesMs, 2)} (${p.visibleNodesCount}) | ${fixed(p.visibleConnectionsMs, 2)} (${p.visibleConnectionsCount}) | ${fixed(p.sidePanelMs, 2)} (${p.sidePanelCount}) | ${fixed(result.longTasks.totalMs, 0)} | ${fixed(result.persist.totalWriteMs, 0)} | ${share} |`,
            );
        }
        lines.push("");
        lines.push(`\`busy ms\` is the main thread's own time inside the sampled frame callbacks (which includes dispatching the input and the app's synchronous response). Compare it with \`frame total\`: if it is a small share, the thread was idle while the browser produced frames slowly, and no application-code change can fix that.`);
        lines.push(`\`render ms\` is React render+commit measured from the perf bridge's own render body to its layout effect, so anything rendered before it is excluded — an approximation, not an exact figure.`);
        lines.push(`\`longtask ms\` and \`write ms\` are main-thread/task costs that sit outside the pipeline columns above.`);
        lines.push(`If every column here is small against \`frame total\`, the cost is not in JavaScript at all.`);
    }
    lines.push("");
    lines.push(`Measured with scripted synthetic events. Not real user input: no OS-level event coalescing, no trackpad momentum, no real pointer capture. Absolute numbers are comparable only within this harness, and one session is not a result — the plan requires at least three interleaved sessions per build.`);
    return lines.join("\n");
}

export async function copyBaselineReport(markdown: string): Promise<void> {
    await navigator.clipboard.writeText(markdown);
}

export function downloadBaselineReport(markdown: string, filename = "canvas-perf-session.md"): void {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

