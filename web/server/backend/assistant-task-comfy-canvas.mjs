/** Task-only, server-side Comfy instance operations. The current bound template
 * revision is looked up from the immutable SQLite registry, not a model-claimed
 * port schema or the browser's transient workflow editor.
 */
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const portId=x=>typeof x==="string"&&/^[A-Za-z0-9_:\-.]{1,128}$/.test(x);
const nodeId=x=>typeof x==="string"&&/^[A-Za-z0-9_:@./-]{1,256}$/.test(x);
const scalar=x=>typeof x==="boolean"||typeof x==="string"&&x.length<=2000||
 typeof x==="number"&&Number.isFinite(x)&&Math.abs(x)<=1e15;
const sensitive=/(?:secret|token|password|api.?key|credential|authorization|密钥|密码|令牌)/i;
const keys=(value,allowed)=>Object.keys(value).every(k=>allowed.includes(k));
export function assertFrozenComfyAction(a){
 const kind=a.type;
 if(kind==="set_workflow_param"){
  if(!keys(a,["type","nodeId","portId","value"])||!nodeId(a.nodeId)||
   !portId(a.portId)||!scalar(a.value))throw fail("assistant_comfy_action_invalid",400);
  return false;
 }
 if(kind==="disconnect_workflow_port"){
  if(!keys(a,["type","nodeId","portId"])||!nodeId(a.nodeId)||!portId(a.portId))
   throw fail("assistant_comfy_action_invalid",400);
  return false;
 }
 if(kind==="connect_workflow_port"||kind==="replace_workflow_port"){
  if(!keys(a,["type","fromNodeId","fromPortId","toNodeId","toPortId"])||
   !nodeId(a.fromNodeId)||!nodeId(a.toNodeId)||a.fromNodeId===a.toNodeId||
   !portId(a.fromPortId)||!portId(a.toPortId))
   throw fail("assistant_comfy_action_invalid",400);
  return true;
 }
 throw fail("assistant_canvas_action_unsupported");
}
const kindMap={text:{text:"STRING"},image:{image:"IMAGE"},video:{video:"VIDEO"},audio:{audio:"AUDIO"}};
function pinnedPort(nodes,targetId,requestedPort,loadTemplate,resolve){
 const node=nodes.find(n=>n.id===resolve(targetId));
 const binding=node?.metadata?.comfyWorkflow;
 if(node?.type!=="comfy:workflow"||!binding?.templateId||!binding.templateRevision)
  throw fail("assistant_comfy_target_invalid");
 const template=loadTemplate?.(binding.templateId,binding.templateRevision);
 if(!template||template.id!==binding.templateId||template.revision!==binding.templateRevision)
  throw fail("assistant_comfy_template_unavailable");
 const actual=node.metadata?.comfyPorts?.find(p=>p.id===requestedPort&&p.direction==="target");
 const port=template.ports?.find(p=>p.id===requestedPort&&p.direction==="target");
 if(!actual||!port||actual.valueKind!==port.valueKind||
  !port.inputBinding?.targets?.length||sensitive.test(port.id+" "+port.label))
  throw fail("assistant_comfy_port_invalid");
 return {node,port};
}
const reached=(from,to,links)=>{
 const stack=[to],seen=new Set();
 while(stack.length){
  const n=stack.pop();if(n===from)return true;if(seen.has(n))continue;seen.add(n);
  for(const e of links)if(e.fromNodeId===n)stack.push(e.toNodeId);
 }return false;
};
export function applyFrozenComfyAction({document,action,edgeId,resolve,loadTemplate}){
 const nodes=document.nodes,connections=document.connections;
 const targetId=action.toNodeId??action.nodeId,targetPort=action.toPortId??action.portId;
 const {node,port}=pinnedPort(nodes,targetId,targetPort,loadTemplate,resolve);
 const incoming=()=>connections.filter(c=>c.toNodeId===node.id&&c.toPortId===port.id);
 if(action.type==="set_workflow_param"){
  if(port.inputBinding.mode!=="literal"||
   !["STRING","INT","FLOAT","BOOLEAN"].includes(port.valueKind)||
   incoming().length)throw fail("assistant_comfy_param_not_editable");
  const value=action.value,good=port.valueKind==="STRING"?typeof value==="string":
   port.valueKind==="BOOLEAN"?typeof value==="boolean":
   port.valueKind==="INT"?Number.isSafeInteger(value):
   typeof value==="number"&&Number.isFinite(value);
  if(!good||(Array.isArray(port.choices)&&port.choices.length&&
   !port.choices.some(choice=>Object.is(choice.value,value))))
   throw fail("assistant_comfy_param_value_invalid");
  const pos=nodes.findIndex(n=>n.id===node.id);
  nodes[pos]={...node,metadata:{...node.metadata,comfyWorkflow:{
   ...node.metadata.comfyWorkflow,inputOverrides:{
    ...node.metadata.comfyWorkflow.inputOverrides,[port.id]:value
   }}}};
  return;
 }
 const old=incoming();
 if(action.type==="disconnect_workflow_port"){
  if(old.length!==1)throw fail("assistant_comfy_port_not_connected");
  connections.splice(connections.findIndex(c=>c.id===old[0].id),1);
  return;
 }
 const from=resolve(action.fromNodeId);
 const source=nodes.find(n=>n.id===from);
 const sourceKind=kindMap[source?.type]?.[action.fromPortId];
 if(!sourceKind||sourceKind!==port.valueKind||from===node.id)
  throw fail("assistant_comfy_source_type_invalid");
 if(action.type==="connect_workflow_port"&&old.length!==0)
  throw fail("assistant_comfy_port_already_connected");
 if(action.type==="replace_workflow_port"&&old.length!==1)
  throw fail("assistant_comfy_port_not_connected");
 if(!edgeId||connections.some(c=>c.id===edgeId))
  throw fail("assistant_comfy_edge_conflict");
 const rest=connections.filter(c=>!old.some(o=>o.id===c.id));
 if(rest.some(c=>c.fromNodeId===from&&c.fromPortId===action.fromPortId&&
   c.toNodeId===node.id&&c.toPortId===port.id)||reached(from,node.id,rest))
  throw fail("assistant_comfy_connection_invalid");
 connections.splice(0,connections.length,...rest,{id:edgeId,fromNodeId:from,
  fromPortId:action.fromPortId,toNodeId:node.id,toPortId:port.id});
}
