import {assertFrozenComfyAction,applyFrozenComfyAction} from "./assistant-task-comfy-canvas.mjs";

/** Deterministic, backend-only ordinary canvas operations.
 * No network, filesystem, Comfy, Skill or GPU work. Unsupported actions
 * fail closed rather than falling back to unsafe browser mutations.
 */
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const own=(obj,fields)=>Object.keys(obj).every(key=>fields.includes(key));
const alias=x=>typeof x==="string"&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(x);
const nodeName=x=>typeof x==="string"&&/^[A-Za-z0-9_:@./-]{1,256}$/.test(x);
const short=(x,max)=>typeof x==="string"&&x.length<=max;
const types=new Set(["text","image","video","audio","config","director"]);
const specs={text:[340,240],image:[340,240],video:[420,236],
 audio:[340,120],config:[340,240],director:[340,240]};
const titles={text:"文本",image:"图片",video:"视频",audio:"音频",config:"配置",director:"导演"};
export function assertAssistantCanvasPlan({actions,center}){
 if(!Array.isArray(actions)||!actions.length||actions.length>16||
  !center||!Number.isFinite(center.x)||!Number.isFinite(center.y)||
  Math.abs(center.x)>1000000||Math.abs(center.y)>1000000)
  throw fail("assistant_canvas_plan_invalid",400);
 const created=[],edges=[];
 for(let index=0;index<actions.length;index++){
  const a=actions[index];
  if(!a||typeof a!=="object"||Array.isArray(a))throw fail("assistant_canvas_plan_invalid",400);
  const fields={
   create_text:["type","ref","title","content"],
   create_node:["type","ref","nodeType","title","content","prompt"],
   connect:["type","from","to"],
   set_text:["type","nodeId","content"],
   set_title:["type","nodeId","title"],
   set_prompt:["type","nodeId","prompt"],
   delete_node:["type","nodeId"],
   delete_connection:["type","connectionId"]
  }[a.type];
  if(!fields){
   if(["set_workflow_param","connect_workflow_port","replace_workflow_port","disconnect_workflow_port"].includes(a.type)){
    if(assertFrozenComfyAction(a))edges.push("edge_"+index);
    continue;
   }
   throw fail("assistant_canvas_action_unsupported");
  }
  if(!own(a,fields))throw fail("assistant_canvas_plan_invalid",400);
  if(["nodeId","from","to","connectionId"].some(key=>key in a&&!nodeName(a[key])))
   throw fail("assistant_canvas_plan_invalid",400);
  if(a.type==="create_text"||a.type==="create_node"){
   if(!alias(a.ref)||created.includes(a.ref)||!short(a.title??"",120)||
    (a.type==="create_text"&&!short(a.content,12000))||
    (a.type==="create_node"&&(!types.has(a.nodeType)||
      (a.content!==undefined&&(a.nodeType!=="text"||!short(a.content,12000)))||
      (a.prompt!==undefined&&(a.nodeType==="text"||!short(a.prompt,3000))))))
    throw fail("assistant_canvas_plan_invalid",400);
   created.push(a.ref);
  }else if(a.type==="connect"){
   if(!nodeName(a.from)||!nodeName(a.to)||a.from===a.to)throw fail("assistant_canvas_plan_invalid",400);
   edges.push("edge_"+index);
  }else if(a.type==="set_text"||a.type==="set_title"||a.type==="set_prompt"){
   const bound=a.type==="set_title"?120:12000;
   if(!short(a[a.type==="set_title"?"title":a.type==="set_text"?"content":"prompt"],bound))
    throw fail("assistant_canvas_plan_invalid",400);
  }
 }
 if(created.length>12)throw fail("assistant_canvas_plan_invalid",400);
 return {newNodes:created,newConnections:edges};
}
const clone=value=>JSON.parse(JSON.stringify(value));
function reachable(from,to,connections){
 const stack=[to],seen=new Set();
 while(stack.length){const current=stack.pop();if(current===from)return true;
  if(seen.has(current))continue;seen.add(current);
  for(const edge of connections)if(edge.fromNodeId===current)stack.push(edge.toNodeId);
 }return false;
}
/** externalRefs are permitted only from server_committed dependency receipts.
 * New node and edge IDs always come from the frozen Step.
 */
