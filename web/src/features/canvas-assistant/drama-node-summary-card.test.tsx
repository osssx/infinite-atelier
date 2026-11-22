// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
const evidence=vi.hoisted(()=>({requests:[] as string[]}));
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
  const entry=board&&q.get("episodeId")?
   entries.find(e=>"episodeId" in e && e.episodeId===q.get("episodeId")):
   entries[Number(q.get("offset")??0)];
  return {versionId:draft?null:"confirmation-1",total:board?2:2,groups,
   entries:q.get("summaryOnly")==="true"?[]:entry?[entry]:[]};
 })
}));
import {DramaNodeSummaryCard} from "./drama-node-summary-card";
const activeRoots:Root[]=[];
beforeEach(()=>{evidence.requests=[];vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true)});
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
 return {container,onOpen};
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
