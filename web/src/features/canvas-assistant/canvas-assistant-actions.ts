import {nanoid} from "nanoid";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import {groupSelectedCanvasNodes} from "@/lib/canvas/canvas-node-geometry";
import {prepareCanvasPortConnection} from "@/lib/canvas/canvas-port-connections";
import {CanvasNodeType,type CanvasConnection,type CanvasNodeData,type Position} from "@/types/canvas";
import {layoutCanvasDependencyGraph,type AssistantGraphLayoutDirection} from "./canvas-assistant-graph-layout";
import {assistantValueHasSupportedShape,setAssistantNodePrompt,setAssistantNodeParameter,type AssistantParameterKey,type AssistantParameterValue,type AssistantExecutionAction} from "./canvas-assistant-node-control";
import type {AiConfig} from "@/stores/use-config-store";
import {validAssistantWorkflowScalar,setAssistantWorkflowParameter,type AssistantWorkflowScalar} from "./canvas-assistant-workflow-params";
import type {ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";

export type AssistantCreatableNodeType="text"|"image"|"video"|"audio"|"config"|"director";
export type AssistantLayoutDirection="horizontal"|"vertical"|"grid";
export type AssistantCanvasAction=
 |{type:"create_text";ref:string;title:string;content:string}
 |{type:"create_node";ref:string;nodeType:AssistantCreatableNodeType;title?:string;content?:string;prompt?:string}
 |{type:"create_group";ref:string;title:string;members:string[]}
 |{type:"add_to_group";groupId:string;members:string[]}
 |{type:"remove_from_group";groupId:string;members:string[]}
 |{type:"ungroup";groupId:string}
 |{type:"layout_nodes";nodeIds:string[];direction:AssistantLayoutDirection;gap?:number}
 |{type:"layout_graph";nodeIds:string[];direction?:AssistantGraphLayoutDirection;gap?:number;layerGap?:number}
 |{type:"connect";from:string;to:string}
 |{type:"set_text";nodeId:string;content:string}
 |{type:"set_title";nodeId:string;title:string}
 |{type:"delete_node";nodeId:string}
 |{type:"delete_connection";connectionId:string}
 |{type:"set_prompt";nodeId:string;prompt:string}
 |{type:"set_node_param";nodeId:string;key:AssistantParameterKey;value:AssistantParameterValue}
 |{type:"set_workflow_param";nodeId:string;portId:string;value:AssistantWorkflowScalar} |AssistantExecutionAction;
export type AssistantCanvasGraph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
export type AssistantCanvasStage="safe"|"dangerous";
export type AssistantCanvasOutcome=AssistantCanvasGraph&{refs:Map<string,string>;applied:number;createdNodeIds:string[]};
/** Selecting a newly created group and its child together would drag the child twice. */
export function assistantCreatedSelection(result:Pick<AssistantCanvasOutcome,"nodes"|"createdNodeIds">):string[]{
 const created=new Set(result.createdNodeIds);
 const groups=new Set(result.nodes.filter(node=>created.has(node.id)&&node.type===CanvasNodeType.Group).map(node=>node.id));
 const byId=new Map(result.nodes.map(node=>[node.id,node]));
 return result.createdNodeIds.filter(id=>{
  const parent=byId.get(id)?.metadata?.groupId;
  return !parent||!groups.has(parent);
 });
}
const MAX_ACTIONS=16,MAX_CREATED=12,MAX_COORD=1_000_000;
const creatable=new Set<AssistantCreatableNodeType>(["text","image","video","audio","config","director"]);
const directions=new Set<AssistantLayoutDirection>(["horizontal","vertical","grid"]);
const identifier=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_:\-.]{1,128}$/.test(value);
const boundedString=(value:unknown,max:number):value is string=>typeof value==="string"&&value.length<=max;
const keys=(obj:Record<string,unknown>,allowed:readonly string[])=>Object.keys(obj).every(key=>allowed.includes(key));
const ids=(value:unknown,min:number,max:number):value is string[]=>
 Array.isArray(value)&&value.length>=min&&value.length<=max&&value.every(identifier)&&new Set(value).size===value.length;
