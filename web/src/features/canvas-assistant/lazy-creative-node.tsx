import {useState} from "react";
import {ensureCreativeNodesLoaded} from "@/stores/canvas/use-canvas-sqlite-store";
import {DramaRevisionBrowser} from "./drama-revision-browser";

export function LazyCreativeNode({projectId,nodeId,storyboard=false}:{projectId:string;nodeId:string;storyboard?:boolean}){
    const [loading,setLoading]=useState(false);
    const [error,setError]=useState("");
    return <section className="thin-scrollbar flex h-full min-h-24 flex-col gap-3 overflow-y-auto p-4">
        {storyboard&&<DramaRevisionBrowser projectId={projectId} nodeId={nodeId}/>}
        <button className="rounded-lg border px-4 py-2 disabled:opacity-50" disabled={loading} onClick={async()=>{
            setLoading(true);setError("");
            try{await ensureCreativeNodesLoaded(projectId,[nodeId]);}
            catch(error){setError(error instanceof Error?error.message:"正文加载失败");}
            finally{setLoading(false);}
        }}>{loading?"正在读取…":"打开创作内容"}</button>
        {error&&<p role="alert">{error}</p>}
    </section>;
}
