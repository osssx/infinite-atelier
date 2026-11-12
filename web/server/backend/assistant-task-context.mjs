/** Provider-side Task context: strictly smaller than the backend's local
 * graph/step evidence. Never serialize whole documents or task event payloads.
 */
const safe=(value,max=1800)=>{
 if(typeof value!=="string")return "";
 const redacted=value.replace(/data:(?:image|video|audio)\/[^\s]+/gi,"[媒体数据省略]")
  .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{16,}/gi,"[敏感值省略]")
  .replace(/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,"[凭据省略]");
 return redacted.length>max?redacted.slice(0,max)+"[内容截断]":redacted;
};
export function buildAssistantTaskProviderContext({task,document}){
 const policy=task.contextPolicy??{includeContext:false,scope:"selection",includedIds:[]};
 const lines=[
  "原始任务要求："+safe(task.originalRequest,1500),
  "任务状态："+safe(task.status,40)+"（仅阶段状态；不得推断任何画布操作或脚本已经成功）",
  "有效计划版本："+Number(task.activePlanVersion??1)
 ];
 const steps=Array.isArray(task.steps)?task.steps.slice(-16):[];
 for(const step of steps)lines.push("步骤 "+safe(step.id,80)+
  "："+safe(step.kind,40)+"/"+safe(step.status,40)+
  "；可信回执="+safe(step.receiptTrust,40));
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
 return lines.join("\n").slice(0,12000);
}
