import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileUp, GripVertical, Link2, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { canToggleComfyInputPortVisibility } from "@/lib/canvas/canvas-ports";
import { theme as antdTheme } from "antd";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore } from "@/stores/use-config-store";
import {useComfyObjectInfo} from "./use-comfy-object-info";
import {inspectComfyInputSpec} from "./comfy-input-spec";
import {moveComfyCanvasPort,reorderComfyCanvasPorts} from "./port-order";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasPortValueKind } from "@/types/canvas";
import {
    appendComfyInputTarget, bindingTargetKey, enumerateComfyGraphItems, filterComfyGraphItems,
    inferComfyBindingMode, inferComfyInputKind, parseBindingTargetKey, removeComfyInputTarget,
    resolveComfyInputBindingAction, toggleComfyPortSelection, usedComfyInputTarget,
} from "./binding-picker";
import { ComfyTemplateBindingError, templatePayloadFromGraph, validateComfyApiGraph, type ComfyInputBinding, type ComfyNodeTarget, type ComfyObjectInfo, type ComfyTemplatePayload, type ComfyTemplatePort, type ComfyWorkflowTemplate } from "./template-schema";
import { getComfyTemplate, saveComfyTemplateVersion } from "./template-registry";
import { upsertComfyPresetForTemplate } from "./preset-registry";
import { listComfyPresetCatalog, type ComfyCatalogPreset } from "./preset-catalog";
import { buildKrea2TurboTemplate, isKrea2TurboT2IWorkflow, KREA2_TURBO_TEMPLATE_ID } from "./krea2-turbo-preset";
import { buildMiniMaxH3I2VPreset, isMiniMaxH3I2VWorkflow, MINIMAX_H3_I2V_TEMPLATE_ID } from "./minimax-h3-i2v-preset";
import { installBundledComfyTemplate } from "./preset-catalog";
import {formatComfyChoiceLines,parseComfyChoiceLines,type ComfyChoiceKind} from "./choice-options";
import type {ComfyScalarChoice} from "./template-schema";

const KINDS: CanvasPortValueKind[] = ["STRING","INT","FLOAT","BOOLEAN","IMAGE","MASK","LATENT","CONDITIONING","VIDEO","AUDIO","JSON"];
const CAPTURES = ["none","image","video","audio","text"] as const;
const FILE_LIMIT = 2_000_000;
const inputClass = "w-full min-w-0 rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-fill)] px-3 py-2 text-xs text-[var(--comfy-text)] outline-none transition-colors focus:border-[var(--comfy-accent)] focus:ring-1 focus:ring-[var(--comfy-accent)]";
const buttonClass = "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-3 py-1.5 text-xs transition hover:bg-[var(--comfy-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--comfy-accent)]";
const captionClass = "text-[11px] font-medium text-[var(--comfy-muted)]";
const selectableClass = "w-full min-w-0 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-[var(--comfy-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--comfy-accent)]";

type Props = {
    node: CanvasNodeData;
    /** Already-wired inputs cannot be hidden in this editor. */
    connectedInputPortIds?: ReadonlySet<string>;
    focus?:{nodeId:string;portId?:string};
    context?: "node" | "preset";
    onChange: (patch: Partial<CanvasNodeMetadata>, boundWorkflowName?:string) => boolean;
    onClose: () => void;
};

function newId() { return crypto.randomUUID().replaceAll("-", "").slice(0, 12); }
async function safeRead(file:File) {
    if (file.size > FILE_LIMIT) throw new Error("ComfyUI JSON 文件不能超过 2 MB");
    return JSON.parse(await file.text()) as unknown;
}
function inputPort(target?:ComfyNodeTarget, kind:CanvasPortValueKind="STRING", mode:ComfyInputBinding["mode"]="literal"):ComfyTemplatePort {
    const targets = target ? [target] : [];
    return {
        id:newId(), label:target?.inputName || "输入端口", direction:"target",valueKind:kind,
        inputBinding:mode==="socket" ? {mode,replaceInternalLink:false,targets}
            : mode==="media-file" ? {mode,mediaKind:kind as "IMAGE"|"VIDEO"|"AUDIO",targets}
            : {mode,targets},
        absentPolicy:{mode:"keep-template"},
    };
}
function outputPort(nodeId:string, index=0, kind:CanvasPortValueKind="IMAGE"):ComfyTemplatePort {
    return {id:newId(),label:"输出 "+index,direction:"source",valueKind:kind,
        outputBinding:{nodeId,outputIndex:index},capture:{kind:"none"}};
}
function displayValue(value:unknown):string {
    if (Array.isArray(value) && value.length===2) return "↗ " + value[0] + "[" + value[1] + "]";
    if (typeof value==="string") return value.length>70 ? value.slice(0,67)+"…" : value;
    if (typeof value==="number" || typeof value==="boolean") return String(value);
    if (value==null) return "null";
    return Array.isArray(value)?"数组": "对象";
}

/** Deliberately scoped to one selected port, so incomplete numeric typing
 * does not rewrite a saved immutable template revision.
 */
function ComfyChoiceEditor({port,onUpdate,onDirtyChange}:{
    port:ComfyTemplatePort;
    onUpdate:(choices:ComfyScalarChoice[])=>void;
    onDirtyChange:(dirty:boolean)=>void;
}) {
    const [text,setText]=useState(()=>formatComfyChoiceLines(port.choices??[]));
    const [error,setError]=useState("");
    useEffect(()=>{
        setText(formatComfyChoiceLines(port.choices??[]));setError("");
    },[port.id,port.choices]);
    const commit=()=>{
        const parsed=parseComfyChoiceLines(port.valueKind as ComfyChoiceKind,text);
        if(!parsed.ok){setError(parsed.error);onDirtyChange(true);return;}
        setError("");
        onUpdate(parsed.choices);
        onDirtyChange(false);
    };
    return <div className="mt-3 space-y-2" data-comfy-choice-editor>
        <label className={captionClass} htmlFor={"comfy-choices-"+port.id}>候选数组 · 每行：实际值 或 显示名称 | 实际值</label>
        <textarea id={"comfy-choices-"+port.id} aria-label="候选数组内容" rows={Math.max(3,Math.min(8,text.split("\n").length+1))}
            spellCheck={false} className={inputClass+" font-mono"}
            placeholder={port.valueKind==="STRING"?"cinematic\n写实 | realistic":port.valueKind==="FLOAT"?"0.25\n标准 | 0.5\n0.75":"8\n标准 | 16\n32"}
            value={text} onChange={e=>{setText(e.target.value);setError("");onDirtyChange(true);}}
            onBlur={commit} onKeyDown={e=>{if(e.key==="Escape")e.currentTarget.blur();}}/>
        <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-[var(--comfy-muted)]">数组只用于参数下拉显示；工作流执行时仍发送所选的 {port.valueKind} 单值。</p>
            <button type="button" className={buttonClass} onClick={commit}>应用候选项</button>
        </div>
        {error?<p role="alert" className="text-xs text-red-500">{error}</p>:null}
    </div>;
}

/** Shared copy for the node editor and global preset editor. */
export function comfyTemplateSaveButtonText(context:"node"|"preset",busy:boolean):string {
    return busy?"正在保存…":context==="preset"?"保存预设版本与绑定":"保存模板版本并绑定节点";
}

