// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";

vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:vi.fn(async(path:string)=>path.includes("/drama-pipeline/runs?")
  ?[{id:"candidate-1",episodeId:"毛毛和豆豆",status:"ready"}]:{})
}));

import {DramaPipelineNodePanel} from "./drama-pipeline-node-panel";

const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;
 vi.unstubAllGlobals();
});


it("integrates reference controls within the asset draft editor and updates only the matching reference slot",async()=>{
 const {useState}=await import("react");
 const {AssetDirectoryContext,initialAssetDirectory}=await import("./drama-asset-directory-state");
 const {CanvasNodeType}=await import("@/types/canvas");
 const key1="cas:"+"a".repeat(64),key2="cas:"+"b".repeat(64),key3="cas:"+"c".repeat(64);
 const assets=[
  {id:"hero",kind:"character",name:"小猫",description:"白色小猫",sourceRefs:[],variants:[
   {id:"hero-day",name:"日常",description:"蓝色围巾"},{id:"hero-night",name:"夜间",description:"睡衣"}]},
  {id:"park",kind:"scene",name:"公园",description:"草地",sourceRefs:[],variants:[{id:"park-night",name:"夜景",description:"月光"}]},
  {id:"kite",kind:"prop",name:"风筝",description:"纸风筝",sourceRefs:[]},
 ];
 const draft=JSON.stringify({assets});
 const initial={id:"asset-node",type:"drama:assets",title:"资产规划",position:{x:0,y:0},metadata:{dramaDraft:draft,dramaAssetReferences:[
  {assetId:"hero",variantId:"hero-day",requiredForRendering:true,imageStorageKeys:[key1]},
  {assetId:"park",variantId:"park-night",requiredForRendering:true,imageStorageKeys:[key3]},
 ]}} as CanvasNodeData;
 const images=[key1,key2,key3].map((storageKey,i)=>({id:"image"+i,type:CanvasNodeType.Image,title:"图片"+i,position:{x:0,y:0},metadata:{storageKey}} as CanvasNodeData));
 const changes=vi.fn(),create=vi.fn();
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 function Host(){
  const [node,setNode]=useState(initial);
  const directory=useState(initialAssetDirectory);
  return <AssetDirectoryContext.Provider value={directory}>
   <DramaPipelineNodePanel node={node} workspaceMode workspaceTab="editor" imageNodes={images} onCreateReferenceConfig={create}
    onChange={patch=>{changes(patch);setNode(n=>({...n,metadata:{...n.metadata,...patch}}))}}/>
  </AssetDirectoryContext.Provider>;
 }
 const find=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===label)!;
 const click=async(el:HTMLElement)=>{expect(el).toBeTruthy();await act(async()=>el.click())};
 await act(async()=>root.render(<Host/>));
 expect(container.querySelector('[data-asset-field="description"]')).toBeTruthy();
 expect([...container.querySelectorAll("[data-asset-reference-slot]")].map(e=>e.getAttribute("data-asset-reference-slot"))).toEqual(["hero","hero-day","hero-night"]);
 expect(container.querySelector('[aria-label="资产提取范围"]')).toBeTruthy();
 expect(find("生成资产候选")).toBeTruthy();
 expect(container.textContent).toContain("参考图已绑定 2 / 6 个位置");
 const daily=container.querySelector('[data-asset-reference-slot="hero-day"]')!;
 const select=daily.querySelector<HTMLButtonElement>('button[aria-label="添加日常参考图"]')!;
 expect(daily.closest("section")?.querySelector('[data-asset-field="description"]')).toBeTruthy();
 await click(container.querySelector<HTMLButtonElement>('button[aria-label="编辑资产描述"]')!);
 expect(select.disabled).toBe(true);
 expect(daily.querySelector('button[aria-label="移除参考"]')).toBeNull();
 await click(container.querySelector<HTMLButtonElement>('[data-drama-action="cancel"]')!);
 expect(select.disabled).toBe(false);
 await click(select);
 const picker=daily.querySelector('[aria-label="选择日常参考图"]')!;
 expect(picker.querySelector('img[alt="图片0"]')).toBeNull();
 expect(picker.querySelector('img[alt="图片1"]')?.getAttribute("src")).toBe("/api/v1/blobs/"+key2.slice(4));
 expect(picker.querySelectorAll('button[aria-pressed]')).toHaveLength(2);
 const before=changes.mock.calls.length;
 await click(picker.querySelector<HTMLButtonElement>('button[aria-label="选择图片 图片1"]')!);
 expect(changes.mock.calls).toHaveLength(before);
 expect(picker.querySelectorAll('img[alt="图片1"]')).toHaveLength(2);
 await click(find("添加参考图"));
 expect(daily.querySelector('[aria-label="选择日常参考图"]')).toBeNull();
 expect(changes.mock.lastCall![0]).toEqual({dramaAssetReferences:expect.arrayContaining([
  expect.objectContaining({assetId:"hero",variantId:"hero-day",imageStorageKeys:[key1,key2]}),
  expect.objectContaining({assetId:"park",variantId:"park-night",imageStorageKeys:[key3]})
 ])});
 expect(daily.querySelectorAll('button[aria-label="移除参考"]')).toHaveLength(2);
 await click(daily.querySelector<HTMLButtonElement>('button[aria-label="移除参考"]')!);
 expect(changes.mock.lastCall![0].dramaAssetReferences).toEqual(expect.arrayContaining([
  expect.objectContaining({variantId:"hero-day",imageStorageKeys:[key2]}),
  expect.objectContaining({variantId:"park-night",imageStorageKeys:[key3]})
 ]));
 expect(changes.mock.calls.every(([patch])=>!Object.hasOwn(patch,"dramaDraft"))).toBe(true);
 await click(find("场景 1"));
 expect([...container.querySelectorAll("[data-asset-reference-slot]")].map(e=>e.getAttribute("data-asset-reference-slot"))).toEqual(["park","park-night"]);
 expect(container.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("公园");
 await click(find("道具 1"));
 expect(container.querySelector('[data-asset-reference-slot="kite"]')).toBeTruthy();
 await click(find("创建生图配置"));
 expect(create).toHaveBeenCalledWith("风筝",expect.stringContaining("纸风筝"));
});


