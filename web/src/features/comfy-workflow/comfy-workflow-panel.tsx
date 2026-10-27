import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronRight, FileUp, Link2, Plus, Save, Search, Trash2, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { theme as antdTheme } from "antd";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasPortValueKind } from "@/types/canvas";
import {
    appendComfyInputTarget, bindingTargetKey, enumerateComfyGraphItems, filterComfyGraphItems,
    inferComfyBindingMode, inferComfyInputKind, parseBindingTargetKey, removeComfyInputTarget,
    usedComfyInputTarget,
} from "./binding-picker";
import { templatePayloadFromGraph, validateComfyApiGraph, type ComfyInputBinding, type ComfyNodeTarget, type ComfyObjectInfo, type ComfyTemplatePayload, type ComfyTemplatePort, type ComfyWorkflowTemplate } from "./template-schema";
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
    context?: "node" | "preset";
    onChange: (patch: Partial<CanvasNodeMetadata>) => boolean;
    onClose: () => void;
};

function newId() { return crypto.randomUUID().replaceAll("-", "").slice(0, 12); }
async function safeRead(file:File) {
    if (file.size > FILE_LIMIT) throw new Error("ComfyUI JSON file must not exceed 2 MB");
    return JSON.parse(await file.text()) as unknown;
}
function inputPort(target?:ComfyNodeTarget, kind:CanvasPortValueKind="STRING", mode:ComfyInputBinding["mode"]="literal"):ComfyTemplatePort {
    const targets = target ? [target] : [];
    return {
        id:newId(), label:target?.inputName || "Input", direction:"target",valueKind:kind,
        inputBinding:mode==="socket" ? {mode,replaceInternalLink:false,targets}
            : mode==="media-file" ? {mode,mediaKind:kind as "IMAGE"|"VIDEO"|"AUDIO",targets}
            : {mode,targets},
        absentPolicy:{mode:"keep-template"},
    };
}
function outputPort(nodeId:string, index=0, kind:CanvasPortValueKind="IMAGE"):ComfyTemplatePort {
    return {id:newId(),label:"Output "+index,direction:"source",valueKind:kind,
        outputBinding:{nodeId,outputIndex:index},capture:{kind:"none"}};
}
function displayValue(value:unknown):string {
    if (Array.isArray(value) && value.length===2) return "↗ " + value[0] + "[" + value[1] + "]";
    if (typeof value==="string") return value.length>70 ? value.slice(0,67)+"…" : value;
    if (typeof value==="number" || typeof value==="boolean") return String(value);
    if (value==null) return "null";
    return Array.isArray(value)?"Array": "Object";
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

export function ComfyWorkflowPanel({node,onChange,onClose,context="node"}:Props) {
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
    const [objectInfo,setObjectInfo] = useState<ComfyObjectInfo>();
    const [selectedNodeId,setSelectedNodeId] = useState("");
    const [selectedPortId,setSelectedPortId] = useState<string|null>(null);
    const [choiceDirty,setChoiceDirty] = useState(false);
    useEffect(()=>setChoiceDirty(false),[selectedPortId]);
    const [nodeSearch,setNodeSearch] = useState("");
    const [expandedAdvanced,setExpandedAdvanced] = useState(false);
    const [busy,setBusy] = useState(false);
    const [error,setError] = useState("");
    const [status,setStatus] = useState("");

    const items = useMemo(()=>draft ? enumerateComfyGraphItems(draft.apiGraph,objectInfo) : [],[draft?.apiGraph,objectInfo]);
    const filteredItems = useMemo(()=>filterComfyGraphItems(items,nodeSearch),[items,nodeSearch]);
    const selectedItem = items.find((item)=>item.id===selectedNodeId) || filteredItems[0];
    const activePort = draft?.ports.find((port)=>port.id===selectedPortId);
    const inputPorts = draft?.ports.filter((port)=>port.direction==="target")||[];
    const outputPorts = draft?.ports.filter((port)=>port.direction==="source")||[];
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
                setSelectedNodeId(Object.keys(bound.apiGraph)[0]||"");
                setSelectedPortId(bound.ports[0]?.id||null);
            }).catch(cause=>{if(alive)setError(String(cause));});
        }
        return ()=>{alive=false;};
    },[node.id]);

    const edit=(fn:(current:ComfyTemplatePayload)=>ComfyTemplatePayload)=>setDraft((current)=>current?fn(current):current);
    const patchPort=(id:string, patch:Partial<ComfyTemplatePort>)=>edit((current)=>({
        ...current,ports:current.ports.map((port)=>port.id===id?{...port,...patch}:port),
    }));
    const addPort=(direction:"source"|"target")=>{
        const port=direction==="target"?inputPort():outputPort(selectedItem?.id||Object.keys(draft?.apiGraph||{})[0]||"");
        edit((d)=>({...d,ports:[...d.ports,port]}));
        setSelectedPortId(port.id);setError("");
    };
    const exposeField=(nodeId:string,inputName:string)=>{
        if(!draft) return;
        const target={nodeId,inputName};
        const claimed=usedComfyInputTarget(draft.ports,target);
        if(claimed && claimed!==selectedPortId) {
            setSelectedPortId(claimed);setStatus("This parameter is already exposed. Selected its existing canvas port.");
            return;
        }
        if (activePort?.direction==="target") {
            try {
                edit((d)=>({...d,ports:appendComfyInputTarget(d.ports,activePort.id,target)}));
                setError("");setStatus("Bound "+nodeId+"."+inputName+" to "+activePort.label);
            } catch(cause) {setError(String(cause));}
            return;
        }
        const value=draft.apiGraph[nodeId].inputs[inputName];
        const nodeType=draft.apiGraph[nodeId].class_type;
        const spec=objectInfo?.[nodeType]?.input;
        const meta=spec?.required?.[inputName]??spec?.optional?.[inputName];
        const declared=Array.isArray(meta)&&typeof meta[0]==="string"?meta[0]:undefined;
        const kind=inferComfyInputKind(value,declared);
        const mode=inferComfyBindingMode(value);
        const port=inputPort(target,kind,mode);
        edit((d)=>({...d,ports:[...d.ports,port]}));
        setSelectedPortId(port.id);setStatus("Created canvas port for "+nodeId+"."+inputName);
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
        setError("");setStatus("Selected Comfy output "+nodeId+"["+index+"]");
    };
    const setBindingMode=(port:ComfyTemplatePort,mode:ComfyInputBinding["mode"])=>{
        const targets=port.inputBinding?.targets || [];
        if (mode==="media-file" && !["IMAGE","VIDEO","AUDIO"].includes(port.valueKind)) {
            setError("Choose IMAGE, VIDEO or AUDIO as the port type before selecting media-file.");
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
        }else patchPort(port.id,{inputBinding});
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
            setStatus(krea2?"Krea 2 Turbo INT8 bindings configured. Review ports then save the revision."
                :minimax?"MiniMax H3 I2V 已配置图片、提示词和 VIDEO 输出绑定。当前画布执行仅支持 IMAGE 产物。"
                :"Workflow loaded. Click a node parameter to expose it as an input port.");
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
                    ?"MiniMax H3 I2V 预设已载入（VIDEO 输出；当前画布执行链路暂不支持视频）。"
                    :"Krea 2 Turbo INT8 preset saved and bound: 11 inputs + image output. Instance verification still required.");
            }
        }catch(cause){setError(String(cause));}finally{setBusy(false);}
    };
    const uploadInfo=async(e:ChangeEvent<HTMLInputElement>)=>{
        const file=e.target.files?.[0];e.target.value="";if(!file)return;
        try {
            const parsed=await safeRead(file);
            if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw new Error("Invalid /object_info JSON");
            setObjectInfo(parsed as ComfyObjectInfo);setStatus("/object_info loaded. Output slots and input types are now available.");
            setError("");
        }catch(cause){setError(String(cause));}
    };
    const applySaved=(template:ComfyWorkflowTemplate):boolean=>{
        const comfyPorts=template.ports.map(({id,label,direction,valueKind,required})=>({id,label,direction,valueKind,required}));
        if(!onChange({comfyPorts,comfyWorkflow:{
            templateId:template.id,templateRevision:template.revision,instanceId:undefined,
            bindingState:"needs-instance-binding",inputOverrides:node.metadata?.comfyWorkflow?.inputOverrides??{},
        }})) {
            setError("Cannot apply revision: existing canvas connections reference removed or incompatible ports.");
            return false;
        }
        setDraft({name:template.name,apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements});
        setTemplateId(template.id);setSelectedNodeId(Object.keys(template.apiGraph)[0]||"");
        setSelectedPortId(template.ports[0]?.id||null);setError("");
        setStatus("已保存新的不可变模板版本。运行时使用全局 ComfyUI 默认实例进行能力验证。");
        return true;
    };
    const save=async()=>{
        if(!draft||busy)return;
        if(choiceDirty){setError("请先修正并应用候选数组，再保存模板");return;}
        try {
            setBusy(true);setError("");
            const template=await saveComfyTemplateVersion(templateId,draft,objectInfo);
            if(applySaved(template) && context==="node") {
                await upsertComfyPresetForTemplate(template);
                setPresets(await listComfyPresetCatalog());
            }
        }catch(cause){setError(String(cause));}finally{setBusy(false);}
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
                    <div className="text-sm font-semibold">ComfyUI Workflow <span className="font-normal text-[var(--comfy-muted)]">/ Template bindings</span></div>
                    <div className="mt-1 text-[11px] text-[var(--comfy-muted)]">Expose internal inputs and output sockets to canvas ports · Execution unavailable</div>
                </div>
                <button type="button" className={buttonClass+" !size-8 !shrink-0 !px-0"} onClick={onClose} aria-label="Close template editor"><X size={15}/></button>
            </header>:null}

            <div className={embedded
                ? "flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--comfy-border)] px-4 py-3 sm:px-5"
                : "flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--comfy-border)] px-5 py-3"}>
                <label className={buttonClass+" cursor-pointer"}><FileUp size={14}/> Import API JSON
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
                <label className={buttonClass+" cursor-pointer"}>Load /object_info
                    <input type="file" accept=".json,application/json" className="sr-only" onChange={(e)=>void uploadInfo(e)}/>
                </label>
                {draft?<span className="ml-auto text-[11px] text-[var(--comfy-muted)]">{items.length} nodes · {draft.ports.length} canvas ports</span>:null}
            </div>

            {error?<div role="alert" className="mx-5 mt-3 shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</div>:null}
            {status?<div role="status" className="mx-5 mt-2 shrink-0 text-xs text-[var(--comfy-muted)]">{status}</div>:null}

            {draft ? (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row" data-comfy-editor-workspace>
                    <aside className={embedded
                        ? "flex min-h-[128px] max-h-[35%] w-full shrink-0 flex-col border-b border-[var(--comfy-border)] md:max-h-none md:min-h-0 md:w-[255px] md:border-b-0 md:border-r"
                        : "flex min-h-[200px] w-full shrink-0 flex-col border-b border-[var(--comfy-border)] md:min-h-0 md:w-[290px] md:border-b-0 md:border-r"} data-comfy-node-list>
                        <div className="shrink-0 px-3 pb-2 pt-4">
                            <div className="flex items-center justify-between px-1">
                                <span className={captionClass}>COMFYUI NODES</span>
                                <span className="text-[11px] text-[var(--comfy-muted)]">{filteredItems.length}/{items.length}</span>
                            </div>
                            <div className="relative mt-2">
                                <Search className="pointer-events-none absolute left-2.5 top-2.5 text-[var(--comfy-muted)]" size={14}/>
                                <input aria-label="Search Comfy nodes" className={inputClass+" !pl-8"} placeholder="Search ID, class, parameter…" value={nodeSearch} onChange={(e)=>setNodeSearch(e.target.value)}/>
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-comfy-node-browser>
                            {filteredItems.map((item)=>{
                                const active=selectedItem?.id===item.id;
                                return <div key={item.id} className="mb-1">
                                    <button type="button" aria-expanded={active} aria-label={"Select Comfy node "+item.id}
                                        className={selectableClass+" flex items-center gap-2 "+(active?"bg-[var(--comfy-fill)] font-semibold":"")}
                                        onClick={()=>setSelectedNodeId(item.id)}>
                                        {active?<ChevronDown size={13}/>:<ChevronRight size={13}/>}
                                        <span className="shrink-0 rounded border border-[var(--comfy-border)] px-1.5 py-0.5 font-mono text-[10px]">{item.id}</span>
                                        <span className="min-w-0 truncate">{item.title}</span>
                                    </button>
                                    {active?<div className="ml-5 border-l border-[var(--comfy-border)] pl-2">
                                        {item.title!==item.classType?<p className="px-2 pt-1 text-[10px] text-[var(--comfy-muted)]">{item.classType}</p>:null}
                                        <p className="px-2 pt-2 text-[10px] font-medium text-[var(--comfy-muted)]">Inputs · click to bind</p>
                                        {item.fields.length?item.fields.map((field)=>{
                                            const target={nodeId:item.id,inputName:field.name};
                                            const owner=usedComfyInputTarget(draft.ports,target);
                                            return <button key={field.name} type="button" title={"Expose "+item.id+"."+field.name}
                                                className={selectableClass+" my-0.5 flex items-start gap-2"}
                                                onClick={()=>exposeField(item.id,field.name)}>
                                                <span className="mt-0.5 shrink-0 text-[var(--comfy-muted)]">{owner?<Check size={12}/>:<Plus size={12}/>}</span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{field.name}</span>
                                                    <span className="block truncate text-[10px] text-[var(--comfy-muted)]">{field.declaredType||inferComfyInputKind(field.value)} · {displayValue(field.value)}</span>
                                                </span>
                                            </button>;
                                        }):<p className="px-2 py-2 text-[11px] text-[var(--comfy-muted)]">No exposed inputs</p>}
                                        <p className="px-2 pt-2 text-[10px] font-medium text-[var(--comfy-muted)]">Output sockets</p>
                                        {item.outputs.length?item.outputs.map((slot)=>
                                            <button type="button" key={slot.index} className={selectableClass+" my-0.5 flex items-center gap-2"}
                                                onClick={()=>exposeSocket(item.id,slot.index,slot.valueKind)}>
                                                <Plus size={12}/><span className="font-mono">[{slot.index}]</span><span>{slot.valueKind}</span>
                                            </button>
                                        ):<p className="px-2 py-2 text-[10px] text-[var(--comfy-muted)]">
                                            {objectInfo?"No output sockets":"Load /object_info to list output sockets"}
                                        </p>}
                                    </div>:null}
                                </div>;
                            })}
                            {!filteredItems.length?<p className="px-3 py-4 text-xs text-[var(--comfy-muted)]">No matching nodes</p>:null}
                        </div>
                    </aside>

                    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-comfy-binding-editor>
                        <div className="shrink-0 border-b border-[var(--comfy-border)] px-4 pb-3 pt-4">
                            <div className="flex items-center justify-between gap-2">
                                <span className={captionClass}>CANVAS PORTS</span>
                                <div className="flex gap-1.5">
                                    <button className={buttonClass} type="button" onClick={()=>addPort("target")}><Plus size={12}/> Input</button>
                                    <button className={buttonClass} type="button" onClick={()=>addPort("source")}><Plus size={12}/> Output</button>
                                </div>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-1.5">
                                {draft.ports.map((p)=><button type="button" key={p.id} aria-pressed={p.id===selectedPortId} onClick={()=>{setSelectedPortId(p.id);setError("");}}
                                    className={"inline-flex max-w-[210px] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition "+(p.id===selectedPortId?"border-[var(--comfy-accent)] bg-[var(--comfy-fill)] font-semibold":"border-[var(--comfy-border)] hover:bg-[var(--comfy-fill)]")}>
                                    <span className="text-[10px] text-[var(--comfy-muted)]">{p.direction==="target"?"IN":"OUT"}</span>
                                    <span className="truncate">{p.label}</span>
                                </button>)}
                                {!draft.ports.length?<p className="text-xs text-[var(--comfy-muted)]">Select a Comfy parameter on the left, or add a port.</p>:null}
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-comfy-port-editor>
                            {activePort ? <>
                                <div className="mb-4 flex items-start gap-2">
                                    <div className="min-w-0 flex-1">
                                        <label className={captionClass} htmlFor="comfy-port-label">PORT LABEL</label>
                                        <input id="comfy-port-label" className={inputClass+" mt-1"} value={activePort.label} onChange={(e)=>patchPort(activePort.id,{label:e.target.value})}/>
                                        <span className="mt-1 block truncate font-mono text-[10px] text-[var(--comfy-faint)]">Port ID · {activePort.id}</span>
                                    </div>
                                    <label className="w-[132px] shrink-0">
                                        <span className={captionClass}>VALUE TYPE</span>
                                        <select className={inputClass+" mt-1"} value={activePort.valueKind} onChange={(e)=>{
                                            const valueKind=e.target.value as CanvasPortValueKind;
                                            const patch:Partial<ComfyTemplatePort>={valueKind};
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
                                                    return {...rest,...patch,...(compatible?{defaultValue:p.defaultValue}:{})};
                                                })}));
                                            }else patchPort(activePort.id,patch);
                                        }}>{KINDS.map((k)=><option key={k} value={k}>{k}</option>)}</select>
                                    </label>
                                    <button type="button" aria-label="Delete selected port" className={buttonClass+" mt-5 !px-2.5"}
                                        onClick={()=>{edit((d)=>({...d,ports:d.ports.filter((p)=>p.id!==activePort.id)}));setSelectedPortId(draft.ports.find((p)=>p.id!==activePort.id)?.id||null);}}>
                                        <Trash2 size={15}/>
                                    </button>
                                </div>

                                {activePort.direction==="target" ? <>
                                    <div className="flex flex-wrap items-end gap-3">
                                        <label className="min-w-[160px] flex-1">
                                            <span className={captionClass}>BINDING MODE</span>
                                            <select aria-label="Binding mode" className={inputClass+" mt-1"} value={activePort.inputBinding?.mode||"literal"}
                                                onChange={(e)=>setBindingMode(activePort,e.target.value as ComfyInputBinding["mode"])}>
                                                <option value="literal">Literal · scalar</option>
                                                <option value="media-file">Media file · uploaded asset</option>
                                                <option value="socket">Socket · internal link</option>
                                            </select>
                                        </label>
                                        <label className="inline-flex items-center gap-1.5 pb-2 text-xs">
                                            <input type="checkbox" checked={!!activePort.required} onChange={(e)=>patchPort(activePort.id,{required:e.target.checked})}/> Required
                                        </label>
                                    </div>

                                    <div className="mt-4">
                                        <span className={captionClass}>COMFY INPUT TARGETS · {activePort.inputBinding?.targets.length||0}</span>
                                        <p className="mt-1 text-[11px] text-[var(--comfy-muted)]">Click parameters in the left node browser to bind them. One canvas input can feed several Comfy fields.</p>
                                        <div className="mt-2 flex flex-col gap-1.5">
                                            {activePort.inputBinding?.targets.map((t)=>{
                                                const info=items.find((item)=>item.id===t.nodeId);
                                                return <div key={bindingTargetKey(t)} className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--comfy-border)] bg-[var(--comfy-fill)] px-3 py-2">
                                                    <Link2 size={13} className="shrink-0 text-[var(--comfy-muted)]"/>
                                                    <span className="min-w-0 flex-1 truncate text-xs"><span className="font-medium">{info?.title||t.nodeId}</span><span className="text-[var(--comfy-muted)]"> · {t.nodeId}.{t.inputName}</span></span>
                                                    <button type="button" aria-label={"Remove target "+t.nodeId+"."+t.inputName}
                                                        className="rounded p-1 hover:bg-[var(--comfy-panel)]"
                                                        onClick={()=>edit((d)=>({...d,ports:removeComfyInputTarget(d.ports,activePort.id,t)}))}><X size={13}/></button>
                                                </div>;
                                            })}
                                            {!activePort.inputBinding?.targets.length?<div className="rounded-lg border border-dashed border-[var(--comfy-border)] p-4 text-center text-xs text-[var(--comfy-muted)]">No targets selected. Choose a parameter from the node browser.</div>:null}
                                        </div>
                                        <label className={captionClass+" mt-3 block"}>OR SELECT A COMFY INPUT</label>
                                        <select aria-label="Choose Comfy input target" className={inputClass+" mt-1"} value=""
                                            onChange={(e)=>{if(!e.target.value)return;const t=parseBindingTargetKey(e.target.value);exposeField(t.nodeId,t.inputName);}}>
                                            <option value="">Choose node / parameter…</option>
                                            {items.map((item)=><optgroup key={item.id} label={item.id+" · "+item.title}>
                                                {item.fields.map((f)=><option key={f.name} value={bindingTargetKey({nodeId:item.id,inputName:f.name})}>
                                                    {f.name} · {f.declaredType||inferComfyInputKind(f.value)}{usedComfyInputTarget(draft.ports,{nodeId:item.id,inputName:f.name})?" (exposed)":""}
                                                </option>)}
                                            </optgroup>)}
                                        </select>
                                    </div>
                                    {activePort.inputBinding?.mode==="socket"?<label className="mt-4 flex items-center gap-2 text-xs">
                                        <input type="checkbox" checked={activePort.inputBinding.replaceInternalLink} onChange={(e)=>patchPort(activePort.id,{inputBinding:{...activePort.inputBinding!,mode:"socket",replaceInternalLink:e.target.checked} as ComfyInputBinding})}/>
                                        Replace an existing internal socket connection
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
                                            })}))}/> Use a default value</label>
                                        {Object.prototype.hasOwnProperty.call(activePort,"defaultValue")?activePort.choices?.length?
                                            <select className={inputClass+" mt-2"} aria-label="Default input value"
                                                value={String(activePort.choices.findIndex(c=>Object.is(c.value,activePort.defaultValue)))}
                                                onChange={e=>{
                                                    const selected=activePort.choices?.[Number(e.target.value)];
                                                    if(selected)patchPort(activePort.id,{defaultValue:selected.value});
                                                }}>
                                                {activePort.choices.map((c,index)=><option key={index} value={String(index)}>{c.label}</option>)}
                                            </select>
                                            :<input className={inputClass+" mt-2"}
                                            aria-label="Default input value" value={String(activePort.defaultValue??"")}
                                            onChange={(e)=>patchPort(activePort.id,{defaultValue:activePort.valueKind==="BOOLEAN"?e.target.value==="true"
                                                :activePort.valueKind==="INT"||activePort.valueKind==="FLOAT"?Number(e.target.value):e.target.value})}/>:null}
                                    </div>:null}
                                    <details className="mt-4 rounded-lg border border-[var(--comfy-border)] p-3">
                                        <summary className="cursor-pointer text-xs font-medium">Advanced · missing input behavior</summary>
                                        <div className="mt-3 grid gap-3">
                                            <label className={captionClass}>When unconnected
                                                <select className={inputClass+" mt-1"} value={activePort.absentPolicy?.mode||"keep-template"} onChange={(e)=>patchPort(activePort.id,{absentPolicy:e.target.value==="disconnect"?{mode:"disconnect",removeInputs:[],removeNodes:[]}:{mode:"keep-template"}})}>
                                                    <option value="keep-template">Keep workflow template value</option><option value="disconnect">Remove optional inputs/nodes</option>
                                                </select>
                                            </label>
                                            {activePort.absentPolicy?.mode==="disconnect"?<>
                                                <label className={captionClass}>Remove Comfy input fields (nodeId.field per line)
                                                    <textarea className={inputClass+" mt-1"} rows={2}
                                                        value={activePort.absentPolicy.removeInputs.map((t)=>t.nodeId+"."+t.inputName).join("\n")}
                                                        onChange={(e)=>{const removeInputs=e.target.value.split("\n").map((x)=>x.trim()).filter(Boolean).map((x)=>{const i=x.indexOf(".");return {nodeId:x.slice(0,i),inputName:x.slice(i+1)};});patchPort(activePort.id,{absentPolicy:{mode:"disconnect",removeInputs,removeNodes:activePort.absentPolicy?.mode==="disconnect"?activePort.absentPolicy.removeNodes:[]}});}}/>
                                                </label>
                                                <label className={captionClass}>Remove Comfy node IDs (comma-separated)
                                                    <input className={inputClass+" mt-1"} value={activePort.absentPolicy.removeNodes.join(",")}
                                                        onChange={(e)=>patchPort(activePort.id,{absentPolicy:{mode:"disconnect",removeInputs:activePort.absentPolicy?.mode==="disconnect"?activePort.absentPolicy.removeInputs:[],removeNodes:e.target.value.split(",").map((x)=>x.trim()).filter(Boolean)}})}/>
                                                </label>
                                            </>:null}
                                        </div>
                                    </details>
                                </> : <>
                                    <p className="mb-3 text-[11px] text-[var(--comfy-muted)]">Choose an internal node and socket. Load /object_info to list actual output types.</p>
                                    <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3">
                                        <label className={captionClass}>SOURCE NODE
                                            <select className={inputClass+" mt-1"} value={activePort.outputBinding?.nodeId||""}
                                                onChange={(e)=>{
                                                    patchPort(activePort.id,{outputBinding:{nodeId:e.target.value,outputIndex:0}});
                                                    setSelectedNodeId(e.target.value);
                                                }}>
                                                {items.map((item)=><option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
                                            </select>
                                        </label>
                                        <label className={captionClass}>OUTPUT SLOT
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
                                        <label className={captionClass}>CAPTURE
                                            <select className={inputClass+" mt-1"} value={activePort.capture?.kind||"none"}
                                                onChange={(e)=>{const kind=e.target.value as typeof CAPTURES[number];patchPort(activePort.id,{capture:kind==="none"?{kind}:{kind,adapterId:kind==="image"?"SaveImage":kind==="video"?"SaveVideo":kind==="audio"?"SaveAudio":"SaveText"}});}}>
                                                {CAPTURES.map((c)=><option key={c} value={c}>{c}</option>)}
                                            </select>
                                        </label>
                                        {activePort.capture?.kind!=="none"?<label className={captionClass}>ADAPTER CLASS
                                            <input className={inputClass+" mt-1"} value={activePort.capture?.adapterId||""}
                                                onChange={(e)=>patchPort(activePort.id,{capture:{kind:activePort.capture?.kind||"none",adapterId:e.target.value}})}/>
                                        </label>:null}
                                    </div>
                                </>}
                            </>:<div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-xs text-[var(--comfy-muted)]">
                                <Link2 size={22}/><p>Select a port above or click a Comfy node parameter on the left.</p>
                            </div>}
                        </div>
                    </main>
                </div>
            ) : <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-5 py-8 text-center text-xs text-[var(--comfy-muted)]">
                <FileUp size={26}/>
                <p>Import a ComfyUI API Format JSON to inspect nodes and bind their parameters.</p>
                <p>Or select a saved immutable template revision above.</p>
            </div>}

            {draft?<div className={embedded
                ? "max-h-[38%] shrink-0 overflow-y-auto border-t border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-4 py-3 sm:px-5"
                : "shrink-0 border-t border-[var(--comfy-border)] bg-[var(--comfy-panel)] px-5 py-3"} data-comfy-save-footer>
                <details open={expandedAdvanced} onToggle={(e)=>setExpandedAdvanced((e.currentTarget as HTMLDetailsElement).open)} className="mb-3">
                    <summary className="cursor-pointer text-[11px] font-medium text-[var(--comfy-muted)]">Template settings · Name, ID & model requirements</summary>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className={captionClass}>NAME<input className={inputClass+" mt-1"} value={draft.name} onChange={(e)=>edit((d)=>({...d,name:e.target.value}))}/></label>
                        <label className={captionClass}>TEMPLATE ID<input className={inputClass+" mt-1"} value={templateId} onChange={(e)=>setTemplateId(e.target.value)}/></label>
                        <label className={captionClass+" sm:col-span-2"}>REQUIRED MODELS
                            <input className={inputClass+" mt-1"} placeholder="Optional, comma separated" value={(draft.requirements.modelAssets||[]).join(", ")}
                                onChange={(e)=>edit((d)=>({...d,requirements:{...d.requirements,modelAssets:e.target.value.split(",").map((x)=>x.trim()).filter(Boolean)}}))}/>
                        </label>
                    </div>
                </details>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="max-w-[440px] text-[11px] text-[var(--comfy-muted)]">{objectInfo?"Offline /object_info loaded":"Socket types unverified · load /object_info for accurate matching"}</span>
                    <button type="button" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition hover:opacity-85 disabled:cursor-wait disabled:opacity-75"
                        style={embedded?{backgroundColor:token.colorPrimary,color:token.colorTextLightSolid}:{backgroundColor:theme.node.activeStroke,color:theme.node.panel}}
                        disabled={busy} onClick={()=>void save()}><Save size={14}/>{busy?"Saving…":context==="preset"?"保存预设版本与绑定":"Save revision & bind node"}</button>
                </div>
            </div>:null}
        </section>
    );
}
