import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(pick:(value:{theme:"light"})=>unknown)=>pick({theme:"light"}),
}));
import { ComfyWorkflowPanel } from "./comfy-workflow-panel";

describe("Comfy workflow binding selector",()=>{
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
        expect(html).toContain('aria-label="选择预设工作流"');
        expect(html).toContain("选择全局预设工作流");
        expect(html).not.toContain("Saved template versions");
        expect(html).not.toContain("已保存的所有模板版本");
    });
});
