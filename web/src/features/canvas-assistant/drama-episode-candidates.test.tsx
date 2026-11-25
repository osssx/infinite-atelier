// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import type {DramaEpisode} from "./drama-episode-fields";
import type {DramaRun} from "./drama-episode-candidate-state";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn()}));
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {DramaPipelineNodePanel} from "./drama-pipeline-node-panel";
import {DramaCreativeWorkspace} from "./drama-creative-workspace";
import {useThemeStore} from "@/stores/use-theme-store";

const ep=(id:string,title:string):DramaEpisode=>({id,title,synopsis:title+"梗概",events:["事件"],eventItems:[{id:id+"-event",text:"事件"}],sourceRefs:[],ending:title+"结尾",targetDurationSec:60,sequences:[{id:id+"-scene",title:"场次",eventRefs:[id+"-event"]}]});
const roots:Root[]=[];
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.mocked(canvasApi).mockReset();});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;vi.unstubAllGlobals();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function click(el:Element|null|undefined){expect(el).toBeTruthy();await act(async()=>{(el as HTMLElement).click();});}
async function input(el:HTMLInputElement|HTMLTextAreaElement,value:string){
 expect(el).toBeTruthy();await act(async()=>{
  Object.getOwnPropertyDescriptor(el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
function button(scope:ParentNode,text:string){return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;}
async function openRun(workspace:ParentNode,id="run"){
 const list=workspace.querySelector("[data-drama-run-scroll-region]")!;
 const details=[...list.children].find(e=>e instanceof HTMLDetailsElement&&e.querySelector("summary")?.textContent?.includes(id==="run"?"完整剧集计划":id)) as HTMLDetailsElement;
 expect(details).toBeTruthy();
 await act(async()=>{details.open=true;details.dispatchEvent(new Event("toggle"));});
 return details;
}
async function mount({workspaceMode=true,appearance="dark",initialRevision=0,initialCount=2}:{workspaceMode?:boolean;appearance?:"light"|"dark";initialRevision?:number;initialCount?:number}={}){
 await act(async()=>useThemeStore.setState({theme:appearance}));
 const episodes=Array.from({length:initialCount},(_,i)=>ep("ep"+i,"第"+(i+1)+"集"));
 let remote:DramaRun={id:"run",episodeId:"*",status:"ready",candidate:{revision:initialRevision,episodes}};
 let listOverride:Promise<DramaRun[]>|null=null;
 let conflict=false;
 const change=vi.fn(),adopt=vi.fn(async(_path:string,_shots?:string[],revision?:number)=>{
  expect(revision).toBe(remote.candidate?.revision);remote={...remote,status:"adopted"};
 });
 const summarized=()=>remote.status==="discarded"?[]:[{...remote,candidate:{...remote.candidate,episodeCount:remote.candidate?.episodes?.length,episodes:[]}}];
 vi.mocked(canvasApi).mockImplementation((async(path:string,method="GET",payload?:any)=>{
  if(path.includes("/dependencies?"))return {status:"current",changes:[]};
  if(path.includes("/runs?")){if(listOverride){const pending=listOverride;listOverride=null;return pending;}return summarized();}
  if(path.endsWith("/runs/run")&&method==="GET")return remote;
  if(method==="PATCH"&&path.includes("/episodes/")){
   if(conflict||payload.expectedRevision!==remote.candidate?.revision)throw Error("drama_candidate_revision_conflict");
   const id=path.split("/").at(-1);
   remote={...remote,candidate:{...remote.candidate,revision:payload.expectedRevision+1,
    episodes:remote.candidate!.episodes!.map(e=>e.id===id?{...e,...payload.changes}:e),
    manualChanges:{originalEpisodeIds:episodes.map(e=>e.id),editedEpisodeIds:[id!],removedEpisodeIds:remote.candidate?.manualChanges?.removedEpisodeIds??[],updatedAt:"2026-11-25"}}};
   return remote;
  }
  if(method==="DELETE"){
   const version=Number(new URL(path,"http://localhost").searchParams.get("expectedRevision"));
   if(version!==remote.candidate?.revision)throw Error("drama_candidate_revision_conflict");
   if(path.includes("/episodes/")){
    const id=path.split("/").at(-1)!.split("?")[0];
    remote={...remote,candidate:{...remote.candidate,revision:version+1,episodes:remote.candidate!.episodes!.filter(e=>e.id!==id),
     manualChanges:{originalEpisodeIds:episodes.map(e=>e.id),editedEpisodeIds:[],removedEpisodeIds:[id],updatedAt:"2026-11-25"}}};
   }else remote={...remote,status:"discarded"};
   return remote;
  }
  return {};
 }) as typeof canvasApi);
 const node={id:"candidate-p2-"+Math.random(),type:"drama:episodes",title:"剧集规划",position:{x:0,y:0},metadata:{dramaDraft:JSON.stringify({episodes:[ep("formal","正式草案")]})}} as CanvasNodeData;
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);roots.push(root);
 await act(async()=>root.render(workspaceMode?<DramaCreativeWorkspace projectId="p" nodeId={node.id} kind="episodes" focus={{}} versionConfirmed={true} onClose={async()=>{}}
  renderPanel={(tab,register)=><DramaPipelineNodePanel node={node} projectId="p" workspaceMode workspaceTab={tab==="settings"?"editor":tab} onPendingChange={register} onChange={change} onAdoptDramaRun={adopt}/>}/>:
  <DramaPipelineNodePanel node={node} projectId="p" workspaceMode workspaceTab="runs" onChange={change} onAdoptDramaRun={adopt}/>));
 const workspace=workspaceMode?document.querySelector('[data-creative-workspace-node-id="'+node.id+'"]')!:container;
 if(workspaceMode)await click(button(workspace,"生成候选"));
 const details=await openRun(workspace);
 return {workspace,details,change,adopt,getRemote:()=>remote,setConflict:(value:boolean)=>{conflict=value;},setListOverride:(value:Promise<DramaRun[]>)=>{listOverride=value;},summarized};
}
describe("P2 episode candidate workspace",()=>{
 it.each(["light","dark"] as const)("edits candidate locally and saves exactly one field in %s theme",async appearance=>{
  const {workspace,details,change,adopt}=await mount({appearance});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  expect(editor.querySelectorAll('[data-episode-editor-layout]')).toHaveLength(1);
  await click(editor.querySelector('[aria-label="编辑剧情梗概"]'));
  const area=editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!;
  await input(area,"人工修改后的剧情");
  expect(vi.mocked(canvasApi).mock.calls.filter(([,m])=>m==="PATCH")).toHaveLength(0);
  expect(button(editor,"第 2 集 · 第2集")?.disabled??editor.querySelector<HTMLButtonElement>('[aria-label="选择候选第 2 集：第2集"]')?.disabled).toBe(true);
  expect(button(details,"采用到草案").disabled).toBe(true);
  await click(details.querySelector("summary"));expect(details.open).toBe(true);
  await click(editor.querySelector('[aria-label="保存候选剧情梗概"]'));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/runs/run/episodes/ep0"),"PATCH",{expectedRevision:0,changes:{synopsis:"人工修改后的剧情"}});
  expect(editor.textContent).toContain("人工修改后的剧情");
  expect(editor.textContent).toContain("已手动修改");
  expect(workspace.querySelector('[data-drama-feedback="success"]')?.textContent).toContain("正式草案未改变");
  expect(change).not.toHaveBeenCalled();
  await click(button(details,"采用到草案"));
  expect(adopt).toHaveBeenCalledWith(expect.stringContaining("/runs/run/adopt"),undefined,1);
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="编辑剧情梗概"]')?.disabled).toBe(true);
 });
 it("cancels a field and uses the workspace guard to save or discard before navigation",async()=>{
  const {workspace,details,change}=await mount();
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑集标题"]'));
  await input(editor.querySelector<HTMLInputElement>('input[aria-label="集标题"]')!,"不保存的标题");
  await click(editor.querySelector('[data-drama-action="cancel"]'));
  expect(editor.textContent).not.toContain("不保存的标题");
  await click(editor.querySelector('[aria-label="编辑本集结尾"]'));
  await input(editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="本集结尾"]')!,"需要保存的结尾");
  await click(button(workspace,"剧集编辑"));
  const guard=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent?.includes("存在未提交的候选修改"))!;
  expect(guard).toBeTruthy();
  await click(button(guard,"保存候选"));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/runs/run/episodes/ep0"),"PATCH",{expectedRevision:0,changes:{ending:"需要保存的结尾"}});
  expect(workspace.querySelector('nav button[aria-pressed="true"]')?.textContent).toContain("剧集编辑");
  await click(button(workspace,"生成候选"));
  const returned=workspace.querySelector("[data-episode-candidate-editor]")!;
  expect(returned.textContent).toContain("需要保存的结尾");
  await click(returned.querySelector('[aria-label="编辑本集结尾"]'));
  await input(returned.querySelector<HTMLTextAreaElement>('textarea[aria-label="本集结尾"]')!,"丢弃的结尾");
  await click(button(workspace,"剧集编辑"));
  await click(button(document,"放弃修改"));
  await click(button(workspace,"生成候选"));
  expect(workspace.querySelector("[data-episode-candidate-editor]")?.textContent).not.toContain("丢弃的结尾");
  expect(vi.mocked(canvasApi).mock.calls.filter(([,m])=>m==="PATCH")).toHaveLength(1);
  expect(change).not.toHaveBeenCalled();
 });
 it("removes a single episode then the whole run using confirmation and the reviewed revision",async()=>{
  const {details,workspace,change,getRemote}=await mount();
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="删除候选剧集 第1集"]'));
  expect(button(details,"采用到草案").disabled).toBe(true);
  expect(vi.mocked(canvasApi).mock.calls.filter(([,m])=>m==="DELETE")).toHaveLength(0);
  await click(button(editor,"确认删除候选"));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/episodes/ep0?expectedRevision=0"),"DELETE",undefined);
  expect(editor.textContent).toContain("采用时保留原内容");
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="删除候选剧集 第2集"]')?.disabled).toBe(true);
  await click(button(editor,"删除生成记录"));
  await click(button(editor,"确认删除候选"));
  expect(getRemote().status).toBe("discarded");
  expect(workspace.querySelector("[data-episode-candidate-editor]")).toBeNull();
  expect(workspace.textContent).toContain("暂无生成候选记录");
  expect(change).not.toHaveBeenCalled();
 });
 it("preserves unsaved input on conflict and keeps stale responses from replacing a committed edit",async()=>{
  const {workspace,details,setConflict,setListOverride,summarized}=await mount();
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑剧情梗概"]'));
  await input(editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!,"待保留修改");
  setConflict(true);
  await click(editor.querySelector('[aria-label="保存候选剧情梗概"]'));
  expect(editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')?.value).toBe("待保留修改");
  expect(editor.textContent).toContain("候选已在其他位置更新");
  expect(button(details,"采用到草案").disabled).toBe(true);
  setConflict(false);
  const old=summarized(),pending=deferred<DramaRun[]>();setListOverride(pending.promise);
  await act(async()=>{await new Promise(r=>setTimeout(r,3100));});
  await click(editor.querySelector('[aria-label="保存候选剧情梗概"]'));
  expect(editor.textContent).toContain("待保留修改");
  await act(async()=>pending.resolve(old));
  expect(editor.querySelector('[data-episode-readonly="synopsis"]')?.textContent).toContain("待保留修改");
  expect(workspace.textContent).toContain("已手动修改");
 },10000);
 it("uses server-normalized event edits and the shared structural sequence editor",async()=>{
  const {details,change}=await mount();
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑剧情事件（每行一条）"]'));
  await input(editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情事件"]')!,"新增事件");
  await click(editor.querySelector('[aria-label="保存候选剧情事件（每行一条）"]'));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/episodes/ep0"),"PATCH",{expectedRevision:0,changes:{events:["新增事件"]}});
  await click(button(editor,"添加场次"));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/episodes/ep0"),"PATCH",{expectedRevision:1,changes:{sequences:expect.arrayContaining([expect.objectContaining({title:"新场次 2"})])}});
  expect(editor.textContent).toContain("新场次 2");
  await click(editor.querySelector('[aria-label="编辑目标时长（秒）"]'));
  await input(editor.querySelector<HTMLInputElement>('input[aria-label="目标时长（秒）"]')!,"");
  await click(editor.querySelector('[aria-label="保存候选目标时长（秒）"]'));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/episodes/ep0"),"PATCH",{expectedRevision:2,changes:{targetDurationSec:null}});
  expect(change).not.toHaveBeenCalled();
 });
 it("mounts only the selected episode editor for a 100-episode candidate",async()=>{
  const {details}=await mount({workspaceMode:false,initialCount:100});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  expect(editor.querySelectorAll('[aria-label^="选择候选第"]')).toHaveLength(100);
  expect(editor.querySelectorAll('[data-episode-editor-layout]')).toHaveLength(1);
  await click(editor.querySelector('[aria-label="选择候选第 100 集：第100集"]'));
  expect(editor.querySelector('[data-episode-readonly="title"]')?.textContent).toContain("第100集");
  expect(editor.querySelectorAll('[data-episode-editor-layout]')).toHaveLength(1);
 });
});
