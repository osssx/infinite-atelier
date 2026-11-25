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
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;vi.restoreAllMocks();vi.unstubAllGlobals();});
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
async function mount({workspaceMode=true,appearance="dark",initialRevision=0,initialCount=2,optimize}:{workspaceMode?:boolean;appearance?:"light"|"dark";initialRevision?:number;initialCount?:number;optimize?:(payload:any,signal?:AbortSignal)=>Promise<unknown>}={}){
 await act(async()=>useThemeStore.setState({theme:appearance}));
 const episodes=Array.from({length:initialCount},(_,i)=>ep("ep"+i,"第"+(i+1)+"集"));
 let remote:DramaRun={id:"run",episodeId:"*",status:"ready",candidate:{revision:initialRevision,episodes}};
 let listOverride:Promise<DramaRun[]>|null=null;
 let conflict=false;
 const change=vi.fn(),adopt=vi.fn(async(_path:string,_shots?:string[],revision?:number,review?:{reviewToken:string;episodeIds?:string[]})=>{
  expect(revision).toBe(remote.candidate?.revision);expect(review?.reviewToken).toBe("review-"+revision);
  if(conflict)throw Error("drama_episode_review_conflict");
  const ids=review?.episodeIds??remote.candidate!.episodes!.map(item=>item.id);
  remote={...remote,status:"adopted",candidate:{...remote.candidate,adoption:{mode:review?.episodeIds?"selected":"all",episodeIds:ids,appliedEpisodeIds:ids}}};
 });
 const summarized=()=>remote.status==="discarded"?[]:[{...remote,candidate:{...remote.candidate,episodeCount:remote.candidate?.episodes?.length,episodes:[]}}];
 vi.mocked(canvasApi).mockImplementation((async(path:string,method="GET",payload?:any,signal?:AbortSignal)=>{
  if((path.endsWith("/optimize")||path.endsWith("/optimize-episode"))&&method==="POST"&&optimize)return optimize(payload,signal);
  if(path.includes("/dependencies?"))return {status:"current",changes:[]};
  if(path.includes("/runs?")){if(listOverride){const pending=listOverride;listOverride=null;return pending;}return summarized();}
  if(path.endsWith("/runs/run/preview")&&method==="GET"){
   const items=remote.candidate!.episodes!.map((after,index)=>({id:after.id,kind:"replaced",changed:true,reordered:false,
    beforeIndex:index,afterIndex:index,before:episodes.find(item=>item.id===after.id),after,fields:["synopsis"],issues:[],blocked:false,selectable:true,
    impact:{storyboards:1,shots:2,configs:1,missingSceneShots:0,missingEpisodeShots:0}}));
   return {runId:"run",stage:"episodes",status:"ready",revision:remote.candidate?.revision,reviewToken:"review-"+remote.candidate?.revision,
    sourceChanged:false,baselineChanged:false,identityConflict:false,globalBlocked:false,fullAdoptBlocked:false,impactUnknown:false,
    summary:{replaced:items.length},items};
  }
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
async function mockTextChannel(){
 const config=await import("@/stores/use-config-store"),routing=await import("@/features/backend-sync/model-channel-autoroute");
 vi.spyOn(config,"useEffectiveConfig").mockReturnValue({...config.defaultConfig,channelMode:"local",textModel:"test-model"});
 vi.spyOn(config,"resolveModelChannel").mockReturnValue({id:"channel",baseUrl:"http://localhost:1234",name:"测试渠道"} as ReturnType<typeof config.resolveModelChannel>);
 vi.spyOn(routing,"modelChannelProvider").mockReturnValue("openai_compatible");
 return vi.spyOn(routing,"ensureSqliteModelChannelForExecution").mockResolvedValue(undefined);
}
const optimizeResult=(payload:any,replacement:string,overrides:Record<string,unknown>={})=>{
 const start=payload.selection?.start??0,end=payload.selection?.end??payload.draft.length;
 return {runId:"run",episodeId:"ep0",revision:payload.expectedRevision,field:payload.field,sequenceId:payload.sequenceId,
  mode:payload.mode,start,end,replacement,value:payload.draft.slice(0,start)+replacement+payload.draft.slice(end),...overrides};
};
describe("P3 local AI candidate optimization",()=>{
 it.each(["light","dark"] as const)("uses unsaved selected text, previews before applying, then saves only on explicit confirmation (%s)",async appearance=>{
  const ensure=await mockTextChannel();
  const optimize=vi.fn(async payload=>optimizeResult(payload,"新悬念"));
  const {workspace,details,getRemote,change}=await mount({appearance,optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑剧情梗概"]'));
  const field=editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!;
  const floating=editor.querySelector<HTMLButtonElement>('[data-episode-ai-input] button[aria-label="AI 优化"]')!;
  expect(floating.parentElement).toBe(field.parentElement);
  expect(floating.textContent).toBe("");
  expect(floating.classList.contains("absolute")).toBe(true);
  expect(field.classList.contains("pr-12")).toBe(true);
  await input(field,"前文｜人工片段｜后文");
  await act(async()=>{field.focus();field.setSelectionRange(3,7);});
  await click(editor.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  expect(button(editor,"选区改写").getAttribute("aria-pressed")).toBe("true");
  await input(editor.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!,"增加冲突");
  await click(button(editor,"生成优化建议"));
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(optimize).toHaveBeenCalledWith(expect.objectContaining({expectedRevision:0,field:"synopsis",mode:"selection",draft:"前文｜人工片段｜后文",selection:{start:3,end:7},instruction:"增加冲突"}),expect.any(AbortSignal));
  const preview=editor.querySelector("[data-episode-ai-preview]")!;
  expect(preview.textContent).toContain("前文｜新悬念｜后文");
  expect(field.value).toBe("前文｜人工片段｜后文");
  expect(getRemote().candidate?.revision).toBe(0);
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="保存候选剧情梗概"]')!.disabled).toBe(true);
  await click(button(workspace,"剧集编辑"));
  const guard=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent?.includes("存在未提交的候选修改"))!;
  await click(button(guard,"保存候选"));
  expect(guard.textContent).toContain("请先应用或放弃 AI 优化建议");
  await click(button(guard,"继续编辑"));
  await click(button(editor,"应用到编辑内容"));
  expect(field.value).toBe("前文｜新悬念｜后文");
  expect(vi.mocked(canvasApi).mock.calls.filter(([,method])=>method==="PATCH")).toHaveLength(0);
  await click(editor.querySelector('[aria-label="保存候选剧情梗概"]'));
  expect(getRemote().candidate?.episodes?.[0].synopsis).toBe("前文｜新悬念｜后文");
  expect(getRemote().candidate?.revision).toBe(1);
  expect(change).not.toHaveBeenCalled();
 });
 it("regenerates with new instructions, rejects mismatched responses and permits discarding without writing",async()=>{
  await mockTextChannel();
  const optimize=vi.fn(async payload=>optimizeResult(payload,"优化一"));
  const {details,getRemote}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑集标题"]'));
  const field=editor.querySelector<HTMLInputElement>('input[aria-label="集标题"]')!;
  await input(field,"手写标题");
  await click(editor.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  const instruction=editor.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!;
  await input(instruction,"更短");
  await click(button(editor,"生成优化建议"));
  expect(editor.querySelector("[data-episode-ai-preview]")?.textContent).toContain("优化一");
  await input(instruction,"更具悬念");
  optimize.mockImplementationOnce(async payload=>optimizeResult(payload,"越权",{episodeId:"ep1"}));
  await click(button(editor,"重新优化"));
  expect(editor.querySelector("[data-episode-ai-preview]")).toBeNull();
  expect(editor.textContent).toContain("模型返回的优化内容格式不正确");
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="保存候选集标题"]')!.disabled).toBe(false);
  optimize.mockImplementationOnce(async payload=>optimizeResult(payload,"优化二"));
  await click(button(editor,"生成优化建议"));
  expect(optimize.mock.lastCall?.[0]).toMatchObject({draft:"手写标题",instruction:"更具悬念",mode:"field"});
  await click(button(editor,"放弃建议"));
  expect(field.value).toBe("手写标题");
  expect(getRemote().candidate?.revision).toBe(0);
  await click(editor.querySelector('[data-drama-action="cancel"]'));
  expect(editor.textContent).not.toContain("手写标题");
 });
 it("aborts and ignores an outdated model response after manual typing or cancel",async()=>{
  await mockTextChannel();
  const late=deferred<unknown>();let requestPayload:any,requestSignal:AbortSignal|undefined;
  const optimize=vi.fn((payload:any,signal?:AbortSignal)=>{requestPayload=payload;requestSignal=signal;return late.promise;});
  const {details,getRemote}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑本集结尾"]'));
  const field=editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="本集结尾"]')!;
  await input(field,"人工结尾");
  await click(editor.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  await input(editor.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!,"留下悬念");
  await click(button(editor,"生成优化建议"));
  expect(button(editor,"停止等待")).toBeTruthy();
  await input(field,"后来手工修改");
  expect(requestSignal?.aborted).toBe(true);
  await act(async()=>late.resolve(optimizeResult(requestPayload,"迟到结果")));
  expect(editor.querySelector("[data-episode-ai-preview]")).toBeNull();
  expect(field.value).toBe("后来手工修改");
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="保存候选本集结尾"]')!.disabled).toBe(false);
  const late2=deferred<unknown>();
  optimize.mockImplementationOnce((payload,signal)=>{requestPayload=payload;requestSignal=signal;return late2.promise;});
  await click(button(editor,"生成优化建议"));
  await click(editor.querySelector('[data-drama-action="cancel"]'));
  expect(requestSignal?.aborted).toBe(true);
  await act(async()=>late2.resolve(optimizeResult(requestPayload,"关闭后的结果")));
  expect(editor.querySelector("[data-episode-ai-preview]")).toBeNull();
  expect(getRemote().candidate?.revision).toBe(0);
 });
 it("cancels during channel preparation and never issues a late model POST",async()=>{
  const ensure=await mockTextChannel(),preparing=deferred<void>();
  ensure.mockImplementationOnce(()=>preparing.promise);
  const optimize=vi.fn(async payload=>optimizeResult(payload,"不应发出"));
  const {details}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑剧情梗概"]'));
  await click(editor.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  await input(editor.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!,"优化");
  await click(button(editor,"生成优化建议"));
  await click(button(editor,"停止等待"));
  await act(async()=>preparing.resolve(undefined));
  expect(optimize).not.toHaveBeenCalled();
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="保存候选剧情梗概"]')!.disabled).toBe(false);
 });
 it("optimizes only the scene name and keeps existing scene references",async()=>{
  await mockTextChannel();
  const optimize=vi.fn(async payload=>optimizeResult(payload,"悬念场次"));
  const {details,getRemote}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  const sequence=editor.querySelector('section[aria-label="场次规划"] details')!;
  await click(sequence.querySelector("summary"));
  await click(sequence.querySelector('[aria-label="编辑场次 1 详情"]'));
  const title=sequence.querySelector<HTMLInputElement>('input[aria-label="场次 1 名称"]')!;
  expect(sequence.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]')?.parentElement).toBe(title.parentElement);
  expect(title.classList.contains("pr-12")).toBe(true);
  await input(title,"人工场名");
  await click(sequence.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  await input(sequence.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!,"突出悬念");
  await click(button(sequence,"生成优化建议"));
  expect(optimize.mock.lastCall?.[0]).toMatchObject({field:"sequenceTitle",sequenceId:"ep0-scene",draft:"人工场名"});
  await click(button(sequence,"应用到编辑内容"));
  expect(title.value).toBe("悬念场次");
  expect(getRemote().candidate?.revision).toBe(0);
  await click(sequence.querySelector('[aria-label="保存候选场次 1 详情"]'));
  expect(getRemote().candidate?.episodes?.[0].sequences?.[0]).toMatchObject({id:"ep0-scene",title:"悬念场次",eventRefs:["ep0-event"]});
 });
});
describe("P4 multi-round and whole episode optimization",()=>{
 it("uses only applied local instructions, supports undo and keeps later manual edits",async()=>{
  await mockTextChannel();
  const optimize=vi.fn(async payload=>optimizeResult(payload,payload.previousInstructions?.length?"第二轮":"第一轮"));
  const {details,getRemote}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(editor.querySelector('[aria-label="编辑剧情梗概"]'));
  const field=editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!;
  await input(field,"人工草稿");
  const open=()=>click(editor.querySelector('[data-episode-ai-input] button[aria-label="AI 优化"]'));
  const generate=async(instruction:string)=>{await open();await input(editor.querySelector<HTMLTextAreaElement>('[aria-label="候选 AI 修改意见"]')!,instruction);await click(button(editor,"生成优化建议"));await click(button(editor,"应用到编辑内容"));};
  await generate("第一条意见");expect(field.value).toBe("第一轮");
  await generate("第二条意见");expect(field.value).toBe("第二轮");
  expect(optimize.mock.lastCall?.[0]).toMatchObject({draft:"第一轮",previousInstructions:["第一条意见"],instruction:"第二条意见"});
  await click(button(editor,"撤销上次 AI 修改"));expect(field.value).toBe("第一轮");
  await click(button(editor,"撤销上次 AI 修改"));expect(field.value).toBe("人工草稿");
  await generate("第三条意见");expect(optimize.mock.lastCall?.[0].previousInstructions).toBeUndefined();
  await input(field,"手工继续修改");expect(button(editor,"撤销上次 AI 修改").disabled).toBe(true);
  expect(getRemote().candidate?.revision).toBe(0);
 });
 it.each(["light","dark"] as const)("previews, groups dependent fields, applies a subset, iterates and saves one atomic patch (%s)",async appearance=>{
  await mockTextChannel();
  const changes={synopsis:"整集梗概",events:["新事件"],scenePlans:[{title:"新场次",eventIndices:[0]}],ending:"未选结尾"};
  const optimize=vi.fn(async(payload:any)=>({runId:"run",episodeId:"ep0",revision:payload.expectedRevision,
   changes:payload.previousInstructions.length?{synopsis:"二轮梗概"}:changes,linkedFields:payload.previousInstructions.length?[]:["events","scenePlans"],warnings:[]}));
  const {details,workspace,getRemote,change,setConflict}=await mount({appearance,optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(button(editor,"整集 AI 优化"));
  const panel=editor.querySelector("[data-whole-episode-optimize]")!;
  expect(button(details,"采用到草案").disabled).toBe(true);
  expect(editor.querySelector<HTMLButtonElement>('[aria-label^="选择候选第 2"]')?.disabled).toBe(true);
  await click([...panel.querySelectorAll("label")].find(label=>label.textContent==="场次规划")?.querySelector("input"));
  const instruction=panel.querySelector<HTMLTextAreaElement>('[aria-label="整集 AI 修改意见"]')!;
  await input(instruction,"第一轮整集优化");
  await click(button(panel,"生成整集建议"));
  expect(panel.querySelector("[data-whole-episode-preview]")?.textContent).toContain("新场次");
  const event=panel.querySelector<HTMLInputElement>('[aria-label="应用剧情事件"]')!,scene=panel.querySelector<HTMLInputElement>('[aria-label="应用场次规划"]')!;
  await click(event);expect(event.checked).toBe(false);expect(scene.checked).toBe(false);
  await click(scene);expect(event.checked).toBe(true);expect(scene.checked).toBe(true);
  // Only accept synopsis for the first round; the dependent pair and ending are excluded.
  await click(scene);await click(panel.querySelector('[aria-label="应用本集结尾"]'));
  await click(button(panel,"应用选中修改"));
  expect(panel.querySelector("[data-whole-episode-draft]")?.textContent).toContain("整集梗概");
  expect(panel.querySelector("[data-whole-episode-draft]")?.textContent).not.toContain("新事件");
  expect(getRemote().candidate?.revision).toBe(0);
  await input(instruction,"第二轮继续");
  await click(button(panel,"生成整集建议"));
  expect(optimize.mock.lastCall?.[0]).toMatchObject({draftChanges:{synopsis:"整集梗概"},previousInstructions:["第一轮整集优化"]});
  await click(button(panel,"应用选中修改"));
  await click(button(panel,"撤销上轮整集修改"));
  expect(panel.querySelector("[data-whole-episode-draft]")?.textContent).toContain("整集梗概");
  setConflict(true);await click(button(panel,"保存整集候选"));
  expect(panel.textContent).toContain("候选已在其他位置更新");
  expect(panel.querySelector("[data-whole-episode-draft]")?.textContent).toContain("整集梗概");
  setConflict(false);await click(button(panel,"保存整集候选"));
  expect(vi.mocked(canvasApi)).toHaveBeenCalledWith(expect.stringContaining("/episodes/ep0"),"PATCH",{expectedRevision:0,wholeEpisode:true,changes:{synopsis:"整集梗概"}});
  expect(getRemote().candidate?.revision).toBe(1);
  expect(getRemote().candidate?.episodes?.[0].ending).toBe("第1集结尾");
  expect(editor.querySelector("[data-whole-episode-optimize]")).toBeNull();
  expect(change).not.toHaveBeenCalled();
  await click(button(workspace,"剧集编辑"));
 });
 it("guard blocks unresolved whole preview and aborts a late optimization on cancel",async()=>{
  await mockTextChannel();
  const late=deferred<unknown>();let signal:AbortSignal|undefined;
  const optimize=vi.fn((payload:any,s?:AbortSignal)=>{signal=s;return late.promise;});
  const {details,workspace,getRemote}=await mount({optimize});
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  await click(button(editor,"整集 AI 优化"));
  const panel=editor.querySelector("[data-whole-episode-optimize]")!;
  await input(panel.querySelector<HTMLTextAreaElement>('[aria-label="整集 AI 修改意见"]')!,"优化");
  await click(button(panel,"生成整集建议"));
  expect(button(panel,"保存整集候选").disabled).toBe(true);
  await click(button(workspace,"剧集编辑"));
  const guard=[...document.querySelectorAll('[role="dialog"]')].find(el=>el.textContent?.includes("存在未提交的候选修改"))!;
  await click(button(guard,"保存候选"));expect(guard.textContent).toContain("请先处理整集 AI 建议");
  await click(button(guard,"继续编辑"));
  await click(button(panel,"取消整集优化"));expect(signal?.aborted).toBe(true);
  await act(async()=>late.resolve({runId:"run",episodeId:"ep0",revision:0,changes:{synopsis:"迟到"},linkedFields:[],warnings:[]}));
  expect(editor.querySelector("[data-whole-episode-optimize]")).toBeNull();
  expect(getRemote().candidate?.revision).toBe(0);
 });
});
describe("P5 episode adoption review",()=>{
 it("requires explicit review and confirmation, shows impact and adopts only selected IDs",async()=>{
  const {details,adopt,getRemote}=await mount();
  await click(button(details,"采用到草案"));
  expect(adopt).not.toHaveBeenCalled();
  const review=details.querySelector("[data-episode-adoption-review]")!;
  expect(review.textContent).toContain("2 个镜头");
  expect(button(review,"采用所选剧集").disabled).toBe(true);
  await click(button(review,"查看对比"));
  expect(review.textContent).toContain("当前草案");
  expect(review.textContent).toContain("全量采用后");
  await click(review.querySelector('[aria-label="选择采用 第1集"]'));
  await click(button(review,"采用所选剧集"));
  expect(adopt).not.toHaveBeenCalled();
  await click(button(review,"确认采用"));
  expect(adopt).toHaveBeenCalledWith(expect.stringContaining("/runs/run/adopt"),undefined,0,{reviewToken:"review-0",episodeIds:["ep0"]});
  expect(getRemote().candidate?.adoption?.mode).toBe("selected");
  expect(details.textContent).toContain("未采用");
 });
 it("invalidates the reviewed snapshot after a conflict and requires a new review",async()=>{
  const {details,adopt,setConflict}=await mount();
  await click(button(details,"采用到草案"));
  const review=details.querySelector("[data-episode-adoption-review]")!;
  await click(button(review,"选择全部新增和修改"));
  await click(button(review,"采用所选剧集"));
  setConflict(true);
  await click(button(review,"确认采用"));
  expect(review.textContent).toContain("候选、草案或下游关联已变化");
  expect(button(review,"确认采用")).toBeUndefined();
  setConflict(false);
  await click(button(review,"刷新差异"));
  expect(button(review,"采用所选剧集").disabled).toBe(true);
  expect(adopt).toHaveBeenCalledTimes(1);
 });
});
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
  expect(adopt).not.toHaveBeenCalled();
  await click(button(details,"全量采用"));
  await click(button(details,"确认采用"));
  expect(adopt).toHaveBeenCalledWith(expect.stringContaining("/runs/run/adopt"),undefined,1,{reviewToken:"review-1"});
  expect(editor.querySelector<HTMLButtonElement>('[aria-label="编辑剧情梗概"]')?.disabled).toBe(true);
 });
 it("aligns candidate title and duration with the full episode editor and enlarges the event input",async()=>{
  const {details,change}=await mount();
  const editor=details.querySelector("[data-episode-candidate-editor]")!;
  const row=editor.querySelector("[data-episode-title-duration-row]")!;
  expect(row.classList.contains("md:grid-cols-[minmax(0,1fr)_190px]")).toBe(true);
  expect(row.querySelector('[data-episode-editable-field="title"]')).toBeTruthy();
  expect(row.querySelector('[data-episode-editable-field="duration"]')).toBeTruthy();
  await click(editor.querySelector('[aria-label="编辑剧情事件（每行一条）"]'));
  const input=editor.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情事件"]')!;
  expect(input.getAttribute("rows")).toBe("9");
  expect(input.classList.contains("resize-y")).toBe(true);
  expect(input.parentElement?.querySelector('[aria-label="AI 优化"]')).toBeTruthy();
  await click(editor.querySelector('[data-drama-action="cancel"]'));
  expect(change).not.toHaveBeenCalled();
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
