import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { canvasPerfBridgeState } from "@/lib/canvas/canvas-perf-bridge-state";

import {
    BASELINE_SCENARIOS,
    CANVAS_200_SCENARIOS,
    CANVAS_200_DENSE_RECOVERY_SCENARIOS,
    ZOOM_DIAGNOSTIC_SCENARIOS,
    copyBaselineReport,
    downloadBaselineReport,
    formatBaselineReport,
    getPerfSessionLabel,
    getPerfSessionState,
    isCanvasPerfEnabled,
    setPerfSessionLabel,
    startPerfSession,
    subscribePerfSession,
    type Scenario,
} from "@/lib/canvas/canvas-perf-harness";

/**
 * Perf-mode control panel. Only ever mounted through the bridge's dynamic import inside a
 * compile-time-false branch, so it is absent from normal builds.
 *
 * It owns no session state: the reset protocol remounts the whole canvas page every round, which
 * would destroy anything held here. It reads the harness's module singleton through
 * `useSyncExternalStore` instead, so a remount mid-run neither loses nor restarts the session.
 *
 * It re-renders once per phase and once per round — never during sampling. A panel that re-rendered
 * every frame would be measuring itself. It is also `position: fixed` outside the canvas subtree, so
 * it neither takes part in the canvas layout nor sits inside the container the scripts hit-test.
 */
export default function CanvasPerfPanel() {
    const [scenarios] = useState<Scenario[]>(BASELINE_SCENARIOS);
    const [canvas200] = useState<Scenario[]>(CANVAS_200_SCENARIOS);
    const [denseRecovery] = useState<Scenario[]>(CANVAS_200_DENSE_RECOVERY_SCENARIOS);
    const [diagnostics] = useState<Scenario[]>(ZOOM_DIAGNOSTIC_SCENARIOS);
    const [sessionLabel, setSessionLabel] = useState(() => getPerfSessionLabel());
    // Shown before running so the environment can be checked against the baseline rather than only
    // discovered afterwards. Every measurement is scoped to a specific canvas size and side-panel
    // state; a session that differs is not comparable and should be abandoned rather than recorded.
    const [canvasSize, setCanvasSize] = useState<string>("(measuring)");
    const session = useSyncExternalStore(subscribePerfSession, getPerfSessionState);
    const run = useCallback((set: Scenario[]) => void startPerfSession(set), []);

    useEffect(() => {
        const measure = () => {
            const rect = canvasPerfBridgeState.container?.getBoundingClientRect();
            setCanvasSize(rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "(no canvas)");
        };
        measure();
        const timer = window.setInterval(measure, 500);
        return () => window.clearInterval(timer);
    }, []);

    const running = session.status === "running";
    const markdown = session.report ? formatBaselineReport(session.report) : "";

    if (!isCanvasPerfEnabled()) return null;

    return (
        <div className="fixed bottom-4 right-4 z-[999] max-h-[70vh] w-[26rem] overflow-auto rounded-lg border border-stone-300 bg-white/95 p-3 text-xs shadow-xl backdrop-blur dark:border-stone-600 dark:bg-stone-900/95 dark:text-stone-100">
            <div className="mb-2 flex items-center justify-between gap-2">
                <strong className="text-sm">Canvas perf harness</strong>
                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">PERF BUILD</span>
            </div>
            <div className="mb-2 flex items-center gap-2">
                <label className="shrink-0 opacity-70" htmlFor="perf-session-label">
                    Session
                </label>
                <input
                    id="perf-session-label"
                    value={sessionLabel}
                    disabled={running}
                    onChange={(event) => {
                        setSessionLabel(event.target.value);
                        setPerfSessionLabel(event.target.value);
                    }}
                    placeholder="e.g. A-1 (build / session number)"
                    className="min-w-0 flex-1 rounded border border-stone-300 bg-transparent px-1.5 py-1 dark:border-stone-600"
                />
            </div>
            <p className="mb-2 opacity-70">
                canvas <strong>{canvasSize}</strong> · baseline is 1631x914 — leave the side panel untouched
            </p>
            <p className="mb-2 opacity-70">
                baseline {scenarios.length}: {scenarios.map((scenario) => `${scenario.id}×${scenario.repeats ?? 3}`).join(", ")} (+1 warm-up each, discarded)
            </p>
            <div className="mb-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => run(scenarios)} disabled={running} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    {running ? "running…" : "Run session"}
                </button>
                <button type="button" onClick={() => run(canvas200)} disabled={running} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    Run 200 + minimap
                </button>
                <button type="button" onClick={() => run(denseRecovery)} disabled={running} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    Run dense LOD recovery
                </button>
                <button type="button" onClick={() => run(diagnostics)} disabled={running} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    Run zoom diagnostics
                </button>
                <button type="button" disabled={!markdown} onClick={() => void copyBaselineReport(markdown)} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    Copy markdown
                </button>
                <button type="button" disabled={!markdown} onClick={() => downloadBaselineReport(markdown)} className="rounded border px-2 py-1 font-medium disabled:opacity-50">
                    Download
                </button>
            </div>
            {session.phase ? <p className="mb-1 font-mono text-[11px] opacity-80">▸ {session.phase}</p> : null}
            {session.progress ? <p className="mb-2 opacity-70">{session.progress}</p> : null}
            {session.error ? <p className="mb-2 rounded bg-red-100 p-2 text-red-900 dark:bg-red-950 dark:text-red-200">{session.error}</p> : null}
            {session.status === "done" && !session.report?.results.length && !session.report?.invalid.length ? <p className="mb-2 opacity-70">Session finished with no samples.</p> : null}
            {session.report ? (
                <>
                    {session.report.invalid.length ? (
                        <div className="mb-2 rounded bg-amber-100 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            <strong>{session.report.invalid.length} rejected</strong>
                            <ul className="mt-1 list-disc pl-4">
                                {session.report.invalid.map((item) => (
                                    <li key={`${item.scenarioId}-${item.reason}`}>
                                        {item.scenarioId}: {item.reason}
                                        {item.detail ? ` — ${item.detail}` : ""}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-stone-100 p-2 text-[11px] leading-snug dark:bg-stone-800">{markdown}</pre>
                </>
            ) : null}
        </div>
    );
}
