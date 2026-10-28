import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CanvasNodeData } from "@/types/canvas";

const instanceState=vi.hoisted(()=>({id:""}));
vi.mock("@/stores/use-config-store",()=>({
    useConfigStore:(selector:(state:{config:{comfyInstanceId:string}})=>unknown)=>
        selector({config:{comfyInstanceId:instanceState.id}}),
}));
vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(pick:(value:{theme:"light"})=>unknown)=>pick({theme:"light"}),
}));
import { ComfyWorkflowPanel,comfyTemplateSaveButtonText } from "./comfy-workflow-panel";

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
        expect(html).not.toContain('aria-label="关闭模板编辑器"');
        expect(html).not.toContain("ComfyUI 工作流 <span");
        expect(html).not.toContain("shadow-2xl");
        expect(html).not.toContain("min(940px");
        expect(html).toContain('data-comfy-bindings-panel');
        const canvasHtml=renderToStaticMarkup(createElement(ComfyWorkflowPanel,{
            ...props,context:"node",
        }));
        expect(canvasHtml).toContain('data-comfy-editor-layout="canvas"');
        expect(canvasHtml).toContain('aria-label="关闭模板编辑器"');
        expect(canvasHtml).toContain("ComfyUI 工作流");
        expect(canvasHtml).toContain("/ 模板绑定");
        expect(canvasHtml).not.toContain("Template bindings");
    });
    it("enables syncing when a default backend instance is selected",()=>{
        instanceState.id="comfy-local";
        try{
            const node:CanvasNodeData={id:"node",title:"Comfy",type:"comfy:workflow",
                position:{x:0,y:0},width:400,height:300,metadata:{}};
            const html=renderToStaticMarkup(createElement(ComfyWorkflowPanel,{
                node,onChange:()=>true,onClose:()=>{}
            }));
            expect(html).toContain('data-comfy-object-info-sync');
            expect(html).toContain("从已配置的 ComfyUI 实例刷新节点定义");
            expect(html).not.toContain("未选择默认 ComfyUI 实例");
            const button=html.match(/<button[^>]+data-comfy-object-info-sync[^>]*>/)?.[0]??"";
            expect(button).not.toContain('disabled=""');
        }finally{instanceState.id="";}
    });
    it("uses Chinese for save, busy, and preset contexts without changing save behavior",()=>{
        expect(comfyTemplateSaveButtonText("node",false)).toBe("保存模板版本并绑定节点");
        expect(comfyTemplateSaveButtonText("preset",false)).toBe("保存预设版本与绑定");
        expect(comfyTemplateSaveButtonText("node",true)).toBe("正在保存…");
        expect(comfyTemplateSaveButtonText("preset",true)).toBe("正在保存…");
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
        expect(html).toContain("导入 API JSON");
        expect(html).toContain("同步节点定义");
        expect(html).toContain('data-comfy-object-info-sync');
        expect(html).toContain("未选择默认 ComfyUI 实例");
        expect((html.match(/type="file"/g)||[])).toHaveLength(1); // API JSON 导入仍保留
        expect(html).not.toContain("Import API JSON");
        expect(html).not.toContain(">Krea 2 Turbo 预设</button>");
        expect(html).not.toContain("Saved template versions");
        expect(html).not.toContain("已保存的所有模板版本");
        expect((html.match(/data-comfy-preset-picker/g)||[])).toHaveLength(1);
    });
});
