// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
const evidence=vi.hoisted(()=>({requests:[] as string[],delayFirst:false}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:vi.fn(async(path:string)=>{
  evidence.requests.push(path);
  const q=new URL(path,"http://localhost").searchParams;
  const draft=q.get("draft")==="true",board=q.get("nodeId")==="board";
  const ids=board?["ep-one","ep-two"]:["ep-one","ep-two"];
  const groups=board?ids.map(episodeId=>({episodeId,total:1,sequenceIds:[]})):[];
  const entries=board?[{id:"shot-1",episodeId:"ep-one",order:1,description:"红色参考镜头",shotSize:"中景",durationSec:5},
   {id:"shot-2",episodeId:"ep-two",order:2,description:"绿色参考镜头",shotSize:"全景",durationSec:7}]:
   [{id:"ep-one",title:"第一集",synopsis:"出发前夜",sequences:[]},
    {id:"ep-two",title:"第二集",synopsis:"第二集概要",sequences:[]}];
  if(board&&evidence.delayFirst&&q.get("episodeId")==="ep-one"&&q.get("summaryOnly")!=="true")
   await new Promise(resolve=>setTimeout(resolve,50));
  const entry=board&&q.get("episodeId")?
   entries.find(e=>"episodeId" in e && e.episodeId===q.get("episodeId")):
   entries[Number(q.get("offset")??0)];
  return {versionId:draft?null:"confirmation-1",total:board?2:2,groups,
   entries:q.get("summaryOnly")==="true"?[]:entry?[entry]:[],
   entryDigests:entry?[{id:entry.id,digest:"a".repeat(64)}]:[]};
 })
}));
import {DramaNodeSummaryCard} from "./drama-node-summary-card";
const activeRoots:Root[]=[];
beforeEach(()=>{evidence.requests=[];evidence.delayFirst=false;vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true)});
afterEach(async()=>{for(const root of activeRoots)await act(async()=>root.unmount());
 activeRoots.length=0;vi.unstubAllGlobals()});
function node(kind:"episodes"|"storyboard"):CanvasNodeData{
 return {id:kind==="episodes"?"episodes":"board",type:"drama:"+kind,title:kind,
   position:{x:0,y:0},width:380,height:240,metadata:{creativePayloadRef:{schemaVersion:1,nodeId:kind}}} as CanvasNodeData;
}
async function mount(kind:"episodes"|"storyboard",onOpen=vi.fn(async(_id:string)=>{})){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);activeRoots.push(root);
 await act(async()=>{root.render(<DramaNodeSummaryCard node={node(kind)} projectId="p1" onOpen={onOpen}/>);});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,18))});
 return {container,onOpen,root};
}
describe("P3.4b2 lightweight creative cards",()=>{
 it("reads only scoped index plus one episode; no draft hydrate, video config or editor DOM",async()=>{
  const {container}=await mount("episodes");
  expect(container.textContent).toContain("已规划 2 集 · 已确认 2 集");
  expect(container.textContent).toContain("第一集");
  expect(container.textContent).toContain("出发前夜");
  expect(container.querySelectorAll("textarea")).toHaveLength(0);
  expect(container.textContent).not.toContain("剧情事件");
  expect(evidence.requests.filter(x=>x.includes("summaryOnly=true"))).toHaveLength(2);
  expect(evidence.requests.some(x=>x.includes("limit=1"))).toBe(true);
  expect(evidence.requests.every(x=>x.includes("revision-scope")&&
   !x.includes("/payload")&&!x.includes("/runs"))).toBe(true);
 });
 it("scopes selected storyboard episode and does not load 100 shots",async()=>{
  const {container}=await mount("storyboard");
  const select=container.querySelector('select[aria-label="摘要选择剧集"]') as HTMLSelectElement;
  expect(select.options.length).toBe(2);
  await act(async()=>{select.value="ep-two";select.dispatchEvent(new Event("change",{bubbles:true}));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))});
  expect(container.textContent).toContain("绿色参考镜头");
  expect(container.textContent).not.toContain("红色参考镜头");
  expect(evidence.requests.some(x=>x.includes("episodeId=ep-two")&&x.includes("limit=1"))).toBe(true);
 });
 it("only exposes quick-edit for draft, lazily mounts and cancels without write",async()=>{
  const {container}=await mount("episodes");
  expect(container.querySelector('button[aria-label="快速编辑当前剧集"]')).toBeNull();
  const select=container.querySelector('select[aria-label="剧集规划版本"]') as HTMLSelectElement;
  await act(async()=>{select.value="draft";select.dispatchEvent(new Event("change",{bubbles:true}));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25))});
  const button=container.querySelector<HTMLButtonElement>('button[aria-label="快速编辑当前剧集"]');
  expect(button).toBeTruthy();
  expect(container.querySelector("textarea")).toBeNull();
  await act(async()=>{button!.click();});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,140))});
  expect(container.querySelector('[aria-label="剧集快速编辑"]'),container.innerHTML).toBeTruthy();
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  const cancel=[...container.querySelectorAll("button")].find(b=>b.textContent?.trim()==="取消");
  await act(async()=>{cancel!.click();});
  expect(container.querySelector("textarea")).toBeNull();
  expect(evidence.requests.every(x=>x.includes("revision-scope"))).toBe(true);
 });
 it("keeps chosen draft view after a metadata refresh",async()=>{
  const {container,root,onOpen}=await mount("episodes");
  const select=container.querySelector('select[aria-label="剧集规划版本"]') as HTMLSelectElement;
  await act(async()=>{select.value="draft";select.dispatchEvent(new Event("change",{bubbles:true}));});
  await act(async()=>{root.render(<DramaNodeSummaryCard node={{
   ...node("episodes"),metadata:{...node("episodes").metadata,dramaConfirmedVersionId:"v2"}
  }} projectId="p1" onOpen={onOpen}/>);});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  expect((container.querySelector('select[aria-label="剧集规划版本"]') as HTMLSelectElement).value).toBe("draft");
  const before=evidence.requests.filter(x=>x.includes("summaryOnly=true")).length;
  const refresh=container.querySelector<HTMLButtonElement>('button[aria-label="刷新剧集规划摘要"]')!;
  await act(async()=>{refresh.click();await new Promise(resolve=>setTimeout(resolve,20))});
  expect(evidence.requests.filter(x=>x.includes("summaryOnly=true")).length).toBe(before+2);
  expect((container.querySelector('select[aria-label="剧集规划版本"]') as HTMLSelectElement).value).toBe("draft");

 });
 it("ignores stale response from another storyboard episode",async()=>{
  evidence.delayFirst=true;
  const {container}=await mount("storyboard");
  const select=container.querySelector('select[aria-label="摘要选择剧集"]') as HTMLSelectElement;
  await act(async()=>{select.value="ep-two";select.dispatchEvent(new Event("change",{bubbles:true}));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,75))});
  expect(container.textContent).toContain("绿色参考镜头");
  expect(container.textContent).not.toContain("红色参考镜头");
 });
 it("opens full editor only on explicit click; never on selection or initial mount",async()=>{
  const onOpen=vi.fn(async(_id:string)=>{});
  const {container}=await mount("episodes",onOpen);
  expect(onOpen).not.toHaveBeenCalled();
  const button=container.querySelector('button[aria-label="打开剧集规划完整编辑器"]') as HTMLButtonElement;
  await act(async()=>{button.click();await Promise.resolve()});
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("episodes",{episodeId:"ep-one"});
 });
});
