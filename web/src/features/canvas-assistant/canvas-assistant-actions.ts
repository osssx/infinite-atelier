import {nanoid} from "nanoid";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import {prepareCanvasPortConnection} from "@/lib/canvas/canvas-port-connections";
import {CanvasNodeType,type CanvasConnection,type CanvasNodeData,type Position} from "@/types/canvas";

export type AssistantCanvasAction=
 |{type:"create_text";ref:string;title:string;content:string}
 |{type:"connect";from:string;to:string}
 |{type:"set_text";nodeId:string;content:string}
 |{type:"set_title";nodeId:string;title:string}
 |{type:"delete_node";nodeId:string}
 |{type:"delete_connection";connectionId:string};
export type AssistantCanvasGraph={nodes:CanvasNodeData[];connections:CanvasConnection[]};
export type AssistantCanvasStage="safe"|"dangerous";
export type AssistantCanvasOutcome=AssistantCanvasGraph&{
 refs:Map<string,string>;applied:number;createdNodeIds:string[];
};
const identifier=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_:\-.]{1,128}$/.test(value);
const boundedString=(value:unknown,max:number):value is string=>typeof value==="string"&&value.length<=max;
const keys=(obj:Record<string,unknown>,allowed:readonly string[])=>Object.keys(obj).every(key=>allowed.includes(key));
export function isAssistantCanvasAction(value:unknown):value is AssistantCanvasAction{
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const action=value as Record<string,unknown>;
 switch(action.type){
  case "create_text":return keys(action,["type","ref","title","content"])&&identifier(action.ref)&&
   boundedString(action.title,120)&&boundedString(action.content,12000);
  case "connect":return keys(action,["type","from","to"])&&identifier(action.from)&&identifier(action.to)&&action.from!==action.to;
  case "set_text":return keys(action,["type","nodeId","content"])&&identifier(action.nodeId)&&boundedString(action.content,12000);
  case "set_title":return keys(action,["type","nodeId","title"])&&identifier(action.nodeId)&&boundedString(action.title,120);
  case "delete_node":return keys(action,["type","nodeId"])&&identifier(action.nodeId);
  case "delete_connection":return keys(action,["type","connectionId"])&&identifier(action.connectionId);
  default:return false;
 }
}
export function parseAssistantCanvasActions(value:unknown):AssistantCanvasAction[]{
 if(!Array.isArray(value)||value.length>16||!value.every(isAssistantCanvasAction))
  throw Error("AI 返回了不支持的画布操作，未执行。");
 const aliases=new Set<string>();
 for(const action of value){
  if(action.type!=="create_text")continue;
  if(aliases.has(action.ref))throw Error("AI 创建节点的引用标识重复，未执行。");
  aliases.add(action.ref);
 }
 return value;
}
export const isDangerousAssistantAction=(action:AssistantCanvasAction)=>
 action.type==="set_text"||action.type==="set_title"||action.type==="delete_node"||action.type==="delete_connection";
export function dangerousAssistantActionSummary(actions:readonly AssistantCanvasAction[]){
 const count=(type:AssistantCanvasAction["type"])=>actions.filter(action=>action.type===type).length;
 return [
  count("set_text")?`修改 ${count("set_text")} 个节点内容`:"",
  count("set_title")?`修改 ${count("set_title")} 个节点标题`:"",
  count("delete_node")?`删除 ${count("delete_node")} 个节点`:"",
  count("delete_connection")?`删除 ${count("delete_connection")} 条连线`:""
 ].filter(Boolean).join("、");
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
/** Pure, all-or-nothing graph transaction. The UI owns confirmation and history. */
export function applyAssistantCanvasActions(
 graph:AssistantCanvasGraph,rawActions:unknown,stage:AssistantCanvasStage,center:Position,
 refs:ReadonlyMap<string,string>=new Map(),
):AssistantCanvasOutcome{
 const actions=parseAssistantCanvasActions(rawActions);
 let nodes=[...graph.nodes],connections=[...graph.connections];
 const mapped=new Map(refs);
 let applied=0;
 const createdNodeIds:string[]=[];
 const safeActions=actions.filter(action=>!isDangerousAssistantAction(action));
 const dangerous=actions.filter(isDangerousAssistantAction);
 if(stage==="safe"){
  if(safeActions.filter(action=>action.type==="create_text").length>12)
   throw Error("单次最多创建 12 个文本节点。");
  // Resolve all temporary refs first, so the model may place connect before create.
  for(const action of safeActions){
   if(action.type!=="create_text")continue;
   if(nodes.some(node=>node.id===action.ref)||mapped.has(action.ref))
    throw Error("节点引用与现有节点冲突，未执行。");
   const index=createdNodeIds.length;
   const node=createCanvasNode(CanvasNodeType.Text,
    {x:center.x+(index%3)*360,y:center.y+Math.floor(index/3)*280},
    {content:action.content,status:"success"});
   if(nodes.some(existing=>existing.id===node.id))throw Error("节点 ID 冲突，未执行。");
   node.title=action.title.trim()||node.title;
   nodes.push(node);
   mapped.set(action.ref,node.id);createdNodeIds.push(node.id);applied++;
  }
  for(const action of safeActions){
   if(action.type!=="connect")continue;
   const from=mapped.get(action.from)??action.from,to=mapped.get(action.to)??action.to;
   if(from===to)throw Error("不能连接同一个节点。");
   if(createsCycle(from,to,connections))throw Error("连线会构成循环，未执行。");
   const result=prepareCanvasPortConnection({nodeId:from,handleType:"source"},
    {nodeId:to,handleType:"target"},nodes,connections);
   if(!result.connection||result.replacedConnectionIds?.length)
    throw Error("连线无效或端口被占用（"+(result.error??"replace")+ "），未执行。");
   connections.push({...result.connection,id:nanoid()});applied++;
  }
 }else{
  for(const action of dangerous){
   switch(action.type){
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