export function isAssistantCanvasAction(value:unknown):value is AssistantCanvasAction{
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const action=value as Record<string,unknown>;
 switch(action.type){
  case "create_text":return keys(action,["type","ref","title","content"])&&identifier(action.ref)&&
   boundedString(action.title,120)&&boundedString(action.content,12000);
  case "create_node":return keys(action,["type","ref","nodeType","title","content","prompt"])&&
   identifier(action.ref)&&creatable.has(action.nodeType as AssistantCreatableNodeType)&&
   (action.title===undefined||boundedString(action.title,120))&&
   (action.content===undefined||(action.nodeType==="text"&&boundedString(action.content,12000)))&&
   (action.prompt===undefined||(action.nodeType!=="text"&&boundedString(action.prompt,3000)));
  case "create_group":return keys(action,["type","ref","title","members"])&&
   identifier(action.ref)&&boundedString(action.title,120)&&
   (ids(action.members,0,0)||ids(action.members,2,MAX_CREATED));
  case "add_to_group":
  case "remove_from_group":return keys(action,["type","groupId","members"])&&
   identifier(action.groupId)&&ids(action.members,1,MAX_CREATED);
  case "ungroup":return keys(action,["type","groupId"])&&identifier(action.groupId);
  case "layout_nodes":return keys(action,["type","nodeIds","direction","gap"])&&
   ids(action.nodeIds,1,MAX_CREATED)&&directions.has(action.direction as AssistantLayoutDirection)&&
   (action.gap===undefined||(Number.isInteger(action.gap)&&Number(action.gap)>=16&&Number(action.gap)<=160));
  case "layout_graph":return keys(action,["type","nodeIds","direction","gap","layerGap"])&&
   ids(action.nodeIds,0,200)&&
   (action.direction===undefined||action.direction==="horizontal"||action.direction==="vertical")&&
   (action.gap===undefined||(Number.isInteger(action.gap)&&Number(action.gap)>=16&&Number(action.gap)<=160))&&
   (action.layerGap===undefined||(Number.isInteger(action.layerGap)&&Number(action.layerGap)>=40&&Number(action.layerGap)<=360));
  case "connect":return keys(action,["type","from","to"])&&identifier(action.from)&&identifier(action.to)&&action.from!==action.to;
  case "set_prompt":return keys(action,["type","nodeId","prompt"])&&identifier(action.nodeId)&&boundedString(action.prompt,12000);
  case "set_node_param":return keys(action,["type","nodeId","key","value"])&&
   identifier(action.nodeId)&&assistantValueHasSupportedShape(action.key,action.value);
  case "set_workflow_param":return keys(action,["type","nodeId","portId","value"])&&
   identifier(action.nodeId)&&validAssistantWorkflowScalar(action.portId,action.value);
  case "run_node":return keys(action,["type","nodeId","mode"])&&identifier(action.nodeId)&&
   (action.mode===undefined||["text","image","video","audio"].includes(String(action.mode)));
  case "run_workflow":return keys(action,["type","nodeId"])&&identifier(action.nodeId);
  case "set_text":return keys(action,["type","nodeId","content"])&&identifier(action.nodeId)&&boundedString(action.content,12000);
  case "set_title":return keys(action,["type","nodeId","title"])&&identifier(action.nodeId)&&boundedString(action.title,120);
  case "delete_node":return keys(action,["type","nodeId"])&&identifier(action.nodeId);
  case "delete_connection":return keys(action,["type","connectionId"])&&identifier(action.connectionId);
  default:return false;
 }
}
export function parseAssistantCanvasActions(value:unknown):AssistantCanvasAction[]{
 if(!Array.isArray(value)||value.length>MAX_ACTIONS||!value.every(isAssistantCanvasAction))
  throw Error("AI 返回了不支持的画布操作，未执行。");
 const aliases=new Set<string>();
 for(const action of value){
  if(action.type!=="create_text"&&action.type!=="create_node"&&action.type!=="create_group")continue;
  if(aliases.has(action.ref))throw Error("AI 创建节点的引用标识重复，未执行。");
  aliases.add(action.ref);
 }
 if(value.filter(action=>action.type==="run_node"||action.type==="run_workflow").length>3)
  throw Error("每次 AI 请求最多触发 3 个生成任务。");
 if(value.filter(action=>["create_text","create_node","create_group"].includes(action.type)).length>MAX_CREATED)
  throw Error("单次最多创建 12 个画布节点或分组。");
 return value;
}
export const isDangerousAssistantAction=(action:AssistantCanvasAction)=>
 action.type==="set_text"||action.type==="set_title"||action.type==="delete_node"||action.type==="delete_connection"||action.type==="ungroup"||action.type==="set_prompt"||action.type==="set_node_param"||action.type==="set_workflow_param";
