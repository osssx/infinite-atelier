import { Button } from "antd";
import { LoaderCircle, Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCanvasTextExecution } from "@/features/backend-sync/canvas-text-execution-visual";

/** Keep execution subscriptions here so phase changes do not rerender model controls. */
export function CanvasConfigGenerateButton({nodeId,canGenerate,onGenerate,onStop}:{
    nodeId:string;canGenerate:boolean;onGenerate:(nodeId:string)=>void;onStop:(nodeId:string)=>void;
}) {
    const {t}=useTranslation();
    const execution=useCanvasTextExecution(nodeId);
    const active=Boolean(execution);
    return <Button type="primary" danger={active}
        className="sticky bottom-0 mt-auto !h-9 !w-full !shrink-0 !cursor-pointer !rounded-lg"
        disabled={execution?.stopping || (!active && !canGenerate)}
        aria-label={t(active?"canvas.configNode.stop":"canvas.configNode.generate")}
        onMouseDown={event=>event.stopPropagation()}
        onClick={()=>active?onStop(nodeId):onGenerate(nodeId)}>
        <span className="inline-flex items-center gap-1.5">
            {active?<>
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <Square className="size-3.5 fill-current" aria-hidden="true" />
            </>:<Play className="size-4" aria-hidden="true" />}
            <span>{t(active?"canvas.configNode.stop":"canvas.configNode.generate")}</span>
        </span>
    </Button>;
}
