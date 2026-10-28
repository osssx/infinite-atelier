import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CanvasNodeHoverToolbar } from "./canvas-node-hover-toolbar";
import type { CanvasNodeData } from "@/types/canvas";
import {setCanvasComfyExecutionScope,setCanvasComfyExecution}
 from "@/features/comfy-workflow/canvas-execution-visual";

vi.mock("antd",()=>({
    App:{useApp:()=>({message:{warning:vi.fn()}})},
    Modal:()=>null, Segmented:()=>null,
    Tooltip:({children}:{children:ReactNode})=>children,
}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("@/hooks/use-copy-text",()=>({useCopyText:()=>vi.fn()}));

const workflow=(status?:string):CanvasNodeData=>({
    id:"workflow",type:"comfy:workflow",title:"workflow",position:{x:0,y:0},width:360,height:265,
    metadata:{
        comfyWorkflow:{templateId:"preset",templateRevision:"rev",bindingState:"bound",inputOverrides:{}},
        comfyExecution:status?{status,runId:"run"}:undefined,
    },
});
function render(node:CanvasNodeData,comfyExecuteDisabled=false){
    // Simulate the backend-observed transient status instead of persisted canvas metadata.
    setCanvasComfyExecutionScope(null);
    setCanvasComfyExecutionScope("toolbar-test");
    if(node.metadata?.comfyExecution)
        setCanvasComfyExecution("toolbar-test",node.id,node.metadata.comfyExecution);
    const noop=()=>undefined;
    const props:ComponentProps<typeof CanvasNodeHoverToolbar>={
        node,viewport:{x:0,y:0,k:1},onKeep:noop,onLeave:noop,onInfo:noop,
        onDecreaseFont:noop,onIncreaseFont:noop,onToggleDialog:noop,
        onGenerateImage:noop,onExecuteComfy:noop,comfyExecuteDisabled,onUpload:noop,
        onDownload:noop,onSaveAsset:noop,onMaskEdit:noop,onCrop:noop,onSplit:noop,
        onCaptureVideoFrame:noop,onTrimAudio:noop,onUpscale:noop,onSuperResolve:noop,
        onAngle:noop,onViewImage:noop,onReversePrompt:noop,onRetry:noop,
        onToggleFreeResize:noop,onDelete:noop,
    };
    return renderToStaticMarkup(createElement(CanvasNodeHoverToolbar,props));
}
describe("ComfyUI workflow selected-node toolbar",()=>{
    it("shows a direct Execute action without opening the inspector",()=>{
        const html=render(workflow());
        expect(html).toContain('aria-label="执行 ComfyUI 工作流"');
        expect(html).toContain(">执行</span>");
        expect(html).toContain('aria-label="canvas.nodeToolbar.infoTitle"');
        expect(html).toContain('aria-label="canvas.nodeToolbar.removeTitle"');
        expect(html.indexOf('aria-label="canvas.nodeToolbar.infoTitle"')).toBeLessThan(html.indexOf('aria-label="执行 ComfyUI 工作流"'));
        expect(html.indexOf('aria-label="执行 ComfyUI 工作流"')).toBeLessThan(html.indexOf('aria-label="canvas.nodeToolbar.removeTitle"'));
    });
    it("spins and disables Execute while a job is submitting or running",()=>{
        for(const status of ["submitting","queued","running","importing"]){
            const html=render(workflow(status));
            expect(html).toContain('aria-label="工作流执行中"');
            expect(html).toMatch(/disabled=""[^>]*aria-label="工作流执行中"/);
            expect(html).toContain("animate-spin");
        }
    });
    it("disables Execute without a bound template or configured instance",()=>{
        expect(render(workflow(),true)).toMatch(/disabled=""[^>]*aria-label="执行 ComfyUI 工作流"/);
        const unbound=workflow();
        unbound.metadata={};
        expect(render(unbound)).toMatch(/disabled=""[^>]*aria-label="执行 ComfyUI 工作流"/);
    });
    it.each(["VIDEO", "IMAGE", "AUDIO", "STRING"] as const)("allows the execute shortcut for %s-only capture outputs",valueKind=>{
        const node=workflow();
        node.metadata={...node.metadata,comfyPorts:[{id:"output",direction:"source",valueKind,label:"生成产物"}]};
        const html=render(node);
        expect(html).toContain('aria-label="执行 ComfyUI 工作流"');
        expect(html).not.toMatch(/disabled=""[^>]*aria-label="执行 ComfyUI 工作流"/);
        expect(html).not.toContain("暂不支持画布执行");
    });
    it("allows mixed VIDEO and IMAGE capture outputs, but keeps genuine disable guards",()=>{
        const node=workflow();
        node.metadata={...node.metadata,comfyPorts:[
            {id:"video",direction:"source",valueKind:"VIDEO",label:"视频"},
            {id:"image",direction:"source",valueKind:"IMAGE",label:"图片"}
        ]};
        expect(render(node)).not.toMatch(/disabled=""[^>]*aria-label="执行 ComfyUI 工作流"/);
        expect(render(node,true)).toMatch(/disabled=""[^>]*aria-label="执行 ComfyUI 工作流"/);
        node.metadata={...node.metadata,comfyExecution:{status:"running",runId:"job"}};
        expect(render(node)).toMatch(/disabled=""[^>]*aria-label="工作流执行中"/);
    });
    it("does not add Execute to unrelated canvas nodes",()=>{
        expect(render({...workflow(),type:"text"})).not.toContain('aria-label="执行 ComfyUI 工作流"');
    });
});