it.each(["success","invalid","failed"] as const)("navigates to asset candidates only after successful generation (%s)",async outcome=>{
 const {useState}=await import("react");
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 const config=await import("@/stores/use-config-store");
 const routing=await import("@/features/backend-sync/model-channel-autoroute");
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const configSpy=vi.spyOn(config,"useEffectiveConfig").mockReturnValue({...config.defaultConfig,channelMode:"local"});
 const routingSpy=vi.spyOn(routing,"ensureSqliteModelChannelForExecution").mockResolvedValue(undefined);
 const proposed={id:"new-cat",kind:"character" as const,name:"小猫候选",description:"白色小猫",sourceRefs:[]};
 const draft=JSON.stringify({assets:[]});
 const initial={id:"generation-assets",type:"drama:assets",title:"资产规划",position:{x:0,y:0},metadata:{dramaDraft:draft}} as CanvasNodeData;
 const changes=vi.fn(),tabChanges=vi.fn();
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 function Host(){
  const [node,setNode]=useState(initial);
  return <DramaCreativeWorkspace projectId="p" nodeId={node.id} kind="assets" focus={{}} versionConfirmed={false}
   candidateCount={node.metadata?.dramaAssetCandidate?.assets.length??0} onClose={async()=>{}} onTabChange={tabChanges}
   renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} workspaceMode workspaceTab={tab==="settings"?"editor":tab}
    projectId="p" upstreamText="故事原文" onPendingChange={onPendingChange}
    onChange={patch=>{changes(patch);setNode(n=>({...n,metadata:{...n.metadata,...patch}}))}}/>}/>;
 }
 try{
  await act(async()=>root.render(<Host/>));
  const workspace=document.querySelector('[data-creative-workspace-node-id="generation-assets"]')!;
  const active=()=>workspace.querySelector('nav button[aria-pressed="true"]')?.textContent?.trim();
  expect(active()).toBe("资产编辑");
  if(outcome==="failed")vi.mocked(canvasApi).mockRejectedValueOnce(new Error("生成请求失败"));
  else vi.mocked(canvasApi).mockResolvedValueOnce({answer:outcome==="success"?JSON.stringify({assets:[proposed]}):"invalid"});
  const button=[...workspace.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()==="生成资产候选")!;
  expect(button).toBeTruthy();
  await act(async()=>button.click());
  if(outcome==="success"){
   expect(changes).toHaveBeenCalledWith({dramaAssetCandidate:{id:expect.any(String),baseline:draft,assets:[proposed]}});
   expect(active()).toBe("生成候选 · 1");
   expect(tabChanges).toHaveBeenCalledWith("runs");
   expect(workspace.querySelector("[data-asset-candidate-review]")?.textContent).toContain("小猫候选");
  }else{
   expect(changes).not.toHaveBeenCalled();
   expect(tabChanges).not.toHaveBeenCalled();
   expect(active()).toBe("资产编辑");
   expect(workspace.textContent).toContain(outcome==="failed"?"生成请求失败":"模型返回的资产格式有误");
  }
 }finally{configSpy.mockRestore();routingSpy.mockRestore();}
});

