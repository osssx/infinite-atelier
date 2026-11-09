import { CanvasNodeType } from "@/types/canvas";
import type { SharedNodeProps } from "./canvas-node-layer";

/** Keep stateful render callbacks off memoized nodes that cannot use them. */
export function selectNodeRenderCallbacks(
    shared: Pick<SharedNodeProps, "renderPanel" | "renderNodeContent">,
    nodeType: CanvasNodeType | string,
    showPanel: boolean,
): Pick<SharedNodeProps, "renderPanel" | "renderNodeContent"> {
    return {
        renderPanel: showPanel ? shared.renderPanel : undefined,
        renderNodeContent: nodeType === CanvasNodeType.Config ? shared.renderNodeContent : undefined,
    };
}
