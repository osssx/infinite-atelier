import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Dices, LoaderCircle, Link2, Play, RotateCcw, Settings2, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { Button } from "antd";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import {
    generateComfySafeSeed, getComfyInstanceScalarFields, parseComfyScalarOverride,
    removeComfyInstanceOverride, setComfyInstanceOverride,
    type ComfyInstanceScalarField, type ComfyScalarKind,
} from "./instance-parameters";
import { getComfyTemplate } from "./template-registry";
import type { ComfyWorkflowTemplate } from "./template-schema";
import { cancelComfyRun, getComfyRun, hasPendingComfyRun, missingComfyMediaInputs, recoverPendingComfyRun, type ComfyRunState } from "./run-client";
import { comfyRunStatusLabel, isComfyRunActive } from "./run-status";
import { ComfyWorkflowPanel } from "./comfy-workflow-panel";

type Props = {
    node: CanvasNodeData;
    connections: readonly CanvasConnection[];
    projectId: string;
    onExecute: () => Promise<ComfyRunState>;
    /** Chosen in the global ComfyUI settings tab, shared by all workflow nodes. */
    comfyInstanceId?: string;
    onExecutionChange: (execution: NonNullable<CanvasNodeMetadata["comfyExecution"]>) => void;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
    onTemplateChange: (patch: Partial<CanvasNodeMetadata>) => boolean;
    onClose: () => void;
};

const inputClass = "min-w-0 w-full rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-fill)] px-3 py-2 text-sm text-[var(--comfy-text)] outline-none focus:border-[var(--comfy-accent)] disabled:cursor-not-allowed disabled:opacity-55";
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--comfy-border)] px-2.5 py-2 text-xs transition hover:bg-[var(--comfy-fill)] disabled:pointer-events-none disabled:opacity-40";

function sourceText(field:ComfyInstanceScalarField) {
    if (field.connectedFrom) return "上游连线";
    switch (field.localValue.source) {
        case "override": return "当前节点";
        case "default": return "模板默认值";
        case "template": return "工作流原值";
        default: return "未设置";
    }
}

function isSeed(port: ComfyInstanceScalarField["port"]) {
    return port.valueKind==="INT" && /seed|随机种子/i.test(port.id+" "+port.label);
}