it.each((["episodes","storyboard"] as const).flatMap(kind=>[...(["ready","failed","cancelled","rejected"] as const).map(outcome=>({kind,outcome,visitHistory:false})),{kind,outcome:"ready" as const,visitHistory:true}]))(
 "navigates from $kind to candidates only for a ready generation ($outcome, history=$visitHistory)",async({kind,outcome,visitHistory})=>{
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 const config=await import("@/stores/use-config-store");
 const routing=await import("@/features/backend-sync/model-channel-autoroute");
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const configSpy=vi.spyOn(config,"useEffectiveConfig").mockReturnValue({...config.defaultConfig,channelMode:"local"});
 const routingSpy=vi.spyOn(routing,"ensureSqliteModelChannelForExecution").mockResolvedValue(undefined);
 const originalApi=vi.mocked(canvasApi).getMockImplementation()!;
 const episode={id:"ep-1",title:"第一集",synopsis:"故事",ending:"",events:[],sourceRefs:[]};
 const shot={id:"s1",episodeId:episode.id,order:1,description:"新镜头候选",characterVariantIds:[],propIds:[],keyPropIds:[]};
 const upstreamArtifacts=[JSON.stringify({assets:[]}),JSON.stringify({episodes:[episode]})];
 const isEpisode=kind==="episodes";
 const node={id:"run-generation-"+kind,type:"drama:"+kind,title:isEpisode?"剧集规划":"分镜配置",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify(isEpisode?{episodes:[episode]}:{shots:[]})}} as CanvasNodeData;
 const oldRun={id:"old-ready",episodeId:"old",status:"ready",candidate:{episodes:[{...episode,id:"old",title:"历史候选"}]}};
 const result={id:"new-run",episodeId:episode.id,status:outcome,candidate:outcome==="ready"?(isEpisode?{episodes:[episode]}:{shots:[shot]}):null,
  ...(outcome==="failed"?{error:"drama_candidate_invalid"}:{})};
 let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 let completed=false;
 const submit=vi.fn();
 vi.mocked(canvasApi).mockImplementation((async(path:string,method?:string)=>{
  if(path.endsWith("/drama-pipeline/runs")&&method==="POST"){
   submit();await pending;
   if(outcome==="rejected")throw new Error("生成请求失败");
   completed=true;return result;
  }
  if(path.includes("/drama-pipeline/dependencies?"))return {status:"current",changes:[]};
  if(path.endsWith("/new-run"))return result;
  if(path.endsWith("/new-run/preview"))return {runId:"new-run",status:"ready",sourceChanged:false,fullAdoptBlocked:false,manualExtraIds:[],
   items:[{id:shot.id,kind:"added",changed:true,reordered:false,conflict:false,adopted:false,after:{order:1,description:shot.description}}],
   summary:{added:1,replaced:0,deleted:0,reordered:0,unchanged:0,conflicts:0}};
  if(path.includes("/drama-pipeline/runs?"))return completed?[oldRun,{...result,candidate:outcome==="ready"?(isEpisode?{episodeCount:1}:{shotCount:1}):null}]:[oldRun];
  return {};
 }) as typeof canvasApi);
 const changes=vi.fn(),tabChanges=vi.fn(),saveBeforeRun=vi.fn(async()=>{});
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 try{
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p" nodeId={node.id} kind={kind} focus={{}} versionConfirmed={false}
   onClose={async()=>{}} onTabChange={tabChanges}
   renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} workspaceMode workspaceTab={tab==="settings"?"editor":tab}
    projectId="p" upstreamText="故事原文" upstreamArtifacts={upstreamArtifacts} onPendingChange={onPendingChange}
    onBeforeDramaRun={saveBeforeRun} onChange={changes}/>} renderHistoryPanel={()=> <div>历史记录</div>}/>));
  const workspace=document.querySelector('[data-creative-workspace-node-id="'+node.id+'"]')!;
  const active=()=>workspace.querySelector('nav button[aria-pressed="true"]')?.textContent?.trim();
  const editor=isEpisode?"剧集编辑":"镜头编辑";
  expect(active()).toBe(editor);
  const button=[...workspace.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===(isEpisode?"生成剧集候选":"生成分镜候选"))!;
  expect(button).toBeTruthy();
  await act(async()=>button.click());
  expect(saveBeforeRun).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-drama-task-status]")?.textContent).toContain("模型生成与校验");
  expect(active()).toBe(editor);
  expect(tabChanges).not.toHaveBeenCalled();
  if(visitHistory){
   const history=[...workspace.querySelectorAll<HTMLButtonElement>("nav button")].find(b=>b.textContent?.trim()==="影响与历史")!;
   await act(async()=>history.click());
   expect(active()).toBe("影响与历史");
   expect(document.querySelector("[data-drama-task-status]")?.textContent).toContain("模型生成与校验");
   tabChanges.mockClear();
  }
  await act(async()=>finish());
  expect(document.querySelector("[data-drama-task-status]")).toBeNull();
  if(outcome==="ready"){
   expect(active()).toBe("生成候选");
   expect(tabChanges).toHaveBeenCalledExactlyOnceWith("runs");
   expect(workspace.querySelector("[data-drama-runs-panel]")).toBeTruthy();
   const cards=[...workspace.querySelectorAll<HTMLDetailsElement>("[data-drama-run-scroll-region] details")];
   expect(cards).toHaveLength(2);
   const newest=cards.find(item=>item.querySelector("summary")?.textContent?.includes("第一集"))!;
   const historical=cards.find(item=>item.querySelector("summary")?.textContent?.includes("old"))!;
   expect(newest).toBeTruthy();
   expect(newest.open).toBe(true);
   expect(historical.open).toBe(false);
   expect(newest.textContent).toContain("待采用");
   expect(newest.querySelector("summary")?.textContent).not.toContain("ready");
   expect(workspace.querySelector('[data-drama-feedback="success"]')?.textContent).toContain("生成成功");
   if(isEpisode)expect(newest.querySelector("article")?.textContent).toContain("故事");
   else{
    expect(newest.querySelector('[aria-label="分镜候选差异预览"]')?.textContent).toContain("新镜头候选");
    expect(vi.mocked(canvasApi).mock.calls.filter(([path])=>path.endsWith("/new-run/preview"))).toHaveLength(1);
   }
   await act(async()=>{newest.open=false;newest.dispatchEvent(new Event("toggle"));});
   expect(newest.open).toBe(false);
  }else{
   expect(active()).toBe(editor);
   expect(tabChanges).not.toHaveBeenCalled();
   expect(workspace.textContent).toContain(outcome==="failed"?"drama_candidate_invalid":outcome==="cancelled"?"已取消生成":"生成请求失败");
   expect(workspace.querySelector(`[data-drama-feedback="${outcome==="cancelled"?"info":"error"}"]`)).toBeTruthy();
  }
  expect(changes).not.toHaveBeenCalled();
 }finally{
  finish();
  configSpy.mockRestore();routingSpy.mockRestore();
  vi.mocked(canvasApi).mockImplementation(originalApi);
 }
});

it("focuses the canonical adopted asset on its actual directory page after atomic adoption",async()=>{
 const {useState}=await import("react");
 const {AssetDirectoryContext,AssetReviewNavigationContext,initialAssetDirectory}=await import("./drama-asset-directory-state");
 const existing=Array.from({length:12},(_,i)=>({id:"old-"+i,kind:"scene",name:"场景 "+i,description:"旧描述",sourceRefs:[]}));
 const proposed={id:"temporary",kind:"scene" as const,name:"新场景",description:"新描述",sourceRefs:[]};
 const baseline=JSON.stringify({assets:existing});
 const initial={id:"assets",type:"drama:assets",title:"资产规划",position:{x:0,y:0},width:400,height:300,metadata:{dramaDraft:baseline,
  dramaAssetCandidate:{id:"batch",baseline,assets:[proposed]}}} as CanvasNodeData;
 const committed={...initial,metadata:{...initial.metadata,dramaDraft:JSON.stringify({assets:[...existing,{...proposed,id:"canonical"}]}),dramaAssetCandidate:undefined}};
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const adoption=vi.fn();
 function Host(){
  const [node,setNode]=useState(initial),[tab,setTab]=useState<"runs"|"editor">("runs");
  const directory=useState(initialAssetDirectory);
  return <AssetDirectoryContext.Provider value={directory}>
   <AssetReviewNavigationContext.Provider value={()=>setTab("editor")}>
    <DramaPipelineNodePanel node={node} onChange={()=>{}} workspaceMode workspaceTab={tab} projectId="p"
     onAdoptDramaAssetCandidate={async(path,command)=>{
      adoption(path,command);setNode(committed);
      return {id:"p",revision:2,document:{nodes:[committed],connections:[]},mapping:{assetIds:{temporary:"canonical"},variantIds:{}}};
     }}/>
   </AssetReviewNavigationContext.Provider>
  </AssetDirectoryContext.Provider>;
 }
 await act(async()=>root.render(<Host/>));
 const click=async(text:string)=>{const b=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;expect(b).toBeTruthy();await act(async()=>b.click());};
 await click("筛选项全部新增");
 await click("合入所选资产");
 expect(adoption).toHaveBeenCalledTimes(1);
 expect(adoption.mock.lastCall![1]).toMatchObject({nodeId:"assets",candidateId:"batch",decisions:{temporary:{action:"new"}}});
 expect(container.querySelector("[data-asset-candidate-review]")).toBeNull();
 expect(container.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("新场景");
 expect(container.querySelector('aside')?.textContent).toContain("2/2");
 expect(container.querySelector('aside button[aria-pressed="true"]:not([aria-label])')?.textContent).toBeTruthy();
});

it("keeps a real gap between candidate title and unshrunk status label",async()=>{
 const node={id:"episodes-1",type:"drama:episodes",title:"剧集规划",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({episodes:[]})}} as CanvasNodeData;
 const container=document.createElement("div");
 document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>{
  root.render(<DramaPipelineNodePanel node={node} onChange={()=>{}}
   projectId="project-1" workspaceMode workspaceTab="runs"/>);
 });
 await act(async()=>await Promise.resolve());
 const summary=[...container.querySelectorAll("details summary")].find(
  item=>item.textContent?.includes("待采用"));
 expect(summary).toBeTruthy();
 const content=summary?.querySelector<HTMLElement>("[data-drama-run-summary-content]");
 expect(content?.classList.contains("gap-2")).toBe(true);
 expect(content?.classList.contains("items-center")).toBe(true);
 expect(content?.children).toHaveLength(2);
 expect(content?.children[0].classList.contains("flex-1")).toBe(true);
 expect(content?.children[0].classList.contains("truncate")).toBe(true);
 expect(content?.children[1].classList.contains("shrink-0")).toBe(true);
 expect(content?.children[1].classList.contains("whitespace-nowrap")).toBe(true);
 expect(content?.children[0].textContent).toContain("毛毛和豆豆");
 expect(content?.children[1].textContent).toBe("待采用");
});