export function applyFrozenAssistantCanvasPlan(document,plan,refs,{externalRefs={},loadTemplate}={}){
 const {newNodes,newConnections}=assertAssistantCanvasPlan(plan);
 if(!refs||!refs.nodes||!refs.connections||
  newNodes.some(value=>!nodeName(refs.nodes[value]))||
  newConnections.some(value=>!nodeName(refs.connections[value])))
  throw fail("assistant_canvas_refs_invalid");
 const output=clone(document),nodes=output.nodes,connections=output.connections;
 const seen=new Set(nodes.map(node=>node.id));
 const seenEdges=new Set(connections.map(edge=>edge.id));
 const resolve=value=>refs.nodes[value]??externalRefs[value]??value;
 let created=0,applied=0;
 for(const a of plan.actions){
  if(a.type!=="create_text"&&a.type!=="create_node")continue;
  const nodeId=refs.nodes[a.ref],type=a.type==="create_text"?"text":a.nodeType;
  if(seen.has(nodeId)||seen.has(a.ref))throw fail("assistant_canvas_ref_conflict");
  const [width,height]=specs[type],idx=created++;
  const position={x:plan.center.x+(idx%3)*440-width/2,
   y:plan.center.y+Math.floor(idx/3)*320-height/2};
  const metadata={content:"",status:"idle",...(type==="text"?{fontSize:14}:{}),
   ...(type==="config"?{generationMode:"image"}:{})};
  if(type==="text"&&a.content!==undefined){metadata.content=a.content;metadata.status="success";}
  if(a.type==="create_node"&&a.prompt!==undefined)metadata.prompt=a.prompt;
  nodes.push({id:nodeId,type,title:(a.title||"").trim()||titles[type],position,width,height,metadata});
  seen.add(nodeId);applied++;
 }
 for(let index=0;index<plan.actions.length;index++){
  const a=plan.actions[index],type=a.type;
  if(type==="create_text"||type==="create_node")continue;
  if(["set_workflow_param","connect_workflow_port","replace_workflow_port","disconnect_workflow_port"].includes(type)){
   applyFrozenComfyAction({document:output,action:a,edgeId:refs.connections["edge_"+index],resolve,loadTemplate});
  }else if(type==="connect"){
   const from=resolve(a.from),to=resolve(a.to),edgeId=refs.connections["edge_"+index];
   if(!seen.has(from)||!seen.has(to)||from===to||seenEdges.has(edgeId)||
    connections.some(edge=>edge.fromNodeId===from&&edge.toNodeId===to)||
    reachable(from,to,connections))throw fail("assistant_canvas_connection_invalid");
   connections.push({id:edgeId,fromNodeId:from,toNodeId:to});
   seenEdges.add(edgeId);
  }else if(type==="delete_connection"){
   const target=resolve(a.connectionId),idx=connections.findIndex(edge=>edge.id===target);
   if(idx<0)throw fail("assistant_canvas_target_invalid");
   connections.splice(idx,1);
  }else{
   const target=resolve(a.nodeId),idx=nodes.findIndex(node=>node.id===target);
   if(idx<0)throw fail("assistant_canvas_target_invalid");
   const node=nodes[idx];
   if(type==="set_text"){
    if(node.type!=="text")throw fail("assistant_canvas_target_invalid");
    nodes[idx]={...node,metadata:{...node.metadata,content:a.content}};
   }else if(type==="set_title")nodes[idx]={...node,title:a.title.trim()||node.title};
   else if(type==="set_prompt"){
    if(!["image","video","audio","config","director","text"].includes(node.type))
     throw fail("assistant_canvas_target_invalid");
    nodes[idx]={...node,metadata:{...node.metadata,prompt:a.prompt}};
   }else if(type==="delete_node"){
    if(node.type!=="text")throw fail("assistant_canvas_target_invalid");
    nodes.splice(idx,1);
    for(let i=connections.length-1;i>=0;i--)
     if(connections[i].fromNodeId===target||connections[i].toNodeId===target)connections.splice(i,1);
   }
  }applied++;
 }
 return {document:output,refs,applied};
}
