import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {CanvasConfigGenerateButton} from "./canvas-config-generate-button";
import {beginCanvasTextSubmission,cancelCanvasNodeExecution,finishCanvasTextSubmission,getCanvasTextExecution,
 setCanvasTextExecutionScope,trackCanvasTextJob,updateCanvasTextJob} from "@/features/backend-sync/canvas-text-execution-visual";
const handlers=vi.hoisted(()=>({click:undefined as undefined|(()=>void)}));
vi.mock("antd",()=>({Button:({children,onClick,danger,...props}:any)=>{
 handlers.click=props.disabled?undefined:onClick;
 return createElement("button",props,children);
}}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key.endsWith(".stop")?"停止生成":"开始生成"})}));
beforeEach(()=>setCanvasTextExecutionScope("p"));
afterEach(()=>setCanvasTextExecutionScope(null));
it.each(["image","text","video","audio"] as const)("shows only stop action throughout %s and sends cancellation directly",async kind=>{
 const generate=vi.fn(),api=vi.fn(async()=>({cancelled:true}));
 let pending:Promise<void>|undefined;
 const stop=vi.fn(()=>{pending=cancelCanvasNodeExecution("p","node",api,vi.fn())});
 const render=()=>renderToStaticMarkup(createElement(CanvasConfigGenerateButton,{nodeId:"node",canGenerate:true,onGenerate:generate,onStop:stop}));
 expect(render()).toContain("开始生成");
 handlers.click?.();expect(generate).toHaveBeenCalledWith("node");
 beginCanvasTextSubmission("p","node","click",kind);
 for(const phase of ["submitting","queued","preparing","running","collecting"]){
  if(phase!=="submitting"){
   trackCanvasTextJob("p","node","job",phase,"click",kind);
   finishCanvasTextSubmission("p","node","click");
  }
  const html=render();
  expect(html).toContain("停止生成");expect(html).toContain("animate-spin");
  expect(html).not.toContain("开始生成");expect(html).not.toContain("正在");
 }
 handlers.click?.();expect(stop).toHaveBeenCalledWith("node");
 expect(render()).toContain('disabled=""');expect(handlers.click).toBeUndefined();
 await pending;expect(api).toHaveBeenCalledExactlyOnceWith("job");
 expect(render()).toContain("开始生成");
 expect(getCanvasTextExecution("node")).toBeUndefined();
 // Snapshot recovery uses the same action without a pending submission.
 trackCanvasTextJob("p","node","restored","running",undefined,kind);
 expect(render()).toContain("停止生成");
 updateCanvasTextJob("p","restored","failed");expect(render()).toContain("开始生成");
});