it.each(["light","dark"] as const)("keeps long expanded run cards in a single themed scroll region in %s mode",async appearance=>{
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const {useThemeStore}=await import("@/stores/use-theme-store");
 const {canvasThemes}=await import("@/lib/canvas-theme");
 const candidates=Array.from({length:3},(_,i)=>({id:"long-"+i,episodeId:"*",status:"ready",
  candidate:{episodes:[{id:"ep-"+i,title:"候选 "+i,synopsis:"长剧情".repeat(400),
   events:Array.from({length:30},(_,j)=>"事件 "+j),ending:"结尾 "+i}]}}));
 vi.mocked(canvasApi).mockResolvedValueOnce(candidates);
 await act(async()=>useThemeStore.setState({theme:appearance}));
 const node={id:"episodes-long",type:"drama:episodes",title:"剧集规划",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({episodes:[]})}} as CanvasNodeData;
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const adopt=vi.fn(async()=>{});
 await act(async()=>root.render(<DramaPipelineNodePanel node={node} onChange={()=>{}}
  projectId="project-1" workspaceMode workspaceTab="runs" onAdoptDramaRun={adopt}/>));
 const header=container.querySelector<HTMLElement>("[data-drama-runs-panel]")!;
 const scroll=container.querySelector<HTMLElement>("[data-drama-run-scroll-region]")!;
 expect(header.classList.contains("shrink-0")).toBe(true);
 expect(scroll.previousElementSibling).toBe(header);
 expect(scroll.getAttribute("aria-label")).toBe("生成候选列表");
 expect(scroll.tabIndex).toBe(0);
 for(const name of ["min-h-0","flex-1","overflow-y-auto","overscroll-contain","thin-scrollbar"])
  expect(scroll.classList.contains(name)).toBe(true);
 const theme=canvasThemes[appearance];
 expect(scroll.style.scrollbarColor).toContain(theme.node.code.scrollbar);
 expect(scroll.style.scrollbarGutter).toBe("auto");
 const cards=[...scroll.querySelectorAll<HTMLDetailsElement>("details")];
 expect(cards).toHaveLength(3);
 for(const card of cards){
  expect(card.classList.contains("shrink-0")).toBe(true);
  expect(card.classList.contains("overflow-hidden")).toBe(false);
  await act(async()=>{card.open=true;card.dispatchEvent(new Event("toggle"));});
  expect(card.querySelectorAll('[data-episode-readonly="events"] li')).toHaveLength(30);
  expect(card.querySelector('[data-episode-readonly="synopsis"]')?.textContent).toContain("长剧情");
 }
 const last=cards[2];
 expect(last.textContent).toContain("结尾 2");
 const action=[...last.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="采用到草案")!;
 expect(action.style.background).toBe(theme.node.activeStroke);
 expect(adopt).not.toHaveBeenCalled();
 await act(async()=>action.click());
 expect(adopt).toHaveBeenCalledWith(expect.stringContaining("/long-2/adopt"),undefined,0);
});