function ComfyScalarInput({field,onSet,onClear}:{
    field:ComfyInstanceScalarField;
    onSet:(value:string|number|boolean)=>void;
    onClear:()=>void;
}) {
    const kind=field.port.valueKind as ComfyScalarKind;
    const local = field.localValue;
    const value=local.source==="disconnect"?"":local.value;
    const textValue=typeof value==="string"||typeof value==="number"?String(value):"";
    const [draft,setDraft]=useState(textValue);
    const [error,setError]=useState("");
    useEffect(()=>{setDraft(textValue);setError("");},[textValue,kind,field.port.id]);
    const connected=!!field.connectedFrom;
    const invalidLinks=field.connectionCount>1;
    const editable=!connected && !invalidLinks;
    const saveNumber=()=>{
        if(!editable || kind==="STRING" || kind==="BOOLEAN")return;
        if(draft===textValue) {setError("");return;}
        const parsed=parseComfyScalarOverride(kind,draft);
        if(!parsed.ok) {setError(parsed.error);return;}
        onSet(parsed.value);setError("");
    };
    const noValue = local.source==="disconnect";
    return <div className="rounded-xl border border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-3 py-3" data-comfy-instance-port={field.port.id}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
            <label htmlFor={"comfy-instance-"+field.port.id} className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--comfy-text)]">{field.port.label}</label>
            <span className="rounded border border-[var(--comfy-border)] px-1.5 py-0.5 text-[10px] text-[var(--comfy-muted)]">{kind}</span>
            <span className="text-[10px] text-[var(--comfy-muted)]">{sourceText(field)}</span>
        </div>
        {connected?<div className="mb-2 flex items-center gap-1.5 rounded-md bg-[var(--comfy-fill)] px-2 py-1.5 text-[11px] text-[var(--comfy-muted)]">
            <Link2 size={12} className="shrink-0"/>
            <span className="truncate">{field.connectedFrom?.nodeId}{field.connectedFrom?.portId?" · "+field.connectedFrom.portId:""} 控制此输入；本地值暂不生效</span>
        </div>:null}
        {invalidLinks?<p role="alert" className="mb-2 text-xs text-red-500">一个输入端口不能连接多个来源，请先修复连线。</p>:null}
        {kind==="BOOLEAN" ? <label className="flex items-center gap-2.5">
            <input id={"comfy-instance-"+field.port.id} type="checkbox" checked={value===true} disabled={!editable}
                onChange={(e)=>onSet(e.target.checked)} className="size-4 accent-[var(--comfy-accent)]" />
            <span className="text-xs text-[var(--comfy-text)]">{value===true?"开启":"关闭"}{noValue?"（未配置）":""}</span>
        </label>
        :kind==="STRING"?<textarea id={"comfy-instance-"+field.port.id} className={inputClass+" resize-y"}
            rows={/prompt|text|提示词|描述/i.test(field.port.id+" "+field.port.label)?3:2}
            value={draft} disabled={!editable} placeholder={field.mixedTemplateValues && noValue?"模板内部存在不同原值，请指定参数":"输入文字…"}
            onChange={(e)=>{const next=e.target.value;setDraft(next);const parsed=parseComfyScalarOverride("STRING",next);if(parsed.ok){setError("");onSet(parsed.value);}else setError(parsed.error);}}
        />:<div className="flex gap-2">
            <input id={"comfy-instance-"+field.port.id} className={inputClass+" flex-1"}
                type="text" inputMode={kind==="INT"?"numeric":"decimal"} value={draft}
                disabled={!editable} placeholder={field.mixedTemplateValues && noValue?"多个原值":kind==="INT"?"输入整数":"输入浮点数"}
                onChange={(e)=>{setDraft(e.target.value);setError("");}}
                onBlur={saveNumber}
                onKeyDown={(e:KeyboardEvent<HTMLInputElement>)=>{e.stopPropagation();if(e.key==="Enter")e.currentTarget.blur();}}
            />
            {isSeed(field.port)?<button type="button" disabled={!editable} title="生成安全范围内的随机种子" aria-label="随机种子"
                className={buttonClass} onClick={()=>{onSet(generateComfySafeSeed());setError("");}}><Dices size={16}/></button>:null}
        </div>}
        {error?<p role="alert" className="mt-1 text-[11px] text-red-500">{error}</p>:null}
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--comfy-muted)]">
            <span className="truncate">{local.source==="override"?"独立保存，不修改共享工作流模板":noValue?"无可用默认值":field.mixedTemplateValues?"多目标参数，请注意原值差异":"仅当前实例的备用值"}</span>
            {local.source==="override"?<button type="button" disabled={!editable} className="inline-flex shrink-0 items-center gap-1 hover:underline disabled:opacity-40"
                onClick={onClear}><RotateCcw size={11}/>恢复默认</button>:null}
        </div>
    </div>;
}

