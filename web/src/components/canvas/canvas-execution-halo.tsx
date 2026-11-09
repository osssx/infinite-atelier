import { useCanvasComfyExecution } from "@/features/comfy-workflow/canvas-execution-visual";
import { isComfyRunActive } from "@/features/comfy-workflow/run-status";
import { useCanvasTextExecution } from "@/features/backend-sync/canvas-text-execution-visual";
import { COMFY_WORKFLOW_MOCK_TYPE } from "@/lib/canvas/canvas-ports";
import { PERF_MODE } from "@/lib/perf-mode";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Subscriptions stay in this small decoration; phase updates never rerender node content. */
export function CanvasExecutionHalo({ node, visible = true }: { node: CanvasNodeData; visible?: boolean }) {
    if (node.type === CanvasNodeType.Group || !visible) return null;
    if (PERF_MODE && node.metadata?.perfSimulatedProgress) return <PerfProgressBadge nodeId={node.id} />;
    const loading = node.metadata?.status === "loading"
        || node.metadata?.images?.some(image => image.status === "loading");
    if (loading) return <Halo />;
    if (node.type === COMFY_WORKFLOW_MOCK_TYPE) return <ComfyHalo nodeId={node.id} />;
    if ([CanvasNodeType.Text, CanvasNodeType.Config, CanvasNodeType.Image,
        CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType))
        return <TextHalo nodeId={node.id} />;
    return null;
}

function PerfProgressBadge({ nodeId }: { nodeId: string }) {
    const execution = useCanvasComfyExecution(nodeId);
    if (!execution || !isComfyRunActive(execution.status)) return null;
    const percent = Math.max(0, Math.min(100, Math.round((execution.progress?.value ?? 0) * 100)));
    return <div data-canvas-perf-progress={percent} aria-hidden="true" className="pointer-events-none absolute bottom-2 left-3 right-3 z-20 h-1.5 overflow-hidden rounded-full bg-black/40">
        <div className="h-full rounded-full bg-cyan-400" style={{ width: `${percent}%` }} />
    </div>;
}

function ComfyHalo({ nodeId }: { nodeId: string }) {
    const execution = useCanvasComfyExecution(nodeId);
    return isComfyRunActive(execution?.status) ? <Halo /> : null;
}

function TextHalo({ nodeId }: { nodeId: string }) {
    const execution = useCanvasTextExecution(nodeId);
    return execution ? <Halo /> : null;
}

function Halo() {
    return <div aria-hidden="true" data-canvas-execution-halo className="canvas-execution-halo" />;
}
