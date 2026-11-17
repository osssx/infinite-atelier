import {lazy,Suspense,useEffect,useState} from "react";
import {Button,Input,Modal,Popconfirm,Typography} from "antd";
import {useTranslation} from "react-i18next";
import type {TextVersion} from "@/features/canvas-text-versions";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
const LazyCanvasTextMarkdown=lazy(()=>import("./canvas-text-markdown").then(({CanvasTextMarkdown})=>({default:CanvasTextMarkdown})));

export function CanvasTextVersionsModal({open,versions,currentContent,onClose,onSave,onDelete,onRestore,onRetryPersistence,retryPending,busy=false}:{open:boolean;versions:TextVersion[];currentContent:string;onClose:()=>void;onSave:(note?:string)=>void;onDelete:(id:string)=>void;onRestore:(version:TextVersion)=>void;onRetryPersistence:()=>Promise<void>;retryPending:boolean;busy?:boolean}){
 const {t}=useTranslation(); const [note,setNote]=useState("");const [selectedId,setSelectedId]=useState<string|null>(null);const [retrying,setRetrying]=useState(false);const [retryFailed,setRetryFailed]=useState(false);const [deleteConfirmOpen,setDeleteConfirmOpen]=useState(false);
 const selected=versions.find(v=>v.id===selectedId)??versions[0]??null;
 const theme=canvasThemes[useThemeStore(s=>s.theme)];
 useEffect(()=>{if(open){setNote("");setSelectedId(versions[0]?.id??null)}},[open]);
 useEffect(()=>{if(selectedId&&!versions.some(v=>v.id===selectedId))setSelectedId(versions[0]?.id??null)},[selectedId,versions]);
 const close=()=>{if(!busy)onClose();};
 if(!open)return null;
 return <Modal title={t("canvas.textVersions.title")} open={open} onCancel={close} closable={!busy} footer={null} width={780} destroyOnHidden keyboard={!busy&&!deleteConfirmOpen} mask={{closable:!busy}}
  >
  <div data-canvas-shortcuts-ignore className="grid min-h-[420px] grid-cols-1 gap-4 md:grid-cols-[260px_1fr]" onKeyDown={event=>{if(event.key!=="Escape")event.stopPropagation();}}>
   <section className="flex min-h-0 flex-col gap-2"><Input maxLength={100} value={note} onChange={e=>setNote(e.target.value)} placeholder={t("canvas.textVersions.notePlaceholder")}/><Button type="primary" disabled={busy||retryPending||!currentContent.trim()||versions[0]?.content===currentContent||versions.length>=50} onClick={()=>onSave(note.trim()||undefined)}>{t("canvas.textVersions.saveCurrent")}</Button>{!currentContent.trim()&&<Typography.Text type="secondary">{t("canvas.textVersions.emptyCannotSave")}</Typography.Text>}{versions.length>=50&&<Typography.Text type="secondary">{t("canvas.textVersions.limitReached")}</Typography.Text>}<div className="max-h-48 min-h-0 flex-1 overflow-y-auto md:max-h-[360px]">{versions.map(v=><button key={v.id} type="button" disabled={busy||retryPending} className={`mb-2 block w-full rounded border p-2 text-left ${selected?.id===v.id?"border-blue-500":""}`} onClick={()=>setSelectedId(v.id)}><div>{new Date(v.createdAt).toLocaleString()}</div><Typography.Text type="secondary">{v.note||t(v.source==="manual"?"canvas.textVersions.manual":"canvas.textVersions.restoreBackup")}</Typography.Text><Typography.Paragraph ellipsis={{rows:2}} className="!mb-0">{v.content}</Typography.Paragraph></button>)}</div></section>
   <section className="flex min-w-0 flex-col"><div className="max-h-[60vh] min-h-[220px] flex-1 overflow-auto rounded border p-3" style={{background:theme.node.panel,color:theme.node.text,borderColor:theme.node.stroke}}>{selected?<Suspense fallback={null}><LazyCanvasTextMarkdown content={selected.content} theme={theme}/></Suspense>:t("canvas.textVersions.empty")}</div>{(retryFailed||retryPending)&&<div role="alert" className="mt-2 text-red-600">{t("canvas.textVersions.saveFailedGeneric")} <Button loading={retrying} disabled={retrying||busy} onClick={()=>{setRetrying(true);void onRetryPersistence().then(()=>setRetryFailed(false),()=>setRetryFailed(true)).finally(()=>setRetrying(false));}}>{t("canvas.textVersions.retry")}</Button></div>}<div className="mt-3 flex justify-end gap-2">{selected&&<Popconfirm open={deleteConfirmOpen} title={t("canvas.textVersions.deleteConfirm")} onOpenChange={setDeleteConfirmOpen} onConfirm={()=>onDelete(selected.id)}><Button danger disabled={busy||retryPending}>{t("common.delete")}</Button></Popconfirm>}<Button type="primary" disabled={busy||retryPending||!selected||!selected.content.trim()||selected.content===currentContent} onClick={()=>selected&&onRestore(selected)}>{t("common.restore")}</Button></div></section>
  </div>
 </Modal>
}