export function ComfyWorkflowPanel({node,onChange,onClose,connectedInputPortIds,focus,context="node"}:Props) {
    const themeName = useThemeStore((s)=>s.theme);
    const theme = canvasThemes[themeName];
    const {token} = antdTheme.useToken();
    const colors = {
        "--comfy-panel":theme.node.panel,
        "--comfy-fill":theme.node.fill,
        "--comfy-border":theme.node.stroke,
        "--comfy-text":theme.node.text,
        "--comfy-muted":theme.node.muted,
        "--comfy-faint":theme.node.faint,
        "--comfy-accent":theme.node.activeStroke,
    } as CSSProperties;
    const presetColors={
        "--comfy-panel":token.colorBgContainer,
        "--comfy-fill":token.colorFillSecondary,
        "--comfy-border":token.colorBorderSecondary,
        "--comfy-text":token.colorText,
        "--comfy-muted":token.colorTextSecondary,
        "--comfy-faint":token.colorTextTertiary,
        "--comfy-accent":token.colorPrimary,
    } as CSSProperties;
    const embedded = context==="preset";

    const [presets,setPresets] = useState<ComfyCatalogPreset[]>([]);
    const [draft,setDraft] = useState<ComfyTemplatePayload|null>(null);
    const [templateId,setTemplateId] = useState("");
    const comfyInstanceId=useConfigStore(s=>s.config.comfyInstanceId);
    const {objectInfo,loading:infoLoading,error:infoError,refresh:refreshObjectInfo}=useComfyObjectInfo(comfyInstanceId);
    const [selectedNodeId,setSelectedNodeId] = useState("");
    const [selectedPortId,setSelectedPortId] = useState<string|null>(null);
    const [draggingPortId,setDraggingPortId]=useState<string|null>(null);
    const [dropPosition,setDropPosition]=useState<{id:string;placement:"before"|"after"}|null>(null);
    const [choiceDirty,setChoiceDirty] = useState(false);
    useEffect(()=>setChoiceDirty(false),[selectedPortId]);
    const [nodeSearch,setNodeSearch] = useState("");
    const [expandedAdvanced,setExpandedAdvanced] = useState(false);
    const [busy,setBusy] = useState(false);
    const [error,setError] = useState("");
    const [bindingIssue,setBindingIssue] = useState<{portId:string;nodeId?:string;inputName?:string}|null>(null);
    const nodeBrowserRef=useRef<HTMLDivElement>(null);
    const portListRef=useRef<HTMLDivElement>(null);
    useEffect(()=>{
        if(!bindingIssue)return;
        const scrollToValue=(root:HTMLDivElement|null,attribute:"comfyNodeId"|"comfyPortId",value:string|undefined)=>{
            if(!root||!value)return;
            const element=Array.from(root.querySelectorAll<HTMLElement>("[data-comfy-node-id],[data-comfy-port-id]"))
                .find(item=>item.dataset[attribute]===value);
            element?.scrollIntoView?.({block:"nearest"});
        };
        scrollToValue(nodeBrowserRef.current,"comfyNodeId",bindingIssue.nodeId);
        scrollToValue(portListRef.current,"comfyPortId",bindingIssue.portId);
    },[bindingIssue]);
    const focusBindingIssue=(issue:{portId:string;nodeId?:string;inputName?:string})=>{
        setSelectedPortId(issue.portId);
        if(issue.nodeId){setSelectedNodeId(issue.nodeId);setNodeSearch("");}
    };
    const showBindingError=(cause:unknown)=>{
        setError(cause instanceof Error?cause.message:String(cause));
        if(cause instanceof ComfyTemplateBindingError){
            const issue={portId:cause.portId,nodeId:cause.nodeId,inputName:cause.inputName};
            setBindingIssue(issue);
            focusBindingIssue(issue);
        }else setBindingIssue(null);
    };
    const [status,setStatus] = useState("");

    const items = useMemo(()=>draft ? enumerateComfyGraphItems(draft.apiGraph,objectInfo) : [],[draft?.apiGraph,objectInfo]);
    const filteredItems = useMemo(()=>filterComfyGraphItems(items,nodeSearch),[items,nodeSearch]);
    const selectedItem = items.find((item)=>item.id===selectedNodeId) || filteredItems[0];
    const activePort = draft?.ports.find((port)=>port.id===selectedPortId);
    const inputPorts = draft?.ports.filter((port)=>port.direction==="target")||[];
    const outputPorts = draft?.ports.filter((port)=>port.direction==="source")||[];
    const activeSidePorts=activePort?.direction==="target"?inputPorts:outputPorts;
    const activeSideIndex=activeSidePorts.findIndex(p=>p.id===activePort?.id);
    const savedValue = node.metadata?.comfyWorkflow?.templateId && node.metadata?.comfyWorkflow?.templateRevision
        ? node.metadata.comfyWorkflow.templateId+"@"+node.metadata.comfyWorkflow.templateRevision : "";
    const selectedPreset=presets.find(p=>p.templateId+"@"+p.revision===savedValue);

    useEffect(()=>{
        let alive=true;
        void listComfyPresetCatalog().then(values=>{if(alive)setPresets(values);}).catch(cause=>{if(alive)setError(String(cause));});
        const binding=node.metadata?.comfyWorkflow;
        if(binding?.templateId && binding.templateRevision) {
            void getComfyTemplate(binding.templateId,binding.templateRevision).then(bound=>{
                if(!alive || !bound)return;
                setDraft({name:bound.name,apiGraph:bound.apiGraph,ports:bound.ports,requirements:bound.requirements});
                setTemplateId(bound.id);
                setSelectedNodeId(focus?.nodeId&&bound.apiGraph[focus.nodeId]?focus.nodeId:Object.keys(bound.apiGraph)[0]||"");
                setSelectedPortId(focus?.portId&&bound.ports.some(p=>p.id===focus.portId)?focus.portId:bound.ports[0]?.id||null);
            }).catch(cause=>{if(alive)setError(String(cause));});
        }
        return ()=>{alive=false;};
    },[node.id,focus?.nodeId,focus?.portId]);

    const edit=(fn:(current:ComfyTemplatePayload)=>ComfyTemplatePayload)=>{
        setBindingIssue(null);setError("");
        setDraft((current)=>current?fn(current):current);
    };
    const patchPort=(id:string, patch:Partial<ComfyTemplatePort>)=>edit((current)=>({
        ...current,ports:current.ports.map((port)=>port.id===id?{...port,...patch}:port),
    }));
    const changePortOrder=(movingId:string,targetId:string,placement:"before"|"after")=>{
        if(!draft||busy)return;
        const updated=reorderComfyCanvasPorts(draft.ports,movingId,targetId,placement);
        if(updated===draft.ports)return;
        edit(current=>({...current,ports:reorderComfyCanvasPorts(current.ports,movingId,targetId,placement)}));
        setSelectedPortId(movingId);
        setStatus("已调整端口显示顺序。保存模板版本后应用到画布节点。");
    };
    const shiftPort=(id:string,step:-1|1)=>{
        if(!draft||busy)return;
        const side=draft.ports.filter(p=>p.direction===draft.ports.find(port=>port.id===id)?.direction);
        const index=side.findIndex(p=>p.id===id);
        const neighbor=side[index+step];
        if(!neighbor)return;
        edit(current=>({...current,ports:moveComfyCanvasPort(current.ports,id,step)}));
        setSelectedPortId(id);
        setStatus("已调整端口显示顺序。保存模板版本后应用到画布节点。");
    };
    const addPort=(direction:"source"|"target")=>{
        const port=direction==="target"?inputPort():outputPort(selectedItem?.id||Object.keys(draft?.apiGraph||{})[0]||"");
        edit((d)=>({...d,ports:[...d.ports,port]}));
        setSelectedPortId(port.id);setError("");
    };
    const exposeField=(nodeId:string,inputName:string)=>{
        if(!draft) return;
        const target={nodeId,inputName};
        const action=resolveComfyInputBindingAction(draft.ports,selectedPortId,target);
        if(action.kind==="existing") {
            setSelectedPortId(action.portId!);
            setStatus("该参数已配置画布端口，已定位到现有映射。");
            return;
        }
        const value=draft.apiGraph[nodeId].inputs[inputName];
        const nodeType=draft.apiGraph[nodeId].class_type;
        const spec=objectInfo?.[nodeType]?.input;
        const meta=spec?.required?.[inputName]??spec?.optional?.[inputName];
        const descriptor=inspectComfyInputSpec(meta);
        const kind=inferComfyInputKind(value,descriptor.valueKind??descriptor.declaredType);
        const mode=inferComfyBindingMode(value);
        if (action.kind==="append") {
            const portId=action.portId!;
            const selected=draft.ports.find(p=>p.id===portId)!;
            try {
                const empty=selected.inputBinding?.targets.length===0;
                edit((d)=>({...d,ports:appendComfyInputTarget(d.ports,portId,target).map(p=>
                    p.id===portId&&empty&&p.inputBinding?.mode==="literal" && mode==="literal"
                        ? {...p,
                            ...(!p.choices&&!Object.prototype.hasOwnProperty.call(p,"defaultValue")
                                ? {valueKind:kind}:{}),
                            ...(!p.choices&&descriptor.choices?.length&&descriptor.valueKind===kind
                                ? {choices:descriptor.choices}:{})}
                        : p)}));
                setError("");setStatus("已将 "+nodeId+"."+inputName+" 绑定到端口「"+selected.label+"」。");
            } catch(cause) {setError(String(cause));}
            return;
        }
        const port=inputPort(target,kind,mode);
        if(mode==="literal" && descriptor.choices?.length && descriptor.valueKind===kind)
            port.choices=descriptor.choices;
        edit((d)=>({...d,ports:[...d.ports,port]}));
        setSelectedPortId(port.id);setStatus("已为 "+nodeId+"."+inputName+" 创建画布端口。");
        setError("");
    };
    const exposeSocket=(nodeId:string,index:number,kind:string)=>{
        if(!draft) return;
        const recognized=KINDS.includes(kind as CanvasPortValueKind)?kind as CanvasPortValueKind:"IMAGE";
        if(activePort?.direction==="source") {
            patchPort(activePort.id,{outputBinding:{nodeId,outputIndex:index},valueKind:recognized});
        } else {
            const port=outputPort(nodeId,index,recognized);
            edit((d)=>({...d,ports:[...d.ports,port]}));
            setSelectedPortId(port.id);
        }
        setError("");setStatus("已选择 ComfyUI 输出 "+nodeId+"["+index+"]。");
    };
    const setBindingMode=(port:ComfyTemplatePort,mode:ComfyInputBinding["mode"])=>{
        const targets=port.inputBinding?.targets || [];
        if (mode==="media-file" && !["IMAGE","VIDEO","AUDIO"].includes(port.valueKind)) {
            setError("请先将端口类型设为 IMAGE、VIDEO 或 AUDIO，再选择媒体文件绑定。");
            return;
        }
        const inputBinding:ComfyInputBinding=mode==="socket"?{mode,targets,replaceInternalLink:false}
            :mode==="media-file"?{mode,targets,mediaKind:port.valueKind as "IMAGE"|"VIDEO"|"AUDIO"}
            :{mode,targets};
        if(mode!=="literal" && port.choices){
            edit(current=>({...current,ports:current.ports.map(p=>{
                if(p.id!==port.id)return p;
                const {choices:_old,...rest}=p;
                return {...rest,inputBinding};
            })}));
        }else patchPort(port.id,{inputBinding,...(mode==="literal"?{absentPolicy:{mode:"keep-template"}}:{})});
        setError("");
    };
    const uploadGraph=async(e:ChangeEvent<HTMLInputElement>)=>{
        const file=e.target.files?.[0];e.target.value="";
        if(!file)return;
        try {
            const parsed=await safeRead(file);
            const graph=validateComfyApiGraph(parsed);
            const krea2=isKrea2TurboT2IWorkflow(graph);
            const minimax=isMiniMaxH3I2VWorkflow(graph);
            const next=krea2?buildKrea2TurboTemplate(graph):minimax?buildMiniMaxH3I2VPreset(graph)
                :templatePayloadFromGraph(file.name.replace(/\.json$/i,""),graph,objectInfo);
            setDraft(next);setTemplateId(krea2?KREA2_TURBO_TEMPLATE_ID:minimax?MINIMAX_H3_I2V_TEMPLATE_ID:"comfy-"+newId());setSelectedNodeId(krea2?"55":minimax?"105_104":Object.keys(next.apiGraph)[0]||"");
            setSelectedPortId(next.ports[0]?.id||null);setNodeSearch("");setError("");
            setStatus(krea2?"已配置 Krea 2 Turbo INT8 端口绑定，请检查并保存模板版本。"
                :minimax?"MiniMax H3 I2V 已配置图片、提示词与 VIDEO 输出绑定，请检查端口后保存模板。"
                :"工作流已加载。点击左侧节点参数即可创建输入端口。");
        }catch(cause){setError(String(cause));}
    };
    const installBuiltinPreset=async(id:string)=>{
        if(busy)return;
        try {
            setBusy(true);setError("");
            // Bundled JSON is version-pinned; no upload or GPU execution is triggered.
            const template=await installBundledComfyTemplate(id);
            if(applySaved(template)) {
                if(context==="node") {
                    await upsertComfyPresetForTemplate(template);
                    setPresets(await listComfyPresetCatalog());
                }
                setSelectedNodeId(id===KREA2_TURBO_TEMPLATE_ID?"55":"105_104");
                setSelectedPortId(id===KREA2_TURBO_TEMPLATE_ID?"prompt":"first_frame");setNodeSearch("");
                setStatus(id===MINIMAX_H3_I2V_TEMPLATE_ID
                    ?"MiniMax H3 I2V 预设已加载并绑定，支持 VIDEO 输出；请验证 ComfyUI 实例兼容性。"
                    :"已载入并绑定 Krea 2 Turbo INT8 预设：11 个输入和 1 个图片输出，仍需验证 ComfyUI 实例兼容性。");
            }
        }catch(cause){setError(String(cause));}finally{setBusy(false);}
    };
    const applySaved=(template:ComfyWorkflowTemplate):boolean=>{
        const comfyPorts=template.ports.map(({id,label,direction,valueKind,required,canvasVisible})=>({id,label,direction,valueKind,required,...(canvasVisible===false?{canvasVisible:false}:{})}));
        if(!onChange({comfyPorts,comfyWorkflow:{
            templateId:template.id,templateRevision:template.revision,instanceId:undefined,
            bindingState:"needs-instance-binding",inputOverrides:node.metadata?.comfyWorkflow?.inputOverrides??{},
        }},template.name)) {
            setError("无法应用该模板版本：已有画布连线引用了被删除或类型不兼容的端口。");
            return false;
        }
        setDraft({name:template.name,apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements});
        setTemplateId(template.id);setSelectedNodeId(Object.keys(template.apiGraph)[0]||"");
        setSelectedPortId(current=>template.ports.some(port=>port.id===current)?current:template.ports[0]?.id||null);setError("");
        setStatus("已保存新的不可变模板版本。运行时使用全局 ComfyUI 默认实例进行能力验证。");
        return true;
    };
    const save=async()=>{
        if(!draft||busy)return;
        if(choiceDirty){setError("请先修正并应用候选数组，再保存模板");return;}
        try {
            setBusy(true);setError("");setBindingIssue(null);
            const template=await saveComfyTemplateVersion(templateId,draft,objectInfo);
            if(applySaved(template) && context==="node") {
                await upsertComfyPresetForTemplate(template);
                setPresets(await listComfyPresetCatalog());
            }
        }catch(cause){showBindingError(cause);}finally{setBusy(false);}
    };

    return (
        <section
            className={embedded
                ? "flex h-full min-h-0 min-w-0 w-full cursor-default flex-col overflow-hidden bg-[var(--comfy-panel)] text-[var(--comfy-text)]"
                : "pointer-events-auto flex min-h-0 cursor-default flex-col overflow-hidden rounded-[18px] border border-[var(--comfy-border)] bg-[var(--comfy-panel)] text-[var(--comfy-text)] shadow-2xl"}
            style={embedded
                ? {...presetColors,accentColor:token.colorPrimary}
                : {...colors,colorScheme:themeName,accentColor:theme.node.activeStroke,width:"min(940px, calc(100vw - 32px))",maxHeight:"min(780px, calc(100vh - 32px))"}}
            data-canvas-no-zoom data-comfy-bindings-panel data-comfy-editor-layout={embedded?"settings":"canvas"}
            onMouseDown={(event)=>event.stopPropagation()}
            onPointerDown={(event)=>event.stopPropagation()}
            onWheel={(event)=>event.stopPropagation()}
        >
            {!embedded?<header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--comfy-border)] px-5 py-4">
                <div className="min-w-0">
                    <div className="text-sm font-semibold">ComfyUI 工作流 <span className="font-normal text-[var(--comfy-muted)]">/ 模板绑定</span></div>
                    <div className="mt-1 text-[11px] text-[var(--comfy-muted)]">将工作流内部输入与输出映射为画布端口 · 此面板仅用于配置</div>
                </div>
                <button type="button" className={buttonClass+" !size-8 !shrink-0 !px-0"} onClick={onClose} aria-label="关闭模板编辑器"><X size={15}/></button>
            </header>:null}

            <div className={embedded
                ? "flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--comfy-border)] px-4 py-3 sm:px-5"
                : "flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--comfy-border)] px-5 py-3"}>
                <label className={buttonClass+" cursor-pointer"}><FileUp size={14}/> 导入 API JSON
                    <input type="file" accept=".json,application/json" className="sr-only" onChange={(e)=>void uploadGraph(e)}/>
                </label>
                <select aria-label="加载预设" data-comfy-preset-picker
                    className={inputClass+" !w-auto min-w-[160px] max-w-[260px] flex-1"}
                    disabled={busy}
                    value={selectedPreset ? "preset:"+selectedPreset.id : ""}
                    onChange={(e)=>{
                        const value=e.target.value;
                        if(value==="builtin:krea2"){void installBuiltinPreset(KREA2_TURBO_TEMPLATE_ID);return;}
                        if(value==="builtin:minimax"){void installBuiltinPreset(MINIMAX_H3_I2V_TEMPLATE_ID);return;}
                        if(!value.startsWith("preset:"))return;
                        const preset=presets.find(p=>p.id===value.slice("preset:".length));
                        if(!preset)return;
                        if(preset.builtIn && !preset.modified){void installBuiltinPreset(preset.builtinId!);return;}
                        setBusy(true);setError("");
                        void getComfyTemplate(preset.templateId,preset.revision)
                            .then(t=>{if(!t)throw new Error("预设模板版本不存在");applySaved(t);})
                            .catch(cause=>setError(String(cause)))
                            .finally(()=>setBusy(false));
                    }}>
                    <option value="">{savedValue && draft && !selectedPreset
                        ? "当前绑定："+draft.name : "加载预设"}</option>
                    <optgroup label="内置预设">
                        {presets.filter(p=>p.builtIn).map(p=><option key={p.id} value={"preset:"+p.id}>
                            {p.name}{p.modified?"（已修改）":""}
                        </option>)}
                        {!presets.length?<>
                            <option value="builtin:krea2">Krea 2 Turbo INT8 · 文生图</option>
                            <option value="builtin:minimax">MiniMax H3 I2V Turbo · 图生视频</option>
                        </>:null}
                    </optgroup>
                    {presets.some(p=>!p.builtIn)?<optgroup label="全局预设">
                        {presets.filter(p=>!p.builtIn).map(p=><option key={p.id} value={"preset:"+p.id}>{p.name}</option>)}
                    </optgroup>:null}
                </select>
                <button type="button" className={buttonClass} data-comfy-object-info-sync
                    disabled={!comfyInstanceId||infoLoading} onClick={()=>void refreshObjectInfo()}
                    title={comfyInstanceId?"从已配置的 ComfyUI 实例刷新节点定义":"请先在 ComfyUI 设置中选择默认实例"}>
                    <RefreshCw size={14} className={infoLoading?"animate-spin":undefined}/>
                    {infoLoading?"同步中…":"同步节点定义"}
                </button>
                {draft?<span className="ml-auto text-[11px] text-[var(--comfy-muted)]">{items.length} 个节点 · {draft.ports.length} 个画布端口</span>:null}
            </div>

            {!comfyInstanceId?<div className="mx-5 mt-2 shrink-0 text-[11px] text-[var(--comfy-muted)]" role="note">
                未选择默认 ComfyUI 实例。可编辑工作流，配置实例后自动同步节点定义。
            </div>:null}
            {infoError?<div className="mx-5 mt-2 shrink-0 text-xs text-amber-600 dark:text-amber-400" role="alert">
                节点定义同步失败：{infoError}。仍可编辑工作流；请检查实例连接后重试。
            </div>:null}
            {objectInfo&&!infoError?<div className="mx-5 mt-2 shrink-0 text-[11px] text-[var(--comfy-muted)]" role="status">
                已获取 {comfyInstanceId} 的 {Object.keys(objectInfo).length} 种节点定义，可用于参数类型和输出槽位校验。
            </div>:null}
            {error?<div role="alert" className="mx-5 mt-3 shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                <div className="whitespace-pre-wrap break-words">{error}</div>
                {bindingIssue?<button type="button" className="mt-2 rounded border border-current px-2 py-1 font-medium hover:bg-red-500/10"
                    data-comfy-error-goto-port onClick={()=>focusBindingIssue(bindingIssue)}>定位出错参数</button>:null}
            </div>:null}
            {status?<div role="status" className="mx-5 mt-2 shrink-0 text-xs text-[var(--comfy-muted)]">{status}</div>:null}

            {draft ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row" data-comfy-editor-workspace>
                    <aside className={embedded
                        ? "flex min-h-[128px] max-h-[35%] w-full shrink-0 flex-col border-b border-[var(--comfy-border)] md:max-h-none md:min-h-0 md:w-[255px] md:border-b-0 md:border-r"
                        : "flex min-h-[200px] w-full shrink-0 flex-col border-b border-[var(--comfy-border)] md:min-h-0 md:w-[290px] md:border-b-0 md:border-r"} data-comfy-node-list>
                        <div className="shrink-0 px-3 pb-2 pt-4">
                            <div className="flex items-center justify-between px-1">
                                <span className={captionClass}>ComfyUI 节点</span>
                                <span className="text-[11px] text-[var(--comfy-muted)]">{filteredItems.length}/{items.length}</span>
                            </div>
                            <div className="relative mt-2">
                                <Search className="pointer-events-none absolute left-2.5 top-2.5 text-[var(--comfy-muted)]" size={14}/>
                                <input aria-label="搜索 ComfyUI 节点" className={inputClass+" !pl-8"} placeholder="搜索节点 ID、类型或参数…" value={nodeSearch} onChange={(e)=>setNodeSearch(e.target.value)}/>
                            </div>
                        </div>
                        <div ref={nodeBrowserRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-comfy-node-browser>
                            {filteredItems.map((item)=>{
                                const active=selectedItem?.id===item.id;
                                return <div key={item.id} data-comfy-node-id={item.id} className="mb-1">
                                    <button type="button" aria-expanded={active} aria-label={"选择 ComfyUI 节点 "+item.id}
                                        className={selectableClass+" flex items-center gap-2 "+(active?"bg-[var(--comfy-fill)] font-semibold":"")}
                                        onClick={()=>setSelectedNodeId(item.id)}>
                                        {active?<ChevronDown size={13}/>:<ChevronRight size={13}/>}
                                        <span className="shrink-0 rounded border border-[var(--comfy-border)] px-1.5 py-0.5 font-mono text-[10px]">{item.id}</span>
                                        <span className="min-w-0 truncate">{item.title}</span>
                                    </button>
                                    {active?<div className="ml-5 border-l border-[var(--comfy-border)] pl-2">
                                        {item.title!==item.classType?<p className="px-2 pt-1 text-[10px] text-[var(--comfy-muted)]">{item.classType}</p>:null}
                                        <p className="px-2 pt-2 text-[10px] font-medium text-[var(--comfy-muted)]">输入参数 · 点击绑定</p>
                                        {item.fields.length?item.fields.map((field)=>{
                                            const target={nodeId:item.id,inputName:field.name};
                                            const owner=usedComfyInputTarget(draft.ports,target);
                                            return <button key={field.name} type="button" title={"绑定参数 "+item.id+"."+field.name}
                                                data-comfy-binding-error={bindingIssue?.nodeId===item.id&&bindingIssue.inputName===field.name?"true":undefined}
                                                className={selectableClass+" my-0.5 flex items-start gap-2 "+(bindingIssue?.nodeId===item.id&&bindingIssue.inputName===field.name?"border border-red-500/60 bg-red-500/10":"")}
                                                onClick={()=>exposeField(item.id,field.name)}>
                                                <span className="mt-0.5 shrink-0 text-[var(--comfy-muted)]">{owner?<Check size={12}/>:<Plus size={12}/>}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{field.name}</span>
                                                    <span className="block truncate text-[10px] text-[var(--comfy-muted)]">{field.declaredType||inferComfyInputKind(field.value)} · {displayValue(field.value)}</span>
                                                </span>
                                            </button>;
                                        }):<p className="px-2 py-2 text-[11px] text-[var(--comfy-muted)]">暂无可绑定的输入参数</p>}
                                        <p className="px-2 pt-2 text-[10px] font-medium text-[var(--comfy-muted)]">输出槽位</p>
                                        {item.outputs.length?item.outputs.map((slot)=>
                                            <button type="button" key={slot.index} className={selectableClass+" my-0.5 flex items-center gap-2"}
                                                onClick={()=>exposeSocket(item.id,slot.index,slot.valueKind)}>
                                                <Plus size={12}/><span className="font-mono">[{slot.index}]</span><span>{slot.valueKind}</span>
                                            </button>
                                        ):<p className="px-2 py-2 text-[10px] text-[var(--comfy-muted)]">
                                            {objectInfo?"无输出槽位":"同步节点定义后查看输出槽位"}
                                        </p>}
                                    </div>:null}
                                </div>;
                            })}
                            {!filteredItems.length?<p className="px-3 py-4 text-xs text-[var(--comfy-muted)]">没有匹配的节点</p>:null}
                        </div>
                    </aside>

                    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-comfy-binding-editor>
                        <div className="shrink-0 border-b border-[var(--comfy-border)] px-4 pb-3 pt-4">
                            <div className="flex items-center justify-between gap-2">
                                <span className={captionClass}>画布端口</span>
                                <div className="flex gap-1.5">
                                    <button className={buttonClass} type="button" onClick={()=>addPort("target")}><Plus size={12}/> 添加输入</button>
                                    <button className={buttonClass} type="button" onClick={()=>addPort("source")}><Plus size={12}/> 添加输出</button>
                                </div>
                            </div>
                            <div ref={portListRef} className="mt-3 space-y-2.5" data-comfy-port-order-list>
                                {(["target","source"] as const).map(direction=>{
                                    const side=direction==="target"?inputPorts:outputPorts;
                                    if(!side.length)return null;
                                    return <div key={direction} data-comfy-port-order-group={direction} className="flex items-start gap-2">
                                        <span className="w-7 shrink-0 pt-2 text-[10px] text-[var(--comfy-muted)]">{direction==="target"?"输入":"输出"}</span>
                                        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                                            {side.map((p)=><button type="button" key={p.id}
                                                draggable={!busy}
                                                data-comfy-port-id={p.id}
                                                data-comfy-error-port={bindingIssue?.portId===p.id?"true":undefined}
                                                data-comfy-port-drop={dropPosition?.id===p.id?dropPosition.placement:undefined}
                                                aria-label={"选择端口 "+p.label+"，可拖动排序"}
                                                title={"拖动调整"+(direction==="target"?"输入":"输出")+"端口顺序"}
                                                aria-pressed={p.id===selectedPortId}
                                                onClick={()=>{setSelectedPortId(current=>toggleComfyPortSelection(current,p.id));setError("");setBindingIssue(null);}}
                                                onDragStart={event=>{
                                                    if(busy){event.preventDefault();return;}
                                                    event.dataTransfer.effectAllowed="move";
                                                    event.dataTransfer.setData("text/plain",p.id);
                                                    setDraggingPortId(p.id);
                                                    setSelectedPortId(p.id);
                                                }}
                                                onDragOver={event=>{
                                                    const source=draft.ports.find(item=>item.id===draggingPortId);
                                                    if(!source||source.direction!==p.direction||source.id===p.id)return;
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect="move";
                                                    const rect=event.currentTarget.getBoundingClientRect();
                                                    const placement=event.clientX<rect.left+rect.width/2?"before":"after";
                                                    if(dropPosition?.id!==p.id||dropPosition.placement!==placement)
                                                        setDropPosition({id:p.id,placement});
                                                }}
                                                onDrop={event=>{
                                                    event.preventDefault();
                                                    if(draggingPortId)changePortOrder(draggingPortId,p.id,
                                                        event.clientX<event.currentTarget.getBoundingClientRect().left+
                                                            event.currentTarget.getBoundingClientRect().width/2?"before":"after");
                                                    setDraggingPortId(null);setDropPosition(null);
                                                }}
                                                onDragEnd={()=>{setDraggingPortId(null);setDropPosition(null);}}
                                                className={"inline-flex max-w-[210px] cursor-grab items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition active:cursor-grabbing "+
                                                    (dropPosition?.id===p.id?"outline outline-2 outline-[var(--comfy-accent)] ":
                                                    bindingIssue?.portId===p.id?"border-red-500 bg-red-500/10 font-semibold ":
                                                    p.id===selectedPortId?"border-[var(--comfy-accent)] bg-[var(--comfy-fill)] font-semibold ":
                                                    "border-[var(--comfy-border)] hover:bg-[var(--comfy-fill)] ") +
                                                    (draggingPortId===p.id?"opacity-50":"")}>
                                                <GripVertical size={12} className="shrink-0 text-[var(--comfy-muted)]" aria-hidden="true"/>
                                                <span className="truncate">{p.label}</span>
                                                {direction==="target" && !p.required && p.canvasVisible===false ? <span className="shrink-0 text-[10px] text-[var(--comfy-muted)]">已隐藏</span> : null}
                                            </button>)}
                                        </div>
                                    </div>;
                                })}
                                {!draft.ports.length?<p className="text-xs text-[var(--comfy-muted)]">点击左侧参数创建端口，或手动添加端口。</p>:null}
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-comfy-port-editor>
                            {activePort ? <>
                                <div className="mb-4 flex items-start gap-2">
                                    <div className="min-w-0 flex-1">
                                        <label className={captionClass} htmlFor="comfy-port-label">端口名称</label>
                                        <input id="comfy-port-label" className={inputClass+" mt-1"} value={activePort.label} onChange={(e)=>patchPort(activePort.id,{label:e.target.value})}/>
                                        <span className="mt-1 block truncate font-mono text-[10px] text-[var(--comfy-faint)]">端口 ID · {activePort.id}</span>
                                    </div>
                                    <label className="w-[132px] shrink-0">
                                        <span className={captionClass}>数据类型</span>
                                        <select className={inputClass+" mt-1"} value={activePort.valueKind} onChange={(e)=>{
                                            const valueKind=e.target.value as CanvasPortValueKind;
                                            const patch:Partial<ComfyTemplatePort>={valueKind,...(!canToggleComfyInputPortVisibility({...activePort,valueKind})?{canvasVisible:true}:{})};
                                            if(activePort.inputBinding?.mode==="media-file" && ["IMAGE","VIDEO","AUDIO"].includes(valueKind))
                                                patch.inputBinding={...activePort.inputBinding,mediaKind:valueKind as "IMAGE"|"VIDEO"|"AUDIO"};
                                            if(activePort.valueKind!==valueKind){
                                                edit(current=>({...current,ports:current.ports.map(p=>{
                                                    if(p.id!==activePort.id)return p;
                                                    // Switching scalar types invalidates the enum's typed values.
                                                    // Remove only the stale editor configuration, not the binding target.
                                                    const {choices:_old,defaultValue:_oldDefault,...rest}=p;
                                                    const compatible=typeof p.defaultValue==="string"?valueKind==="STRING":
                                                        typeof p.defaultValue==="boolean"?valueKind==="BOOLEAN":
                                                        typeof p.defaultValue==="number"?valueKind==="FLOAT"||
                                                            valueKind==="INT"&&Number.isSafeInteger(p.defaultValue):false;
                                                    return {...rest,...patch,...(compatible?{defaultValue:p.defaultValue}:{}),
                                                        ...(p.absentPolicy?.mode==="auto-prune" &&
                                                            !["IMAGE","VIDEO","AUDIO"].includes(valueKind)
                                                            ?{absentPolicy:{mode:"keep-template" as const}}:{})};
                                                })}));
                                            }else patchPort(activePort.id,patch);
                                        }}>{KINDS.map((k)=><option key={k} value={k}>{k}</option>)}</select>
                                    </label>
                                    <div className="mt-5 flex shrink-0 items-center gap-1" data-comfy-port-order-controls>
                                        <button type="button" aria-label="端口上移" title="上移端口（同侧）"
                                            className={buttonClass+" !px-2"} disabled={busy||activeSideIndex<=0}
                                            onClick={()=>shiftPort(activePort.id,-1)}><ArrowUp size={14}/></button>
                                        <button type="button" aria-label="端口下移" title="下移端口（同侧）"
                                            className={buttonClass+" !px-2"} disabled={busy||activeSideIndex<0||activeSideIndex===activeSidePorts.length-1}
                                            onClick={()=>shiftPort(activePort.id,1)}><ArrowDown size={14}/></button>
                                        <button type="button" aria-label="删除当前端口" className={buttonClass+" !px-2.5"}
                                            onClick={()=>{edit((d)=>({...d,ports:d.ports.filter((p)=>p.id!==activePort.id)}));setSelectedPortId(draft.ports.find((p)=>p.id!==activePort.id)?.id||null);}}>
                                            <Trash2 size={15}/>
                                        </button>
                                    </div>
                                </div>

                                {activePort.direction==="target" ? <>
                                    <div className="flex flex-wrap items-end gap-3">
                                        <label className="min-w-[160px] flex-1">
                                            <span className={captionClass}>绑定方式</span>
                                            <select aria-label="绑定方式" className={inputClass+" mt-1"} value={activePort.inputBinding?.mode||"literal"}
                                                onChange={(e)=>setBindingMode(activePort,e.target.value as ComfyInputBinding["mode"])}>
                                                <option value="literal">常量值 · 标量</option>
                                                <option value="media-file">媒体文件 · 上传素材</option>
                                                <option value="socket">数据插槽 · 内部连线</option>
                                            </select>
                                        </label>
                                        <label className="inline-flex items-center gap-1.5 pb-2 text-xs">
                                            <input type="checkbox" checked={!!activePort.required} onChange={(e)=>patchPort(activePort.id,{required:e.target.checked,...(e.target.checked?{canvasVisible:true}:{}),...(e.target.checked&&activePort.absentPolicy?.mode==="auto-prune"?{absentPolicy:{mode:"keep-template"}}:{})})}/> 必填
                                        </label>
                                    </div>

                                    {canToggleComfyInputPortVisibility(activePort) ? <div className="mt-3 rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-fill)] px-3 py-2.5" data-comfy-input-port-visibility={activePort.id}>
                                        <label className="flex items-center gap-2 text-xs">
                                            <input type="checkbox" aria-label="显示画布连线端口"
                                                checked={!!activePort.required || activePort.canvasVisible !== false}
                                                disabled={busy || !!activePort.required || !!connectedInputPortIds?.has(activePort.id)}
                                                onChange={event=>patchPort(activePort.id,{canvasVisible:event.target.checked})}/>
                                            <span>显示画布连线端口</span>
                                            {activePort.required ? <span className="text-[11px] text-[var(--comfy-muted)]">必填项始终显示</span> : null}
                                        </label>
                                        {connectedInputPortIds?.has(activePort.id) && !activePort.required ?
                                            <p className="mt-1 text-[11px] text-[var(--comfy-muted)]">已有连线，断开后才能隐藏端口。</p> : null}
                                    </div> : null}

                                    {["IMAGE","VIDEO","AUDIO"].includes(activePort.valueKind) &&
                                    ["media-file","socket"].includes(activePort.inputBinding?.mode??"")?
                                        <label className="mt-3 flex items-start gap-2 text-xs" data-comfy-auto-prune-option>
                                            <input type="checkbox" aria-label="未提供媒体时动态裁剪输入"
                                                checked={activePort.absentPolicy?.mode==="auto-prune"}
                                                onChange={e=>patchPort(activePort.id,{
                                                    absentPolicy:{mode:e.target.checked?"auto-prune":"keep-template"},
                                                    ...(e.target.checked?{required:false}:{}),
                                                })}/>
                                            <span>未提供媒体时动态裁剪输入
                                                <span className="mt-1 block text-[11px] text-[var(--comfy-muted)]">
                                                    不连接时移除该可选参数及无用的图片/音频/视频加载分支；生成模式交给 ComfyUI 模型自身判断。
                                                </span>
                                            </span>
                                        </label>:null}
                                    <div className="mt-4">
                                        <span className={captionClass}>ComfyUI 输入映射 · {activePort.inputBinding?.targets.length||0}</span>
                                        <p className="mt-1 text-[11px] text-[var(--comfy-muted)]">点击左侧节点参数进行绑定。一个画布输入可映射到多个 ComfyUI 参数。</p>
                                        <div className="mt-2 flex flex-col gap-1.5">
                                            {activePort.inputBinding?.targets.map((t)=>{
                                                const info=items.find((item)=>item.id===t.nodeId);
                                                return <div key={bindingTargetKey(t)} className={"flex min-w-0 items-center gap-2 rounded-lg border bg-[var(--comfy-fill)] px-3 py-2 "+(bindingIssue?.nodeId===t.nodeId&&bindingIssue.inputName===t.inputName?"border-red-500/60 bg-red-500/10":"border-[var(--comfy-border)]")}>
                                                    <Link2 size={13} className="shrink-0 text-[var(--comfy-muted)]"/>
                                                    <span className="min-w-0 flex-1 truncate text-xs"><span className="font-medium">{info?.title||t.nodeId}</span><span className="text-[var(--comfy-muted)]"> · {t.nodeId}.{t.inputName}</span></span>
                                                    <button type="button" aria-label={"移除输入映射 "+t.nodeId+"."+t.inputName}
                                                        className="rounded p-1 hover:bg-[var(--comfy-panel)]"
                                                        onClick={()=>edit((d)=>({...d,ports:removeComfyInputTarget(d.ports,activePort.id,t)}))}><X size={13}/></button>
                                                </div>;
                                            })}
                                            {!activePort.inputBinding?.targets.length?<div className="rounded-lg border border-dashed border-[var(--comfy-border)] p-4 text-center text-xs text-[var(--comfy-muted)]">尚未选择映射目标。请从左侧节点列表选择参数。</div>:null}
                                        </div>
                                        <label className={captionClass+" mt-3 block"}>或选择 ComfyUI 输入参数</label>
                                        <select aria-label="选择 ComfyUI 输入目标" className={inputClass+" mt-1"} value=""
                                            onChange={(e)=>{if(!e.target.value)return;const t=parseBindingTargetKey(e.target.value);exposeField(t.nodeId,t.inputName);}}>
                                            <option value="">选择节点 / 参数…</option>
                                            {items.map((item)=><optgroup key={item.id} label={item.id+" · "+item.title}>
                                                {item.fields.map((f)=><option key={f.name} value={bindingTargetKey({nodeId:item.id,inputName:f.name})}>
                                                    {f.name} · {f.declaredType||inferComfyInputKind(f.value)}{usedComfyInputTarget(draft.ports,{nodeId:item.id,inputName:f.name})?"（已绑定）":""}
                                                </option>)}
                                            </optgroup>)}
                                        </select>
                                    </div>
                                    {activePort.inputBinding?.mode==="socket"?<label className="mt-4 flex items-center gap-2 text-xs">
                                        <input type="checkbox" checked={activePort.inputBinding.replaceInternalLink} onChange={(e)=>patchPort(activePort.id,{inputBinding:{...activePort.inputBinding!,mode:"socket",replaceInternalLink:e.target.checked} as ComfyInputBinding})}/>
                                        覆盖已有的内部插槽连接
                                    </label>:null}
                                    {activePort.inputBinding?.mode==="literal" && ["STRING","INT","FLOAT"].includes(activePort.valueKind)
                                        ?<div className="mt-4 rounded-lg border border-[var(--comfy-border)] p-3">
                                            <label className="inline-flex items-center gap-2 text-xs">
                                                <input type="checkbox" aria-label="启用候选数组下拉"
                                                    checked={!!activePort.choices}
                                                    onChange={e=>{setChoiceDirty(false);edit(current=>({...current,ports:current.ports.map(p=>{
                                                        if(p.id!==activePort.id)return p;
                                                        if(!e.target.checked){const {choices:_old,...rest}=p;return rest;}
                                                        const candidate=p.defaultValue ?? current.apiGraph[p.inputBinding!.targets[0]?.nodeId]?.inputs[
                                                            p.inputBinding!.targets[0]?.inputName];
                                                        const value=p.valueKind==="STRING"
                                                            ?typeof candidate==="string"?candidate:""
                                                            :typeof candidate==="number"&&Number.isFinite(candidate)?candidate:0;
                                                        return {...p,choices:[{label:String(value)||"默认",value}]};
                                                    })}));}}/>
                                                使用候选数组（节点参数显示下拉选择）
                                            </label>
                                            {activePort.choices?<ComfyChoiceEditor key={activePort.id} port={activePort}
                                                onDirtyChange={setChoiceDirty}
                                                onUpdate={choices=>edit(current=>({...current,ports:current.ports.map(p=>
                                                    p.id!==activePort.id?p:{
                                                        ...p,choices,
                                                        ...(Object.prototype.hasOwnProperty.call(p,"defaultValue") &&
                                                            !choices.some(c=>Object.is(c.value,p.defaultValue))
                                                            ?{defaultValue:choices[0].value}:{}),
                                                    })}))}/>:null}
                                        </div>:null}
                                    {activePort.inputBinding?.mode==="literal"?<div className="mt-4">
                                        <label className="inline-flex items-center gap-2 text-xs"><input type="checkbox"
                                            checked={Object.prototype.hasOwnProperty.call(activePort,"defaultValue")}
                                            onChange={(e)=>edit((d)=>({...d,ports:d.ports.map((p)=>{
                                                if(p.id!==activePort.id)return p;
                                                if(!e.target.checked){const {defaultValue:_removed,...rest}=p;return rest;}
                                                const defaultValue=p.choices?.[0]?.value ?? (p.valueKind==="BOOLEAN"?false:p.valueKind==="INT"||p.valueKind==="FLOAT"?0:"");
                                                return {...p,defaultValue};
                                            })}))}/> 使用默认值</label>
                                        {Object.prototype.hasOwnProperty.call(activePort,"defaultValue")?activePort.choices?.length?
                                            <select className={inputClass+" mt-2"} aria-label="默认输入值"
                                                value={String(activePort.choices.findIndex(c=>Object.is(c.value,activePort.defaultValue)))}
                                                onChange={e=>{
                                                    const selected=activePort.choices?.[Number(e.target.value)];
                                                    if(selected)patchPort(activePort.id,{defaultValue:selected.value});
                                                }}>
                                                {activePort.choices.map((c,index)=><option key={index} value={String(index)}>{c.label}</option>)}
                                            </select>
                                            :<input className={inputClass+" mt-2"}
                                            aria-label="默认输入值" value={String(activePort.defaultValue??"")}
                                            onChange={(e)=>patchPort(activePort.id,{defaultValue:activePort.valueKind==="BOOLEAN"?e.target.value==="true"
                                                :activePort.valueKind==="INT"||activePort.valueKind==="FLOAT"?Number(e.target.value):e.target.value})}/>:null}
                                    </div>:null}
                                    <details className="mt-4 rounded-lg border border-[var(--comfy-border)] p-3">
                                        <summary className="cursor-pointer text-xs font-medium">高级设置 · 缺失输入时的处理</summary>
                                        <div className="mt-3 grid gap-3">
                                            <label className={captionClass}>未连接时的处理
                                                <select className={inputClass+" mt-1"} value={activePort.absentPolicy?.mode||"keep-template"} onChange={(e)=>patchPort(activePort.id,{absentPolicy:e.target.value==="disconnect"?{mode:"disconnect",removeInputs:[],removeNodes:[]}:e.target.value==="auto-prune"?{mode:"auto-prune"}:{mode:"keep-template"},...(e.target.value==="auto-prune"?{required:false}:{})})}>
                                                    <option value="keep-template">保留工作流模板原值</option>
                                                    {["IMAGE","VIDEO","AUDIO"].includes(activePort.valueKind) &&
                                                        ["socket","media-file"].includes(activePort.inputBinding?.mode??"")?
                                                        <option value="auto-prune">未连接时自动裁剪</option>:null}
                                                    <option value="disconnect">移除可选输入或节点（高级）</option>
                                                </select>
                                            </label>
                                            {activePort.absentPolicy?.mode==="disconnect"?<>
                                                <label className={captionClass}>移除 ComfyUI 输入字段（每行填写 nodeId.field）
                                                    <textarea className={inputClass+" mt-1"} rows={2}
                                                        value={activePort.absentPolicy.removeInputs.map((t)=>t.nodeId+"."+t.inputName).join("\n")}
                                                        onChange={(e)=>{const removeInputs=e.target.value.split("\n").map((x)=>x.trim()).filter(Boolean).map((x)=>{const i=x.indexOf(".");return {nodeId:x.slice(0,i),inputName:x.slice(i+1)};});patchPort(activePort.id,{absentPolicy:{mode:"disconnect",removeInputs,removeNodes:activePort.absentPolicy?.mode==="disconnect"?activePort.absentPolicy.removeNodes:[]}});}}/>
                                                </label>
                                                <label className={captionClass}>移除 ComfyUI 节点 ID（用逗号分隔）
                                                    <input className={inputClass+" mt-1"} value={activePort.absentPolicy.removeNodes.join(",")}
                                                        onChange={(e)=>patchPort(activePort.id,{absentPolicy:{mode:"disconnect",removeInputs:activePort.absentPolicy?.mode==="disconnect"?activePort.absentPolicy.removeInputs:[],removeNodes:e.target.value.split(",").map((x)=>x.trim()).filter(Boolean)}})}/>
                                                </label>
                                            </>:null}
                                        </div>
                                    </details>
                                </> : <>
                                    <p className="mb-3 text-[11px] text-[var(--comfy-muted)]">选择内部节点和输出槽位。同步节点定义后可查看实际输出类型。</p>
                                    <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3">
                                        <label className={captionClass}>来源节点
                                            <select className={inputClass+" mt-1"} value={activePort.outputBinding?.nodeId||""}
                                                onChange={(e)=>{
                                                    patchPort(activePort.id,{outputBinding:{nodeId:e.target.value,outputIndex:0}});
                                                    setSelectedNodeId(e.target.value);
                                                }}>
                                                {items.map((item)=><option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
                                            </select>
                                        </label>
                                        <label className={captionClass}>输出槽位
                                            {objectInfo && items.find((item)=>item.id===activePort.outputBinding?.nodeId)?.outputs.length ?
                                                <select className={inputClass+" mt-1"} value={activePort.outputBinding?.outputIndex??0}
                                                    onChange={(e)=>patchPort(activePort.id,{outputBinding:{nodeId:activePort.outputBinding?.nodeId||"",outputIndex:Number(e.target.value)}})}>
                                                    {items.find((item)=>item.id===activePort.outputBinding?.nodeId)?.outputs.map((o)=><option key={o.index} value={o.index}>[{o.index}] {o.valueKind}</option>)}
                                                </select>:
                                                <input type="number" min={0} className={inputClass+" mt-1"}
                                                    value={activePort.outputBinding?.outputIndex??0}
                                                    onChange={(e)=>patchPort(activePort.id,{outputBinding:{nodeId:activePort.outputBinding?.nodeId||"",outputIndex:Math.max(0,Number(e.target.value))}})}/>
                                            }
                                        </label>
                                    </div>
                                    <div className="mt-4 grid grid-cols-2 gap-3">
                                        <label className={captionClass}>产物采集
                                            <select className={inputClass+" mt-1"} value={activePort.capture?.kind||"none"}
                                                onChange={(e)=>{const kind=e.target.value as typeof CAPTURES[number];patchPort(activePort.id,{capture:kind==="none"?{kind}:{kind,adapterId:kind==="image"?"SaveImage":kind==="video"?"SaveVideo":kind==="audio"?"SaveAudio":"SaveText"}});}}>
                                                {CAPTURES.map((c)=><option key={c} value={c}>{({none:"不采集",image:"图片",video:"视频",audio:"音频",text:"文本"} as Record<string,string>)[c]}</option>)}
                                            </select>
                                        </label>
                                        {activePort.capture?.kind!=="none"?<label className={captionClass}>适配器类名
                                            <input className={inputClass+" mt-1"} value={activePort.capture?.adapterId||""}
                                                onChange={(e)=>patchPort(activePort.id,{capture:{kind:activePort.capture?.kind||"none",adapterId:e.target.value}})}/>
                                        </label>:null}
                                    </div>
                                </>}
                            </>:<div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-xs text-[var(--comfy-muted)]">
                                <Link2 size={22}/><p>在上方选择端口，或点击左侧 ComfyUI 节点参数。</p>
                            </div>}
                        </div>
                    </main>
                </div>
            ) : <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-5 py-8 text-center text-xs text-[var(--comfy-muted)]">
                <FileUp size={26}/>
                <p>导入 ComfyUI API 格式的 JSON 文件，即可查看节点并绑定参数。</p>
                <p>也可以从上方选择已保存的工作流预设。</p>
            </div>}

            {draft?<div className={embedded
                ? "max-h-[38%] shrink-0 overflow-y-auto border-t border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-4 py-3 sm:px-5"
                : "shrink-0 border-t border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-5 py-3"} data-comfy-save-footer>
                <details open={expandedAdvanced} onToggle={(e)=>setExpandedAdvanced((e.currentTarget as HTMLDetailsElement).open)} className="mb-3">
                    <summary className="cursor-pointer text-[11px] font-medium text-[var(--comfy-muted)]">模板设置 · 名称、ID 与模型依赖</summary>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className={captionClass}>模板名称<input className={inputClass+" mt-1"} value={draft.name} onChange={(e)=>edit((d)=>({...d,name:e.target.value}))}/></label>
                        <label className={captionClass}>模板 ID<input className={inputClass+" mt-1"} value={templateId} onChange={(e)=>setTemplateId(e.target.value)}/></label>
                        <label className={captionClass+" sm:col-span-2"}>依赖的模型文件
                            <input className={inputClass+" mt-1"} placeholder="可选，多个模型以英文逗号分隔" value={(draft.requirements.modelAssets||[]).join(", ")}
                                onChange={(e)=>edit((d)=>({...d,requirements:{...d.requirements,modelAssets:e.target.value.split(",").map((x)=>x.trim()).filter(Boolean)}}))}/>
                        </label>
                    </div>
                </details>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="max-w-[440px] text-[11px] text-[var(--comfy-muted)]">{objectInfo?"已同步当前 ComfyUI 实例的节点定义":"尚未校验插槽类型；同步节点定义后可准确匹配"}</span>
                    <button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition hover:opacity-85 disabled:cursor-wait disabled:opacity-75"
                        style={embedded?{backgroundColor:token.colorPrimary,color:token.colorTextLightSolid}:{backgroundColor:theme.node.activeStroke,color:theme.node.panel}}
                        disabled={busy} onClick={()=>void save()}><Save size={14}/>{comfyTemplateSaveButtonText(context,busy)}</button>
                </div>
            </div>:null}
        </section>
    );
}
