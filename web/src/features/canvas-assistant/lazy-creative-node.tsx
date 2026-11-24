import {useEffect,useState} from "react";
import {ensureCreativeNodesLoaded} from "@/stores/canvas/use-canvas-sqlite-store";

// Visible story/asset cards hydrate automatically. Coalesce concurrent mounts
// (including React StrictMode) without hydrating the whole canvas up front.
const pendingLoads=new Map<string,Promise<void>>();
function loadCreativeContent(projectId:string,nodeId:string){
    const key=JSON.stringify([projectId,nodeId]);
    const existing=pendingLoads.get(key);
    if(existing)return existing;
    const request=ensureCreativeNodesLoaded(projectId,[nodeId]).finally(()=>{
        if(pendingLoads.get(key)===request)pendingLoads.delete(key);
    });
    pendingLoads.set(key,request);
    return request;
}

export function LazyCreativeNode({projectId,nodeId}:{projectId:string;nodeId:string;stage:string}){
    const [error,setError]=useState("");
    const [retry,setRetry]=useState(0);
    useEffect(()=>{
        let active=true;
        setError("");
        void loadCreativeContent(projectId,nodeId).catch(cause=>{
            if(active)setError(cause instanceof Error?cause.message:"正文加载失败");
        });
        return ()=>{active=false;};
    },[projectId,nodeId,retry]);
    return <section className="thin-scrollbar flex h-full min-h-24 flex-col items-center justify-center gap-3 overflow-y-auto p-4">
        {error?<>
            <p role="alert" className="text-xs">创作内容加载失败：{error}</p>
            <button type="button" className="rounded-lg border px-4 py-2" onClick={()=>setRetry(value=>value+1)}>重试加载</button>
        </>:<p role="status" className="text-xs">正在读取创作内容…</p>}
    </section>;
}
