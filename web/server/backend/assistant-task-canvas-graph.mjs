import {assertFrozenComfyAction,applyFrozenComfyAction} from "./assistant-task-comfy-canvas.mjs";
import {assertFrozenNodeParameterAction,applyFrozenNodeParameterAction} from "./assistant-task-node-params.mjs";
import {canvasTextContentPatch} from "../canvas-text-content.mjs";

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
const allNodeNames=(values,min,max)=>Array.isArray(values)&&values.length>=min&&
 values.length<=max&&values.every(nodeName)&&new Set(values).size===values.length;
export function assertAssistantCanvasPlan({actions,center}){
 if(!Array.isArray(actions)||!actions.length||actions.length>16||
  !center||!Number.isFinite(center.x)||!Number.isFinite(center.y)||
  Math.abs(center.x)>1000000||Math.abs(center.y)>1000000)
  throw fail("assistant_canvas_plan_invalid",400);
 const created=[],edges=[];
 const fieldsByType={
  create_text:["type","ref","title","content"],
  create_node:["type","ref","nodeType","title","content","prompt"],
  create_group:["type","ref","title","members"],
  layout_nodes:["type","nodeIds","direction","gap"],
  add_to_group:["type","groupId","members"],
  remove_from_group:["type","groupId","members"],
  ungroup:["type","groupId"],
  connect:["type","from","to"],
  set_text:["type","nodeId","content"],
  set_title:["type","nodeId","title"],
  set_prompt:["type","nodeId","prompt"],
  delete_node:["type","nodeId"],
  delete_connection:["type","connectionId"]
 };
 for(let index=0;index<actions.length;index++){
  const a=actions[index];
  if(!a||typeof a!=="object"||Array.isArray(a))throw fail("assistant_canvas_plan_invalid",400);
  const fields=fieldsByType[a.type];
  if(!fields){
   if(a.type==="set_node_param"){assertFrozenNodeParameterAction(a);continue;}
   if(["set_workflow_param","connect_workflow_port","replace_workflow_port","disconnect_workflow_port"].includes(a.type)){
    if(assertFrozenComfyAction(a))edges.push("edge_"+index);
    continue;
   }
   throw fail("assistant_canvas_action_unsupported");
  }
  if(!own(a,fields)||["nodeId","from","to","connectionId","groupId"].some(key=>key in a&&!nodeName(a[key]))||
   ["add_to_group","remove_from_group","ungroup"].includes(a.type)&&!nodeName(a.groupId))
   throw fail("assistant_canvas_plan_invalid",400);
  if(["create_text","create_node","create_group"].includes(a.type)){
   if(!alias(a.ref)||created.includes(a.ref)||!short(a.title??"",120)||
    (a.type==="create_text"&&!short(a.content,12000))||
    (a.type==="create_node"&&(!types.has(a.nodeType)||
     (a.content!==undefined&&(a.nodeType!=="text"||!short(a.content,12000)))||
     (a.prompt!==undefined&&(a.nodeType==="text"||!short(a.prompt,3000)))))||
    (a.type==="create_group"&&(!allNodeNames(a.members,0,12)||
     (a.members.length!==0&&a.members.length<2))))
    throw fail("assistant_canvas_plan_invalid",400);
   created.push(a.ref);
  }else if(a.type==="layout_nodes"){
   if(!allNodeNames(a.nodeIds,1,12)||!["horizontal","vertical","grid"].includes(a.direction)||
    a.gap!==undefined&&(!Number.isInteger(a.gap)||a.gap<16||a.gap>160))
    throw fail("assistant_canvas_plan_invalid",400);
  }else if(a.type==="add_to_group"||a.type==="remove_from_group"){
   if(!allNodeNames(a.members,1,12))throw fail("assistant_canvas_plan_invalid",400);
  }else if(a.type==="connect"){
   if(a.from===a.to)throw fail("assistant_canvas_plan_invalid",400);
   edges.push("edge_"+index);
  }else if(["set_text","set_title","set_prompt"].includes(a.type)){
   const bound=a.type==="set_title"?120:12000;
   if(!short(a[a.type==="set_title"?"title":a.type==="set_text"?"content":"prompt"],bound))
    throw fail("assistant_canvas_plan_invalid",400);
  }
 }
 if(created.length>12)throw fail("assistant_canvas_plan_invalid",400);
 return {newNodes:created,newConnections:edges};
}
const validCoordinate=(n)=>Number.isFinite(n)&&Math.abs(n)<=1000000;
const validPosition=({x,y})=>validCoordinate(x)&&validCoordinate(y);
function canvasBounds(items){
 if(!items.length)throw fail("assistant_canvas_target_invalid");
 const left=Math.min(...items.map(n=>n.position.x));
 const top=Math.min(...items.map(n=>n.position.y));
 const right=Math.max(...items.map(n=>n.position.x+n.width));
 const bottom=Math.max(...items.map(n=>n.position.y+n.height));
 if(![left,top,right,bottom].every(validCoordinate)||right<=left||bottom<=top)
  throw fail("assistant_canvas_target_invalid");
 return {left,top,right,bottom};
}
function groupBounds(items){
 const {left,top,right,bottom}=canvasBounds(items);
 const position={x:left-36,y:top-80},width=Math.max(260,right-left+72);
 const height=Math.max(180,bottom-top+116);
 if(width>1000000||height>1000000||!validPosition(position)||
  !validPosition({x:position.x+width,y:position.y+height}))
  throw fail("assistant_canvas_plan_invalid",400);
 return {position,width,height};
}
function layoutNodePositions(selected,center,direction,gap){
 const n=selected.length,cols=direction==="horizontal"?n:direction==="vertical"?1:Math.ceil(Math.sqrt(n));
 const rows=Math.ceil(n/cols),widths=[],heights=[];
 for(let col=0;col<cols;col++)
  widths.push(Math.max(...selected.filter((_,i)=>i%cols===col).map(node=>node.width)));
 for(let row=0;row<rows;row++)
  heights.push(Math.max(...selected.slice(row*cols,(row+1)*cols).map(node=>node.height)));
 const width=widths.reduce((a,b)=>a+b,0)+gap*(cols-1);
 const height=heights.reduce((a,b)=>a+b,0)+gap*(rows-1);
 const positions=selected.map((node,i)=>{
  const col=i%cols,row=Math.floor(i/cols);
  const x=center.x-width/2+widths.slice(0,col).reduce((a,b)=>a+b,0)+gap*col+(widths[col]-node.width)/2;
  const y=center.y-height/2+heights.slice(0,row).reduce((a,b)=>a+b,0)+gap*row+(heights[row]-node.height)/2;
  const position={x,y};
  if(!validPosition(position)||!validPosition({x:x+node.width,y:y+node.height}))
   throw fail("assistant_canvas_plan_invalid",400);
  return position;
 });
 return positions;
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
export function applyFrozenAssistantCanvasPlan(document,plan,refs,{externalRefs={},loadTemplate,config}={}){
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
  if(type==="create_group"){
   const nodeId=refs.nodes[a.ref];
   if(seen.has(nodeId)||seen.has(a.ref))throw fail("assistant_canvas_ref_conflict");
   const memberIds=a.members.map(resolve);
   if(new Set(memberIds).size!==memberIds.length)throw fail("assistant_canvas_plan_invalid",400);
   const members=memberIds.map(id=>nodes.find(node=>node.id===id));
   if(members.some(node=>!node||node.type==="group"||node.metadata?.groupId))
    throw fail("assistant_canvas_target_invalid");
   const bounds=members.length?groupBounds(members):
    {position:{x:plan.center.x+created*800-280,y:plan.center.y-160},width:560,height:320};
   if(!validPosition(bounds.position)||!validPosition({x:bounds.position.x+bounds.width,y:bounds.position.y+bounds.height}))
    throw fail("assistant_canvas_plan_invalid",400);
   const group={id:nodeId,type:"group",title:a.title.trim()||"分组",
    ...bounds,metadata:{content:"",status:"idle"}};
   for(const memberId of memberIds){
    const at=nodes.findIndex(node=>node.id===memberId);
    nodes[at]={...nodes[at],metadata:{...nodes[at].metadata,groupId:nodeId}};
   }
   nodes.push(group);seen.add(nodeId);
  }else if(type==="layout_nodes"){
   const targetIds=a.nodeIds.map(resolve);
   if(new Set(targetIds).size!==targetIds.length)throw fail("assistant_canvas_plan_invalid",400);
   const selected=targetIds.map(id=>nodes.find(node=>node.id===id));
   if(selected.some(node=>!node))throw fail("assistant_canvas_target_invalid");
   const selectedSet=new Set(targetIds);
   if(selected.some(node=>node.metadata?.groupId||
    node.type==="group"&&nodes.some(child=>child.metadata?.groupId===node.id&&selectedSet.has(child.id))))
    throw fail("assistant_canvas_target_invalid");
   const positions=layoutNodePositions(selected,plan.center,a.direction,a.gap??36);
   const movements=new Map(selected.map((node,i)=>[node.id,{
    dx:positions[i].x-node.position.x,dy:positions[i].y-node.position.y
   }]));
   for(let at=0;at<nodes.length;at++){
    const node=nodes[at],delta=movements.get(node.id)??movements.get(node.metadata?.groupId);
    if(!delta)continue;
    const position={x:node.position.x+delta.dx,y:node.position.y+delta.dy};
    if(!validPosition(position)||!validPosition({x:position.x+node.width,y:position.y+node.height}))
     throw fail("assistant_canvas_plan_invalid",400);
    nodes[at]={...node,position};
   }
  }else if(type==="add_to_group"||type==="remove_from_group"){
   const groupId=resolve(a.groupId),group=nodes.find(node=>node.id===groupId&&node.type==="group");
   if(!group)throw fail("assistant_canvas_target_invalid");
   const memberIds=a.members.map(resolve);
   if(new Set(memberIds).size!==memberIds.length)throw fail("assistant_canvas_plan_invalid",400);
   const members=memberIds.map(id=>nodes.find(node=>node.id===id));
   if(members.some(node=>!node||node.type==="group"))throw fail("assistant_canvas_target_invalid");
   if(type==="add_to_group"&&members.some(node=>node.metadata?.groupId)||
    type==="remove_from_group"&&members.some(node=>node.metadata?.groupId!==groupId))
    throw fail("assistant_canvas_target_invalid");
   for(const memberId of memberIds){
    const at=nodes.findIndex(node=>node.id===memberId);
    const metadata={...nodes[at].metadata};
    if(type==="add_to_group")metadata.groupId=groupId;
    else delete metadata.groupId;
    nodes[at]={...nodes[at],metadata};
   }
   if(type==="add_to_group"){
    const attached=nodes.filter(node=>node.metadata?.groupId===groupId);
    const left=Math.min(group.position.x,...attached.map(node=>node.position.x-36));
    const top=Math.min(group.position.y,...attached.map(node=>node.position.y-80));
    const right=Math.max(group.position.x+group.width,...attached.map(node=>node.position.x+node.width+36));
    const bottom=Math.max(group.position.y+group.height,...attached.map(node=>node.position.y+node.height+36));
    if(![left,top,right,bottom].every(validCoordinate)||right-left>1000000||bottom-top>1000000)
     throw fail("assistant_canvas_plan_invalid",400);
    nodes[nodes.indexOf(group)]={...group,position:{x:left,y:top},width:right-left,height:bottom-top};
   }
  }else if(type==="ungroup"){
   const groupId=resolve(a.groupId),at=nodes.findIndex(node=>node.id===groupId&&node.type==="group");
   if(at<0||connections.some(edge=>edge.fromNodeId===groupId||edge.toNodeId===groupId))
    throw fail("assistant_canvas_target_invalid");
   nodes.splice(at,1);
   for(let i=0;i<nodes.length;i++){
    if(nodes[i].metadata?.groupId!==groupId)continue;
    const metadata={...nodes[i].metadata};
    delete metadata.groupId;
    nodes[i]={...nodes[i],metadata};
   }
  }else if(type==="set_node_param"){
   applyFrozenNodeParameterAction({document:output,action:a,resolve,config});
  }else if(["set_workflow_param","connect_workflow_port","replace_workflow_port","disconnect_workflow_port"].includes(type)){
   applyFrozenComfyAction({document:output,action:a,edgeId:refs.connections["edge_"+index],resolve,loadTemplate,config});
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
    const patch=canvasTextContentPatch(node.type,a.content);
    if(!patch)throw node.type==="drama:episodes"?fail("assistant_episode_draft_invalid",400):fail("assistant_canvas_target_invalid");
    nodes[idx]={...node,metadata:{...node.metadata,...patch}};
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
