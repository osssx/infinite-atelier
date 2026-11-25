import {lazy,Suspense,useCallback,useEffect,useId,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {ConfigProvider,Modal} from "antd";
import {BookOpenText,Boxes,Clapperboard,Film,History,LayoutList,ShieldAlert,Sparkles,X} from "lucide-react";
import {canvasThemes,type CanvasTheme} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {DramaNodeStatus} from "./drama-node-style";
import {DramaCandidateNavigationContext,AssetDirectoryContext,AssetReviewBusyContext,AssetReviewContext,AssetReviewNavigationContext,emptyAssetReview,initialAssetDirectory,type AssetDirectorySelection} from "./drama-asset-directory-state";
import {DramaStoryboardNavigationContext} from "./drama-storyboard-navigation";
import type {DramaWorkspaceTab} from "./drama-pipeline-node-panel";
type StoryWorkspaceTab=DramaWorkspaceTab|"settings";

export type DramaWorkspaceFocus={episodeId?:string;sequenceId?:string;shotId?:string;assetId?:string;assetDirectory?:AssetDirectorySelection};
export type WorkspacePendingRegistration=(key:string,save:(()=>Promise<void>)|null)=>void;

type WorkspaceTabItem={id:StoryWorkspaceTab;label:string;icon:typeof BookOpenText};

function WorkspaceTabButton({item,description,active,theme,onSelect}:{
 item:WorkspaceTabItem;description:string;active:boolean;theme:CanvasTheme;onSelect:()=>void;
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
  <button ref={buttonRef} type="button" aria-pressed={active} aria-description={description}
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
export function DramaCreativeWorkspace({projectId,nodeId,kind,focus,versionConfirmed,candidateCount=0,onClose,onTabChange,renderPanel,renderHistoryPanel}:{
 projectId:string;nodeId:string;kind:"source"|"assets"|"episodes"|"storyboard";focus:DramaWorkspaceFocus;
 versionConfirmed:boolean;candidateCount?:number;
 color?:{fill:string;text:string;muted:string};
 onClose:()=>Promise<void>;
 onTabChange?:(tab:StoryWorkspaceTab)=>void;
 renderPanel:(tab:StoryWorkspaceTab,onPendingChange:WorkspacePendingRegistration)=>ReactNode;
 renderHistoryPanel?:()=>ReactNode;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const episodeMode=kind==="episodes";
 const storyMode=kind==="source";
 const assetMode=kind==="assets";
 const assetDirectory=useState(()=>focus.assetDirectory??initialAssetDirectory);
 const assetReview=useState(()=>emptyAssetReview(""));
 const [tab,setTab]=useState<StoryWorkspaceTab>("editor");
 const reviewBusyRef=useRef(false);
 const [reviewBusy,setReviewBusy]=useState(false);
 const updateReviewBusy=useCallback((value:boolean)=>{reviewBusyRef.current=value;setReviewBusy(value);},[]);
 const [pendingAction,setPendingAction]=useState<StoryWorkspaceTab|"close"|null>(null);
 const [pendingCount,setPendingCount]=useState(0);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const pending=useRef(new Map<string,()=>Promise<void>>());
 const registerPending=useCallback<WorkspacePendingRegistration>((key,save)=>{
  if(save)pending.current.set(key,save);else pending.current.delete(key);
  setPendingCount(pending.current.size);
 },[]);
 useEffect(()=>()=>{pending.current.clear()},[nodeId,projectId]);
 const perform=useCallback(async(target:StoryWorkspaceTab|"close")=>{
  if(target==="close")await onClose();
  else {setTab(target);onTabChange?.(target);}
 },[onClose,onTabChange]);
 const request=useCallback((target:StoryWorkspaceTab|"close")=>{
  if(target===tab||reviewBusyRef.current)return;
  if(pending.current.size){setPendingAction(target);return;}
  void perform(target).catch(e=>setError(e instanceof Error?e.message:"操作失败"));
 },[perform,tab]);
 const decide=async(save:boolean)=>{
  if(!pendingAction||busy)return;
  setBusy(true);setError("");
  try{
   if(save){
    for(const entry of [...pending.current.values()])await entry();
   }
   const action=pendingAction;
   pending.current.clear();setPendingCount(0);
   setPendingAction(null);
   await perform(action);
  }catch(e){setError(e instanceof Error?e.message:"草案保存失败，请检查冲突后重试");}
  finally{setBusy(false);}
 };
 const tabs:{id:StoryWorkspaceTab;label:string;icon:typeof BookOpenText}[]=[
  {id:"editor",label:storyMode?"故事正文":assetMode?"资产编辑":episodeMode?"剧集编辑":"镜头编辑",icon:LayoutList},
  ...(storyMode?[{id:"settings" as const,label:"美术设定",icon:BookOpenText}]:
   assetMode||episodeMode?[]:[{id:"video" as const,label:"批量创建配置",icon:Film}]),
  ...(!storyMode?[{id:"runs" as const,label:assetMode&&candidateCount>0?`生成候选 · ${candidateCount}`:"生成候选",icon:Sparkles}]:[]),
  {id:"history",label:"影响与历史",icon:History},
 ];
 const paneDesc:Record<StoryWorkspaceTab,string>={
  editor:storyMode?"编写故事、选区改写、AI 续写及全文润色":assetMode?"编辑角色、场景、道具、造型设定及参考图":episodeMode?"按集编辑剧情、事件、场次及来源引用":"编辑镜头内容、资产引用与单镜头视频配置",
  settings:"故事影片比例、风格、美术指导与原文确认",
  video:"批量创建视频配置及组建批量生成镜头组",
  runs:"按运行状态浏览候选，展开查看内容与采用选项",
  history:"版本快照与上游影响直接在工作区内查看",
 };
 const subtle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const action="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40";
 const primary={background:theme.node.text,color:theme.node.panel,borderColor:theme.node.text};
 return <>
  <Modal open centered destroyOnHidden footer={null} closable={!reviewBusy} maskClosable={!reviewBusy} keyboard={!reviewBusy} onCancel={()=>request("close")}
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
       <DramaNodeStatus theme={theme} confirmed={versionConfirmed}/>
      </span>
     </div>
    </div>
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
    data-drama-workspace-kind={kind} className="flex h-full min-h-0 flex-col gap-2.5"
    style={{color:theme.node.text,colorScheme:appearance}}>
    <nav aria-label="创作工作区功能" className="thin-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-b pb-2"
     style={{borderColor:theme.node.stroke}}>
     {tabs.map(item=><WorkspaceTabButton key={item.id} item={item}
       description={paneDesc[item.id]} active={tab===item.id} theme={theme}
       onSelect={()=>request(item.id)}/>)}
    </nav>
    {reviewBusy&&<p role="status" className="shrink-0 text-xs" style={{color:theme.node.muted}}>正在合入资产，请勿关闭工作区或切换页面。</p>}
    {pendingCount>0&&<div className="flex min-h-0 shrink-0 justify-end">
     <span role="status" className="rounded-md border px-2 py-1 text-[11px]"
      style={{...subtle,background:theme.toolbar.activeBg}}>
      {pendingCount} 组尚未保存的局部草案修改
     </span>
    </div>}
    <div data-drama-workspace-content="" className={`thin-scrollbar min-h-0 min-w-0 flex-1 rounded-xl border p-3 sm:p-4 ${tab==="history"?"flex flex-col overflow-hidden":"overflow-y-auto overscroll-contain"}`}
     style={{...subtle}}>
     <DramaStoryboardNavigationContext.Provider value={kind==="storyboard"?()=>request("editor"):null}>
     <AssetDirectoryContext.Provider value={assetMode?assetDirectory:null}>
     <AssetReviewContext.Provider value={assetMode?assetReview:null}>
     <AssetReviewBusyContext.Provider value={assetMode?updateReviewBusy:null}>
     <AssetReviewNavigationContext.Provider value={assetMode?()=>void perform("editor"):null}>
     <DramaCandidateNavigationContext.Provider value={!storyMode?()=>request("runs"):null}>
     <Suspense fallback={<p role="status" className="text-xs" style={{color:theme.node.muted}}>正在按需加载工作区…</p>}>
      {tab==="history"&&renderHistoryPanel
         ? <div data-drama-history-layout="" className="grid h-full min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,2fr)] gap-3 xl:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)]">
            <section aria-label="上游影响面板" className="min-h-0 min-w-0 overflow-hidden">
             <div data-drama-impact-scroll="" className="thin-scrollbar max-h-full min-w-0 overflow-y-auto overscroll-contain" style={{scrollbarGutter:"auto"}}>
              <h3 className="mb-2 px-1 text-sm font-semibold">上游影响</h3>
              {renderPanel(tab,registerPending)}
             </div>
            </section>
            <section aria-label="历史版本面板" className="flex min-h-0 min-w-0 flex-col gap-2">
             <div className="flex shrink-0 items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-semibold">历史版本</h3>
              <span className="text-[11px]" style={{color:theme.node.muted}}>可查看、保存或恢复创作内容快照</span>
             </div>
             <div data-drama-history-fill="" className="min-h-0 min-w-0 flex-1">{renderHistoryPanel()}</div>
            </section>
           </div>
        : renderPanel(tab,registerPending)}
     </Suspense>
     </DramaCandidateNavigationContext.Provider>
     </AssetReviewNavigationContext.Provider>
     </AssetReviewBusyContext.Provider>
     </AssetReviewContext.Provider>
     </AssetDirectoryContext.Provider>
     </DramaStoryboardNavigationContext.Provider>
    </div>
    {error&&<p role="alert" className="shrink-0 rounded-lg border p-2 text-xs"
      style={{...subtle,background:theme.toolbar.activeBg}}>{error}</p>}
   </div>
   </ConfigProvider>
  </Modal>
  <Modal title={<span style={{color:theme.node.text}}>存在未提交的草案修改</span>}
   open={pendingAction!==null} closable={!busy}
   closeIcon={<X size={17} style={{color:theme.node.text}}/>}
   onCancel={()=>{if(!busy)setPendingAction(null)}} footer={null} centered
   styles={{container:{background:theme.node.fill,color:theme.node.text,
     border:`1px solid ${theme.node.stroke}`,colorScheme:appearance},
    header:{background:theme.node.fill},body:{color:theme.node.text}}}>
   <div className="space-y-3">
    <div className="flex items-start gap-2.5">
     <ShieldAlert size={19} className="mt-0.5 shrink-0" style={{color:theme.node.muted}}/>
     <p className="text-sm leading-relaxed">离开当前编辑区会丢失尚未保存的局部修改。请选择保存草案、放弃修改或继续编辑。</p>
    </div>
    {error&&<p role="alert" className="rounded-lg border p-2 text-xs"
     style={{...subtle,background:theme.toolbar.activeBg}}>{error}</p>}
    <div className="flex flex-wrap justify-end gap-2 border-t pt-3" style={{borderColor:theme.node.stroke}}>
     <button type="button" disabled={busy} className={action} style={subtle}
      onClick={()=>setPendingAction(null)}>继续编辑</button>
     <button type="button" disabled={busy} className={action} style={subtle}
      onClick={()=>void decide(false)}>放弃修改</button>
     <button type="button" disabled={busy} className={action} style={primary}
      onClick={()=>void decide(true)}>{busy?"正在保存…":"保存草案"}</button>
    </div>
   </div>
  </Modal>
 </>;
}
