import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const pendingFlag=vi.hoisted(()=>({value:false}));
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("antd", () => ({
    Button: ({children, type, className, disabled, ...rest}:{
        children:ReactNode;type?:string;className?:string;disabled?:boolean;
    })=>createElement("button",{className:(className??"")+" "+(type??""),disabled,...rest},children),
}));
vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(select:(state:{theme:"light"})=>unknown)=>select({theme:"light"}),
}));
vi.mock("./run-client",()=>({
    hasPendingComfyRun:()=>pendingFlag.value,
    getComfyRun:vi.fn(),
    cancelComfyRun:vi.fn(),
    recoverPendingComfyRun:vi.fn(),
}));
vi.mock("./template-registry",()=>({getComfyTemplate:vi.fn()}));
vi.mock("./comfy-workflow-panel",()=>({ComfyWorkflowPanel:()=>null}));

import { ComfyWorkflowInstancePanel } from "./comfy-workflow-instance-panel";

const node=(status?:string,error?:string):CanvasNodeData=>({
    id:"wf",type:"comfy:workflow",title:"Workflow",position:{x:0,y:0},width:420,height:300,
    metadata:{
        comfyWorkflow:{templateId:"template",templateRevision:"rev",bindingState:"bound",inputOverrides:{}},
        comfyExecution:status?{status,error,runId:"run"}:undefined,
    },
});
function footer(status?:string,error?:string) {
    const noop=()=>undefined;
    const props:ComponentProps<typeof ComfyWorkflowInstancePanel>={
        node:node(status,error),connections:[],projectId:"p",comfyInstanceId:"comfy-local",
        onExecute:async()=>{throw Error("not expected");},onExecutionChange:noop,
        onChange:noop,onTemplateChange:()=>true,onClose:noop,
    };
    const html=renderToStaticMarkup(createElement(ComfyWorkflowInstancePanel,props));
    return html.split("data-comfy-run-footer")[1]?.split("</footer>")[0]??"";
}
afterEach(()=>{pendingFlag.value=false;});
describe("compact ComfyUI inspector execution footer",()=>{
    it("matches the config node full-width rectangular Start Generation button",()=>{
        const html=footer();
        expect(html).toContain("!h-9");
        expect(html).toContain("!w-full");
        expect(html).toContain("!rounded-lg");
        expect(html).toContain("!shrink-0");
        expect(html).toContain("sticky bottom-0 mt-auto");
        expect(html).toContain('aria-label="开始生成"');
        expect(html).toContain("开始生成");
        expect(html).toContain("lucide-play");
        expect(html).not.toContain("!rounded-full");
        expect(html).toContain("待执行");
        expect(html).not.toContain("画布实例");
        expect(html).not.toContain("prompt");
        expect(html).not.toContain("刷新状态");
        expect(html).not.toContain("首版仅支持");
        expect(html).not.toContain("参数自动保存");
    });
    it("shows a succinct running indicator with the primary button disabled",()=>{
        const html=footer("running");
        expect(html).toContain("生成中");
        expect(html).toContain("animate-spin");
        expect(html).toContain("生成中…");
        expect(html).toMatch(/disabled=""[^>]*aria-label="开始生成"/);
    });
    it("keeps only the needed recovery control for uncertain submissions",()=>{
        pendingFlag.value=true;
        const html=footer("submission_unknown");
        expect(html).toContain("提交待确认");
        expect(html).toContain("恢复待确认提交");
        expect(html).toMatch(/disabled=""[^>]*aria-label="开始生成"/);
        expect(html).not.toContain("幂等 key");
    });
    it("shows compact finished and failure statuses without raw task identifiers",()=>{
        expect(footer("succeeded")).toContain("已完成");
        const failed=footer("failed","GPU error details");
        expect(failed).toContain("生成失败");
        expect(failed).toContain("GPU error details");
        expect(failed).toContain('role="alert"');
        expect(failed).not.toContain("run-");
    });
});
