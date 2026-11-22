import {lazy,Suspense,useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {ConfigProvider,Modal} from "antd";
import {BookOpenText,Clapperboard,Database,Film,History,LayoutList,ShieldAlert,Sparkles,X} from "lucide-react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import type {DramaWorkspaceTab} from "./drama-pipeline-node-panel";
const EpisodeBrowser=lazy(()=>import("./drama-creative-scope-browser").then(m=>({default:m.DramaCreativeScopeBrowser})));
const StoryboardBrowser=lazy(()=>import("./drama-revision-browser").then(m=>({default:m.DramaRevisionBrowser})));

export type DramaWorkspaceFocus={episodeId?:string;sequenceId?:string;shotId?:string};
export type WorkspacePendingRegistration=(key:string,save:(()=>Promise<void>)|null)=>void;

/** One page-level workspace, never a child of the culled CanvasNode. Each tab
 * mounts only its active feature. The unsaved CAS navigation guard is shared by
 * every visual close/tab action.
 */
export function DramaCreativeWorkspace({projectId,nodeId,kind,focus,onClose,onTabChange,renderPanel,renderHistoryPanel}:{
 projectId:string;nodeId:string;kind:"episodes"|"storyboard";focus:DramaWorkspaceFocus;
 color?:{fill:string;text:string;muted:string};
 onClose:()=>Promise<void>;
 onTabChange?:(tab:DramaWorkspaceTab)=>void;
 renderPanel:(tab:DramaWorkspaceTab)=>ReactNode;
 renderHistoryPanel?:()=>ReactNode;
}){
 const appearance=useThemeStore(state=>state.theme);
 const theme=canvasThemes[appearance];
 const episodeMode=kind==="episodes";
 const [tab,setTab]=useState<DramaWorkspaceTab>("editor");
 const [pendingAction,setPendingAction]=useState<DramaWorkspaceTab|"close"|null>(null);
 const [pendingCount,setPendingCount]=useState(0);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const pending=useRef(new Map<string,()=>Promise<void>>());
 const registerPending=useCallback<WorkspacePendingRegistration>((key,save)=>{
  if(save)pending.current.set(key,save);else pending.current.delete(key);
  setPendingCount(pending.current.size);
 },[]);
 useEffect(()=>()=>{pending.current.clear()},[nodeId,projectId]);
 const perform=useCallback(async(target:DramaWorkspaceTab|"close")=>{
  if(target==="close")await onClose();
  else {setTab(target);onTabChange?.(target);}
 },[onClose,onTabChange]);
 const request=useCallback((target:DramaWorkspaceTab|"close")=>{
  if(target===tab)return;
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
 const tabs:{id:DramaWorkspaceTab;label:string;icon:typeof BookOpenText}[]=[
  {id:"editor",label:episodeMode?"剧集编辑":"分镜表",icon:LayoutList},
  {id:"scope",label:"分页与单条 CAS",icon:Database},
  ...(episodeMode?[]:[{id:"video" as const,label:"视频配置",icon:Film}]),
  {id:"runs",label:"生成候选",icon:Sparkles},
  {id:"history",label:"影响与历史",icon:History},
 ];
 const paneDesc:Record<DramaWorkspaceTab,string>={
  editor:episodeMode?"按集编辑剧情、事件、场次及来源引用":"检查分镜结构与镜头安排",
  scope:"按页读取、精准保存和批量提交草案",
  video:"按镜头配置独立的视频生成参数",
  runs:"按运行状态浏览候选，展开查看内容与采用选项",
  history:"版本快照与上游影响直接在工作区内查看",
 };
 const subtle={background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text};
 const action="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40";
 const primary={background:theme.node.text,color:theme.node.panel,borderColor:theme.node.text};
 return <>
  <Modal open centered destroyOnHidden footer={null} onCancel={()=>request("close")}
   closeIcon={<X size={18} style={{color:theme.node.text}}/>}
   title={<div className="flex min-w-0 items-center gap-3 py-0.5" data-drama-workspace-title="">
    <span className="grid size-10 shrink-0 place-items-center rounded-xl border" style={subtle}>
     {episodeMode?<BookOpenText size={21}/>:<Clapperboard size={21}/>}
    </span>
    <div className="min-w-0">
     <p className="text-[11px] font-medium tracking-wide" style={{color:theme.node.muted}}>INFINITE ATELIER · 创作工作区</p>
     <div className="truncate text-base font-semibold" style={{color:theme.node.text}}>
      {episodeMode?"剧集规划":"分镜配置"}
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
     {tabs.map(item=><button type="button" key={item.id} aria-pressed={tab===item.id}
      className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={tab===item.id?{background:theme.toolbar.activeBg,color:theme.toolbar.activeText,
       borderColor:theme.node.stroke,outlineColor:theme.node.activeStroke}:
       {background:"transparent",color:theme.node.muted,borderColor:"transparent",
        outlineColor:theme.node.activeStroke}}
      onClick={()=>request(item.id)}><item.icon size={14} aria-hidden="true"/>{item.label}</button>)}
    </nav>
    <div className="flex min-h-0 shrink-0 items-center justify-between gap-2">
     <p className="truncate text-[11px]" style={{color:theme.node.muted}}>{paneDesc[tab]}</p>
     {pendingCount>0&&<span role="status"
      className="shrink-0 rounded-md border px-2 py-1 text-[11px]"
      style={{...subtle,background:theme.toolbar.activeBg}}>
      {pendingCount} 组尚未保存的局部草案修改
     </span>}
    </div>
    <div data-drama-workspace-content="" className="thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border p-3 sm:p-4"
     style={{...subtle}}>
     <Suspense fallback={<p role="status" className="text-xs" style={{color:theme.node.muted}}>正在按需加载工作区…</p>}>
      {tab==="scope"?(episodeMode?
       <EpisodeBrowser key={nodeId} projectId={projectId} nodeId={nodeId} kind="episodes"
        initialEntryId={focus.episodeId} onPendingChange={registerPending}/>:
       <StoryboardBrowser key={nodeId} projectId={projectId} nodeId={nodeId}
        initialEpisodeId={focus.episodeId} initialShotId={focus.shotId} initialSequenceId={focus.sequenceId}
        onPendingChange={registerPending}/>):
       tab==="history"&&renderHistoryPanel
        ? <div data-drama-history-layout="" className="grid min-h-0 min-w-0 gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
           <section aria-label="历史版本面板" className="min-w-0 space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
             <h3 className="text-sm font-semibold">历史版本</h3>
             <span className="text-[11px]" style={{color:theme.node.muted}}>可查看、保存或恢复剧集草案快照</span>
            </div>
            {renderHistoryPanel()}
           </section>
           <section aria-label="上游影响面板" className="min-w-0 space-y-2">
            <h3 className="px-1 text-sm font-semibold">上游影响</h3>
            {renderPanel(tab)}
           </section>
          </div>
        : renderPanel(tab)}
     </Suspense>
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
