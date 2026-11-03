import { useCanvasComfyExecution } from "@/features/comfy-workflow/canvas-execution-visual";
import { isComfyRunActive } from "@/features/comfy-workflow/run-status";
import { useCanvasTextExecution } from "@/features/backend-sync/canvas-text-execution-visual";
import { COMFY_WORKFLOW_MOCK_TYPE } from "@/lib/canvas/canvas-ports";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Subscriptions stay in this small decoration; phase updates never rerender node content. */
export function CanvasExecutionHalo({ node, visible = true }: { node: CanvasNodeData; visible?: boolean }) {
    if (node.type === CanvasNodeType.Group || !visible) return null;
    const loading = node.metadata?.status === "loading"
        || node.metadata?.images?.some(image => image.status === "loading");
    if (loading) return <Halo />;
    if (node.type === COMFY_WORKFLOW_MOCK_TYPE) return <ComfyHalo nodeId={node.id} />;
    if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Config) return <TextHalo nodeId={node.id} />;
    return null;
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