it.each(["dark","light"] as const)("matches episode planning footer button sizing and theme in %s mode",async appearance=>{
 const {useThemeStore}=await import("@/stores/use-theme-store");
 const {canvasThemes}=await import("@/lib/canvas-theme");
 await act(async()=>useThemeStore.setState({theme:appearance}));
 const cases=[
  {id:"episodes",type:"drama:episodes",draft:{episodes:[{id:"ep-1",title:"毛毛和豆豆",synopsis:"",ending:"",events:[],sourceRefs:[]}]},
   label:"剧集生成与确认操作",validate:"校验剧集",generate:"生成剧集候选"},
  {id:"storyboard",type:"drama:storyboard",draft:{shots:[{id:"shot-1",episodeId:"ep-1",order:1,description:"森林入口",characterVariantIds:[],propIds:[],keyPropIds:[]}]},
   label:"分镜生成与确认工具栏",validate:"校验分镜",generate:"生成分镜候选"},
 ];
 const bars:HTMLElement[]=[];
 for(const entry of cases){
  const node={id:entry.id,type:entry.type,title:entry.id,position:{x:0,y:0},metadata:{dramaDraft:JSON.stringify(entry.draft)}} as CanvasNodeData;
  const container=document.createElement("div");document.body.append(container);
  const root=createRoot(container);roots.push(root);
  await act(async()=>root.render(<DramaPipelineNodePanel node={node} onChange={()=>{}}
   projectId="project-1" workspaceMode workspaceTab="editor" initialEpisodeId="ep-1"/>));
  const bar=container.querySelector<HTMLElement>(`[aria-label="${entry.label}"]`)!;
  expect(bar).toBeTruthy();
  expect(bar.classList.contains("gap-2")).toBe(true);
  expect(bar.classList.contains("pt-3")).toBe(true);
  expect(bar.classList.contains("[&>button]:min-h-9")).toBe(true);
  const actions=[...bar.querySelectorAll<HTMLButtonElement>("button")];
  expect(actions.find(button=>button.textContent?.includes(entry.validate))).toBeTruthy();
  expect(actions.find(button=>button.textContent?.includes(entry.generate))).toBeTruthy();
  expect(actions.find(button=>button.textContent?.includes("确认阶段"))).toBeTruthy();
  for(const action of actions)expect(action.classList.contains("ant-btn-sm")).toBe(false);
  const confirm=actions.find(button=>button.textContent?.includes("确认阶段"))!;
  expect(confirm.classList.contains("order-last")).toBe(true);
  expect(confirm.style.background).toBe(canvasThemes[appearance].node.activeStroke);
  bars.push(bar);
 }
 const scope=bars[1].querySelector<HTMLButtonElement>('[aria-label="设置分镜生成范围"]')!;
 expect(scope.classList.contains("min-h-9")).toBe(true);
 expect(scope.classList.contains("ant-btn-sm")).toBe(false);
 expect(scope.style.background).toBe(canvasThemes[appearance].node.panel);
});
it("enables first storyboard generation after confirmed upstream data loads and shares episode selection with the editor",async()=>{
 const node={id:"board-empty",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},metadata:{dramaDraft:JSON.stringify({shots:[]})}} as CanvasNodeData;
 const assets=JSON.stringify({assets:[{id:"scene-1",kind:"scene",name:"森林",description:"",sourceRefs:[]}]});
 const episodes=JSON.stringify({episodes:["ep-1","ep-2"].map((id,index)=>({id,title:"第 "+(index+1)+" 集",synopsis:"",ending:"",events:[],sourceRefs:[]}))});
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const render=async(upstreamArtifacts:string[])=>act(async()=>root.render(<DramaPipelineNodePanel node={node}
  upstreamArtifacts={upstreamArtifacts} onChange={()=>{}} projectId="project-1" workspaceMode workspaceTab="editor"/>));
 const generate=()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="生成分镜候选")!;
 const scope=()=>container.querySelector('[data-drama-storyboard-scope-summary]')?.textContent;
 await render([]);
 expect(generate().disabled).toBe(true);
 expect(container.textContent).toContain("请先确认并连接资产规划节点");
 await render([assets]);
 expect(generate().disabled).toBe(true);
 expect(container.textContent).toContain("请先确认并连接包含剧集的剧集规划节点");
 await render([assets,episodes]);
 expect(generate().disabled).toBe(false);
 expect(scope()).toContain("第 1 集");
 const editor=container.querySelector<HTMLSelectElement>('select[aria-label="选择分镜剧集"]')!;
 expect(editor.value).toBe("ep-1");
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(editor,"ep-2");
  editor.dispatchEvent(new Event("change",{bubbles:true}));
 });
 expect(scope()).toContain("第 2 集");
 expect(generate().disabled).toBe(false);
 await render([assets,episodes]);
 expect(scope()).toContain("第 2 集");
 await render([assets,JSON.stringify({episodes:[]})]);
 expect(generate().disabled).toBe(true);
});
it.each(["editor","video"] as const)("keeps the %s tab footer compact; scopes and migration live in a popover",async workspaceTab=>{
 const {useThemeStore}=await import("@/stores/use-theme-store");
 useThemeStore.setState({theme:"dark"});
 const node={id:"storyboard-1",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({shots:[
   {id:"shot-1",episodeId:"episode-1",order:1,description:"森林入口",characterVariantIds:[],propIds:[],keyPropIds:[]}
  ]})}} as CanvasNodeData;
 const upstreamArtifacts=[
  JSON.stringify({assets:[{id:"scene-1",kind:"scene",name:"森林",description:"",sourceRefs:[]}]}),
  JSON.stringify({episodes:[{id:"episode-1",title:"毛毛和豆豆",synopsis:"",ending:"",events:[],sourceRefs:[],
   sequences:[{id:"sequence-1",title:"森林入口"}]}]})
 ];
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>root.render(<DramaPipelineNodePanel node={node}
  upstreamArtifacts={upstreamArtifacts} initialEpisodeId="episode-1" onChange={()=>{}}
  projectId="project-1" workspaceMode workspaceTab={workspaceTab}/>));
 const toolbar=container.querySelector<HTMLElement>('[data-drama-storyboard-toolbar]')!;
 expect(toolbar).toBeTruthy();
 expect(toolbar.getAttribute("aria-label")).toBe("分镜生成与确认工具栏");
 expect(toolbar.classList.contains("flex")).toBe(true);
 expect(toolbar.classList.contains("grid-cols-2")).toBe(false);
 expect(toolbar.querySelectorAll("button")).toHaveLength(4);
 expect(container.querySelectorAll('[data-drama-storyboard-toolbar]')).toHaveLength(1);
 expect(container.querySelectorAll('select[aria-label="生成范围：剧集"]')).toHaveLength(0);
 expect(container.querySelector('[data-drama-sequence-migration]')).toBeNull();
 expect(toolbar.textContent).toContain("生成范围");
 expect(toolbar.textContent).toContain("校验分镜");
 expect(toolbar.textContent).toContain("生成分镜候选");
 expect(toolbar.textContent).toContain("确认阶段");
 expect(toolbar.querySelector('[data-drama-storyboard-scope-summary]')?.textContent)
  .toContain("毛毛和豆豆");
 expect(container.querySelector('[data-drama-sequence-migration]')).toBeNull();
 expect(container.querySelector('select[aria-label="生成范围：场次"]')).toBeNull();
 await act(async()=>{
  toolbar.querySelector<HTMLButtonElement>('[aria-label="设置分镜生成范围"]')!.click();
  await new Promise(resolve=>setTimeout(resolve,70));
 });
 const popup=document.querySelector<HTMLElement>('[data-drama-storyboard-options]')!;
 expect(popup).toBeTruthy();
 const overlay=popup.closest<HTMLElement>(".ant-popover")!;
 expect(overlay).toBeTruthy();
 // The AntD arrow and its white tail previously overlapped the footer trigger.
 expect(overlay.querySelector(".ant-popover-arrow")).toBeNull();
 expect(overlay.style.zIndex).toBe("1200");
 expect(container.contains(popup)).toBe(false);
 expect(popup.classList.contains("max-h-[min(56vh,440px)]")).toBe(true);
 expect(popup.classList.contains("border")).toBe(false);
 const surface=overlay.querySelector<HTMLElement>(".ant-popover-content")!;
 expect(surface).toBeTruthy();
 expect(surface.style.borderColor).toBe((await import("@/lib/canvas-theme")).canvasThemes.dark.node.stroke);
 expect(popup.querySelector('select[aria-label="生成范围：剧集"]')).toBeTruthy();
 expect(popup.querySelector('select[aria-label="生成范围：场次"]')).toBeTruthy();
 expect(popup.querySelector('select[aria-label="生成范围：镜头"]')).toBeTruthy();
 expect(popup.querySelector('[data-drama-sequence-migration]')).toBeTruthy();
 expect(popup.style.background).toBe((await import("@/lib/canvas-theme")).canvasThemes.dark.node.panel);
 await act(async()=>useThemeStore.setState({theme:"light"}));
 expect(toolbar.style.borderColor).toBe((await import("@/lib/canvas-theme")).canvasThemes.light.node.stroke);
 expect(document.querySelector<HTMLElement>('[data-drama-storyboard-options]')?.style.background)
  .toBe((await import("@/lib/canvas-theme")).canvasThemes.light.node.panel);
 expect(surface.style.borderColor).toBe((await import("@/lib/canvas-theme")).canvasThemes.light.node.stroke);
 const sequence=popup.querySelector<HTMLSelectElement>('select[aria-label="生成范围：场次"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(sequence,"sequence-1");
  sequence.dispatchEvent(new Event("change",{bubbles:true}));
 });
 expect(toolbar.querySelector('[data-drama-storyboard-scope-summary]')?.textContent)
  .toContain("森林入口");
});
it("uses the same shot directory for production editing and separates batch preparation",async()=>{
 const published={id:"s1",episodeId:"ep-1",order:1,description:"确认版森林入口",shotSize:"全景",characterVariantIds:[],propIds:[],keyPropIds:[]};
 const draftShot={...published,description:"草案森林入口"};
 const unpublished={...published,id:"s2",order:2,description:"新镜头",shotSize:"特写"};
 const node={id:"storyboard-merged",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({shots:[draftShot,unpublished]}),dramaConfirmed:JSON.stringify({shots:[published]})}} as CanvasNodeData;
 const upstreamArtifacts=[JSON.stringify({assets:[]}),JSON.stringify({episodes:[{id:"ep-1",title:"第一集",synopsis:"",ending:"",events:[],sourceRefs:[]}]})];
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await import("./drama-video-config-fields");
 const render=async(tab:"editor"|"video")=>{
  await act(async()=>root.render(<DramaPipelineNodePanel node={node} upstreamArtifacts={upstreamArtifacts}
   projectId="project-1" workspaceMode workspaceTab={tab} onChange={()=>{}}/>));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 };
 await render("editor");
 expect(container.querySelectorAll('[aria-label="分镜镜头导航"]')).toHaveLength(1);
 expect(container.querySelector('[aria-label="视频配置镜头目录"]')).toBeNull();
 const video=()=>container.querySelector('[aria-label="镜头视频配置"]');
 expect(video()).toBeTruthy();
 expect(video()?.textContent).toContain("当前使用最近一次确认的分镜");
 expect(video()?.textContent).toContain("确认版森林入口");
 expect(container.querySelector('[aria-label="批量创建配置"]')).toBeNull();
 await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label^="选择镜头 2："]')!.click());
 expect(video()?.textContent).toContain("请先确认当前镜头");
 expect(video()?.querySelector('[aria-label="逐镜媒体输入预检"]')).toBeNull();
 await render("video");
 expect(container.querySelector('[aria-label="分镜镜头导航"]')).toBeNull();
 expect(video()).toBeNull();
 expect(container.querySelector('[aria-label="批量创建配置"]')?.textContent).toContain("确认版森林入口");
 expect(container.querySelector('[aria-label="批量创建配置"]')?.textContent).not.toContain("新镜头");
 await render("editor");
 expect(container.querySelector('[aria-label^="选择镜头 2："]')?.getAttribute("aria-pressed")).toBe("true");
 expect(video()?.textContent).toContain("请先确认当前镜头");
});
it("navigates from batch rows into the actual workspace editor and selects the matching shot",async()=>{
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 await import("./drama-batch-config-panel");
 const shots=["s1","s2"].map((id,index)=>({id,episodeId:"ep-1",order:index+1,description:"定位镜头内容 "+index,shotSize:index?"特写":"全景",characterVariantIds:[],propIds:[],keyPropIds:[]}));
 const data=JSON.stringify({shots});
 const node={id:"board-locate",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},metadata:{dramaDraft:data,dramaConfirmed:data}} as CanvasNodeData;
 const upstreamArtifacts=[JSON.stringify({assets:[]}),JSON.stringify({episodes:[{id:"ep-1",title:"第一集",synopsis:"",ending:"",events:[],sourceRefs:[]}]})];
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>root.render(<DramaCreativeWorkspace projectId="project-1" nodeId={node.id} kind="storyboard" focus={{}} versionConfirmed onClose={async()=>{}}
  renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} upstreamArtifacts={upstreamArtifacts}
   projectId="project-1" workspaceMode workspaceTab={tab==="settings"?"editor":tab} onPendingChange={onPendingChange} onChange={()=>{}}/>}/>));
 const workspace=()=>document.querySelector<HTMLElement>('[data-creative-workspace-node-id="board-locate"]')!;
 const click=async(button:HTMLElement)=>{expect(button).toBeTruthy();await act(async()=>button.click());await act(async()=>{await new Promise(r=>setTimeout(r,35));});};
 await click([...workspace().querySelectorAll("nav button")].find(b=>b.textContent?.trim()==="批量创建配置") as HTMLElement);
 const rows=workspace().querySelectorAll("tbody tr");
 expect(rows).toHaveLength(2);
 await click([...rows[1].querySelectorAll("button")].find(b=>b.textContent==="定位镜头")!);
 expect(workspace().querySelector('[aria-label="批量创建配置"]')).toBeNull();
 expect(workspace().querySelector('[aria-label^="选择镜头 2："]')?.getAttribute("aria-pressed")).toBe("true");
 expect(workspace().querySelector('[aria-label="镜头视频配置"]')).toBeTruthy();
 await click(workspace().querySelector<HTMLButtonElement>('[aria-label="编辑视频输入模式"]')!);
 const mode=workspace().querySelector<HTMLSelectElement>('select[aria-label="视频输入模式"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(mode,"first_frame");
  mode.dispatchEvent(new Event("change",{bubbles:true}));
 });
 expect(workspace().querySelector<HTMLButtonElement>('[aria-label^="选择镜头 1："]')?.disabled).toBe(true);
 expect(workspace().querySelector<HTMLButtonElement>('[aria-label="选择首帧"]')).toBeTruthy();
 await click([...workspace().querySelectorAll("nav button")].find(b=>b.textContent?.trim()==="批量创建配置") as HTMLElement);
 expect(document.body.textContent).toContain("存在未提交的草案修改");
 expect(workspace().querySelector('[data-video-mode-field="editing"]')).toBeTruthy();
 await click([...document.querySelectorAll("button")].find(b=>b.textContent?.trim()==="继续编辑")!);
 expect(workspace().querySelector('[data-video-mode-field="editing"]')).toBeTruthy();
 await click(workspace().querySelector<HTMLButtonElement>('[data-video-mode-field="editing"] [data-drama-action="cancel"]')!);
 expect(workspace().querySelector<HTMLButtonElement>('[aria-label^="选择镜头 1："]')?.disabled).toBe(false);
});
it("keeps the precise upstream impact scope when history remounts the storyboard editor",async()=>{
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const originalApi=vi.mocked(canvasApi).getMockImplementation()!;
 const shots=[{id:"s1",episodeId:"ep-1",sequenceId:"a",order:1,description:"第一镜",characterVariantIds:[],propIds:[],keyPropIds:[]},{id:"s0",episodeId:"ep-2",sequenceId:"b",order:1,description:"同集其他镜头",characterVariantIds:[],propIds:[],keyPropIds:[]},{id:"s2",episodeId:"ep-2",sequenceId:"b",order:2,description:"受影响镜头",characterVariantIds:[],propIds:[],keyPropIds:[]}];
 const draft=JSON.stringify({shots});
 const node={id:"board-impact",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},metadata:{dramaDraft:draft,dramaConfirmed:draft}} as CanvasNodeData;
 const upstreamArtifacts=[JSON.stringify({assets:[]}),JSON.stringify({episodes:[{id:"ep-1",title:"第一集",synopsis:"",ending:"",events:[],sourceRefs:[],sequences:[{id:"a",title:"第一场"}]},{id:"ep-2",title:"第二集",synopsis:"",ending:"",events:[],sourceRefs:[],sequences:[{id:"b",title:"第二场"}]}]})];
 const impact={assetIds:[],episodeIds:["ep-2"],sequenceIds:["ep-2/b"],shotIds:["s2"],mediaShotIds:[],configIds:[],needsReview:[]};
 vi.mocked(canvasApi).mockImplementation((async(path:string)=>path.includes("/dependencies?")?{status:"changed",changes:[],impact}:path.includes("/runs?")?[]:{}) as typeof canvasApi);
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 try{
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p" nodeId={node.id} kind="storyboard" focus={{}} versionConfirmed onClose={async()=>{}}
   renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} upstreamArtifacts={upstreamArtifacts} projectId="p" workspaceMode workspaceTab={tab==="settings"?"editor":tab} onPendingChange={onPendingChange} onChange={()=>{}}/>} renderHistoryPanel={()=> <div>历史版本</div>}/>));
  const workspace=document.querySelector('[data-creative-workspace-node-id="board-impact"]')!;
  const click=async(text:string)=>{const b=[...workspace.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;expect(b).toBeTruthy();await act(async()=>b.click());};
  await click("影响与历史");
  expect(workspace.querySelector('[data-drama-inline-feedback="warning"]')?.textContent).toContain("上游已有更新");
  await click("按镜重跑 · 第二集 · 镜头 2");
  expect(workspace.querySelector('nav button[aria-pressed="true"]')?.textContent).toContain("镜头编辑");
  expect(workspace.querySelector("[data-drama-storyboard-scope-summary]")?.textContent).toBe("第二集 · 第二场 · 镜头 2");
  expect(workspace.querySelector<HTMLSelectElement>('select[aria-label="选择分镜剧集"]')?.value).toBe("ep-2");
  expect(workspace.querySelector('[aria-label="选择镜头 2：s2"]')?.getAttribute("aria-pressed")).toBe("true");
 }finally{await act(async()=>root.unmount());roots.splice(roots.indexOf(root),1);vi.mocked(canvasApi).mockImplementation(originalApi);}
});

