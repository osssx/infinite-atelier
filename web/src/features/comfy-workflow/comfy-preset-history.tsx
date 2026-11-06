import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {App,Button,Checkbox,Input,Modal,Spin,Tag} from "antd";
import {ChevronDown,ChevronRight,Eye,Info,Pencil,RotateCcw,Trash2} from "lucide-react";
import {deleteComfyVersions,getComfyVersionReferences,listComfyPresets,listComfyWorkflowVersions,restoreComfyPresetVersion,setComfyVersionNote,type ComfyPreset,type ComfyVersion,type ComfyVersionReferences} from "./preset-registry";
import {getComfyTemplate} from "./template-registry";

type Props={preset:ComfyPreset;onClose:()=>void;onChanged:()=>void|Promise<void>};
const pageSize=20;
const keyOf=(v:ComfyVersion)=>`${v.templateId}@${v.revision}`;
const dateOf=(v:ComfyVersion)=>new Date(v.createdAt).toLocaleString();
const isConflict=(e:unknown)=>!!e&&typeof e==="object"&&("status" in e&&(e as {status?:number}).status===409||"code" in e&&String((e as {code?:unknown}).code).includes("conflict"));
export function ComfyPresetHistory({preset,onClose,onChanged}:Props){
 const {message,modal}=App.useApp();
 const [versions,setVersions]=useState<ComfyVersion[]>([]),[current,setCurrent]=useState(preset),[currentExists,setCurrentExists]=useState(true),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const [shown,setShown]=useState(pageSize),[advanced,setAdvanced]=useState(false),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<string|null>(null),[note,setNote]=useState(""),[detail,setDetail]=useState<{title:string;body:string}|null>(null);
 const alive=useRef(true),request=useRef(0),currentRef=useRef(current);
 useEffect(()=>{currentRef.current=current;},[current]);
 const reload=useCallback(async(target=currentRef.current)=>{const id=++request.current;setLoading(true);setError("");try{const all=await listComfyWorkflowVersions(target.workflowId??target.templateId);if(!alive.current||id!==request.current)return;
  setVersions(all.filter(v=>v.templateId===target.templateId).sort((a,b)=>b.createdAt-a.createdAt));setShown(pageSize);
 }catch(e){if(alive.current&&id===request.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current&&id===request.current)setLoading(false);}},[]);
 useEffect(()=>{alive.current=true;void reload();return()=>{alive.current=false;request.current++;};},[reload]);
 const visible=useMemo(()=>versions.slice(0,shown),[versions,shown]);
 const toggleAdvanced=()=>{setAdvanced(v=>!v);setSelected([]);};
 const deleteOne=(v:ComfyVersion)=>modal.confirm({title:"删除此历史版本？",content:"仍被引用的版本无法删除。",okText:"删除",okButtonProps:{danger:true},cancelText:"取消",onOk:async()=>{setBusy(true);try{await deleteComfyVersions([{templateId:v.templateId,revision:v.revision}]);if(!alive.current)return;setSelected(s=>s.filter(k=>k!==keyOf(v)));message.success("历史版本已删除");await reload();await onChanged();}catch(e){if(alive.current){setSelected([]);await reload();message.error(`删除失败：${e instanceof Error?e.message:String(e)}`);}}finally{if(alive.current)setBusy(false);}}});
 const saveNote=async(v:ComfyVersion)=>{setBusy(true);try{await setComfyVersionNote(v.templateId,v.revision,note.trim());if(!alive.current)return;setVersions(items=>items.map(x=>keyOf(x)===keyOf(v)?{...x,note:note.trim()}:x));setEditing(null);message.success("备注已保存");}catch(e){if(alive.current)message.error(e instanceof Error?e.message:String(e));}finally{if(alive.current)setBusy(false);}};
 const refreshCurrent=async()=>{
  try{
   const fresh=(await listComfyPresets()).find(p=>p.id===preset.id);
   if(!alive.current)return;
   if(!fresh)throw Error("此预设已被删除，无法恢复版本。");
   currentRef.current=fresh;setCurrent(fresh);setCurrentExists(true);setSelected([]);await reload(fresh);
  }catch(e){if(alive.current){setCurrentExists(false);setError(`刷新预设失败：${e instanceof Error?e.message:String(e)}`);}throw e;}
 };
 const restore=async(v:ComfyVersion)=>{modal.confirm({title:"恢复此版本？",content:<div><p>{dateOf(v)}</p><p className="whitespace-pre-wrap break-words">{v.note||"未填写备注"}</p><p className="mt-2 text-xs text-stone-500">恢复仅影响预设，已有画布节点保持原版本。</p></div>,okText:"恢复",cancelText:"取消",onOk:async()=>{
  setBusy(true);
  try{
   await restoreComfyPresetVersion(preset.id,v,currentRef.current);
   if(!alive.current)return;
   await refreshCurrent();message.success("预设已恢复");await onChanged();
  }catch(e){
   if(!alive.current)return;
   if(isConflict(e)){
    setCurrentExists(false);
    try{await refreshCurrent();await onChanged();message.warning("预设已被其他操作更新，当前状态已刷新；可重试恢复");}
    catch(refreshError){message.error(`刷新预设失败：${String(refreshError)}`);}
    return;
   }
   if(e&&typeof e==="object"&&"code" in e&&e.code==="comfy_preset_not_found"){
    setCurrentExists(false);setError("此预设已被删除，无法恢复版本。");return;
   }
   message.error(`恢复失败：${e instanceof Error?e.message:String(e)}`);
  }finally{if(alive.current)setBusy(false);}
 }});};
 const bulkDelete=()=>modal.confirm({title:`删除 ${selected.length} 个历史版本？`,content:"删除是事务操作；仍被预设、项目节点、任务或默认值引用的版本无法删除。",okText:"删除",okButtonProps:{danger:true},cancelText:"取消",onOk:async()=>{setBusy(true);try{await deleteComfyVersions(versions.filter(v=>selected.includes(keyOf(v))).map(v=>({templateId:v.templateId,revision:v.revision})));if(!alive.current)return;setSelected([]);message.success("历史版本已删除");await reload();await onChanged();}catch(e){if(alive.current){setSelected([]);await reload();message.error(`删除失败：${e instanceof Error?e.message:String(e)}`);}}finally{if(alive.current)setBusy(false);}}});
 const showSnapshot=async(v:ComfyVersion)=>{setBusy(true);try{const template=await getComfyTemplate(v.templateId,v.revision);if(alive.current)setDetail({title:"版本快照",body:template?JSON.stringify(template,null,2):"快照不存在"});}catch(e){if(alive.current)message.error(String(e));}finally{if(alive.current)setBusy(false);}};
 const showRefs=async(v:ComfyVersion)=>{setBusy(true);try{const refs:ComfyVersionReferences=await getComfyVersionReferences(v.templateId,v.revision);if(alive.current)setDetail({title:"引用详情",body:JSON.stringify(refs,null,2)});}catch(e){if(alive.current)message.error(String(e));}finally{if(alive.current)setBusy(false);}};
 return <><Modal title={`${preset.name} · 修改历史`} open closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={busy?()=>{}:onClose} footer={null} width={640} destroyOnHidden>
  <p className="mb-3 text-xs text-stone-500">恢复仅影响预设，已有画布节点保持原版本。</p>
  {error?<div role="alert" className="mb-3 text-sm text-red-500">{error} <Button size="small" onClick={()=>{void refreshCurrent().catch(()=>{});}}>重试</Button></div>:null}
  {loading?<div className="py-8 text-center"><Spin/></div>:<div className="max-h-[55vh] overflow-y-auto rounded-md border border-stone-200 dark:border-stone-700">{visible.map(v=>{const key=keyOf(v);return <div key={key} className="border-b border-stone-200 px-3 py-2 last:border-0 dark:border-stone-700">
   <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 text-sm">{dateOf(v)}</span>
    {editing===key?<><Input aria-label="版本备注" maxLength={200} size="small" value={note} onChange={e=>setNote(e.target.value)} className="min-w-32 flex-1" disabled={busy}/><Button size="small" type="primary" loading={busy} disabled={busy} onClick={()=>void saveNote(v)}>保存</Button><Button size="small" disabled={busy} onClick={()=>setEditing(null)}>取消</Button></>:<><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-stone-500">{v.note||"未填写备注"}</span><Button type="text" size="small" aria-label="编辑备注" disabled={busy} icon={<Pencil size={14}/>} onClick={()=>{setNote(v.note??"");setEditing(key);}}/></>}
    {v.templateId===current.templateId&&v.revision===current.revision?<Tag color="blue">当前使用</Tag>:<Button size="small" disabled={busy||!currentExists} icon={<RotateCcw size={13}/>} onClick={()=>restore(v)}>恢复此版本</Button>}
   </div>
   {advanced?<div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-stone-500"><Checkbox aria-label={`选择 ${v.shortRevision}`} disabled={v.references.count>0||busy||(!selected.includes(key)&&selected.length>=128)} checked={selected.includes(key)} onChange={e=>setSelected(s=>e.target.checked?[...s,key]:s.filter(x=>x!==key))}/><code className="min-w-0 max-w-full break-all whitespace-normal">{v.templateId} · {v.revision}</code><span>引用 {v.references.count}</span><Button size="small" type="text" disabled={busy} icon={<Eye size={13}/>} onClick={()=>void showSnapshot(v)}>查看快照</Button><Button size="small" type="text" disabled={busy} icon={<Info size={13}/>} onClick={()=>void showRefs(v)}>引用详情</Button><span>{v.references.count?"仍有引用，禁止删除":"可删除"}</span><Button danger size="small" type="text" disabled={busy||v.references.count>0} icon={<Trash2 size={13}/>} onClick={()=>deleteOne(v)}>删除</Button></div>:null}
  </div>;})}{!visible.length&&!error?<p className="p-4 text-sm text-stone-500">暂无此预设对应的版本</p>:null}</div>}
  {versions.length>shown?<Button disabled={busy||loading} className="mt-2 w-full" onClick={()=>setShown(n=>n+pageSize)}>显示更多（{Math.min(pageSize,versions.length-shown)}）</Button>:null}
  <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Button disabled={busy} aria-expanded={advanced} icon={advanced?<ChevronDown size={14}/>:<ChevronRight size={14}/>} onClick={toggleAdvanced}>高级管理</Button>{advanced?<Button danger size="small" icon={<Trash2 size={14}/>} disabled={!selected.length||busy} onClick={bulkDelete}>删除所选（{selected.length}）</Button>:null}</div>
 </Modal><Modal title={detail?.title} open={!!detail} footer={null} onCancel={()=>setDetail(null)} width={600}><pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-all text-xs">{detail?.body}</pre></Modal></>;
}
