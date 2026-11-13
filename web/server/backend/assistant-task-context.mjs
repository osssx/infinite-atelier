/** Provider-side Task context: strictly smaller than the backend's local
 * graph/step evidence. Never serialize whole documents or task event payloads.
 */
const safe=(value,max=1800)=>{
 if(typeof value!=="string")return "";
 const redacted=value.replace(/data:(?:image|video|audio)\/[^\s]+/gi,"[媒体数据省略]")
  .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{16,}/gi,"[敏感值省略]")
  .replace(/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,"[凭据省略]")
  .replace(/[\r\n\t]+/g," ");
 return redacted.length>max?redacted.slice(0,max)+"[内容截断]":redacted;
};
/** A past turn may have referenced local canvas nodes. Never widen that
 * past disclosure when the user narrows the scope on this request.
 * Ordinary user-typed text (no graph references) is still a user statement,
 * never trusted proof of any tool or external Job completing.
 */
function mayRepeatTurn(current,prior){
 if(!prior||typeof prior.includeContext!=="boolean")return false;
 if(!prior.includeContext)return true;
 if(!current.includeContext||prior.scope!==current.scope)return false;
 if(prior.scope==="overview")return true;
 const available=new Set(current.includedIds??[]);
 return Array.isArray(prior.includedIds)&&prior.includedIds.every(id=>available.has(id));
}
export function buildAssistantTaskProviderContext({task,document,trustedOutputs=[],currentTurnMessageId=null}){
 const policy=task.contextPolicy??{includeContext:false,scope:"selection",includedIds:[]};
 const lines=[
  "原始任务要求："+safe(task.originalRequest,1500),
  "任务状态："+safe(task.status,40)+"（仅阶段状态；不得推断任何画布操作或脚本已经成功）",
  "有效计划版本："+Number(task.activePlanVersion??1)
 ];
 const facts=task.summary;
 if(facts?.version===1&&facts?.source==="server_derived"&&facts.execution?.currentPlan){
  const plan=facts.execution.currentPlan,model=facts.modelCalls??{},turns=facts.userTurns??{};
  lines.push("持久任务事实摘要（由服务端 DB 推导，仅供推理提示；是否完成仍须核验 Step 回执，不得凭本段重放 Job）：");
  lines.push("累计用户续写轮次："+Number(turns.total??0)+"；模型调用："+Number(model.total??0)+
   "，其中结果未确认："+Number(model.needsReconcile??0));
  lines.push("当前计划步骤："+Number(plan.stepCount??0)+"；后端可信成功回执："+Number(plan.trustedSteps??0)+
   "；未可信确认的成功状态："+Number(plan.unverifiedSuccess??0)+
   "；待审批："+Number(plan.stages?.waiting_approval??0)+
   "；待对账："+Number(plan.stages?.needs_reconcile??0)+
   "；失败："+Number(plan.stages?.failed??0)+"；阻断："+Number(plan.stages?.blocked??0));
  lines.push("可信生成回执产物："+Number(plan.confirmedArtifacts??0)+
   "（生成完成不代表已落图）；可信物化绑定："+Number(plan.materializedBindings??0)+
   "；画布事务操作："+Number(plan.appliedCanvasActions??0));
  lines.push("旧计划历史可信回执："+Number(facts.execution.historicalTrustedReceipts??0)+
   "（仅审计，不能直接满足当前计划依赖）");
  const history=Array.isArray(turns.recent)?turns.recent.slice(-20):[];
  for(const turn of history){
   if(turn?.messageId===currentTurnMessageId||!mayRepeatTurn(policy,turn?.contextPolicy))continue;
   if(!turn?.preview)continue;
   lines.push("历史用户请求（仅用户陈述，非执行证据）："+JSON.stringify(safe(turn.preview,120)));
  }
 }
 const allSteps=Array.isArray(task.steps)?task.steps:[];
 const steps=allSteps.slice(-16);
 if(allSteps.length>steps.length)lines.push("总步骤数："+allSteps.length+"（仅显示最近 "+steps.length+" 步；旧步骤不作为新成功依据）");
 for(const step of steps){
  const trusted=step.status==="succeeded"&&step.receiptTrust==="server_committed";
  const result=step.result??{};
  const verified=trusted&&step.kind==="canvas_mutation"&&Number.isInteger(result.applied)&&result.applied>=0?
   "；已提交画布操作="+result.applied:
   trusted&&["model_job","comfy_workflow"].includes(step.kind)&&Array.isArray(result.artifactIds)?
   "；已确认产物="+result.artifactIds.length:
   trusted&&step.kind==="materialize"&&Array.isArray(result.bindings)?
   "；已核对落图="+result.bindings.length:"";
  lines.push("步骤 "+safe(step.id,80)+
   "："+safe(step.kind,40)+"/"+safe(step.status,40)+
   "；可信回执="+safe(step.receiptTrust,40)+verified);
 }
 if(task.lastError)lines.push("上轮有失败的客户端观察记录；不能作为服务端执行证据。");
 if(!policy.includeContext){
  lines.push("用户未授权发送画布资料。不得引用任何本地图节点标题、内容、提示词或媒体。");
  return lines.join("\n").slice(0,12000);
 }
 const nodes=Array.isArray(document?.nodes)?document.nodes:[];
 const byId=new Map(nodes.map(node=>[node.id,node]));
 if(policy.scope==="overview"){
  lines.push("画布范围：概要（仅节点类型与标题，不包含正文/参数/媒体）");
  for(const node of nodes.slice(0,30))lines.push("节点："+safe(node.title,90)+" ["+safe(node.type,40)+"]");
  if(nodes.length>30)lines.push("其余节点信息未提供");
 }else{
  const selected=[...new Set(policy.includedIds??[])].slice(0,12)
   .map(id=>byId.get(id)).filter(Boolean);
  lines.push("画布范围：仅明确选择的 "+selected.length+" 个节点；不得读取或描述其他节点");
  for(const node of selected){
   lines.push("节点："+safe(node.title,90)+" ["+safe(node.type,40)+", id="+safe(node.id,128)+"]");
   if(node.type==="text"&&node.metadata?.content)lines.push("正文："+safe(node.metadata.content,1600));
   if(node.metadata?.prompt)lines.push("提示词："+safe(node.metadata.prompt,1000));
   if(node.metadata?.composerContent)lines.push("参数输入："+safe(node.metadata.composerContent,600));
   if(node.metadata?.comfyWorkflow?.bindingState)
    lines.push("ComfyUI 绑定状态："+safe(node.metadata.comfyWorkflow.bindingState,50));
  }
  const visible=new Set(selected.map(node=>node.id));
  for(const edge of (document?.connections??[]).slice(0,120))
   if(visible.has(edge.fromNodeId)&&visible.has(edge.toNodeId))
    lines.push("连线："+safe(edge.fromNodeId,128)+" → "+safe(edge.toNodeId,128));
 }
  const visible=policy.scope==="selection"?new Set((policy.includedIds??[]).slice(0,12)):null;
  const products=Array.isArray(trustedOutputs)?trustedOutputs.filter(x=>
   x&&typeof x.nodeId==="string"&&(visible?.has(x.nodeId)??false)&&
   ["image","video","audio","text"].includes(x.kind)).slice(-8):[];
  for(const output of products)lines.push("已验证的落图资源：节点 id="+safe(output.nodeId,128)+
   "；类型="+safe(output.kind,10)+"；产物 id="+safe(output.artifactId,128)+
   "（只作来源标识；不得视为已授权读取资源正文/媒体）");
  return lines.join("\n").slice(0,12000);}