export function dangerousAssistantActionSummary(actions:readonly AssistantCanvasAction[]){
 const count=(type:AssistantCanvasAction["type"])=>actions.filter(action=>action.type===type).length;
 return [
  count("set_text")?"修改 "+count("set_text")+" 个节点内容":"",
  count("set_title")?"修改 "+count("set_title")+" 个节点标题":"",
  count("delete_node")?"删除 "+count("delete_node")+" 个节点":"",
  count("delete_connection")?"删除 "+count("delete_connection")+" 条连线":"",
  count("ungroup")?"解散 "+count("ungroup")+" 个分组（保留组内节点和连线）":"",
  count("set_prompt")?"修改 "+count("set_prompt")+" 个生成提示词":"",
  count("set_node_param")?"修改 "+count("set_node_param")+" 项节点生成参数":"",
  count("set_workflow_param")?"修改 "+count("set_workflow_param")+" 项工作流预设端口参数":"" ].filter(Boolean).join("、");
}
function createsCycle(from:string,to:string,connections:readonly CanvasConnection[]){
 const stack=[to],seen=new Set<string>();
 while(stack.length){
  const id=stack.pop()!;
  if(id===from)return true;
  if(seen.has(id))continue;
  seen.add(id);
  for(const edge of connections)if(edge.fromNodeId===id)stack.push(edge.toNodeId);
 }
 return false;
}
function validPosition(position:Position){
 return Number.isFinite(position.x)&&Number.isFinite(position.y)&&
  Math.abs(position.x)<=MAX_COORD&&Math.abs(position.y)<=MAX_COORD;
}
function layoutPositions(items:readonly CanvasNodeData[],center:Position,direction:AssistantLayoutDirection,gap:number){
 const n=items.length;
 const cols=direction==="horizontal"?n:direction==="vertical"?1:Math.ceil(Math.sqrt(n));
 const rows=Math.ceil(n/cols);
 const widths=Array.from({length:cols},(_,col)=>Math.max(...items.filter((_,i)=>i%cols===col).map(node=>node.width)));
 const heights=Array.from({length:rows},(_,row)=>Math.max(...items.slice(row*cols,(row+1)*cols).map(node=>node.height)));
 const totalW=widths.reduce((a,b)=>a+b,0)+gap*(cols-1);
 const totalH=heights.reduce((a,b)=>a+b,0)+gap*(rows-1);
 const offsetsX=widths.map((_,i)=>widths.slice(0,i).reduce((a,b)=>a+b,0)+gap*i);
 const offsetsY=heights.map((_,i)=>heights.slice(0,i).reduce((a,b)=>a+b,0)+gap*i);
 return items.map((node,i)=>{
  const col=i%cols,row=Math.floor(i/cols);
  const result={x:center.x-totalW/2+offsetsX[col]+(widths[col]-node.width)/2,
   y:center.y-totalH/2+offsetsY[row]+(heights[row]-node.height)/2};
  if(!validPosition(result))throw Error("节点位置超过画布安全范围，未执行。");
  return result;
 });
}
/** Expand a group without relocating members or modifying their content. */
function expandGroupToEncloseMembers(group:CanvasNodeData,nodes:readonly CanvasNodeData[]):CanvasNodeData{
 const members=nodes.filter(n=>n.metadata?.groupId===group.id);
 if(!members.length)return group;
 const left=Math.min(group.position.x,...members.map(n=>n.position.x-36));
 const top=Math.min(group.position.y,...members.map(n=>n.position.y-80));
 const right=Math.max(group.position.x+group.width,...members.map(n=>n.position.x+n.width+36));
 const bottom=Math.max(group.position.y+group.height,...members.map(n=>n.position.y+n.height+36));
 const position={x:left,y:top},width=right-left,height=bottom-top;
 if(!validPosition(position)||!validPosition({x:right,y:bottom})||
  !Number.isFinite(width)||!Number.isFinite(height)||width>MAX_COORD||height>MAX_COORD||
  width<1||height<1)throw Error("添加节点后分组尺寸超出安全范围，未执行。");
 return {...group,position,width,height};
}
/** Pure all-or-nothing graph transaction. The caller owns confirmation, saving and history. */
export function applyAssistantCanvasActions(
 graph:AssistantCanvasGraph,rawActions:unknown,stage:AssistantCanvasStage,center:Position,
 refs:ReadonlyMap<string,string>=new Map(),config?:AiConfig,
 workflowTemplates?:ReadonlyMap<string,ComfyWorkflowTemplate>
):AssistantCanvasOutcome{ const actions=parseAssistantCanvasActions(rawActions);
 if(!validPosition(center))throw Error("画布中心坐标无效，未执行。");
 let nodes=[...graph.nodes],connections=[...graph.connections];
 const mapped=new Map(refs);
 let applied=0;
 const createdNodeIds:string[]=[];
 const safeActions=actions.filter(action=>!isDangerousAssistantAction(action));
 if(stage==="safe"){
  // Resolve new ordinary nodes up front, even if the model lists connections first.
  for(const action of safeActions){
   if(action.type!=="create_text"&&action.type!=="create_node")continue;
   if(nodes.some(node=>node.id===action.ref)||mapped.has(action.ref))
    throw Error("节点引用与现有节点冲突，未执行。");
   const index=createdNodeIds.length;
   const type=action.type==="create_text"?CanvasNodeType.Text:action.nodeType;
   const metadata=action.type==="create_text"?{content:action.content,status:"success" as const}:
    action.nodeType==="text"&&action.content!==undefined?{content:action.content,status:"success" as const}:
    action.prompt!==undefined?{prompt:action.prompt}:{};
   const node=createCanvasNode(type,{x:center.x+(index%3)*440,y:center.y+Math.floor(index/3)*320},metadata);
   if(nodes.some(existing=>existing.id===node.id)||!validPosition(node.position))
    throw Error("节点 ID 或位置无效，未执行。");
   node.title=action.title?.trim()||node.title;
   nodes.push(node);
   mapped.set(action.ref,node.id);createdNodeIds.push(node.id);applied++;
  }
  const resolve=(ref:string)=>mapped.get(ref)??ref;
  // Process ordered safe actions: layout children before grouping, then layout groups.
  for(const action of safeActions){
   if(action.type==="create_text"||action.type==="create_node")continue;
   if(action.type==="create_group"){
    if(nodes.some(node=>node.id===action.ref)||mapped.has(action.ref))
     throw Error("分组引用与现有节点冲突，未执行。");
    const members=action.members.map(resolve);
    if(new Set(members).size!==members.length)throw Error("分组成员引用重复，未执行。");
    const template=createCanvasNode(CanvasNodeType.Group,
     {x:center.x+createdNodeIds.length*800,y:center.y});
    template.title=action.title.trim()||template.title;
    if(!validPosition(template.position))throw Error("分组位置无效，未执行。");
    if(members.length){
     const targets=members.map(id=>nodes.find(node=>node.id===id));
     if(targets.some(node=>!node||node.type===CanvasNodeType.Group||node.metadata?.groupId))
      throw Error("分组成员不存在、是分组或已属于其他分组，未执行。");
     const result=groupSelectedCanvasNodes(nodes,new Set(members),template);
     if(!result||!validPosition(result.group.position))
      throw Error("无法创建该分组，未执行。");
     nodes=result.nodes;
    }else nodes.push(template);
    mapped.set(action.ref,template.id);createdNodeIds.push(template.id);applied++;
    continue;
   }
   if(action.type==="add_to_group"||action.type==="remove_from_group"){
    const groupId=resolve(action.groupId);
    if(!nodes.some(n=>n.id===groupId&&n.type===CanvasNodeType.Group))
     throw Error("目标分组不存在，未执行。");
    const memberIds=action.members.map(resolve);
    if(new Set(memberIds).size!==memberIds.length)throw Error("分组成员重复，未执行。");
    const members=memberIds.map(id=>nodes.find(n=>n.id===id));
    if(members.some(n=>!n||n.type===CanvasNodeType.Group))
     throw Error("成员不存在或不支持嵌套分组，未执行。");
    if(action.type==="add_to_group"&&members.some(n=>n?.metadata?.groupId))
     throw Error("节点已属于其他分组或已在目标分组，未执行。");
    if(action.type==="remove_from_group"&&members.some(n=>n?.metadata?.groupId!==groupId))
     throw Error("节点不是目标分组的成员，未执行。");
    const chosen=new Set(memberIds);
    nodes=nodes.map(n=>!chosen.has(n.id)?n:{
     ...n,metadata:{...n.metadata,groupId:action.type==="add_to_group"?groupId:undefined}
    });
    if(action.type==="add_to_group")
     nodes=nodes.map(n=>n.id===groupId?expandGroupToEncloseMembers(n,nodes):n);
    applied++;continue;
   }
   if(action.type==="layout_graph"){
    const selected=action.nodeIds.map(resolve);
    if(new Set(selected).size!==selected.length)
     throw Error("自动布局节点引用重复，未执行。");
    nodes=layoutCanvasDependencyGraph(nodes,connections,{
     nodeIds:selected,direction:action.direction??"horizontal",
     gap:action.gap??48,layerGap:action.layerGap??140,center
    });
    applied++;continue;
   }
   if(action.type==="layout_nodes"){
    const targetIds=action.nodeIds.map(resolve);
    if(new Set(targetIds).size!==targetIds.length)throw Error("布局节点重复，未执行。");
    const targets=targetIds.map(id=>nodes.find(node=>node.id===id));
    if(targets.some(node=>!node))throw Error("布局节点不存在，未执行。");
    const selected=targets as CanvasNodeData[];
    const selectedSet=new Set(targetIds);
    if(selected.some(node=>node.metadata?.groupId)||
       selected.some(node=>node.type===CanvasNodeType.Group&&nodes.some(other=>
        other.metadata?.groupId===node.id&&selectedSet.has(other.id))))
     throw Error("请对整个分组布局，不能单独调整分组内的节点。");
    const positions=layoutPositions(selected,center,action.direction,action.gap??36);
    const movement=new Map(selected.map((node,i)=>[node.id,{
     dx:positions[i].x-node.position.x,dy:positions[i].y-node.position.y
    }]));
    const moves=new Map<string,{dx:number;dy:number}>(movement);
    for(const node of nodes){
     if(!node.metadata?.groupId)continue;
     const groupMovement=movement.get(node.metadata.groupId);
     if(groupMovement)moves.set(node.id,groupMovement);
    }
    nodes=nodes.map(node=>{
     const move=moves.get(node.id);
     if(!move)return node;
     const position={x:node.position.x+move.dx,y:node.position.y+move.dy};
     if(!validPosition(position))throw Error("布局结果超出画布安全范围，未执行。");
     return {...node,position};
    });
    applied++;continue;
   }
   if(action.type==="connect"){
    const from=resolve(action.from),to=resolve(action.to);
    if(from===to)throw Error("不能连接同一个节点。");
    if(createsCycle(from,to,connections))throw Error("连线会构成循环，未执行。");
    const result=prepareCanvasPortConnection({nodeId:from,handleType:"source"},
     {nodeId:to,handleType:"target"},nodes,connections);
    if(!result.connection||result.replacedConnectionIds?.length)
     throw Error("连线无效或端口被占用（"+(result.error??"replace")+"），未执行。");
    connections.push({...result.connection,id:nanoid()});applied++;
   }
  }
 }else{
  for(const action of actions.filter(isDangerousAssistantAction)){
   switch(action.type){
    case "ungroup":{
     const groupId=mapped.get(action.groupId)??action.groupId;
     const group=nodes.find(n=>n.id===groupId&&n.type===CanvasNodeType.Group);
     if(!group)throw Error("目标分组不存在，未执行。");
     if(connections.some(edge=>edge.fromNodeId===groupId||edge.toNodeId===groupId))
      throw Error("分组自身仍有连线，请先处理连线，未执行。");
     nodes=nodes.filter(n=>n.id!==groupId).map(n=>n.metadata?.groupId===groupId
      ?{...n,metadata:{...n.metadata,groupId:undefined}}:n);
     applied++;break;
    }
    case "set_prompt":{
     const id=mapped.get(action.nodeId)??action.nodeId;
     const i=nodes.findIndex(node=>node.id===id);
     if(i<0)throw Error("目标节点不存在，未执行。");
     nodes[i]=setAssistantNodePrompt(nodes[i],action.prompt);applied++;break;
    }
    case "set_node_param":{
     const id=mapped.get(action.nodeId)??action.nodeId;
     const i=nodes.findIndex(node=>node.id===id);
     if(i<0)throw Error("目标节点不存在，未执行。");
     nodes[i]=setAssistantNodeParameter(nodes[i],action.key,action.value,config);applied++;break;
    }
    case "set_workflow_param":{
     const id=mapped.get(action.nodeId)??action.nodeId;
     const i=nodes.findIndex(node=>node.id===id);
     if(i<0)throw Error("工作流参数目标节点不存在，未执行。");
     const template=workflowTemplates?.get(id);
     if(!config||!template)throw Error("尚未加载该节点绑定的工作流预设参数定义，未修改。");
     nodes[i]=setAssistantWorkflowParameter(nodes[i],action.portId,action.value,config,template);
     applied++;break;
    }
    case "set_text":{
     const i=nodes.findIndex(node=>node.id===action.nodeId);
     if(i<0||nodes[i].type!==CanvasNodeType.Text)throw Error("文本节点不存在或类型不支持，未执行。");
     nodes[i]={...nodes[i],metadata:{...nodes[i].metadata,content:action.content}};applied++;break;
    }
    case "set_title":{
     const i=nodes.findIndex(node=>node.id===action.nodeId);
     if(i<0)throw Error("目标节点不存在，未执行。");
     nodes[i]={...nodes[i],title:action.title.trim()||nodes[i].title};applied++;break;
    }
    case "delete_node":{
     const node=nodes.find(item=>item.id===action.nodeId);
     if(!node||node.type!==CanvasNodeType.Text)
      throw Error("首批仅支持删除文本节点，其他类型需要手动处理。");
     nodes=nodes.filter(item=>item.id!==node.id);
     connections=connections.filter(edge=>edge.fromNodeId!==node.id&&edge.toNodeId!==node.id);
     applied++;break;
    }
    case "delete_connection":{
     if(!connections.some(edge=>edge.id===action.connectionId))throw Error("目标连线不存在，未执行。");
     connections=connections.filter(edge=>edge.id!==action.connectionId);applied++;break;
    }
   }
  }
 }
 return {nodes,connections,refs:mapped,applied,createdNodeIds};
}