/** The regular workflow node inspector; template editing is an explicit secondary action. */
export function ComfyWorkflowInstancePanel({node,connections,projectId,comfyInstanceId,onExecute,onExecutionChange,onChange,onTemplateChange,onClose}:Props) {
    const themeName=useThemeStore((state)=>state.theme);
    const theme=canvasThemes[themeName];
    const colors={
        "--comfy-panel":theme.node.panel,
        "--comfy-fill":theme.node.fill,
        "--comfy-border":theme.node.stroke,
        "--comfy-text":theme.node.text,
        "--comfy-muted":theme.node.muted,
        "--comfy-accent":theme.node.activeStroke,
    } as CSSProperties;
    const binding=node.metadata?.comfyWorkflow;
    const liveExecution=node.metadata?.comfyExecution;
    const [template,setTemplate]=useState<ComfyWorkflowTemplate|null>(null);
    const [loading,setLoading]=useState(false);
    const [error,setError]=useState("");
    const [editingTemplate,setEditingTemplate]=useState(false);
    const [run,setRun]=useState<ComfyRunState|null>(null);
    const [runBusy,setRunBusy]=useState(false);
    const [runError,setRunError]=useState("");
    const [pending,setPending]=useState(()=>hasPendingComfyRun(projectId,node.id));
    useEffect(()=>{setPending(hasPendingComfyRun(projectId,node.id));},[projectId,node.id,liveExecution?.status]);
    const outputs=useMemo(()=>template?.ports.filter(p=>p.direction==="source" && !!p.capture?.adapterId && p.capture.kind!=="none")??[],[template]);
    const missingMedia=useMemo(()=>template?missingComfyMediaInputs(template,node.id,connections):[],[template,node.id,connections]);
    useEffect(()=>{
        let active=true;
        setRun(null);setRunError("");
        if(binding?.lastRunId)void getComfyRun(binding.lastRunId)
            .then(value=>{if(active)setRun(value);})
            .catch(cause=>{if(active)setRunError("恢复任务失败："+String(cause));});
        return ()=>{active=false;};
    },[binding?.lastRunId,node.id]);
    useEffect(()=>{
        if(!run?.runId || ["succeeded","failed","cancelled","submission_unknown","timed_out"].includes(run.status))return;
        const timer=setInterval(()=>{void getComfyRun(run.runId).then(setRun).catch(cause=>setRunError(String(cause)));},2500);
        return ()=>clearInterval(timer);
    },[run?.runId,run?.status]);
    const execute=async()=>{
        if(!template||!comfyInstanceId||!outputs[0]||!binding)return;
        setRunBusy(true);setRunError("");
        try{
            const result=await onExecute();
            setRun(result);
        }catch(cause){setRunError("提交失败："+String(cause));}
        finally{setPending(hasPendingComfyRun(projectId,node.id));setRunBusy(false);}
    };
    const recoverSubmission=async()=>{
        if(!binding)return;
        setRunBusy(true);setRunError("");
        onExecutionChange({status:"submitting"});
        try{
            const result=await recoverPendingComfyRun(projectId,node.id);
            onChange({comfyWorkflow:{...binding,lastRunId:result.runId}});
            setRun(result);
            onExecutionChange({runId:result.runId,status:result.status,error:result.error||undefined});
        }catch(cause){
            setRunError("无法恢复提交："+String(cause));
            onExecutionChange({status:hasPendingComfyRun(projectId,node.id)?"submission_unknown":"failed",error:String(cause)});
        }
        finally{setPending(hasPendingComfyRun(projectId,node.id));setRunBusy(false);}
    };

    useEffect(()=>{
        let active=true;
        setTemplate(null);setError("");
        if(!binding?.templateId || !binding.templateRevision) return;
        setLoading(true);
        void getComfyTemplate(binding.templateId,binding.templateRevision)
            .then((result)=>{if(active){setTemplate(result);if(!result)setError("本地找不到已绑定的模板版本，请重新导入工作流。");}})
            .catch((cause)=>{if(active)setError("模板校验失败："+String(cause));})
            .finally(()=>{if(active)setLoading(false);});
        return ()=>{active=false;};
    },[binding?.templateId,binding?.templateRevision,node.id]);
    const fields=useMemo(()=>template?getComfyInstanceScalarFields(template,node,connections):[],[template,node,connections]);
    const updateOverride=(portId:string,value:string|number|boolean)=>{
        if(!binding || connections.some((edge)=>edge.toNodeId===node.id && edge.toPortId===portId))return;
        const current = binding.inputOverrides??{};
        onChange({comfyWorkflow:{...binding,inputOverrides:setComfyInstanceOverride(current,portId,value)}});
    };
    const resetOverride=(portId:string)=>{
        if(!binding || connections.some((edge)=>edge.toNodeId===node.id && edge.toPortId===portId))return;
        onChange({comfyWorkflow:{...binding,inputOverrides:removeComfyInstanceOverride(binding.inputOverrides??{},portId)}});
    };
    // Do not show details belonging to an older run after a newer submission has begun.
    // Canvas-level progress also updates when a run was triggered from the selected-node toolbar.
    const currentRun=run?.runId===binding?.lastRunId?run:null;
    const status=liveExecution?.status||currentRun?.status;
    const active=isComfyRunActive(status)||runBusy;
    const artifactSummary=currentRun?.status==="succeeded" ?
        Object.entries(currentRun.artifacts.reduce<Record<string,number>>((acc,item)=>{
            acc[item.kind]=(acc[item.kind]??0)+1;return acc;
        },{})).map(([kind,count])=>count+({image:" 张图片",video:" 段视频",audio:" 段音频",text:" 条文本"} as Record<string,string>)[kind]).join(" · ") : "";
    const statusLabel=pending?"提交待确认":status==="succeeded"
        ? `已完成${artifactSummary?` · ${artifactSummary}`:""}`
        :status?comfyRunStatusLabel(status):"待执行";
    const statusError=runError||liveExecution?.error||(currentRun?.error??"");
    const canCancel=Boolean(currentRun && ["queued","preparing","running","collecting","submitting"].includes(currentRun.status));
    const disabled=!template||!comfyInstanceId||!outputs[0]||!projectId||active||pending||missingMedia.length>0;
    if(editingTemplate) return <ComfyWorkflowPanel node={node} onChange={(patch)=>{
        const applied=onTemplateChange(patch);
        if(applied)setEditingTemplate(false);
        return applied;
    }} onClose={()=>setEditingTemplate(false)}/>;
    return <section className="pointer-events-auto mx-auto flex max-h-[min(690px,calc(100vh-32px))] w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-[18px] border border-[var(--comfy-border)] bg-[var(--comfy-panel)] text-[var(--comfy-text)] shadow-2xl"
        style={{...colors,colorScheme:themeName,accentColor:theme.node.activeStroke}}
        data-comfy-instance-panel data-canvas-no-zoom
        onMouseDown={(e)=>e.stopPropagation()} onPointerDown={(e)=>e.stopPropagation()} onWheel={(e)=>e.stopPropagation()}>
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--comfy-border)] px-4 py-3">
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{template?.name||"ComfyUI Workflow"}</div>
                <div className="mt-1 text-[11px] text-[var(--comfy-muted)]">实例参数 · 修改只影响当前画布节点</div>
            </div>
            <button type="button" className={buttonClass} onClick={()=>setEditingTemplate(true)}><Settings2 size={13}/>模板绑定</button>
            <button type="button" aria-label="关闭参数面板" className={buttonClass} onClick={onClose}><X size={14}/></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!comfyInstanceId?<p className="mb-3 rounded-lg bg-[var(--comfy-fill)] px-3 py-2 text-[11px] text-[var(--comfy-muted)]">请在右上角「配置与用户偏好 → ComfyUI」中选择默认实例，所有画布工作流节点共用此配置。</p>:null}
            {outputs.length>0?<p role="note" className="mb-3 text-[11px] text-[var(--comfy-muted)]">
                本次执行将捕获 {outputs.map(port=>port.label+" ("+port.valueKind+")").join("、")}，所有输出共享一次 ComfyUI 生成任务。
            </p>:null}
            {missingMedia.length>0?<p role="alert" className="mb-3 rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-fill)] px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                请先连接输入：{missingMedia.map(port=>port.label+" ("+port.id+")").join("、")}。从画布的图片节点连接到对应端口，模板自带的示例文件名不可直接用于生成。
            </p>:null}
            {loading?<p className="text-xs text-[var(--comfy-muted)]">正在加载模板版本…</p>
            :error?<p role="alert" className="rounded-md p-2 text-xs text-red-500">{error}</p>
            :!binding?.templateId?<div className="flex flex-col items-center gap-3 py-8 text-center text-xs text-[var(--comfy-muted)]">
                <p>尚未绑定工作流模板。先导入 API JSON 或选择预设，再编辑当前节点参数。</p>
                <button type="button" className={buttonClass} onClick={()=>setEditingTemplate(true)}><Settings2 size={14}/>导入 / 配置模板</button>
            </div>
            :fields.length?<div className="grid gap-2">
                {fields.map((field)=><ComfyScalarInput key={field.port.id} field={field}
                    onSet={(value)=>updateOverride(field.port.id,value)} onClear={()=>resetOverride(field.port.id)}/>)}
            </div>:<p className="text-xs text-[var(--comfy-muted)]">模板没有可编辑的标量输入。可在模板绑定编辑器中暴露 STRING、INT、FLOAT 或 BOOLEAN 输入。</p>}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-[var(--comfy-border)] px-4 py-3" data-comfy-run-footer>
            <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--comfy-muted)]" role="status" aria-live="polite">
                    {active?<LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true"/>
                        :status==="succeeded"?<Check size={14} className="shrink-0" aria-hidden="true"/>:null}
                    <span className="truncate">{statusLabel}</span>
                </div>
                {canCancel?<button type="button" className="shrink-0 text-[11px] text-[var(--comfy-muted)] hover:underline"
                    onClick={()=>void cancelComfyRun(currentRun!.runId).then(setRun).catch(e=>setRunError(String(e)))}>取消请求</button>:null}
            </div>
            <Button type="primary" className="sticky bottom-0 mt-auto !h-9 !w-full !shrink-0 !cursor-pointer !rounded-lg"
                disabled={disabled} onClick={()=>void execute()} aria-label="开始生成">
                <span className="inline-flex items-center gap-1.5">
                    {active?<><LoaderCircle className="size-4 animate-spin" aria-hidden="true"/><span>生成中…</span></>
                        :<><Play className="size-4" aria-hidden="true"/><span>开始生成</span></>}
                </span>
            </Button>
            {pending?<button type="button" className={buttonClass} disabled={runBusy}
                onClick={()=>void recoverSubmission()}>恢复待确认提交</button>:null}
            {statusError?<p className="break-words text-[11px] text-red-500" role="alert">{statusError}</p>:null}
        </footer>
    </section>;
}
