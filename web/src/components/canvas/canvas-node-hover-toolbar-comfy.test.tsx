import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CanvasNodeHoverToolbar } from "./canvas-node-hover-toolbar";
import type { CanvasNodeData } from "@/types/canvas";
import {setCanvasComfyExecutionScope,setCanvasComfyExecution}
 from "@/features/comfy-workflow/canvas-execution-visual";

const currentTheme=vi.hoisted(()=>({value:"dark" as "dark"|"light"}));
vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(selector:(state:{theme:"dark"|"light"})=>unknown)=>selector({theme:currentTheme.value}),
}));
vi.mock("./canvas-image-toolbar-settings-modal",()=>({ImageToolSettingsModal:()=>null}));
vi.mock("antd",()=>({
    App:{useApp:()=>({message:{warning:vi.fn()}})},
    Modal:()=>null, Segmented:()=>null,
    Tooltip:({children,color,styles}:{children:ReactNode;color:string;styles?:{root?:{color?:string}}})=>
        <span data-tooltip-color={color} data-tooltip-text={styles?.root?.color}>{children}</span>,
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
function render(node:CanvasNodeData,comfyExecuteDisabled=false,theme:"light"|"dark"="dark"){
    currentTheme.value=theme;
    // Simulate the backend-observed transient status instead of persisted canvas metadata.
    setCanvasComfyExecutionScope(null);
    setCanvasComfyExecutionScope("toolbar-test");
    if(node.metadata?.comfyExecution)
        setCanvasComfyExecution("toolbar-test",node.id,node.metadata.comfyExecution);
    const noop=()=>undefined;
    const props:ComponentProps<typeof CanvasNodeHoverToolbar>={
        node,viewport:{x:0,y:0,k:1},onKeep:noop,onLeave:noop,onInfo:noop,
        onDecreaseFont:noop,onIncreaseFont:noop,onToggleDialog:noop,
        onGenerateImage:noop,onExecuteComfy:noop,onCancelComfy:noop,comfyExecuteDisabled,onUpload:noop,
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
    it("keeps Execute disabled while submission, preparation and capture are busy",()=>{
        for(const status of ["submitting","preparing","collecting","importing"]){
            const html=render(workflow(status));
            expect(html).toContain('aria-label="工作流执行中"');
            expect(html).toMatch(/disabled=""[^>]*aria-label="工作流执行中"/);
            expect(html).toContain("animate-spin");
        }
    });
    it("changes the same Execute control to Stop, without another toolbar button",()=>{
        for(const status of ["running"]){
            const html=render(workflow(status),true);
            expect(html).toContain('aria-label="停止当前 ComfyUI 工作流"');
            expect(html).toContain(">停止</span>");
            expect(html).not.toContain('aria-label="执行 ComfyUI 工作流"');
            expect(html).not.toMatch(/disabled=""[^>]*aria-label="停止当前 ComfyUI 工作流"/);
            expect((html.match(/aria-label="停止当前 ComfyUI 工作流"/g)??[])).toHaveLength(1);
        }
        const queued=render(workflow("queued"));
        expect(queued).toContain('aria-label="工作流执行中"');
        expect(queued).toMatch(/disabled=""[^>]*aria-label="工作流执行中"/);
        expect(queued).not.toContain('aria-label="停止当前 ComfyUI 工作流"');
        for(const status of ["submitting","preparing","collecting","succeeded","cancelled","submission_unknown"]){
            expect(render(workflow(status))).not.toContain('aria-label="停止当前 ComfyUI 工作流"');
        }
        const cancelling=render(workflow("cancelling"));
        expect(cancelling).toContain('aria-label="正在停止工作流"');
        expect(cancelling).toMatch(/disabled=""[^>]*aria-label="正在停止工作流"/);
        expect(cancelling).toContain("停止中");
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
        expect(render(node)).toContain('aria-label="停止当前 ComfyUI 工作流"');
    });
    it.each([
        ["dark","rgba(31,29,26,.96)","#44403c","#d6d3d1","#292524","#3a3631","#f5f5f4"],
        ["light","rgba(251,250,247,.96)","#d6d3ca","#57534e","#e7e5df","#e7e5df","#292524"],
    ] as const)("adapts the selected toolbar and tooltip to the %s canvas theme",
        (name,panel,border,text,hover,active,activeText)=>{
            const html=render(workflow(),false,name);
            expect(html).toContain(`data-canvas-node-toolbar="${name}"`);
            expect(html).toContain(`background-color:${panel}`);
            expect(html).toContain(`border-color:${border}`);
            expect(html).toContain(`color:${text}`);
            expect(html).toContain(`--canvas-node-toolbar-hover:${hover}`);
            expect(html).toContain(`--canvas-node-toolbar-active:${active}`);
            expect(html).toContain(`--canvas-node-toolbar-active-text:${activeText}`);
            expect(html).toContain(`data-tooltip-color="${panel}"`);
            expect(html).toContain(`data-tooltip-text="${activeText}"`);
            expect(html).not.toContain("bg-white");
            expect(html).not.toContain("group-hover:bg-[#f0f0f1]");
        });
    it("uses the dark toolbar palette for image tools as well as workflow tools",()=>{
        const image:CanvasNodeData={...workflow(),id:"media",type:"image",metadata:{content:"data:image/png;base64,AAAA"}};
        const html=render(image,false,"dark");
        expect(html).toContain('data-canvas-node-toolbar="dark"');
        expect(html).toContain('background-color:rgba(31,29,26,.96)');
        expect(html).toContain('aria-label="canvas.imageTools.configure"');
    });
    it("does not add Execute to unrelated canvas nodes",()=>{
        expect(render({...workflow(),type:"text"})).not.toContain('aria-label="执行 ComfyUI 工作流"');
    });
});
