import {lazy,Suspense,useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {Modal} from "antd";
import type {DramaWorkspaceTab} from "./drama-pipeline-node-panel";
const EpisodeBrowser=lazy(()=>import("./drama-creative-scope-browser").then(m=>({default:m.DramaCreativeScopeBrowser})));
const StoryboardBrowser=lazy(()=>import("./drama-revision-browser").then(m=>({default:m.DramaRevisionBrowser})));

export type DramaWorkspaceFocus={episodeId?:string;sequenceId?:string;shotId?:string};
export type WorkspacePendingRegistration=(key:string,save:(()=>Promise<void>)|null)=>void;

export function DramaCreativeWorkspace({projectId,nodeId,kind,focus,color,onClose,renderPanel}:{
 projectId:string;nodeId:string;kind:"episodes"|"storyboard";focus:DramaWorkspaceFocus;
 color:{fill:string;text:string;muted:string};
 onClose:()=>Promise<void>;renderPanel:(tab:DramaWorkspaceTab)=>ReactNode;
}){
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
  if(target==="close")await onClose();else setTab(target);
 },[onClose]);
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
 const tabs: {id:DramaWorkspaceTab;label:string}[]=[
  {id:"editor",label:kind==="episodes"?"剧集编辑":"分镜表"},
  {id:"scope",label:"分页与单条 CAS"},
  ...(kind==="storyboard"?[{id:"video" as const,label:"视频配置"}]:[]),
  {id:"runs",label:"生成候选"},
  {id:"history",label:"影响与历史"},
 ];
 return <>
  <Modal open centered destroyOnHidden footer={null} onCancel={()=>request("close")}
   title={<span style={{color:color.text}}>{kind==="episodes"?"剧集规划":"分镜配置"} · 完整工作区</span>}
   width="min(1420px, calc(100vw - 32px))"
   styles={{container:{background:color.fill,color:color.text},header:{background:color.fill},
    body:{height:"min(920px, calc(100dvh - 132px))",overflow:"hidden",padding:"12px 4px 16px"}}}>
   <div data-creative-workspace-node-id={nodeId} className="flex h-full min-h-0 flex-col gap-3">
    <nav aria-label="创作工作区功能" className="flex shrink-0 flex-wrap gap-2 border-b pb-2"
      style={{borderColor:color.muted}}>
     {tabs.map(item=><button type="button" key={item.id} aria-pressed={tab===item.id}
      className="rounded-md border px-3 py-1.5 text-sm"
      style={tab===item.id?{fontWeight:700,borderColor:"currentColor"}:{opacity:.7}}
      onClick={()=>request(item.id)}>{item.label}</button>)}
    </nav>
    {pendingCount>0&&<p role="status" className="text-xs">有 {pendingCount} 组尚未保存的局部草案修改。</p>}
    <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
     <Suspense fallback={<p role="status">正在按需加载工作区…</p>}>
      {tab==="scope"?(kind==="episodes"?
       <EpisodeBrowser key={nodeId} projectId={projectId} nodeId={nodeId} kind="episodes"
        initialEntryId={focus.episodeId} onPendingChange={registerPending}/>:
       <StoryboardBrowser key={nodeId} projectId={projectId} nodeId={nodeId}
        initialEpisodeId={focus.episodeId} initialShotId={focus.shotId} initialSequenceId={focus.sequenceId}
        onPendingChange={registerPending}/>):
       renderPanel(tab)}
     </Suspense>
    </div>
    {error&&<p role="alert" className="text-xs">{error}</p>}
   </div>
  </Modal>
  <Modal title="存在未提交的草案修改" open={pendingAction!==null} closable={!busy}
    onCancel={()=>{if(!busy)setPendingAction(null)}} footer={null} centered>
   <p>离开当前编辑区会丢失尚未保存的局部修改。请选择保存草案、放弃修改或继续编辑。</p>
   {error&&<p role="alert">{error}</p>}
   <div className="mt-4 flex flex-wrap justify-end gap-2">
    <button type="button" disabled={busy} onClick={()=>setPendingAction(null)}>继续编辑</button>
    <button type="button" disabled={busy} className="rounded border px-3 py-1.5" onClick={()=>void decide(false)}>放弃修改</button>
    <button type="button" disabled={busy} className="rounded border px-3 py-1.5 font-semibold" onClick={()=>void decide(true)}>
     {busy?"正在保存…":"保存草案"}
    </button>
   </div>
  </Modal>
 </>;
}
