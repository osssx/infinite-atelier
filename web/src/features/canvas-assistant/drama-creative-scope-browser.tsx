import {useEffect,useState} from "react";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import type {CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier,ensureCreativeNodesLoaded} from "@/stores/canvas/use-canvas-sqlite-store";

type ScopedEntry={id:string;name?:string;kind?:string;description?:string;
    title?:string;synopsis?:string;ending?:string;variants?:{id:string;name:string;description?:string}[];
    sequences?:{id:string;title:string}[]};
type ScopedPage={versionId:string|null;total:number;offset:number;limit:number;
    entries:ScopedEntry[];entryDigests:{id:string;digest:string}[]};
const perPage=10;

type Field="name"|"description"|"title"|"synopsis"|"ending";
const fieldsLabel:Record<Field,string>={name:"名称",description:"描述",title:"标题",synopsis:"剧情概要",ending:"结尾"};
function DraftEntryFields({value,fields,onSave}:{value:Partial<Record<Field,string>>;
    fields:Field[];onSave:(changes:Partial<Record<Field,string>>)=>Promise<void>}){
    const [values,setValues]=useState<Partial<Record<Field,string>>>(value);
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState("");
    const changes=Object.fromEntries(fields.filter(field=>values[field]!==value[field])
        .map(field=>[field,values[field]??""])) as Partial<Record<Field,string>>;
    return <div className="grid min-w-0 gap-2 border-t p-2">
        {fields.map(field=><label key={field} className="grid min-w-0 gap-1">{fieldsLabel[field]}
            {field==="name"||field==="title"?
                <input className="min-w-0 rounded border bg-transparent p-1" maxLength={12000}
                    value={values[field]??""} disabled={busy}
                    onChange={event=>setValues(current=>({...current,[field]:event.target.value}))}/>:
                <textarea className="min-w-0 rounded border bg-transparent p-1" rows={3} maxLength={12000}
                    value={values[field]??""} disabled={busy}
                    onChange={event=>setValues(current=>({...current,[field]:event.target.value}))}/>}
        </label>)}
        <button type="button" disabled={busy||!Object.keys(changes).length||
            ("name" in changes&&!changes.name?.trim())||("title" in changes&&!changes.title?.trim())}
            onClick={async()=>{
                setBusy(true);setError("");
                try{await onSave(changes);}
                catch(error){setError(error instanceof Error?error.message:"局部草案保存失败");}
                finally{setBusy(false);}
            }}>{busy?"正在保存…":"保存当前条目草案"}</button>
        {error&&<p role="alert">{error}</p>}
    </div>;
}
/** P3: quiet by default. No payload is fetched for an offscreen or collapsed
 * creative card. Every request returns at most one page of the selected stage.
 */
export function DramaCreativeScopeBrowser({projectId,nodeId,kind}:{
    projectId:string;nodeId:string;kind:"assets"|"episodes";
}){
    const [expanded,setExpanded]=useState(false);
    const [draft,setDraft]=useState(false);
    const [offset,setOffset]=useState(0);
    const [refresh,setRefresh]=useState(0);
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
    },[expanded,projectId,nodeId,draft,offset,refresh]);
    const label=kind==="assets"?"资产":"剧集";
    const save=async(entryId:string,expectedDigest:string,changes:Partial<Record<Field,string>>,
        target?:{variantId?:string;sequenceId?:string})=>{
        await commitAssistantCanvasGraphWithSaveBarrier(projectId,()=>canvasApi<CanvasBackendProject>(
            `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/entry-draft`,"PATCH",
            {nodeId,kind,entryId,expectedDigest,operationId:crypto.randomUUID(),changes,...target}),
            {textVersionNodeId:nodeId,keepCreativePointers:true,invalidateCreativeNodeId:nodeId});
        await ensureCreativeNodesLoaded(projectId,[nodeId]);
        setRefresh(current=>current+1);
    };
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
                    {draft&&page.entryDigests.find(item=>item.id===entry.id)?.digest&&(()=>{
                        const digest=page.entryDigests.find(item=>item.id===entry.id)!.digest;
                        return <div className="grid gap-2">
                            <details aria-label="编辑当前资产或剧集条目" className="rounded border p-1">
                                <summary>编辑当前条目</summary>
                                <DraftEntryFields key={digest+"-entry"} value={entry} fields={kind==="assets"?
                                    ["name","description"]:["title","synopsis","ending"]}
                                    onSave={changes=>save(entry.id,digest,changes)}/>
                            </details>
                            {kind==="assets"&&entry.variants?.map(variant=><details
                                key={variant.id} className="rounded border p-1">
                                <summary>编辑变体：{variant.name}</summary>
                                <DraftEntryFields key={digest+"-"+variant.id} value={variant}
                                    fields={["name","description"]}
                                    onSave={changes=>save(entry.id,digest,changes,{variantId:variant.id})}/>
                            </details>)}
                            {kind==="episodes"&&entry.sequences?.map(sequence=><details
                                key={sequence.id} className="rounded border p-1">
                                <summary>编辑场次标题：{sequence.title}</summary>
                                <DraftEntryFields key={digest+"-"+sequence.id} value={sequence} fields={["title"]}
                                    onSave={changes=>save(entry.id,digest,changes,{sequenceId:sequence.id})}/>
                            </details>)}
                        </div>;
                    })()}
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
