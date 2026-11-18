import {canonicalBackendGraph} from "@/features/backend-sync/backend-source-fingerprint";
import {isDangerousAssistantAction,type AssistantCanvasAction,type AssistantCanvasGraph} from "./canvas-assistant-actions";
import type {AssistantTaskGraphPreview} from "./canvas-assistant-task-execution";

export type FrozenCanvasEditContext = {
  projectId?: string;
  projectRevision?: number;
  graphFingerprint: string;
  selectedNodeIds: string[];
  selectedConnectionId?: string;
  explicitReferences: {nodeId:string}[];
  fullGraphGrant: boolean;
};

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(Reflect.get(value,key))}`).join(",")}}`;
};

export function freezeCanvasEditContext(graph: AssistantCanvasGraph, input: Omit<FrozenCanvasEditContext,"graphFingerprint">): FrozenCanvasEditContext {
  return {...input,graphFingerprint:canonicalBackendGraph(graph),selectedNodeIds:[...input.selectedNodeIds],
    explicitReferences:input.explicitReferences.map(reference=>({...reference}))};
}

export function assertCanvasEditCurrent(graph:AssistantCanvasGraph,frozen:FrozenCanvasEditContext){
  if(canonicalBackendGraph(graph)!==frozen.graphFingerprint)
    throw Error("画布在发送后发生变化，请重新生成提案。");
}

export function applyTaskEditPreview(before:AssistantCanvasGraph,preview:AssistantTaskGraphPreview):AssistantCanvasGraph{
  const apply=<T extends {id:string}>(items:T[],changes:{removed:string[];upserted:T[]})=>{
    const next=new Map(items.map(item=>[item.id,item]));
    for(const id of changes.removed)next.delete(id);
    for(const item of changes.upserted)next.set(item.id,item);
    return [...next.values()];
  };
  return {nodes:apply(before.nodes,preview.nodes),connections:apply(before.connections,preview.connections)};
}

export function describeCanvasEdit(before:AssistantCanvasGraph,after:AssistantCanvasGraph,
 actions:readonly AssistantCanvasAction[],frozen:FrozenCanvasEditContext){
  const allowed=new Set([...frozen.selectedNodeIds,...frozen.explicitReferences.map(ref=>ref.nodeId)]);
  const full=frozen.fullGraphGrant;
  const nodes=new Map(before.nodes.map(node=>[node.id,node]));
  const edges=new Map(before.connections.map(edge=>[edge.id,edge]));
  const existing=(id:string)=>{if(nodes.has(id)&&!full&&!allowed.has(id))throw Error("操作越过本轮授权范围："+id);};
  for(const action of actions){
    if("nodeId" in action)existing(action.nodeId);
    if("groupId" in action)existing(action.groupId);
    if("members" in action)action.members.forEach(existing);
    if("nodeIds" in action)action.nodeIds.forEach(existing);
    if("from" in action){existing(action.from);existing(action.to);}
    if("fromNodeId" in action){existing(action.fromNodeId);existing(action.toNodeId);}
    if(action.type==="delete_connection"&&action.connectionId!==frozen.selectedConnectionId){
      const edge=edges.get(action.connectionId);
      if(edge){existing(edge.fromNodeId);existing(edge.toNodeId);}
    }
  }
  const nextNodes=new Map(after.nodes.map(node=>[node.id,node]));
  const nextEdges=new Map(after.connections.map(edge=>[edge.id,edge]));
  const rows:string[]=[];
  let requiresPreview=actions.some(action=>isDangerousAssistantAction(action)||action.type==="remove_from_group");
  const clip=(value:unknown)=>{
    const text=value===undefined?"∅":JSON.stringify(value);
    return text.length>400?text.slice(0,400)+"…":text;
  };
  const edgeLabel=(edge:AssistantCanvasGraph["connections"][number])=>
    `${edge.fromNodeId}${edge.fromPortId?":"+edge.fromPortId:""} → ${edge.toNodeId}${edge.toPortId?":"+edge.toPortId:""}`;
  for(const [id,node] of nodes){
    const next=nextNodes.get(id);
    if(!next){rows.push(`删除节点 ${node.title??""} [${id}]`);requiresPreview=true;continue;}
    if(stable(node)===stable(next))continue;
    const fields=[...new Set([...Object.keys(node),...Object.keys(next)])].filter(key=>key!=="metadata");
    const changes=fields.flatMap(key=>{
      const oldValue=Reflect.get(node,key),newValue=Reflect.get(next,key);
      return stable(oldValue)===stable(newValue)?[]:[`${key} ${clip(oldValue)} → ${clip(newValue)}`];
    });
    const metadataKeys=new Set([...Object.keys(node.metadata??{}),...Object.keys(next.metadata??{})]);
    for(const key of metadataKeys){
      const oldValue=Reflect.get(node.metadata??{},key),newValue=Reflect.get(next.metadata??{},key);
      if(stable(oldValue)!==stable(newValue))changes.push(`${key} ${clip(oldValue)} → ${clip(newValue)}`);
    }
    const cascades=!full&&!allowed.has(id);
    requiresPreview ||= cascades || changes.some(change=>!change.startsWith("position ")&&!change.startsWith("width ")&&!change.startsWith("height ")&&!change.startsWith("groupId ∅ → "));
    rows.push(`${cascades?"级联：":""}${node.title??""} [${id}] ${changes.join("，")}`);
  }
  for(const [id,node] of nextNodes)if(!nodes.has(id))rows.push(`新增节点 ${node.title??""} [${id}]`);
  for(const [id,edge] of edges){
    const next=nextEdges.get(id);
    if(!next||stable(next)!==stable(edge)){
      requiresPreview=true;
      rows.push(`${next?"替换":"移除"}连线 [${id}] ${edgeLabel(edge)}${next?" 改为 "+edgeLabel(next):""}`);
    }
  }
  for(const [id,edge] of nextEdges)if(!edges.has(id))rows.push(`添加连线 [${id}] ${edgeLabel(edge)}`);
  return {requiresPreview,summary:rows.join("\n")};
}
