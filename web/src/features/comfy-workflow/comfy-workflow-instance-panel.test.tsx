import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasNodeData } from "@/types/canvas";

vi.mock("antd", () => ({
    Button: ({children, type, className, disabled, ...rest}:{
        children:ReactNode;type?:string;className?:string;disabled?:boolean;
    })=>createElement("button",{className:(className??"")+" "+(type??""),disabled,...rest},children),
}));
vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(select:(state:{theme:"light"})=>unknown)=>select({theme:"light"}),
}));
vi.mock("./run-types",()=>({missingComfyMediaInputs:()=>[]}));
vi.mock("./template-registry",()=>({getComfyTemplate:vi.fn()}));
vi.mock("./comfy-workflow-panel",()=>({ComfyWorkflowPanel:()=>null}));

import { ComfyWorkflowInstancePanel,ComfyScalarInput } from "./comfy-workflow-instance-panel";
import type {ComfyInstanceScalarField} from "./instance-parameters";

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
        node:node(status,error),connections:[],projectId:"p",comfyInstanceId:"comfy-local",backendExecution:true,
        onExecute:async()=>{throw Error("not expected");},onExecutionChange:noop,
        onChange:noop,onTemplateChange:()=>true,onClose:noop,
    };
    const html=renderToStaticMarkup(createElement(ComfyWorkflowInstancePanel,props));
    return html.split("data-comfy-run-footer")[1]?.split("</footer>")[0]??"";
}
describe("literal enum array dropdown",()=>{
    it.each([
        ["STRING","fast","fast",[{label:"快速",value:"fast"},{label:"高质量",value:"quality"}]],
        ["INT",16,16,[{label:"极速",value:8},{label:"标准",value:16}]],
        ["FLOAT",0.75,0.75,[{label:"低",value:0.25},{label:"高",value:0.75}]],
    ] as const)("shows candidate label but persists %s as its native scalar",(kind,value,expected,choices)=>{
        const field={
            port:{id:"quality",label:"生成质量",direction:"target",valueKind:kind,
                inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"quality"}]},choices:choices.map(option=>({...option}))},
            localValue:{source:"override",value},source:"override",
            mixedTemplateValues:false,connectionCount:0,
        } as ComfyInstanceScalarField;
        const html=renderToStaticMarkup(createElement(ComfyScalarInput,{field,onSet:()=>undefined,onClear:()=>undefined}));
        expect(html).toContain('aria-label="生成质量 候选项"');
        const selected=choices.findIndex(choice=>Object.is(choice.value,value));
        expect(html).toContain(`<option value="${selected}" selected="">`);
        expect(html).toContain(choices[selected].label);
        expect(html).not.toContain("输入浮点数");
        expect(value).toBe(expected);
    });
    it("locks a dropdown when a canvas input edge is connected",()=>{
        const field={port:{id:"steps",label:"步数",direction:"target",valueKind:"INT",
            choices:[{label:"8步",value:8},{label:"16步",value:16}]},
            connectedFrom:{nodeId:"text",portId:"text"},connectionCount:1,
            localValue:{source:"override",value:16},source:"edge",mixedTemplateValues:false
        } as ComfyInstanceScalarField;
        const html=renderToStaticMarkup(createElement(ComfyScalarInput,{field,onSet:()=>undefined,onClear:()=>undefined}));
        expect(html).toContain('disabled=""');
        expect(html).toContain("上游连线");
    });
});
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
    it("blocks uncertain submissions without legacy browser payload recovery",()=>{
        const html=footer("submission_unknown");
        expect(html).toContain("提交待确认");
        expect(html).toContain("本地后端会恢复任务");
        expect(html).toMatch(/disabled=""[^>]*aria-label="开始生成"/);
        expect(html).not.toContain("恢复待确认提交");
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
