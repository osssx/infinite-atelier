import {useEffect,useState} from "react";
import {canvasApi} from "@/features/backend-sync/canvas-api";

type ScopedEntry={id:string;name?:string;kind?:string;description?:string;
    title?:string;synopsis?:string;ending?:string;variants?:{id:string;name:string}[];
    sequences?:{id:string;title:string}[]};
type ScopedPage={versionId:string|null;total:number;offset:number;limit:number;
    entries:ScopedEntry[]};
const perPage=10;

/** P3: quiet by default. No payload is fetched for an offscreen or collapsed
 * creative card. Every request returns at most one page of the selected stage.
 */
export function DramaCreativeScopeBrowser({projectId,nodeId,kind}:{
    projectId:string;nodeId:string;kind:"assets"|"episodes";
}){
    const [expanded,setExpanded]=useState(false);
    const [draft,setDraft]=useState(false);
    const [offset,setOffset]=useState(0);
    const [page,setPage]=useState<ScopedPage|null>(null);
    const [error,setError]=useState("");
    const [loading,setLoading]=useState(false);
    useEffect(()=>{
        if(!expanded)return;
        let current=true;
        setLoading(true);setError("");
        const url=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/revision-scope?`+
            `nodeId=${encodeURIComponent(nodeId)}&draft=${draft}&offset=${offset}&limit=${perPage}`;
        void canvasApi<ScopedPage>(url,"GET").then(result=>{
            if(current)setPage(result);
        }).catch(error=>{
            if(current){setPage(null);setError(error instanceof Error?error.message:"无法读取创作分页");}
        }).finally(()=>{if(current)setLoading(false);});
        return ()=>{current=false;};
    },[expanded,projectId,nodeId,draft,offset]);
    const label=kind==="assets"?"资产":"剧集";
    return <section aria-label={label+"独立存储分页浏览"} className="grid min-w-0 gap-2 rounded-xl border p-2 text-xs">
        <button type="button" aria-expanded={expanded} className="text-left font-medium"
            onClick={()=>setExpanded(value=>!value)}>
            {expanded?"收起":"按需浏览"}{draft?"草案":"已确认"}{label}（每次 10 项）
        </button>
        {expanded&&<>
            <label><input type="checkbox" checked={draft} onChange={event=>{
                setDraft(event.target.checked);setOffset(0);setPage(null);
            }}/> 浏览当前草案</label>
            {loading&&<p role="status">正在读取当前页…</p>}
            {error&&<p role="alert">{error}</p>}
            {page&&<>
                <p role="status">{label}共 {page.total} 项 · {page.versionId?"已确认版本 "+page.versionId:
                    draft?"当前草案":"无已确认版本"}</p>
                {page.entries.map(entry=><details key={entry.id} className="min-w-0 rounded border p-1">
                    <summary className="break-words font-medium">
                        {entry.title??entry.name??entry.id}{entry.kind?" · "+entry.kind:""}
                    </summary>
                    <p className="whitespace-pre-wrap break-words">{kind==="assets"?entry.description:entry.synopsis}</p>
                    {kind==="assets"&&!!entry.variants?.length&&<p>变体：{entry.variants.map(item=>item.name).join("、")}</p>}
                    {kind==="episodes"&&<>
                        <p>场次：{entry.sequences?.length??0}</p>
                        {entry.sequences?.map(item=><p key={item.id}>{item.title} · {item.id}</p>)}
                    </>}
                </details>)}
                {page.total>perPage&&<div className="flex justify-between gap-2">
                    <button type="button" disabled={loading||offset===0}
                        onClick={()=>setOffset(value=>Math.max(0,value-perPage))}>上一页</button>
                    <span>{page.total?offset+1:0}–{Math.min(offset+perPage,page.total)} / {page.total}</span>
                    <button type="button" disabled={loading||offset+perPage>=page.total}
                        onClick={()=>setOffset(value=>value+perPage)}>下一页</button>
                </div>}
            </>}
        </>}
    </section>;
}
