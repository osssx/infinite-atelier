// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import type {DramaVideoInput} from "./drama-pipeline-media";
const mock=vi.hoisted(()=>({config:{videoSeconds:6,videoRatio:"16:9",videoModel:"test"},audit:vi.fn()}));
vi.mock("@/stores/use-config-store",()=>({useEffectiveConfig:()=>mock.config}));
vi.mock("./drama-production-audit",()=>({
 dramaMediaModes:[{id:"text_to_video",label:"文生视频"},{id:"first_frame",label:"首帧"}],
 auditDramaProduction:mock.audit,
}));
import {DramaBatchConfigPanel} from "./drama-batch-config-panel";
const episodes=[{id:"e1",title:"森林",sequences:[{id:"a",title:"林间小路"},{id:"b",title:"草地"}]},{id:"e2",title:"河边",sequences:[{id:"a",title:"河畔"}]}];
const inputs:DramaVideoInput[]=Array.from({length:20},(_,i)=>({
 shot:{id:"s"+i,episodeId:i<18?"e1":"e2",sequenceId:i<16||i>=18?"a":"b",order:i+1,description:"镜头内容 "+i,
 characterVariantIds:[],propIds:[],keyPropIds:[],durationSec:5},prompt:"镜头 "+i,referenceImages:[],
}));
const roots:Root[]=[];
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);mock.audit.mockReset();mock.audit.mockImplementation(async(input:DramaVideoInput)=>({ready:true,input}));});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
async function mount(){
 const el=document.createElement("div");document.body.append(el);const root=createRoot(el);roots.push(root);
 const create=vi.fn(),group=vi.fn(async()=>{}),locate=vi.fn();
 const configs=new Map([["s0",{id:"cfg0"} as CanvasNodeData],["s1",{id:"cfg1"} as CanvasNodeData]]);
 const render=async(data=inputs,revision="v1",disabled=false)=>act(async()=>root.render(<DramaBatchConfigPanel inputs={data} episodes={episodes}
  configs={configs} missingFor={()=>[]} disabled={disabled} theme={canvasThemes.dark} confirmedRevisionId={revision}
  onCreateSelected={create} onCreateBatch={group} onLocate={locate} canLocate={id=>id!=="s19"}/>));
 await render();
 const button=(name:string)=>[...el.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===name)!;
 const click=async(target:HTMLElement)=>{expect(target).toBeTruthy();await act(async()=>target.click());};
 const choose=async(label:string,value:string)=>{const select=el.querySelector<HTMLSelectElement>('select[aria-label="'+label+'"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,value);select.dispatchEvent(new Event("change",{bubbles:true}));});};
 const selectRow=async(id:number)=>click(el.querySelector<HTMLInputElement>('input[aria-label="选择镜头 '+(id+1)+' · 镜头内容 '+id+'"]')!);
 return {el,render,create,group,locate,button,click,choose,selectRow};
}
it("filters named sequences, paginates and preserves cross-page selection without auditing on mount",async()=>{
 const h=await mount();expect(mock.audit).not.toHaveBeenCalled();
 expect(h.el.querySelectorAll("tbody tr")).toHaveLength(15);
 expect(h.el.querySelector<HTMLInputElement>('input[aria-label="选择镜头 1 · 镜头内容 0"]')?.disabled).toBe(true);
 await h.selectRow(2);await h.click(h.button("下一页"));await h.selectRow(16);
 expect(h.el.textContent).toContain("已选 2 镜");
 await h.choose("批量创建配置剧集","e1");
 await h.choose("批量配置场次","e1/b");
 expect(h.el.querySelectorAll("tbody tr")).toHaveLength(2);
 expect(h.el.textContent).toContain("草地");expect(h.el.textContent).toContain("已选 2 镜");
 await h.click(h.button("全选筛选结果"));expect(h.el.textContent).toContain("已选 3 镜");
 await h.choose("批量配置状态","configured");
 expect(h.el.textContent).toContain("没有匹配的镜头");
 expect(h.el.textContent).toContain("已选 3 镜");
 await h.click(h.button("清空选择"));expect(h.el.textContent).toContain("已选 0 镜");
});
it("audits with a maximum of four concurrent jobs, reports per-shot failures and creates passed items only on explicit action",async()=>{
 const h=await mount();let active=0,peak=0;
 mock.audit.mockImplementation(async(input:DramaVideoInput)=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;
  if(input.shot.id==="s3")throw Error("缺少首帧");
  if(input.shot.id==="s4")return {ready:false,error:"模板不支持"};
  return {ready:true,input};
 });
 await h.click(h.button("全选筛选结果"));
 await h.click(h.button("预检所选镜头"));
 await act(async()=>{await new Promise(r=>setTimeout(r,60));});
 expect(peak).toBe(4);expect(mock.audit).toHaveBeenCalledTimes(18);
 expect(h.create).not.toHaveBeenCalled();expect(h.el.textContent).toContain("通过 16 · 失败 2");
 await h.choose("批量配置状态","failed");expect(h.el.querySelectorAll("tbody tr")).toHaveLength(2);
 expect(h.el.textContent).toContain("缺少首帧");expect(h.el.textContent).toContain("模板不支持");
 await h.click([...h.el.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="定位镜头")!);
 expect(h.locate).toHaveBeenCalledWith("s3","e1");
 await h.click(h.button("创建通过的 16 项"));
 expect(h.create).toHaveBeenCalledTimes(1);
 const ids=h.create.mock.lastCall![0].map((input:DramaVideoInput)=>input.shot.id);
 expect(ids).toHaveLength(16);expect(ids).not.toContain("s3");expect(ids).not.toContain("s4");
 expect(h.el.textContent).toContain("已选 2 镜");
});
it("invalidates passed audits after the confirmed revision changes and isolates group selection",async()=>{
 const h=await mount();await h.selectRow(2);await h.click(h.button("预检所选镜头"));
 expect(h.button("创建通过的 1 项").disabled).toBe(false);
 await h.render(inputs,"v2");
 expect(h.button("创建通过的 0 项").disabled).toBe(true);
 expect(h.create).not.toHaveBeenCalled();
 await h.click(h.button("组建批量生成镜头组"));
 expect(h.el.querySelectorAll("tbody tr")).toHaveLength(2);
 expect(h.el.textContent).toContain("已选 0 镜");
 await h.selectRow(0);await h.selectRow(1);
 await h.click(h.button("组建所选镜头并进入批量预检（2）"));
 expect(h.group).toHaveBeenCalledWith(["s0","s1"]);
 expect(h.create).not.toHaveBeenCalled();
 await h.click(h.button("批量创建视频配置"));expect(h.el.textContent).toContain("已选 1 镜");
});
