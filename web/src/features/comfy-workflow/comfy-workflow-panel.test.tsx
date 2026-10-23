import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(pick:(value:{theme:"light"})=>unknown)=>pick({theme:"light"}),
}));
import { ComfyWorkflowPanel } from "./comfy-workflow-panel";

describe("Comfy workflow binding selector",()=>{
    it("renders an embedded settings editor without the canvas floating header or fixed width",()=>{
        const node:CanvasNodeData={
            id:"preset",title:"预设工作流",type:"comfy:workflow",
            position:{x:0,y:0},width:400,height:300,metadata:{},
        };
        const props:ComponentProps<typeof ComfyWorkflowPanel>={
            node,context:"preset",onChange:()=>true,onClose:()=>undefined,
        };
        const html=renderToStaticMarkup(createElement(ComfyWorkflowPanel,props));
        expect(html).toContain('data-comfy-editor-layout="settings"');
        expect(html).toContain("h-full min-h-0 min-w-0 w-full");
        expect(html).not.toContain("Close template editor");
        expect(html).not.toContain("ComfyUI Workflow <span");
        expect(html).not.toContain("shadow-2xl");
        expect(html).not.toContain("min(940px");
        expect(html).toContain('data-comfy-bindings-panel');
        const canvasHtml=renderToStaticMarkup(createElement(ComfyWorkflowPanel,{
            ...props,context:"node",
        }));
        expect(canvasHtml).toContain('data-comfy-editor-layout="canvas"');
        expect(canvasHtml).toContain("Close template editor");
        expect(canvasHtml).toContain("ComfyUI Workflow");
    });
    it("only presents the global preset selector; no saved-version history group",()=>{
        const node:CanvasNodeData={
            id:"wf",title:"Krea 2 Turbo",type:"comfy:workflow",
            position:{x:0,y:0},width:400,height:300,
            metadata:{comfyWorkflow:{
                templateId:"image-krea2-turbo-t2i-int8",templateRevision:"a".repeat(64),
                bindingState:"bound",inputOverrides:{}
            }}
        };
        const props:ComponentProps<typeof ComfyWorkflowPanel>={
            node,onChange:()=>true,onClose:()=>undefined
        };
        const html=renderToStaticMarkup(createElement(ComfyWorkflowPanel,props));
        expect(html).toContain('aria-label="加载预设"');
        expect(html).toContain("data-comfy-preset-picker");
        expect(html).toContain("加载预设");
        expect(html).toContain('value="builtin:krea2"');
        expect(html).toContain("Krea 2 Turbo INT8 · 文生图");
        expect(html).toContain("Import API JSON");
        expect(html).toContain("Load /object_info");
        expect(html).not.toContain(">Krea 2 Turbo 预设</button>");
        expect(html).not.toContain("Saved template versions");
        expect(html).not.toContain("已保存的所有模板版本");
        expect((html.match(/data-comfy-preset-picker/g)||[])).toHaveLength(1);
    });
});