it("allows cancellation during a retry, and reports the returned terminal status",async()=>{
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const originalApi=vi.mocked(canvasApi).getMockImplementation()!;
 const run={id:"retry-run",episodeId:"ep-1",status:"failed",error:"drama_candidate_invalid"};
 let status="failed";let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const retry=vi.fn(),cancel=vi.fn();
 vi.mocked(canvasApi).mockImplementation((async(path:string)=>{
  if(path.endsWith("/retry")){retry();status="running";await pending;return {...run,status,error:undefined};}
  if(path.endsWith("/cancel")){cancel();status="cancelled";finish();return {...run,status,error:undefined};}
  if(path.includes("/runs?")||path.endsWith("/retry-run"))return path.includes("/runs?")?[{...run,status,error:status==="failed"?run.error:undefined}]:{...run,status};
  return {};
 }) as typeof canvasApi);
 const node={id:"retry-episodes",type:"drama:episodes",title:"剧集规划",position:{x:0,y:0},metadata:{dramaDraft:JSON.stringify({episodes:[]})}} as CanvasNodeData;
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);roots.push(root);
 try{
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p" nodeId={node.id} kind="episodes" focus={{}} versionConfirmed={false} onClose={async()=>{}}
   renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} projectId="p" workspaceMode workspaceTab={tab==="settings"?"editor":tab} onPendingChange={onPendingChange} onChange={()=>{}}/>}/>));
  const workspace=document.querySelector('[data-creative-workspace-node-id="retry-episodes"]')!;
  const button=(text:string)=>[...workspace.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
  await act(async()=>button("生成候选").click());
  const details=workspace.querySelector<HTMLDetailsElement>("[data-drama-run-scroll-region] details")!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event("toggle"));});
  await act(async()=>button("使用原输入重试").click());
  expect(retry).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-drama-task-status]")?.textContent).toContain("正在重试候选生成");
  await act(async()=>{await new Promise(r=>setTimeout(r,3100));});
  expect(button("取消生成").disabled).toBe(false);
  await act(async()=>button("取消生成").click());
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-drama-task-status]")).toBeNull();
  expect(workspace.querySelector('[data-drama-feedback="info"]')?.textContent).toContain("已取消");
 }finally{finish();await act(async()=>root.unmount());roots.splice(roots.indexOf(root),1);vi.mocked(canvasApi).mockImplementation(originalApi);}
});
it("reports committed adoption separately from a failed preview refresh and prevents stale adoption",async()=>{
 const {DramaCreativeWorkspace}=await import("./drama-creative-workspace");
 const {canvasApi}=await import("@/features/backend-sync/canvas-api");
 const originalApi=vi.mocked(canvasApi).getMockImplementation()!;
 const shot={id:"s1",episodeId:"ep-1",order:1,description:"候选镜头",characterVariantIds:[],propIds:[],keyPropIds:[]};
 const run={id:"adopt-run",episodeId:"ep-1",status:"ready",candidate:{shots:[shot]}};
 const preview={items:[{id:shot.id,kind:"added",after:shot,changed:true,conflict:false,adopted:false}],manualExtraIds:[],sourceChanged:false,fullAdoptBlocked:false,summary:{added:1,replaced:0,deleted:0,reordered:0,unchanged:0,conflicts:0}};
 let committed=false,failRefresh=true;
 const adopt=vi.fn(async()=>{committed=true;});
 vi.mocked(canvasApi).mockImplementation((async(path:string)=>{
  if(path.endsWith("/preview")){
   if(committed&&failRefresh)throw Error("preview_unavailable");
   return committed?{...preview,items:[{...preview.items[0],adopted:true}]}:preview;
  }
  if(path.includes("/runs?"))return [run];
  if(path.endsWith("/adopt-run"))return run;
  return {};
 }) as typeof canvasApi);
 const node={id:"board-adopt-recovery",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},metadata:{dramaDraft:JSON.stringify({shots:[]})}} as CanvasNodeData;
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);roots.push(root);
 try{
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p" nodeId={node.id} kind="storyboard" focus={{}} versionConfirmed={false} onClose={async()=>{}}
   renderPanel={(tab,onPendingChange)=><DramaPipelineNodePanel node={node} projectId="p" workspaceMode workspaceTab={tab==="settings"?"editor":tab} onPendingChange={onPendingChange} onChange={()=>{}} onAdoptDramaRun={adopt}/>}/>));
  const workspace=document.querySelector('[data-creative-workspace-node-id="board-adopt-recovery"]')!;
  const button=(text:string)=>[...workspace.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text)!;
  await act(async()=>button("生成候选").click());
  const details=workspace.querySelector<HTMLDetailsElement>("[data-drama-run-scroll-region] details")!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event("toggle"));});
  await act(async()=>button("选择全部无冲突差异").click());
  await act(async()=>button("采用所选差异").click());
  expect(adopt).toHaveBeenCalledTimes(1);
  expect(workspace.querySelector('[data-drama-feedback="success"]')?.textContent).toContain("已合入所选差异");
  expect(workspace.querySelector('[data-drama-feedback="error"]')?.textContent).toContain("差异已合入，刷新结果失败");
  expect(button("采用所选差异").disabled).toBe(true);
  expect(button("采用到草案").disabled).toBe(true);
  failRefresh=false;
  await act(async()=>button("重新加载差异预览").click());
  expect(workspace.querySelector('[data-drama-feedback="error"]')).toBeNull();
  expect(workspace.querySelector('[aria-label="分镜候选差异预览"]')?.textContent).toContain("已采用");
  expect(button("采用所选差异").disabled).toBe(true);
 }finally{await act(async()=>root.unmount());roots.splice(roots.indexOf(root),1);vi.mocked(canvasApi).mockImplementation(originalApi);}
});
it("switches between storyboard and video footer without restoring legacy rows or leaving a stale popup",async()=>{
 const node={id:"storyboard-switch",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({shots:[{
   id:"shot-1",episodeId:"ep-1",order:1,description:"测试镜头",
   characterVariantIds:[],propIds:[],keyPropIds:[]}]})}} as CanvasNodeData;
 const upstreamArtifacts=[
  JSON.stringify({assets:[]}),
  JSON.stringify({episodes:[{id:"ep-1",title:"毛毛和豆豆",synopsis:"",ending:"",events:[],sourceRefs:[]}]})
 ];
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const render=async(workspaceTab:"editor"|"video")=>act(async()=>root.render(
  <DramaPipelineNodePanel node={node} upstreamArtifacts={upstreamArtifacts}
   projectId="project-1" initialEpisodeId="ep-1" onChange={()=>{}}
   workspaceMode workspaceTab={workspaceTab}/>
 ));
 await render("editor");
 const toolbar=()=>container.querySelector<HTMLElement>('[data-drama-storyboard-toolbar]');
 expect(toolbar()?.classList.contains("flex")).toBe(true);
 await act(async()=>{
  toolbar()!.querySelector<HTMLButtonElement>('[aria-label="设置分镜生成范围"]')!.click();
  await new Promise(resolve=>setTimeout(resolve,70));
 });
 expect(document.querySelector('[data-drama-storyboard-options]')).toBeTruthy();
 await render("video");
 expect(toolbar()?.classList.contains("flex")).toBe(true);
 expect(toolbar()?.querySelectorAll("button")).toHaveLength(4);
 expect(container.querySelector('[data-drama-sequence-migration]')).toBeNull();
 expect(container.querySelector('select[aria-label="生成范围：场次"]')).toBeNull();
 const movedOverlay=document.querySelector<HTMLElement>('[data-drama-storyboard-options]')?.closest<HTMLElement>(".ant-popover");
 // AntD keeps the overlay in the DOM during its exit transition, but must disable interaction.
 expect(movedOverlay?.style.pointerEvents).toBe("none");
 await render("editor");
 expect(toolbar()?.querySelectorAll("button")).toHaveLength(4);
 expect(toolbar()?.querySelector<HTMLButtonElement>('[aria-label="设置分镜生成范围"]')).toBeTruthy();
});
