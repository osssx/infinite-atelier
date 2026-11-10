import {useCallback,useEffect,useMemo,useRef,useState,type CSSProperties,type Dispatch,type SetStateAction} from "react";
import {Modal} from "antd";
import {AlertCircle,ArrowUp,ArrowUpRight,Bot,Check,ChevronDown,ChevronUp,Clock3,Copy,FileText,Image as ImageIcon,Layers3,Link2,LoaderCircle,MessageSquarePlus,Music2,Plus,RefreshCw,Sparkles,Square,Trash2,UserRound,Video,X} from "lucide-react";
import {Streamdown} from "streamdown";
import {nanoid} from "nanoid";
import {CanvasApiError,canvasApi} from "@/features/backend-sync/canvas-api";
import {ensureSqliteModelChannelForExecution,modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {modelOptionLabel,modelOptionName,resolveModelChannel,resolveModelScript,selectableModelsByCapability,type AiConfig} from "@/stores/use-config-store";
import {canvasThemes,type CanvasColorTheme} from "@/lib/canvas-theme";import {useThemeStore} from "@/stores/use-theme-store";
import {CanvasNodeType,type CanvasAssistantMessage,type CanvasAssistantSession,type CanvasNodeTypeId} from "@/types/canvas";
import type {AssistantContextResult,AssistantContextScope} from "./canvas-assistant-context";
import {parseAssistantCanvasActions,isDangerousAssistantAction,dangerousAssistantActionSummary,type AssistantCanvasStage} from "./canvas-assistant-actions";
import {buildCanvasAssistantTurns} from "./canvas-assistant-history";
import "./canvas-assistant-panel.css";
type Choice={id:string;title:string;type:CanvasNodeTypeId};
function ReferenceIcon({type}:{type:CanvasNodeTypeId}){
 const Icon=type===CanvasNodeType.Text?FileText:type===CanvasNodeType.Image?ImageIcon:
  type===CanvasNodeType.Video?Video:type===CanvasNodeType.Audio?Music2:Layers3;
 return <Icon size={12} aria-hidden="true"/>;
}
type Props={
 projectId:string;projectTitle:string;open:boolean;onClose:()=>void;
 sessions:CanvasAssistantSession[];setSessions:Dispatch<SetStateAction<CanvasAssistantSession[]>>;
 activeChatId:string|null;setActiveChatId:Dispatch<SetStateAction<string|null>>;
   selectedNodes:Choice[];getContext:(ids:string[],scope:AssistantContextScope)=>AssistantContextResult;
   onApplyActions:(actions:unknown,stage:AssistantCanvasStage,refs?:ReadonlyMap<string,string>)=>{applied:number;refs:Map<string,string>};
   onRunActions:(actions:unknown,refs:ReadonlyMap<string,string>,signal:AbortSignal)=>Promise<{submitted:number;jobIds:string[]}>;
   config:AiConfig;};const now=()=>new Date().toISOString();
const append=(list:CanvasAssistantSession[],id:string,message:CanvasAssistantMessage)=>{
 const stamp=now();
 const existing=list.find(session=>session.id===id);
 if(!existing)return [...list,{id,title:message.text.slice(0,30)||"新对话",messages:[message],createdAt:stamp,updatedAt:stamp}];
 return list.map(session=>session.id===id?{...session,messages:[...session.messages,message].slice(-40),updatedAt:stamp}:session);};
const assistantErrorMessages:Record<string,string>={
 assistant_response_invalid:"模型返回的数据无法解析，请确认渠道兼容 Chat Completions 接口，或更换模型重试。",
 assistant_response_empty:"模型请求已完成，但没有返回可显示的最终正文。可能是模型只生成了推理内容；请尝试精简提问或更换模型。",
 assistant_response_incomplete:"模型回答未完成，可能达到输出长度限制或响应中断。请缩短上下文后重试。",
 assistant_response_blocked:"模型回复被内容安全限制拦截，请调整问题后重试。",
 assistant_response_too_large:"模型回复超过支持的大小限制，请缩短提问或要求简短回答。",
 assistant_upstream_rate_limited:"模型渠道请求过于频繁（429），请稍后重试。",
 assistant_upstream_auth_failed:"模型渠道鉴权失败，请检查渠道设置中的 API Key 与权限。",
 assistant_upstream_error:"模型渠道返回错误，请检查模型名称、接口地址及该渠道的接口兼容性。",
 assistant_upstream_unavailable:"无法连接模型渠道或请求超时，请检查网络、渠道地址和服务状态。",
 assistant_upstream_retry_exhausted:"模型请求网络异常或超时，已自动重试 2 次仍未成功。请检查网络与模型服务状态后再试。",
  assistant_channel_unavailable:"模型渠道尚未配置可用的服务端密钥，请在设置中检查配置。",
  assistant_actions_invalid:"模型返回的画布操作格式不符合要求，未执行画布修改。请尝试更明确地描述操作。",
  assistant_actions_missing:"模型未返回可执行的画布指令，已尝试重新生成操作计划，但画布仍未修改。请明确要执行的操作，或更换支持结构化 JSON 输出的模型。",};
export function canvasAssistantErrorText(error:unknown){
 if(error instanceof CanvasApiError)return assistantErrorMessages[error.code]??error.message;
 if(error instanceof Error)return assistantErrorMessages[error.message]??error.message;
 return "模型请求失败，请稍后重试。";
}
/** Modal.confirm portals into document.body, so it cannot inherit the canvas panel palette. */
export function canvasAssistantConfirmTheme(themeName:CanvasColorTheme){
 const palette=canvasThemes[themeName];
 return {
  className:"canvas-assistant-confirm",
  rootClassName:"canvas-assistant-confirm-root",
  style:{
   "--assistant-confirm-panel":palette.toolbar.panel,
   "--assistant-confirm-surface":palette.node.panel,
   "--assistant-confirm-border":palette.toolbar.border,
   "--assistant-confirm-text":palette.node.text,
   "--assistant-confirm-muted":palette.node.muted,
   "--assistant-confirm-hover":palette.toolbar.itemHover,
   "--assistant-confirm-active":palette.toolbar.activeBg,
   "--assistant-confirm-danger":themeName==="dark"?"#fca5a5":"#b91c1c",
   "--assistant-confirm-shadow":themeName==="dark"?"0 24px 72px rgba(0,0,0,.60)":"0 24px 72px rgba(41,37,36,.20)",
  } as CSSProperties,
  styles:{mask:{backgroundColor:themeName==="dark"?"rgba(10,9,8,.64)":"rgba(30,27,24,.32)"}}
 };
}
/** Confirm only high-risk operations; do not display a generic diff preview. */
function confirmDangerousActions(summary:string,signal:AbortSignal,themeName:CanvasColorTheme):Promise<boolean>{
 return new Promise(resolve=>{
  if(signal.aborted){resolve(false);return;}
  let settled=false;
  let dialog:ReturnType<typeof Modal.confirm>|undefined;
  let unsubscribe=()=>{};
  const finish=(accepted:boolean)=>{
   if(settled)return;
   settled=true;
   unsubscribe();
   signal.removeEventListener("abort",onAbort);
   resolve(accepted);
  };
  const onAbort=()=>{dialog?.destroy();finish(false);};
  dialog=Modal.confirm({
   ...canvasAssistantConfirmTheme(themeName),
   icon:<AlertCircle className="canvas-assistant-confirm-icon" size={19} aria-hidden="true"/>,
   title:"确认 AI 画布操作",
   content:summary+"。"+(summary.includes("解散")?"解散仅移除分组容器，保留组内节点、素材及连线。":"这些操作会修改或删除已有内容。")+"是否执行？",
   okText:"确认执行",okType:"danger",cancelText:"取消",
   onOk:()=>{finish(true);},onCancel:()=>{finish(false);}
  });
  // Keep an already-open portal aligned if the user switches the canvas theme.
  if(typeof useThemeStore.subscribe==="function"){
   unsubscribe=useThemeStore.subscribe(state=>{
    if(!settled)dialog?.update(canvasAssistantConfirmTheme(state.theme));
   });
  }
  signal.addEventListener("abort",onAbort,{once:true});
  if(signal.aborted)onAbort();
 });
}/** UI messages update only on send/terminal, not on every canvas pointer event. */
export function CanvasAssistantPanel({projectId,projectTitle,open,onClose,sessions,setSessions,activeChatId,setActiveChatId,selectedNodes,getContext,onApplyActions,onRunActions,config}:Props){
  const themeName=useThemeStore(state=>state.theme);
  const theme=canvasThemes[themeName];
  const [draft,setDraft]=useState(""); const [modelRef,setModelRef]=useState(config.textModel);
 const [scope,setScope]=useState<AssistantContextScope>("selection");
 const [includeContext,setIncludeContext]=useState(true);
 const [includedIds,setIncludedIds]=useState<string[]>([]);
 const [sending,setSending]=useState(false);
 const [previewOpen,setPreviewOpen]=useState(false);
 const [previewRevision,setPreviewRevision]=useState(0);
 const controllerRef=useRef<AbortController|null>(null);
 const scrollRef=useRef<HTMLDivElement>(null);
 const signature=selectedNodes.map(node=>node.id).join("|");
 useEffect(()=>{setIncludedIds(selectedNodes.slice(0,12).map(node=>node.id));setPreviewRevision(n=>n+1);},[signature]);
 useEffect(()=>()=>controllerRef.current?.abort(),[]);
 const options=useMemo(()=>selectableModelsByCapability(config,"text").filter(value=>
  !resolveModelScript(config,value)&&Boolean(modelChannelProvider(resolveModelChannel(config,value),"text")))
  .map(value=>({value,label:modelOptionLabel(config,value)})),[config]);
 const chosenModel=options.some(option=>option.value===modelRef)?modelRef:options[0]?.value??"";
 const effectiveScope=scope==="selection"&&includedIds.length===0&&selectedNodes.length===0?"overview":scope; const context=useMemo(()=>getContext(includedIds,effectiveScope),[getContext,includedIds,effectiveScope,previewRevision]);
 const session=sessions.find(item=>item.id===activeChatId);
 useEffect(()=>{if(open)scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight});},[open,session?.id,session?.messages.length,sending]);
 const stop=useCallback(()=>controllerRef.current?.abort(),[]);
 const send=useCallback(async()=>{
  const text=draft.trim();if(!text||controllerRef.current||!chosenModel)return;
  const channel=resolveModelChannel(config,chosenModel);
  const provider=modelChannelProvider(channel,"text");
  if(!channel||!provider||provider==="volcengine_ark")return;
  const contextSnapshot=includeContext?getContext(includedIds,effectiveScope):null;
  const user:CanvasAssistantMessage={id:nanoid(),role:"user",text,
   ...(contextSnapshot?.references.length?{references:contextSnapshot.references}:{})};
  const id=session?.id??nanoid();
   const prior=session?.messages??[];
   const modelHints=(["text","image","video","audio"] as const).map(mode=>{
    const models=selectableModelsByCapability(config,mode).slice(0,16);
    return mode+" 生成模型："+(models.length?models.join("、"):"未配置");
   }).join("\n").slice(0,2500);
   const contextText=contextSnapshot?.text?contextSnapshot.text+"\n"+modelHints:undefined;
   const turns=buildCanvasAssistantTurns(prior,text,contextText);
   const controller=new AbortController();controllerRef.current=controller;  setSending(true);setDraft("");setSessions(prev=>append(prev,id,user));setActiveChatId(id);
  try{
   await ensureSqliteModelChannelForExecution(channel,provider);
   if(controller.signal.aborted)return;
    const response=await canvasApi<{answer:string;model:string;retryCount?:number;actions?:unknown}>(
     "/api/v1/projects/"+encodeURIComponent(projectId)+"/assistant/chat","POST",{
      channelId:channel.id,provider,baseUrl:channel.baseUrl,model:modelOptionName(chosenModel),
      messages:turns,canvasActions:true
     },controller.signal);
    if(controller.signal.aborted)throw new DOMException("Aborted","AbortError");
    const notes:string[]=[];
     try{
       const actions=parseAssistantCanvasActions(response.actions??[]);
       if(!actions.length)notes.push("本轮没有执行任何画布操作，画布保持不变。");
       if(actions.length){
        const safe=onApplyActions(actions,"safe");
        if(safe.applied)notes.push("已自动执行 "+safe.applied+" 项画布操作。");
        const dangerous=actions.filter(isDangerousAssistantAction);
        let approved=true;
        if(dangerous.length){
         const confirmed=await confirmDangerousActions(dangerousAssistantActionSummary(dangerous),controller.signal,themeName);
         if(controller.signal.aborted)throw new DOMException("Aborted","AbortError");
         if(confirmed){
          const result=onApplyActions(actions,"dangerous",safe.refs);
          if(result.applied)notes.push("已确认并执行 "+result.applied+" 项内容或参数修改。");
         }else{
          approved=false;
          notes.push("你已取消修改或删除操作，其他已执行的操作不受影响。");
         }
        }
        const runs=actions.filter(action=>action.type==="run_node"||action.type==="run_workflow");
        if(runs.length){
         if(!approved)notes.push("因你拒绝了本轮参数或内容修改，已跳过全部 "+runs.length+" 项生成执行。");
         else{
          const result=await onRunActions(runs,safe.refs,controller.signal);
          if(controller.signal.aborted)throw new DOMException("Aborted","AbortError");
          if(result.submitted)notes.push("已通过原有节点执行链路提交 "+result.submitted+
           " 项生成任务（任务 ID："+result.jobIds.join("、")+"）。可在节点或任务历史查看进度并停止。");
         }
        }
       }
     }catch(operationError){
       if(controller.signal.aborted)throw operationError;
       notes.push("画布操作未完成："+(operationError instanceof Error?operationError.message:"执行失败"));
     }    const answer=[response.answer,...notes].filter(Boolean).join("\n\n");
    setSessions(prev=>append(prev,id,{id:nanoid(),role:"assistant",text:answer,
      meta:response.model+(response.retryCount?` · 网络自动重试 ${response.retryCount} 次`:"")}));
   }catch(error){
   const stopped=controller.signal.aborted;
   setSessions(prev=>append(prev,id,{id:nanoid(),role:"error",text:stopped?"已停止生成":canvasAssistantErrorText(error)}));
  }finally{
   if(controllerRef.current===controller)controllerRef.current=null;
   setSending(false);
  }
  },[draft,chosenModel,config,includeContext,getContext,includedIds,effectiveScope,session,setSessions,setActiveChatId,projectId,onApplyActions,onRunActions,themeName]);
  const clear=()=>{
  if(!session||sending)return;
  Modal.confirm({...canvasAssistantConfirmTheme(themeName),icon:<AlertCircle className="canvas-assistant-confirm-icon" size={19} aria-hidden="true"/>,title:"删除当前对话？",content:"删除后无法恢复。",okText:"删除",okType:"danger",cancelText:"取消",onOk:()=>{
   setSessions(prev=>prev.filter(item=>item.id!==session.id));
   setActiveChatId(null);
  }});
 };
 const assistantStyle={
  "--assistant-panel":theme.toolbar.panel,
  "--assistant-surface":theme.node.panel,
  "--assistant-fill":theme.node.fill,
  "--assistant-border":theme.toolbar.border,
  "--assistant-text":theme.node.text,
  "--assistant-muted":theme.node.muted,
  "--assistant-faint":theme.node.faint,
  "--assistant-hover":theme.toolbar.itemHover,
  "--assistant-active":theme.toolbar.activeBg,
  "--assistant-code-surface":theme.node.code.surface,
  "--assistant-code-border":theme.node.code.stroke,
  "--assistant-scrollbar":theme.node.code.scrollbar,
  "--assistant-focus":themeName==="dark"?"rgba(245,245,244,.1)":"rgba(41,37,36,.07)",
  "--assistant-error":themeName==="dark"?"#fca5a5":"#b91c1c",
  "--assistant-shadow":themeName==="dark"?"0 22px 64px rgba(0,0,0,.45)":"0 20px 65px rgba(41,37,36,.18)",
 } as CSSProperties;
 if(!open)return null;
 return (
  <aside data-canvas-no-zoom aria-label="画布 AI 助手" className="canvas-assistant-shell pointer-events-auto" style={assistantStyle}
   onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
   <header className="canvas-assistant-header">
    <span className="canvas-assistant-brand" aria-hidden="true"><Sparkles size={17}/></span>
    <div className="min-w-0 flex-1">
     <h2 className="text-[13px] font-semibold leading-5">AI 创作助手</h2>
     <p className="truncate text-[10.5px] leading-4" style={{color:theme.node.muted}} title={projectTitle}>{projectTitle}</p>
    </div>
    <div className="canvas-assistant-actions">
     <button type="button" className="canvas-assistant-icon" aria-label="新建对话" title="新建对话" disabled={sending} onClick={()=>setActiveChatId(null)}><MessageSquarePlus size={16}/></button>
     <button type="button" className="canvas-assistant-icon" aria-label="删除当前对话" title="删除当前对话" disabled={!session||sending} onClick={clear}><Trash2 size={15}/></button>
     <button type="button" className="canvas-assistant-icon" aria-label="收起助手" title="收起助手" onClick={onClose}><X size={17}/></button>
    </div>
   </header>

   <section className="canvas-assistant-settings" aria-label="助手配置">
    <div className="canvas-assistant-settings-grid">
     <div className="canvas-assistant-field">
      <label className="canvas-assistant-field-label" htmlFor="canvas-assistant-model">文字模型</label>
      <div className="canvas-assistant-select-wrap">
       <Bot size={14} className="canvas-assistant-select-icon" aria-hidden="true"/>
       <select id="canvas-assistant-model" className="canvas-assistant-select" value={chosenModel} onChange={event=>setModelRef(event.target.value)} disabled={sending} title={options.find(option=>option.value===chosenModel)?.label||"选择文字模型"}>
        {!options.length?<option value="">未配置文字模型</option>:options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
       </select>
       <ChevronDown size={13} className="canvas-assistant-select-chevron" aria-hidden="true"/>
      </div>
     </div>
     <div className="canvas-assistant-field">
      <label className="canvas-assistant-field-label" htmlFor="canvas-assistant-session">历史会话</label>
      <div className="canvas-assistant-select-wrap">
       <Clock3 size={13} className="canvas-assistant-select-icon" aria-hidden="true"/>
       <select id="canvas-assistant-session" className="canvas-assistant-select" value={session?.id??""} onChange={event=>setActiveChatId(event.target.value||null)} disabled={sending}>
        <option value="">新对话</option>
        {sessions.map(item=><option value={item.id} key={item.id}>{item.title}</option>)}
       </select>
       <ChevronDown size={13} className="canvas-assistant-select-chevron" aria-hidden="true"/>
      </div>
     </div>
    </div>

    <div className="canvas-assistant-context">
     <div className="canvas-assistant-context-bar">
      <label className="canvas-assistant-context-toggle" title="在提问时附带只读画布资料">
       <input type="checkbox" checked={includeContext} onChange={event=>setIncludeContext(event.target.checked)}/>
       <Link2 size={13} aria-hidden="true"/><span>画布引用</span>
      </label>
      <span className="canvas-assistant-context-divider" aria-hidden="true"/>
      <div className="flex min-w-0 items-center gap-0.5">
       <button type="button" className="canvas-assistant-scope-button" aria-pressed={scope==="selection"} disabled={!includeContext} onClick={()=>setScope("selection")}>选中节点</button>
       <button type="button" className="canvas-assistant-scope-button" aria-pressed={scope==="overview"} disabled={!includeContext} onClick={()=>setScope("overview")}>画布概览</button>
      </div>
      <button type="button" className="canvas-assistant-link" aria-expanded={previewOpen} disabled={!includeContext} onClick={()=>setPreviewOpen(value=>!value)}>
       {previewOpen?"收起":"预览"}{previewOpen?<ChevronUp size={12}/>:<ChevronDown size={12}/>}
      </button>
     </div>
     {includeContext&&scope==="selection"&&selectedNodes.length>0?(
      <div className="canvas-assistant-reference-list" aria-label="引用节点列表">
       {selectedNodes.slice(0,12).map(node=>{
        const chosen=includedIds.includes(node.id);
        return <button type="button" key={node.id} className="canvas-assistant-reference" aria-pressed={chosen}
         title={chosen?"移除引用："+node.title:"添加引用："+node.title}
         onClick={()=>setIncludedIds(previous=>previous.includes(node.id)?previous.filter(id=>id!==node.id):[...previous,node.id])}>
         <ReferenceIcon type={node.type}/><span>{node.title||node.id}</span>{chosen?<X size={11}/>:<Plus size={11}/>}
        </button>;
       })}
       {selectedNodes.length>12?<span className="canvas-assistant-reference-count">最多引用 12 个节点</span>:null}
      </div>
     ):null}
     {includeContext&&scope==="selection"&&includedIds.length===0?(
      <p className="canvas-assistant-context-help">{selectedNodes.length?"当前未引用节点，只附带项目统计信息。":"未选中节点，将使用画布概要。"}</p>
     ):null}
     {includeContext&&previewOpen?(
      <div className="canvas-assistant-preview">
       <pre>{context.text}</pre>
       <div className="canvas-assistant-preview-actions">
        <span>发送时重新获取上下文{context.truncated?" · 已截断":""}</span>
        <button type="button" className="canvas-assistant-link" onClick={()=>setPreviewRevision(version=>version+1)} title="刷新上下文预览"><RefreshCw size={12}/>刷新</button>
       </div>
      </div>
     ):null}
    </div>
    {!options.length?<p className="mt-2 flex items-center gap-1 text-[11px]" style={{color:theme.node.muted}}><AlertCircle size={12}/>请先在设置中配置文字模型渠道。</p>:null}
   </section>

   <div ref={scrollRef} className="canvas-assistant-transcript" aria-live="polite">
    {!session?.messages.length?(
     <div className="canvas-assistant-empty">
      <span className="canvas-assistant-empty-icon" aria-hidden="true"><Sparkles size={22}/></span>
      <h3 className="mt-4 text-[14px] font-semibold">从画布开始创作</h3>
      <p className="mt-2 max-w-[270px] text-[11.5px] leading-[1.7]" style={{color:theme.node.muted}}>
       选择画布中的节点，询问创作建议、梳理故事结构，或优化文本内容。
      </p>
      <div className="canvas-assistant-suggestions" aria-label="推荐问题">
        {["创建三个分镜文本节点并依次连线","根据连线关系对整个工作流智能排版","把选中节点添加到已有分组","移出分组中的指定节点","解散选中的分组（需确认）","修改选中图片节点的提示词并生成（修改前确认）","执行选中的 ComfyUI 工作流"].map(hint=>         <button type="button" key={hint} className="canvas-assistant-suggestion" onClick={()=>setDraft(hint)}>
          <span>{hint}</span><ArrowUpRight size={14}/>
         </button>)}
      </div>
     </div>
    ):(
     <div className="canvas-assistant-message-list">
      {session.messages.map(item=>item.role==="error"?(
       <div key={item.id} className="canvas-assistant-error" role="status"><AlertCircle size={15} className="mt-[2px] shrink-0"/><span>{item.text}</span></div>
      ):(
       <article key={item.id} className={"canvas-assistant-message "+(item.role==="user"?"is-user":"is-assistant")}>
        <span className="canvas-assistant-avatar" aria-hidden="true">{item.role==="user"?<UserRound size={14}/>:<Sparkles size={14}/>}</span>
        <div className="canvas-assistant-message-body">
         <div className="canvas-assistant-speaker">{item.role==="user"?"你":"AI 助手"}</div>
         <div className="canvas-assistant-bubble">
          {item.role==="assistant"?(
           <div className="canvas-assistant-markdown">
            <Streamdown mode="static" skipHtml controls={{code:{copy:true,download:false},table:false,mermaid:false}}>{item.text}</Streamdown>
           </div>
          ):<span className="whitespace-pre-wrap break-words">{item.text}</span>}
         </div>
         {item.references?.length?(
          <div className="canvas-assistant-message-refs">
           <Link2 size={11}/>
           {item.references.slice(0,3).map(ref=><span key={ref.id} title={ref.title}>{ref.title}</span>)}
           {item.references.length>3?<small>+{item.references.length-3}</small>:null}
          </div>
         ):null}
         {item.role==="assistant"?(
          <div className="canvas-assistant-message-tools">
           <span className="min-w-0 truncate" title={item.meta}>{item.meta||"AI 回复"}</span>
           <button type="button" className="canvas-assistant-copy" aria-label="复制回答" title="复制回答" onClick={()=>void navigator.clipboard.writeText(item.text)}><Copy size={12}/>复制</button>
          </div>
         ):null}
        </div>
       </article>
      ))}
     </div>
    )}
    {sending?<div className="canvas-assistant-loading mt-4" role="status"><LoaderCircle size={15} className="animate-spin"/>正在请求模型 · 网络异常时最多自动重试 2 次…</div>:null}
   </div>

   <footer className="canvas-assistant-footer">
    <div className="canvas-assistant-composer">
     <textarea aria-label="向 AI 助手发送消息" value={draft} rows={3} placeholder="提问或描述你的创作想法…"
      onChange={event=>setDraft(event.target.value)}
      onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void send();}}}/>
     <div className="canvas-assistant-composer-footer">
      <span className="canvas-assistant-shortcut">Ctrl / ⌘ + Enter 发送</span>
      {sending?(
       <button type="button" className="canvas-assistant-send canvas-assistant-stop" aria-label="停止生成" onClick={stop}><Square size={13}/>停止</button>
      ):(
       <button type="button" className="canvas-assistant-send" aria-label="发送消息" disabled={!draft.trim()||!chosenModel} onClick={()=>void send()}><ArrowUp size={15}/>发送</button>
      )}
     </div>
    </div>
    <div className="canvas-assistant-hint">
     <span>AI 建议仅供参考</span>
      <span className="inline-flex items-center gap-1"><Check size={11}/>创建、布局、生成自动执行 · 修改已有提示词、参数及删除需确认</span>
     </div>   </footer>
  </aside>
 );
}