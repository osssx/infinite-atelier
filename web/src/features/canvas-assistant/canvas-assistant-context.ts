import {CanvasNodeType,type CanvasConnection,type CanvasNodeData,type CanvasAssistantReference} from "@/types/canvas";

export type AssistantContextScope="selection"|"overview";
export type AssistantContextResult={text:string;references:CanvasAssistantReference[];truncated:boolean};
const limitString=(value:unknown,max:number)=>{
 if(typeof value!=="string")return "";
 // Never ship inline binary, arbitrary URLs, or hidden credentials as assistant context.
 if(/^\s*data:|^\s*blob:/i.test(value))return "[媒体数据省略]";
 const safe=value.replace(/data:(?:image|video|audio)\/[^\s]+/gi,"[内嵌媒体省略]")
  .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{20,}/gi,"[敏感值省略]");
 return safe.length>max?safe.slice(0,max)+"…":safe;
};
/** Read-only snapshot, captured at send time; never serialize the entire 200-node graph or media data. */
export function buildCanvasAssistantContext({projectTitle,nodes,connections,nodeIds,scope="selection",maxChars=12000}:{
 projectTitle:string;nodes:readonly CanvasNodeData[];connections:readonly CanvasConnection[];
 nodeIds:readonly string[];scope?:AssistantContextScope;maxChars?:number;
}):AssistantContextResult{
 const allowed=Math.max(256,Math.min(maxChars,12000));
 const index=new Map(nodes.map(node=>[node.id,node]));
 const requested=scope==="selection"?[...new Set(nodeIds)].map(id=>index.get(id)).filter((node):node is CanvasNodeData=>Boolean(node)):[];
 const chosen=requested.slice(0,12); const refs:CanvasAssistantReference[]=chosen.map(node=>({id:node.id,type:node.type,title:node.title}));
 const lines=["项目："+limitString(projectTitle,120),"画布统计：节点 "+nodes.length+"，连线 "+connections.length];
 if(scope==="selection"){
  lines.push("上下文范围：用户明确引用的 "+chosen.length+" 个节点（不包括媒体文件本体）");
  if(requested.length>12)lines.push("注意：引用数量超过 12 个，仅提供前 12 个节点。");  for(const node of chosen){
   lines.push("节点："+limitString(node.title,120)+" ("+node.type+", id="+node.id+")");
   const meta=node.metadata;
   if(node.type===CanvasNodeType.Text && meta?.content)
    lines.push("文本内容："+limitString(meta.content,2200));
   if(meta?.prompt)lines.push("提示词："+limitString(meta.prompt,1400));
   if(meta?.composerContent)lines.push("参数输入："+limitString(meta.composerContent,1000));
   if(node.type===CanvasNodeType.Image||node.type===CanvasNodeType.Video||node.type===CanvasNodeType.Audio)
    lines.push("媒体：仅提供标题及已有提示词；未提供图片、视频或音频内容");
  }
  const selected=new Set(chosen.map(node=>node.id));
  for(const edge of connections){
   if(!selected.has(edge.fromNodeId)&&!selected.has(edge.toNodeId))continue;
   const a=index.get(edge.fromNodeId),b=index.get(edge.toNodeId);
   if(a&&b)lines.push("关联："+limitString(a.title,100)+" → "+limitString(b.title,100));
   if(lines.length>60)break;
  }
 }else{
  lines.push("上下文范围：画布概要（不包含节点正文和媒体内容）");
  for(const node of nodes.slice(0,30))lines.push("· "+limitString(node.title,90)+" ["+node.type+"]");
  if(nodes.length>30)lines.push("另有 "+(nodes.length-30)+" 个节点未列出");
 }
 const combined=lines.join("\n");
 const truncated=combined.length>allowed||requested.length>12;
 return {text:combined.length>allowed?combined.slice(0,allowed)+"\n[上下文已截断]":combined,references:refs,truncated};}
