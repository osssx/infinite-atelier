import {useCallback,useEffect,useRef,useState} from "react";
import {App,Button,Input} from "antd";
import {useNavigate} from "react-router-dom";
import {awaitCanvasStorePersistence,useCanvasStore,type CanvasProject} from "@/stores/canvas/use-canvas-store";
import {explainBackendSyncError,type BackendCanvasGraph,type BackendProjectResponse} from "./canvas-backend-sync";
import {canonicalBackendGraph} from "./backend-source-fingerprint";

type Summary={id:string;revision:number;title:string;nodeCount:number;connectionCount:number};
type Library={projects:Summary[];eventCursor:number};
type RemoteDocument=BackendCanvasGraph&Partial<Pick<CanvasProject,"title"|"viewport"|"backgroundMode"|"showImageInfo">>;
async function fail(response:Response){
 const data=await response.json().catch(()=>null) as {code?:string}|null;
 return new Error(explainBackendSyncError(data?.code??"Backend HTTP "+response.status));
}
async function getJson<T>(path:string,init?:RequestInit):Promise<T>{
 const response=await fetch(path,{credentials:"same-origin",cache:"no-store",...init});
 if(!response.ok)throw await fail(response);
 return response.json() as Promise<T>;
}
function requestBootstrap(modal:ReturnType<typeof App.useApp>["modal"]):Promise<string|null>{
 return new Promise(resolve=>{
  let token="";
  modal.confirm({
   title:"登录共享项目库（每个浏览器地址需要独立登录）",
   content:<Input.Password autoComplete="off" placeholder="后端终端按 r 回车获取一次性 Token"
    onChange={e=>{token=e.target.value}}/>,
   okText:"登录",cancelText:"取消",
   onOk:()=>{const value=token.trim();token="";resolve(value||null)},
   onCancel:()=>{token="";resolve(null)}
  });
 });
}
export function BackendSharedProjects(){
 const {message,modal}=App.useApp();
 const navigate=useNavigate();
 const hydrated=useCanvasStore(s=>s.hydrated);
 const projects=useCanvasStore(s=>s.projects);
 const adopt=useCanvasStore(s=>s.adoptBackendProject);
 const [enabled,setEnabled]=useState(false);
 const [loading,setLoading]=useState(false);
 const [library,setLibrary]=useState<Library|null>(null);
 const [error,setError]=useState<string|null>(null);
 const live=useRef<EventSource|null>(null);
 const refresh=useCallback(async()=>{
  const snapshot=await getJson<Library>("/api/v1/projects");
  setLibrary(snapshot);setError(null);
  return snapshot;
 },[]);
 const connect=useCallback(async()=>{
  setLoading(true);
  try{
   const session=await fetch("/api/v1/session",{credentials:"same-origin",cache:"no-store"});
   if(session.status===401){
    const token=await requestBootstrap(modal);
    if(!token)return;
    const result=await fetch("/api/v1/session",{method:"POST",credentials:"same-origin",
     headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:"{}"});
    if(!result.ok)throw Error("Token 无效或已过期，请在后端终端按 r 获取新的 Token");
   }else if(!session.ok)throw await fail(session);
   await refresh();
   setEnabled(true);
  }catch(e){
   setError(e instanceof Error?e.message:"无法连接共享项目库");
  }finally{setLoading(false)}
 },[modal,refresh]);
 useEffect(()=>{
  if(!enabled)return;
  let closed=false;
  let stream:EventSource|null=null;
  const attach=()=>{
   if(closed)return;
   stream=new EventSource("/api/v1/projects/events?after="+(library?.eventCursor??0),{withCredentials:true});
   live.current=stream;
   stream.addEventListener("project",()=>{
    if(!closed)void refresh().catch(()=>setError("共享项目列表更新失败，可手动刷新"));
   });
   stream.onerror=()=>{if(closed)return;stream?.close();stream=null};
  };
  attach();
  // Poll as bounded fallback after a dropped EventSource connection.
  const poll=setInterval(()=>{if(!closed)void refresh().catch(()=>setError("共享项目库断开，请检查登录状态"))},5000);
  return()=>{closed=true;clearInterval(poll);stream?.close();live.current=null};
 },[enabled,library?.eventCursor,refresh]);
 const open=useCallback(async(item:Summary)=>{
  if(!hydrated)return;
  setLoading(true);
  try{
   const existing=useCanvasStore.getState().openProject(item.id);
   if(existing){
    const remote=await getJson<BackendProjectResponse>("/api/v1/projects/"+encodeURIComponent(item.id));
    if(canonicalBackendGraph({nodes:existing.nodes,connections:existing.connections})!==
       canonicalBackendGraph({nodes:remote.document.nodes,connections:remote.document.connections})){
     message.warning("本地址已有相同 ID 的本地项目。未覆盖本地草稿；请打开项目手动连接并处理版本冲突。");
     return;
    }
   }else{
    const remote=await getJson<BackendProjectResponse>("/api/v1/projects/"+encodeURIComponent(item.id));
    const document=remote.document as RemoteDocument;
    if(!Array.isArray(document.nodes)||!Array.isArray(document.connections))throw Error("远端项目数据不完整");
    const now=new Date().toISOString();
    const project:CanvasProject={
     id:remote.id,title:document.title||item.title||remote.id,createdAt:now,updatedAt:now,
     nodes:document.nodes,connections:document.connections,
     chatSessions:[],activeChatId:null,
     backgroundMode:document.backgroundMode??"lines",
     showImageInfo:document.showImageInfo??false,
     viewport:document.viewport??{x:0,y:0,k:1}
    };
    if(!adopt(project))throw Error("本地已有同 ID 项目，已阻止覆盖");
    await awaitCanvasStorePersistence();
   }
   navigate("/canvas/"+encodeURIComponent(item.id)+"?backendSync=1");
  }catch(e){message.error(e instanceof Error?e.message:"共享项目打开失败")}
  finally{setLoading(false)}
 },[adopt,hydrated,message,navigate]);
 return <section className="rounded-2xl border border-stone-200 p-5 dark:border-stone-800">
  <div className="flex flex-wrap items-center justify-between gap-3">
   <div>
    <h2 className="font-semibold">共享后端项目库（实验性）</h2>
    <p className="mt-1 text-sm text-stone-500">同一本地项目库可从 localhost 和 127.0.0.1 分别登录使用。现有本地项目不会被覆盖。</p>
   </div>
   {enabled?<Button loading={loading} onClick={()=>void refresh().catch(e=>setError(String(e)))}>刷新共享项目</Button>:
    <Button loading={loading} onClick={()=>void connect()}>连接共享项目库</Button>}
  </div>
  {error?<p className="mt-3 text-sm text-red-600">{error}</p>:null}
  {enabled&&library?<div className="mt-4 grid gap-3 sm:grid-cols-2">
   {library.projects.length?library.projects.map(item=><div key={item.id} className="flex items-center justify-between rounded-xl border p-3 dark:border-stone-700">
    <div className="min-w-0">
     <p className="truncate font-medium">{item.title}</p>
     <p className="text-xs text-stone-500">修订 {item.revision} · 节点 {item.nodeCount} · 连接 {item.connectionCount}</p>
    </div>
    <Button size="small" loading={loading} disabled={!hydrated} onClick={()=>void open(item)}>打开共享项目</Button>
   </div>):<p className="text-sm text-stone-500">后端暂无共享项目。进入本地项目并启用同步可创建后端副本。</p>}
  </div>:null}
 </section>
}
