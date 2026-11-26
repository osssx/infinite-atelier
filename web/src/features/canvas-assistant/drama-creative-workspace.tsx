import {lazy,Suspense,useCallback,useEffect,useId,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {ConfigProvider,Modal} from "antd";
import {BookOpenText,Boxes,Clapperboard,Film,History,LayoutList,ShieldAlert,Sparkles,X} from "lucide-react";
import {canvasThemes,type CanvasTheme} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {DramaNodeStatus} from "./drama-node-style";
import {DramaFeedbackContext,DramaFeedbackNotices,DramaTaskStatus,useDramaFeedbackController} from "./drama-feedback";
import {DramaCandidateNavigationContext,DramaWorkspaceExitGuardContext,AssetDirectoryContext,AssetReviewBusyContext,AssetReviewContext,AssetReviewNavigationContext,emptyAssetReview,initialAssetDirectory,type AssetDirectorySelection} from "./drama-asset-directory-state";
import {DramaStoryboardNavigationContext,DramaStoryboardScopeContext,type StoryboardScopeFocus} from "./drama-storyboard-navigation";
import {DramaStoryHistoryNavigationContext} from "./drama-story-history-navigation";
import type {DramaWorkspaceTab} from "./drama-pipeline-node-panel";
type StoryWorkspaceTab=DramaWorkspaceTab;

export type DramaWorkspaceFocus={episodeId?:string;sequenceId?:string;shotId?:string;assetId?:string;variantId?:string;assetDirectory?:AssetDirectorySelection};
/** Story candidates must be resolved separately from saving or discarding draft edits. */
export type StoryCandidateResolution={canAdopt:boolean;adopt:()=>{dirty:boolean}|null;discard:()=>{dirty:boolean}};
export type WorkspacePendingRegistration=(key:string,save:(()=>Promise<void>)|null,candidate?:StoryCandidateResolution)=>void;

type WorkspaceTabItem={id:StoryWorkspaceTab;label:string;icon:typeof BookOpenText};

function WorkspaceTabButton({item,description,active,theme,onSelect,disabled=false}:{
 item:WorkspaceTabItem;description:string;active:boolean;theme:CanvasTheme;onSelect:()=>void;disabled?:boolean;
}){
 const buttonRef=useRef<HTMLButtonElement>(null);
 const tipId=useId();
 const [hovered,setHovered]=useState(false);
 const [position,setPosition]=useState<{top:number;left:number}|null>(null);
 const visible=hovered;
 const updatePosition=useCallback(()=>{
  const rect=buttonRef.current?.getBoundingClientRect();
  if(!rect)return;
  const half=160;
  const left=Math.max(Math.min(window.innerWidth-half-12,rect.left+rect.width/2),Math.min(half+12,window.innerWidth/2));
  setPosition({top:rect.bottom+8,left});
 },[]);
 useEffect(()=>{
  if(!visible)return;
  updatePosition();
  window.addEventListener("scroll",updatePosition,true);
  window.addEventListener("resize",updatePosition);
  return ()=>{
   window.removeEventListener("scroll",updatePosition,true);
   window.removeEventListener("resize",updatePosition);
  };
 },[visible,updatePosition]);
 const Icon=item.icon;
 return <>
  <button ref={buttonRef} type="button" aria-pressed={active} aria-description={description} disabled={disabled}
   aria-describedby={visible&&position?tipId:undefined}
   className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
   style={active?{background:theme.toolbar.activeBg,color:theme.toolbar.activeText,
    borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke}:
    {background:"transparent",color:theme.node.muted,borderColor:"transparent",
     outlineColor:theme.node.activeStroke}}
   onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
   onClick={()=>{setHovered(false);onSelect();}}>
   <Icon size={14} aria-hidden="true"/>{item.label}
  </button>
  {visible&&position&&typeof document!=="undefined"&&createPortal(
   <span id={tipId} role="tooltip" data-drama-tab-tooltip={item.id}
    className="pointer-events-none rounded-lg border px-3 py-2 text-xs leading-relaxed"
    style={{position:"fixed",left:position.left,top:position.top,transform:"translateX(-50%)",
     maxWidth:"min(320px,calc(100vw - 24px))",zIndex:10000,background:theme.node.panel,
     color:theme.node.text,borderColor:theme.node.stroke,boxShadow:"0 8px 24px rgba(0,0,0,.20)"}}>
    {description}
   </span>,document.body)}
 </>;
}

/** One page-level workspace, never a child of the culled CanvasNode. Each tab
 * mounts only its active feature. The unsaved CAS navigation guard is shared by
 * every visual close/tab action.
 */
export function DramaCreativeWorkspace({projectId,nodeId,kind,focus,versionConfirmed,versionDraftLabel,candidateCount=0,onClose,onTabChange,renderPanel,renderHistoryPanel,storyVersionAction}:{
 projectId:string;nodeId:string;kind:"source"|"assets"|"episodes"|"storyboard";focus:DramaWorkspaceFocus;
 versionConfirmed:boolean;versionDraftLabel?:string;candidateCount?:number;
 storyVersionAction?:{hasText:boolean;busy:boolean;allowReconfirm?:boolean;confirm:()=>Promise<void>};
 color?:{fill:string;text:string;muted:string};
 onClose:()=>Promise<void>;
 onTabChange?:(tab:StoryWorkspaceTab)=>void;
 renderPanel:(tab:StoryWorkspaceTab,onPendingChange:WorkspacePendingRegistration)=>ReactNode;
 renderHistoryPanel?:(locked:boolean)=>ReactNode;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const episodeMode=kind==="episodes";
 const storyMode=kind==="source";
 const assetMode=kind==="assets";
 const feedback=useDramaFeedbackController();
 const operationLocked=Boolean(feedback.context.task?.blockNavigation||storyMode&&storyVersionAction?.busy);
 const operationLockedRef=useRef(operationLocked);operationLockedRef.current=operationLocked;
 const assetDirectory=useState(()=>focus.assetDirectory??initialAssetDirectory);
 const storyboardScope=useState<StoryboardScopeFocus|null>(null);
 const assetReview=useState(()=>emptyAssetReview(""));
 const [tab,setTab]=useState<StoryWorkspaceTab>("editor");
 const tabRef=useRef(tab);tabRef.current=tab;
 const reviewBusyRef=useRef(false);
 const [reviewBusy,setReviewBusy]=useState(false);
 const updateReviewBusy=useCallback((value:boolean)=>{reviewBusyRef.current=value;setReviewBusy(value);},[]);
 const [pendingAction,setPendingAction]=useState<StoryWorkspaceTab|"close"|null>(null);
 const [pendingCount,setPendingCount]=useState(0);
 const [storyCandidatePending,setStoryCandidatePending]=useState(false);
 const [storyCandidateAdoptable,setStoryCandidateAdoptable]=useState(false);
 const storyCandidateResolver=useRef<StoryCandidateResolution|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const busyRef=useRef(false);
 const [pendingMenu,setPendingMenu]=useState(false);
 const pendingMenuRef=useRef<HTMLDivElement>(null);
 const [editorEpoch,setEditorEpoch]=useState(0);
 const pending=useRef(new Map<string,()=>Promise<void>>());
 const registerPending=useCallback<WorkspacePendingRegistration>((key,save,candidate)=>{
  if(save)pending.current.set(key,save);else pending.current.delete(key);
  setPendingCount(pending.current.size);
  if(key===nodeId+":story-candidate"){
   storyCandidateResolver.current=save?candidate??null:null;
   setStoryCandidatePending(!!save);setStoryCandidateAdoptable(!!save&&!!candidate?.canAdopt);
  }
 },[nodeId]);
 useEffect(()=>()=>{pending.current.clear();storyCandidateResolver.current=null;},[nodeId,projectId]);
 useEffect(()=>{
  if(!pendingCount&&!busy)setPendingMenu(false);
 },[pendingCount,busy]);
 useEffect(()=>{
  if(!pendingMenu)return;
  const outside=(event:PointerEvent)=>{
   if(!busyRef.current&&!pendingMenuRef.current?.contains(event.target as Node)){setPendingMenu(false);setError("");}
  };
  const escape=(event:KeyboardEvent)=>{
   if(event.key!=="Escape")return;
   event.stopPropagation();event.preventDefault();
   if(!busyRef.current){setPendingMenu(false);setError("");pendingMenuRef.current?.querySelector("button")?.focus();}
  };
  document.addEventListener("pointerdown",outside);
  document.addEventListener("keydown",escape,true);
  return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape,true);};
 },[pendingMenu]);
 const perform=useCallback(async(target:StoryWorkspaceTab|"close")=>{
  if(target==="close")await onClose();
  else {setTab(target);onTabChange?.(target);}
 },[onClose,onTabChange]);
 const request=useCallback((target:StoryWorkspaceTab|"close")=>{
  if(target===tabRef.current||reviewBusyRef.current||operationLockedRef.current||busyRef.current)return;
  setPendingMenu(false);setError("");
  if(pending.current.size){setPendingAction(target);return;}
  void perform(target).catch(e=>setError(e instanceof Error?e.message:"操作失败"));
 },[perform]);
 const decide=async(save:boolean,target:StoryWorkspaceTab|"close"|"stay"|null=pendingAction)=>{
  if(!target||busyRef.current||reviewBusyRef.current||operationLockedRef.current)return;
  if(storyMode&&pending.current.has(nodeId+":story-candidate")){setError("请先处理 AI 候选");return;}
  busyRef.current=true;setBusy(true);setError("");
  try{
   if(save){
    for(const entry of [...pending.current.values()])await entry();
   }
   // Staying in the current tab must actually discard the local buffers,
   // not merely clear their registrations. Reset only the content subtree.
   if(target!=="stay"||!save){
    pending.current.clear();setPendingCount(0);setStoryCandidatePending(false);
   }
   if(target==="stay"){
    if(!save)setEditorEpoch(epoch=>epoch+1);
    setPendingMenu(false);
   }else{
    setPendingAction(null);
    await perform(target);
   }
  }catch(e){
   if(storyMode&&!save&&target!=="stay")setEditorEpoch(epoch=>epoch+1);
   setError(e instanceof Error?e.message:"草案保存失败，请检查冲突后重试");
  }
  finally{busyRef.current=false;setBusy(false);}
 };
 // Resolve the temporary AI result first. Adopt is a local edit, never a save or confirmation.
 const resolveStoryCandidate=async(adopt:boolean,target:StoryWorkspaceTab|"close"|"stay"|null=pendingAction)=>{
  if(!target||busyRef.current||operationLockedRef.current||reviewBusyRef.current)return;
  const resolver=storyCandidateResolver.current;
  if(!resolver||adopt&&!resolver.canAdopt)return;
  const result=adopt?resolver.adopt():resolver.discard();
  if(!result){setError("候选暂不可采用，请返回查看候选状态。");return;}
  pending.current.delete(nodeId+":story-candidate");storyCandidateResolver.current=null;
  setStoryCandidatePending(false);setStoryCandidateAdoptable(false);setPendingCount(pending.current.size);setError("");
  // The story editor will register its resulting draft when React commits. Keep the
  // requested navigation open for the separate save/discard decision if needed.
  if(result.dirty||[...pending.current.keys()].some(key=>key!==nodeId+":story"))return;
  if(target==="stay"){setPendingMenu(false);return;}
  setPendingAction(null);
  try{await perform(target);}catch(e){setError(e instanceof Error?e.message:"操作失败");}
 };
 const confirmStory=async()=>{
  if(!storyVersionAction||busyRef.current||operationLockedRef.current||storyVersionAction.busy||pending.current.has(nodeId+":story-candidate"))return;
  busyRef.current=true;setBusy(true);setError("");
  try{
   for(const entry of [...pending.current.values()])await entry();
   await storyVersionAction.confirm();
   feedback.context.api.notify("story-confirm","success","故事版本已确认");
  }catch(e){setError(e instanceof Error?e.message:"故事版本确认失败");}
  finally{busyRef.current=false;setBusy(false);}
 };
 const tabs:{id:StoryWorkspaceTab;label:string;icon:typeof BookOpenText}[]=[
  {id:"editor",label:storyMode?"故事正文":assetMode?"资产编辑":episodeMode?"剧集编辑":"镜头编辑",icon:LayoutList},
  ...(storyMode||assetMode||episodeMode?[]:[{id:"video" as const,label:"批量创建配置",icon:Film}]),
  ...(!storyMode?[{id:"runs" as const,label:assetMode&&candidateCount>0?`生成候选 · ${candidateCount}`:"生成候选",icon:Sparkles}]:[]),
  {id:"history",label:"影响与历史",icon:History},
 ];
 const paneDesc:Record<StoryWorkspaceTab,string>={
  editor:storyMode?"编写故事、设置美术风格、选区改写及 AI 续写润色":assetMode?"编辑角色、场景、道具、造型设定及参考图":episodeMode?"按集编辑剧情、事件、场次及来源引用":"编辑镜头内容、资产引用与单镜头视频配置",
  video:"批量创建视频配置及组建批量生成镜头组",
  runs:episodeMode?"浏览、编辑或删除生成候选，审核后采用到草案":"按运行状态浏览候选，展开查看内容与采用选项",
  history:storyMode?"文本来源同步、直接下游及版本历史":"版本快照与上游影响直接在工作区内查看",
 };
 const subtle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const action="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40";
 const primary={background:theme.node.text,color:theme.node.panel,borderColor:theme.node.text};
 const pendingLabel=storyCandidatePending?(pendingCount>1?`候选待审核 · ${pendingCount-1} 处未保存`:"候选待审核"):`${pendingCount} 处未保存`;
 return <>
  <Modal open centered destroyOnHidden footer={null} closable={!reviewBusy&&!operationLocked&&!busy} maskClosable={!reviewBusy&&!operationLocked&&!busy} keyboard={!reviewBusy&&!operationLocked&&!busy&&!pendingMenu} onCancel={()=>request("close")}
   closeIcon={<X size={18} style={{color:theme.node.text}}/>}
   title={<div className="flex min-w-0 items-center gap-3 py-0.5" data-drama-workspace-title="">
    <span className="grid size-10 shrink-0 place-items-center rounded-xl border" style={subtle}>
     {assetMode?<Boxes size={21}/>:storyMode||episodeMode?<BookOpenText size={21}/>:<Clapperboard size={21}/>}
    </span>
    <div className="min-w-0">
     <p className="text-[11px] font-medium tracking-wide" style={{color:theme.node.muted}}>INFINITE ATELIER · 创作工作区</p>
     <div className="flex min-w-0 items-center gap-2" data-drama-workspace-title-row="">
      <span className="truncate text-base font-semibold" style={{color:theme.node.text}}>
       {storyMode?"故事":assetMode?"资产规划":episodeMode?"剧集规划":"分镜配置"}
      </span>
      <span data-drama-workspace-version-status="" className="shrink-0">
       <DramaNodeStatus theme={theme} confirmed={versionConfirmed} draftLabel={versionDraftLabel}/>
      </span>
     </div>
    </div>
    {feedback.context.task&&<DramaTaskStatus task={feedback.context.task} theme={theme}/>}
   </div>}
   width="min(1420px, calc(100vw - 24px))"
   styles={{
    container:{background:theme.node.fill,color:theme.node.text,border:`1px solid ${theme.node.stroke}`,
     borderRadius:18,boxShadow:"0 24px 72px rgba(0,0,0,.24)",colorScheme:appearance},
    header:{background:theme.node.fill,borderBottom:`1px solid ${theme.node.stroke}`,
     padding:"0 36px 12px 0",marginBottom:0},
    body:{height:"min(920px, calc(100dvh - 122px))",minHeight:0,overflow:"hidden",
     padding:"12px 0 0"},
   }}>
   <ConfigProvider theme={{token:{
    colorBgContainer:theme.node.panel,colorBgElevated:theme.node.panel,
    colorText:theme.node.text,colorTextSecondary:theme.node.muted,
    colorBorder:theme.node.stroke,colorPrimary:theme.node.activeStroke,
    colorTextLightSolid:theme.node.panel,controlItemBgActive:theme.toolbar.activeBg,borderRadius:10,
   }}}>
   <div data-creative-workspace-node-id={nodeId} data-drama-workspace-theme={appearance}
    data-drama-workspace-kind={kind} className="relative flex h-full min-h-0 flex-col gap-2.5"
    style={{color:theme.node.text,colorScheme:appearance}}>
    <div data-drama-workspace-tab-row="" className="flex min-w-0 shrink-0 items-center gap-2 border-b pb-2" style={{borderColor:theme.node.stroke}}>
     <nav aria-label="创作工作区功能" className="thin-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
      {tabs.map(item=><WorkspaceTabButton key={item.id} item={item}
        description={paneDesc[item.id]} active={tab===item.id} theme={theme} disabled={reviewBusy||operationLocked||busy}
        onSelect={()=>request(item.id)}/>)}
     </nav>
     {storyMode&&storyVersionAction&&<button type="button" data-story-confirm-version="" className={action+" !min-h-7 shrink-0"}
      style={primary} title={storyCandidatePending?"请先采用或舍弃 AI 候选":"保存当前草案后确认故事正文及美术设定"}
      disabled={busy||operationLocked||storyVersionAction.busy||storyCandidatePending||(!pendingCount&&(!storyVersionAction.hasText||versionConfirmed&&!storyVersionAction.allowReconfirm))}
      onClick={()=>void confirmStory()}>{busy||storyVersionAction.busy?"处理中…":pendingCount&&!storyCandidatePending?"保存并确认故事版本":"确认故事版本"}</button>}
     {pendingCount>0&&<div ref={pendingMenuRef} className="relative ml-auto shrink-0" data-drama-pending-status="">
      <button type="button" aria-expanded={pendingMenu} aria-label={pendingLabel}
       title={storyCandidatePending?"当前 AI 候选尚未处理":pendingCount+" 组尚未保存的局部"+(episodeMode&&tab==="runs"?"候选":"草案")+"修改"}
       disabled={reviewBusy||operationLocked||busy}
       className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium hover:opacity-80 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
       style={{...subtle,outlineColor:theme.node.activeStroke}}
       onClick={()=>{setError("");setPendingMenu(open=>!open);}}>
       <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500"/>
       <span role="status">{pendingLabel}</span>
      </button>
      {pendingMenu&&<div role="dialog" aria-label="未保存修改" data-drama-pending-menu=""
       className="absolute right-0 top-full z-40 mt-2 w-[min(320px,calc(100vw-64px))] space-y-3 rounded-lg border p-3 text-xs"
       style={{...subtle,boxShadow:"0 8px 24px rgba(0,0,0,.18)"}}>
       <strong className="block text-sm">{storyCandidatePending?"AI 候选待审核":`${pendingCount} 组尚未保存的局部${episodeMode&&tab==="runs"?"候选":"草案"}修改`}</strong>
       <p className="leading-relaxed" style={{color:theme.node.muted}}>{storyCandidatePending?"采用仅写入本地草案；舍弃候选不会丢失现有正文修改。":"保存或放弃当前修改后，仍停留在当前页面。"}</p>
       {error&&<p role="alert" className="break-words rounded-md border p-2" style={subtle}>{error}</p>}
       {storyCandidatePending?<div className="flex flex-wrap justify-end gap-1.5">
        <button type="button" className={action+" !min-h-7 !px-2"} style={subtle} onClick={()=>{setPendingMenu(false);setError("");}}>继续查看</button>
        <button type="button" className={action+" !min-h-7 !px-2"} style={subtle} disabled={busy||operationLocked} onClick={()=>void resolveStoryCandidate(false,"stay")}>舍弃候选</button>
        <button type="button" className={action+" !min-h-7 !px-2"} style={primary} disabled={busy||operationLocked||!storyCandidateAdoptable} onClick={()=>void resolveStoryCandidate(true,"stay")}>采用到草案</button>
       </div>:<div className="flex flex-wrap justify-end gap-1.5">
        <button type="button" className={action+" !min-h-7 !px-2"} style={subtle} disabled={busy} onClick={()=>{setPendingMenu(false);setError("");}}>继续编辑</button>
        <button type="button" className={action+" !min-h-7 !px-2"} style={subtle} disabled={busy||reviewBusy||operationLocked} onClick={()=>void decide(false,"stay")}>放弃修改</button>
        <button type="button" className={action+" !min-h-7 !px-2"} style={primary} disabled={busy||reviewBusy||operationLocked} onClick={()=>void decide(true,"stay")}>
         {busy?"正在保存…":episodeMode&&tab==="runs"?"保存候选":"保存草案"}
        </button>
       </div>}
      </div>}
     </div>}
    </div>
    <DramaFeedbackNotices notices={feedback.notices} clear={feedback.clear} theme={theme}/>
    {reviewBusy&&<p role="status" className="shrink-0 text-xs" style={{color:theme.node.muted}}>正在合入资产，请勿关闭工作区或切换页面。</p>}
    {operationLocked&&<p role="status" className="shrink-0 text-xs" style={{color:theme.node.muted}}>当前操作完成后可切换页面或关闭工作区。</p>}
    <div data-drama-workspace-content="" inert={busy&&(storyMode||pendingMenu)} className={`thin-scrollbar min-h-0 min-w-0 flex-1 rounded-xl border p-3 sm:p-4 ${tab==="history"?"flex flex-col overflow-hidden":"overflow-y-auto overscroll-contain"}`}
     style={{...subtle}}>
     <DramaFeedbackContext.Provider value={feedback.context}>
     <DramaWorkspaceExitGuardContext.Provider value={()=>{if(pending.current.size||busyRef.current||reviewBusyRef.current||operationLockedRef.current)throw Error("存在未保存修改或正在执行操作，请先完成当前操作。");}}>
     <DramaStoryboardScopeContext.Provider value={kind==="storyboard"?storyboardScope:null}>
     <DramaStoryboardNavigationContext.Provider value={kind==="storyboard"?(focus)=>{if(focus)storyboardScope[1](focus);request("editor");}:null}>
     <AssetDirectoryContext.Provider value={assetMode?assetDirectory:null}>
     <AssetReviewContext.Provider value={assetMode?assetReview:null}>
     <AssetReviewBusyContext.Provider value={assetMode?updateReviewBusy:null}>
     <AssetReviewNavigationContext.Provider value={assetMode?()=>void perform("editor"):null}>
     <DramaCandidateNavigationContext.Provider value={!storyMode?()=>request("runs"):null}>
     <DramaStoryHistoryNavigationContext.Provider value={storyMode?()=>request("history"):null}>
     <Suspense key={editorEpoch} fallback={<p role="status" className="text-xs" style={{color:theme.node.muted}}>正在按需加载工作区…</p>}>
      {tab==="history"&&renderHistoryPanel
         ? <div data-drama-history-layout="" className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] gap-3 xl:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)]">
            <section aria-label={storyMode?"来源与下游影响面板":"上游影响面板"} className="min-h-0 min-w-0 overflow-hidden">
             <div data-drama-impact-scroll="" className="thin-scrollbar max-h-full min-w-0 overflow-y-auto overscroll-contain" style={{scrollbarGutter:"auto"}}>
              <h3 className="mb-2 px-1 text-sm font-semibold">{storyMode?"来源与下游影响":"上游影响"}</h3>
              {renderPanel(tab,registerPending)}
             </div>
            </section>
            <section aria-label="历史版本面板" className="flex min-h-0 min-w-0 flex-col gap-2">
             <div className="flex shrink-0 items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-semibold">历史版本</h3>
              <span className="text-[11px]" style={{color:theme.node.muted}}>可查看、保存或恢复创作内容快照</span>
             </div>
             <div data-drama-history-fill="" className="min-h-0 min-w-0 flex-1">{renderHistoryPanel(storyMode&&(operationLocked||busy))}</div>
            </section>
           </div>
        : renderPanel(tab,registerPending)}
     </Suspense>
     </DramaStoryHistoryNavigationContext.Provider>
     </DramaCandidateNavigationContext.Provider>
     </AssetReviewNavigationContext.Provider>
     </AssetReviewBusyContext.Provider>
     </AssetReviewContext.Provider>
     </AssetDirectoryContext.Provider>
     </DramaStoryboardNavigationContext.Provider>
     </DramaStoryboardScopeContext.Provider>
     </DramaWorkspaceExitGuardContext.Provider>
     </DramaFeedbackContext.Provider>
    </div>
    {error&&!pendingMenu&&!pendingAction&&<p role="alert" className="shrink-0 rounded-lg border p-2 text-xs"
      style={{...subtle,background:theme.toolbar.activeBg}}>{error}</p>}
   </div>
   </ConfigProvider>
  </Modal>
  <Modal title={<span style={{color:theme.node.text}}>{storyCandidatePending?"存在待审核的 AI 候选":`存在未提交的${episodeMode&&tab==="runs"?"候选":"草案"}修改`}</span>}
   open={pendingAction!==null} closable={!busy}
   closeIcon={<X size={17} style={{color:theme.node.text}}/>}
   onCancel={()=>{if(!busy)setPendingAction(null)}} footer={null} centered
   styles={{container:{background:theme.node.fill,color:theme.node.text,
     border:`1px solid ${theme.node.stroke}`,colorScheme:appearance},
    header:{background:theme.node.fill},body:{color:theme.node.text}}}>
   <div className="space-y-3">
    <div className="flex items-start gap-2.5">
     <ShieldAlert size={19} className="mt-0.5 shrink-0" style={{color:theme.node.muted}}/>
     <p className="text-sm leading-relaxed">{storyCandidatePending?
      "请先处理本次会话的 AI 候选。采用后仍需选择是否保存草案；舍弃候选不影响现有草案。关闭后不会保留候选。":
      `离开当前编辑区会丢失尚未保存的局部修改。请选择保存${episodeMode&&tab==="runs"?"候选":"草案"}、放弃修改或继续编辑。`}</p>
    </div>
    {error&&<p role="alert" className="rounded-lg border p-2 text-xs"
     style={{...subtle,background:theme.toolbar.activeBg}}>{error}</p>}
    {storyCandidatePending?<div data-story-candidate-exit="" className="flex flex-wrap justify-end gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
     <button type="button" disabled={busy} className={action} style={subtle} onClick={()=>setPendingAction(null)}>继续查看</button>
     <button type="button" disabled={busy||operationLocked} className={action} style={subtle} onClick={()=>void resolveStoryCandidate(false)}>舍弃候选</button>
     <button type="button" disabled={busy||operationLocked||!storyCandidateAdoptable} className={action} style={primary} onClick={()=>void resolveStoryCandidate(true)}>采用到草案</button>
    </div>:<div className="flex flex-wrap justify-end gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
     <button type="button" disabled={busy} className={action} style={subtle}
      onClick={()=>setPendingAction(null)}>继续编辑</button>
     <button type="button" disabled={busy} className={action} style={subtle}
      onClick={()=>void decide(false)}>放弃修改</button>
     <button type="button" disabled={busy} className={action} style={primary}
      onClick={()=>void decide(true)}>{busy?"正在保存…":episodeMode&&tab==="runs"?"保存候选":"保存草案"}</button>
    </div>}
   </div>
  </Modal>
 </>;
}