// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {StoryEventReviewPanel,storyReviewReadiness,type StoryEventReview}
 from "./canvas-assistant-story-review";

const mocked=vi.hoisted(()=>({api:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:mocked.api}));
let root:Root|null=null;
let container:HTMLDivElement|null=null;
const hash="a".repeat(64),diff="b".repeat(64);
const template=():StoryEventReview=>({
 version:1,kind:"story_event_editorial_review",taskId:"task-1",
 turnMessageId:"revision-turn",snapshotDigest:hash,projectRevision:1,
 activePlanVersion:1,semanticRevision:0,catalogDigest:diff,
 source:{requestId:"original-call",digest:diff},revision:{requestId:"revision-call",digest:hash},
 comparison:[{eventId:"star_returns_to_sky",label:"把星星放回天空",
  sourceShotIndex:6,revisionShotIndex:null,detected:false,
  warnings:["prior_story_action_not_observed"],decision:"pending"}],
 warnings:[{id:"star_returns_to_sky",code:"prior_story_action_not_observed",afterEventId:null}],
 reviewStatus:"pending",userConfirmed:false,semanticReview:"pending",
 canvasExecutionAuthorized:false,taskCompletionAuthorized:false
} as StoryEventReview);
const props={projectId:"proj",taskId:"task-1",turnMessageId:"revision-turn",
 disabled:false,readOnly:false,frozenStep:{id:"frozen-step",actionDigest:diff} as
  {id:string;actionDigest:string}|null,
 getCanvasCenter:undefined as undefined|(()=>{x:number;y:number}),
 onPrepared:undefined as undefined|(()=>Promise<void>)};
async function render(override:Partial<typeof props>={}){
 container=document.createElement("div");document.body.appendChild(container);
 root=createRoot(container);
 await act(async()=>root!.render(createElement(StoryEventReviewPanel,{...props,...override})));
}
async function click(label:string){
 const node=Array.from(container!.querySelectorAll("button")).find(button=>
  button.textContent?.trim()===label);
 expect(node,label).toBeTruthy();
 await act(async()=>{node!.click();await Promise.resolve()});
}
const find=(text:string)=>container!.textContent?.includes(text);
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 mocked.api.mockReset();
});
afterEach(async()=>{
 if(root)await act(async()=>root!.unmount());
 root=null;container?.remove();container=null;
});
describe("P4.9j Task storyboard editorial review UI",()=>{
 it("loads authorized source only by user click; explains missing action, no model or graph requests",async()=>{
  mocked.api.mockResolvedValue(template());
  await render();
  expect(mocked.api).not.toHaveBeenCalled();
  await click("剧情事件审核（只读差异）");
  expect(find("修订中未观察到")).toBe(true);
  expect(find("原第 6 镜")).toBe(true);
  expect(find("不是长期事实")).toBe(true);
  expect(mocked.api.mock.calls.every(([url,method])=>url.includes("/story-events/review?")&&method==="GET")).toBe(true);
  expect(find("旧审核")).toBe(false);
 });
 it("records one explicit decision with the exact frozen digest, never executes Canvas",async()=>{
  let current=template();
  mocked.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="POST"){
    expect(url.endsWith("/story-events/review")).toBe(true);
    expect(payload?.confirmed).toBe(true);
    expect(payload?.snapshotDigest).toBe(hash);
    expect(payload?.turnMessageId).toBe("revision-turn");
    expect(payload?.eventId).toBe("star_returns_to_sky");
    expect(payload?.decision).toBe("request_revision");
    current={...current,comparison:current.comparison.map(v=>({...v,decision:"request_revision"})),
     reviewStatus:"recorded_only"};
    return {current:true,eventId:"star_returns_to_sky",decision:"request_revision"};
   }
   return current;
  });
  await render();
  await click("剧情事件审核（只读差异）");
  await click("需要修订");
  expect(find("已标记需要修订")).toBe(true);
  expect(find("已查看候选（非正式批准）")).toBe(false);
  const posts=mocked.api.mock.calls.filter(([,method])=>method==="POST");
  expect(posts).toHaveLength(1);
  expect(mocked.api.mock.calls.some(([url])=>url.endsWith("/approval")||
   url.endsWith("/execute")||url.endsWith("/canvas-steps"))).toBe(false);
 });
 it("reports needs-revision and warnings even when all candidates acknowledged",()=>{
  const v=template();
  expect(storyReviewReadiness(v).ready).toBe(false);
  v.comparison[0].decision="acknowledge_candidate";
  v.reviewStatus="recorded_only";
  expect(storyReviewReadiness(v).ready).toBe(false);
  v.warnings=[];
  v.comparison[0].warnings=[];
  v.comparison[0].detected=true;
  v.comparison[0].revisionShotIndex=6;
  expect(storyReviewReadiness(v).ready).toBe(true);
  v.comparison[0].decision="request_revision";
  expect(storyReviewReadiness(v).ready).toBe(false);
 });
 it("only displays preflight success for the same server-verified frozen Step, never authorizes execution",async()=>{
  const good=template();
  good.comparison[0]={...good.comparison[0],decision:"acknowledge_candidate",
   detected:true,revisionShotIndex:6,warnings:[]};
  good.reviewStatus="recorded_only";good.warnings=[];
  mocked.api.mockImplementation(async(url:string,method:string)=>{
   if(method!=="GET")throw Error("unexpected mutation");
   if(url.includes("/preflight?"))return {
    verified:true,reason:"bound_editorial_source_rechecked",
    snapshotDigest:hash,stepId:"frozen-step",stepActionDigest:diff,
    canvasExecutionAuthorized:false
   };
   return good;
  });
  await render();
  await click("剧情事件审核（只读差异）");
  await click("核对冻结步骤的应用来源（只读）");
  expect(find("已完成编辑候选初核")).toBe(true);
  expect(find("这不是画布执行授权")).toBe(true);
  expect(mocked.api.mock.calls.filter(([url])=>url.includes("/preflight?"))).toHaveLength(1);
 });
 it("never turns a stale or invalid preflight into an approval",async()=>{
  const good=template();
  good.comparison[0]={...good.comparison[0],decision:"acknowledge_candidate",
   detected:true,revisionShotIndex:6,warnings:[]};
  good.reviewStatus="recorded_only";good.warnings=[];
  mocked.api.mockImplementation(async(url:string)=>{
   if(url.includes("/preflight?"))return {verified:true,snapshotDigest:hash,stepId:"other-step",
    stepActionDigest:diff,canvasExecutionAuthorized:false,reason:"bound_editorial_source_rechecked"};
   return good;
  });
  await render();
  await click("剧情事件审核（只读差异）");
  await click("核对冻结步骤的应用来源（只读）");
  expect(find("冻结步骤来源未通过核验")).toBe(true);
  expect(find("已完成编辑候选初核")).toBe(false);
 });
 it("clears stale review after switching Task while old GET is pending",async()=>{
  let resolve!:(value:StoryEventReview)=>void;
  const deferred=new Promise<StoryEventReview>(ok=>{resolve=ok});
  mocked.api.mockReturnValue(deferred);
  await render();
  await act(async()=>{container!.querySelector("button")!.click();await Promise.resolve()});
  await act(async()=>root!.render(createElement(StoryEventReviewPanel,{
   ...props,taskId:"task-2",turnMessageId:"other-turn"})));
  await act(async()=>{resolve(template());await Promise.resolve()});
  expect(find("原第 6 镜")).toBe(false);
  expect(container!.querySelectorAll("button")).toHaveLength(1);
 });

 it("P4.9k explicit prepare-apply freezes a reviewed storyboard but never approves or executes Canvas",async()=>{
  const good=template();
  good.comparison[0]={...good.comparison[0],decision:"acknowledge_candidate",
   detected:true,revisionShotIndex:6,warnings:[]};
  good.reviewStatus="recorded_only";good.warnings=[];
  const prepared=vi.fn(async()=>{});
  mocked.api.mockImplementation(async(url:string,method:string,payload?:Record<string,unknown>)=>{
   if(method==="POST"){
    expect(url.endsWith("/story-events/review/prepare-apply")).toBe(true);
    expect(payload?.confirmed).toBe(true);
    expect(payload?.snapshotDigest).toBe(hash);
    expect(payload?.turnMessageId).toBe("revision-turn");
    expect(payload?.center).toEqual({x:125,y:275});
    return {stepId:"frozen-step-id",status:"waiting_approval",existing:false};
   }
   return good;
  });
  await render({frozenStep:null,getCanvasCenter:()=>({x:125,y:275}),onPrepared:prepared});
  await click("剧情事件审核（只读差异）");
  await click("准备应用已审核分镜（仅冻结步骤，仍需审批）");
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(find("已冻结待审批步骤")).toBe(true);
  expect(mocked.api.mock.calls.filter(([,method])=>method==="POST")).toHaveLength(1);
  expect(mocked.api.mock.calls.some(([url])=>url.endsWith("/execute")||
   url.endsWith("/approval")||url.endsWith("/canvas-steps"))).toBe(false);
 });
 it("P4.9k omitted action or archived Task never offers the apply button",async()=>{
  mocked.api.mockResolvedValue(template());
  await render({frozenStep:null});
  await click("剧情事件审核（只读差异）");
  expect(find("准备应用已审核分镜")).toBe(false);
  expect(mocked.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
 });
 it("read-only archived Task can inspect but cannot submit decisions or preflight",async()=>{
  mocked.api.mockResolvedValue(template());
  await render({readOnly:true});
  await click("剧情事件审核（只读差异）");
  expect(find("修订中未观察到")).toBe(true);
  expect(container!.querySelector('button[aria-label^="已查看事件"]')).toBeNull();
  const button=Array.from(container!.querySelectorAll("button")).find(v=>
   v.textContent?.includes("核对冻结步骤的应用来源"));
  expect(button?.disabled).toBe(true);
  expect(mocked.api.mock.calls.some(([,method])=>method==="POST")).toBe(false);
 });
});
