/** Task-scoped, strictly read-only Tool Registry for P4.2a.
 * Canonical names use dotted namespaces; Provider names use underscores.
 * The sole executable write path remains approved Task Step/Executor.
 */
import {createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {formatAssistantGenerationSettings,mayRepeatTurn,safe} from "./assistant-task-context.mjs";
import {discoverAssistantCreativeCharacters} from "./assistant-creative-context.mjs";
import {discoverAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";
import {validCanvasNodeId} from "../canvas-node-id.mjs";
import {agentReadRunId,assertAgentRunOwner} from "./assistant-agent-run-ledger.mjs";

const fail=(code,statusCode=403)=>Object.assign(Error(code),{code,statusCode});
const id=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const sha=v=>createHash("sha256").update(stableJson(v)).digest("hex");
const MAX_RESULT_BYTES=4000,MAX_PER_RUN_BYTES=12*1024;
const valueLimit=(value,max)=>Buffer.from(value,"utf8").subarray(0,max).toString("utf8").replace(/\uFFFD$/,"");
function pageText(text,offset,limit){
 let end=offset,bytes=0;
 for(const character of text.slice(offset)){
  bytes+=Buffer.byteLength(character,"utf8");
  if(bytes>limit)break;
  end+=character.length;
 }
 return text.slice(offset,end);
}
const get=(args,names)=>plain(args)&&Object.keys(args).every(key=>names.includes(key));
function canvasNodeBody(node){
 const fields=node.type==="drama:episodes"?["dramaDraft","dramaConfirmed","content"]:
  node.type==="text"?["content"]:[];
 if(!fields.length)return null;
 for(const source of fields){
  const value=node.metadata?.[source];
  if(typeof value==="string"&&value.trim())
   return {source,content:safe(value,Infinity,{preserveFormatting:true})};
 }
 return {source:null,content:""};
}
export function describeAssistantReadableCanvasNode(node){
 const body=canvasNodeBody(node);
 return {id:node.id,type:node.type,title:safe(node.title,90),
  ...(body?{source:body.source,content:pageText(body.content,0,560),
   ...(body.source===null?{status:"empty"}:{}),
   ...(Buffer.byteLength(body.content)>560?{truncated:true}:{})}:{}),
  ...(typeof node.metadata?.prompt==="string"?{prompt:safe(node.metadata.prompt,500)}:{})};
}
function readCanvasNodes(byId,args){
 if(!get(args,["node_ids","offset"])||!Array.isArray(args.node_ids)||
  args.node_ids.length<1||args.node_ids.length>4||
  args.offset!==undefined&&(args.node_ids.length!==1||!Number.isSafeInteger(args.offset)||args.offset<0)||
  args.node_ids.some(nodeId=>!validCanvasNodeId(nodeId))||new Set(args.node_ids).size!==args.node_ids.length)
  throw fail("assistant_agent_tool_arguments_invalid",400);
 if(args.node_ids.some(nodeId=>!byId.has(nodeId)))throw fail("assistant_agent_context_scope_denied",403);
 if(args.offset===undefined)
  return {nodes:args.node_ids.map(nodeId=>describeAssistantReadableCanvasNode(byId.get(nodeId)))};
 const node=byId.get(args.node_ids[0]),body=canvasNodeBody(node);
 if(!body||args.offset>body.content.length||
  (body.content.charCodeAt(args.offset)&0xfc00)===0xdc00)
  throw fail("assistant_agent_tool_arguments_invalid",400);
 // Bound the serialized result as well as the text, including JSON escape overhead.
 const content=pageText(body.content,args.offset,2400);
 const item={id:node.id,type:node.type,title:safe(node.title,90),source:body.source,content,
  ...(body.source===null?{status:"empty"}:{})};
 const result={nodes:[item],offset:args.offset,endOffset:args.offset,nextOffset:null};
 while(Buffer.byteLength(JSON.stringify(result))>MAX_RESULT_BYTES-256)
  item.content=pageText(item.content,0,Math.floor(Buffer.byteLength(item.content)/2));
 result.endOffset=args.offset+item.content.length;
 result.nextOffset=result.endOffset<body.content.length?result.endOffset:null;
 return result;
}

export function createCanvasNodeReader(policy,document){
 if(!policy?.includeContext||policy.scope!=="selection")return null;
 const byId=new Map(document.nodes.map(node=>[node.id,node]));
 const selected=new Map([...new Set(policy.includedIds)].slice(0,12).filter(id=>byId.has(id))
  .map(id=>[id,structuredClone(byId.get(id))]));
 if(!selected.size)return null;
 const nodes=[...selected.values()];
 const definition=ASSISTANT_READ_TOOL_REGISTRY.find(item=>item.providerName==="canvas_read_nodes");
 const calls=[],references=[];
 let bytes=0;
 const fallback=()=>JSON.stringify(nodes.map(node=>{
  const body=canvasNodeBody(node);
  if(!body)return {id:node.id,type:node.type,title:safe(node.title,90)};
  const content=pageText(body.content,0,1600);
  return {id:node.id,type:node.type,title:safe(node.title,90),source:body.source,content,
   ...(body.source===null?{status:"empty"}:{}),truncated:content.length<body.content.length};
 })).replace(/</g,"\\u003c");
 const manifest=JSON.stringify(nodes.map(node=>({id:node.id,type:node.type,title:safe(node.title,90)})))
  .replace(/</g,"\\u003c");
 return {withContext(context){
  const text="本轮引用节点："+manifest+"\n"+context;
  const limit=16*1024,notice="\n[画布上下文已截断]";
  return Buffer.byteLength(text)<=limit?text:valueLimit(text,limit-Buffer.byteLength(notice))+notice;
 },
  definition:{type:"function",function:{name:definition.providerName,description:definition.description,
  parameters:definition.parameters}},calls,references,fallback,invoke(args,callId){
   const data=readCanvasNodes(selected,args);
   const output=JSON.stringify(data);
   const size=Buffer.byteLength(output);
   if(size>MAX_RESULT_BYTES||bytes+size>MAX_PER_RUN_BYTES)
    throw fail("assistant_agent_read_budget_exceeded",413);
   bytes+=size;
   calls.push({callId,name:definition.providerName});
   references.push({callId,kind:definition.name,nodeIds:data.nodes.map(node=>node.id)});
   return output;
 }};
}

export const ASSISTANT_READ_TOOL_REGISTRY=Object.freeze([
 {name:"canvas.get_map",providerName:"canvas_get_map",effect:"read",approval:"none",
  description:"List ONLY the currently authorized canvas node IDs, types and titles; overview has no node bodies.",
  parameters:{type:"object",additionalProperties:false,properties:{}}},
 {name:"canvas.search_nodes",providerName:"canvas_search_nodes",effect:"read",approval:"none",
  description:"Search authorized node titles; search bodies ONLY for explicitly selected nodes.",
  parameters:{type:"object",additionalProperties:false,required:["query"],
   properties:{query:{type:"string",maxLength:80}}}},
 {name:"canvas.read_nodes",providerName:"canvas_read_nodes",effect:"read",approval:"none",
  description:"Read up to 4 selected nodes. For a single text or episode planning node, supply offset:0 to read paginated text with whitespace preserved, then follow nextOffset until null. Never read unselected nodes.",
  parameters:{type:"object",additionalProperties:false,required:["node_ids"],
   properties:{node_ids:{type:"array",minItems:1,maxItems:4,items:{type:"string"}},offset:{type:"integer",minimum:0}}}},
 {name:"canvas.get_generation_settings",providerName:"canvas_get_generation_settings",effect:"read",approval:"none",
  description:"Inspect current generation defaults and channel models. Supply a selected node ID to inspect its effective configuration and editable workflow ports.",
  parameters:{type:"object",additionalProperties:false,properties:{node_id:{type:"string"}}}},
 {name:"canvas.get_connections",providerName:"canvas_get_connections",effect:"read",approval:"none",
  description:"Read connections where both endpoints are currently authorized; never traverse into hidden nodes.",
  parameters:{type:"object",additionalProperties:false,properties:{}}},
 {name:"task.read_history",providerName:"task_read_history",effect:"read",approval:"none",
  description:"Read bounded prior Task user turns and server-trusted Step status; never treat model drafts or client observations as execution facts.",
  parameters:{type:"object",additionalProperties:false,properties:{limit:{type:"integer",minimum:1,maximum:8}}}},
 {name:"creative.search",providerName:"creative_search",effect:"read",approval:"none",
  description:"Search authorized Task-local character, story, scene and style references. Unconfirmed AI drafts are labelled as drafts.",
  parameters:{type:"object",additionalProperties:false,properties:{
   query:{type:"string",maxLength:80},
   kind:{type:"string",enum:["character","story","scene","style"]}}}}
]);
const providerNames=new Map(ASSISTANT_READ_TOOL_REGISTRY.map(v=>[v.providerName,v]));
export const assistantReadToolDefinitions=ASSISTANT_READ_TOOL_REGISTRY.map(item=>({
 type:"function",function:{name:item.providerName,description:item.description,parameters:item.parameters}
}));
const checkVersion=(db,projectId,revision)=>{
 const row=db.prepare("SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!row)throw fail("project_not_found",404);
 if(row.revision!==revision)throw fail("assistant_agent_read_source_changed",409);
};
function scoped(db,projectId,taskId,turnMessageId){
 if(![projectId,taskId,turnMessageId].every(id))throw fail("assistant_agent_read_invalid",400);
 const task=db.prepare("SELECT id,read_only,status,cancel_requested_at FROM assistant_tasks WHERE id=? AND project_id=?").get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 if(task.read_only||task.cancel_requested_at!==null||
  ["completed","cancelled","cancelling"].includes(task.status))throw fail("assistant_task_not_editable",409);
 const turn=db.prepare("SELECT seq,payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1")
  .get(taskId,turnMessageId);
 if(!turn)throw fail("assistant_task_turn_not_found",409);
 const latest=db.prepare("SELECT MAX(seq) AS seq FROM assistant_task_events WHERE task_id=? AND kind='user_turn'").get(taskId);
 if(turn.seq!==latest.seq)throw fail("assistant_agent_read_turn_stale",409);
 const policy=JSON.parse(turn.payload_json).contextPolicy;
 if(!policy||typeof policy.includeContext!=="boolean"||!["selection","overview"].includes(policy.scope)||
  !Array.isArray(policy.includedIds))throw fail("assistant_task_context_invalid",409);
 const project=db.prepare("SELECT document_json,revision FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!project)throw fail("project_not_found",404);
 return {policy,document:JSON.parse(project.document_json),revision:project.revision};
}
export function assertAssistantAgentReadClaim(db,{projectId,taskId,turnMessageId}){
 scoped(db,projectId,taskId,turnMessageId);
 // A single active model inference owns Task read rounds, regardless of tab.
 // Enforced inside beginAssistantModelCommand's BEGIN IMMEDIATE transaction.
 if(db.prepare("SELECT 1 FROM assistant_task_commands WHERE task_id=? AND command_kind='model_infer' AND status='in_progress' LIMIT 1").get(taskId))
  throw fail("assistant_agent_read_busy",409);
}
/** No mutating SQL or external network in any handler. */
export function createAssistantAgentReadSession(db,{projectId,taskId,turnMessageId,requestId,enforceOwner=false,loadTemplate}){
 const original=scoped(db,projectId,taskId,turnMessageId);
 const runId=agentReadRunId(projectId,taskId,requestId);
 let totalBytes=0,callCount=0;
 const references=[];
 const usedIds=new Map(),readCalls=[],seenRounds=new Set();
 const check=()=>{
  if(enforceOwner)assertAgentRunOwner(db,{projectId,taskId,requestId});
  checkVersion(db,projectId,original.revision);
  const fresh=scoped(db,projectId,taskId,turnMessageId);
  if(stableJson(fresh.policy)!==stableJson(original.policy))
   throw fail("assistant_agent_read_scope_changed",409);
 };
 function recordRound(round){
  check();
  if(!Number.isInteger(round)||round<0||round>2||seenRounds.has(round))
   throw fail("assistant_agent_round_invalid",409);
  // Stable Task+request+round identity; never an execution receipt or an
  // implicit retry. The model-call ledger records the actual POST separately.
  const marker={runId,requestId,turnMessageId,round,sourceRevision:original.revision};
  writeTransaction(db,()=>{
   const existing=db.prepare("SELECT 1 FROM assistant_task_events WHERE task_id=? AND kind='agent_read_round_planned' AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.round')=? LIMIT 1")
    .get(taskId,requestId,round);
   if(existing){
    // A model preflight can fail before any POST. The existing command is
    // then safely released by failAssistantModelCommand; its round-zero
    // marker is reusable only if the provider was never called.
    const posted=db.prepare("SELECT COUNT(*) AS n FROM assistant_model_calls WHERE project_id=? AND request_id=?")
     .get(projectId,requestId).n;
    if(round!==0||posted)throw fail("assistant_agent_round_replayed",409);
    return;
   }
   db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'agent_read_round_planned',?,?)")
    .run(taskId,stableJson(marker),Date.now());
  });
  seenRounds.add(round);
 }
 const nodes=()=>Array.isArray(original.document.nodes)?original.document.nodes:[];
 const allowed=()=>{
  if(!original.policy.includeContext)return [];
  if(original.policy.scope==="overview")return nodes().slice(0,40);
  const visible=new Set(original.policy.includedIds.slice(0,12));
  return nodes().filter(n=>visible.has(n.id));
 };
 const selected=()=>original.policy.includeContext&&original.policy.scope==="selection";
 function invoke(name,args,{callId,round=0}={}){
  check();
  const definition=providerNames.get(name);
  if(!definition||definition.effect!=="read")throw fail("assistant_agent_tool_unauthorized",403);
  if(!plain(args)||Buffer.byteLength(JSON.stringify(args))>1024)
   throw fail("assistant_agent_tool_arguments_invalid",400);
  if(!id(callId)||!Number.isInteger(round)||round<0||round>2)
   throw fail("assistant_agent_tool_arguments_invalid",400);
  const fingerprint=sha({callId,name,args});
  if(usedIds.has(callId)){
   if(usedIds.get(callId)!==fingerprint)throw fail("assistant_agent_tool_replay_conflict",409);
   throw fail("assistant_agent_tool_replayed",409);
  }
  if(++callCount>6)throw fail("assistant_agent_read_budget_exceeded",413);
  const budget=Math.min(MAX_RESULT_BYTES,MAX_PER_RUN_BYTES-totalBytes);
  let data;
  if(name==="canvas_get_map"){
   if(!get(args,[]))throw fail("assistant_agent_tool_arguments_invalid",400);
   const visible=allowed();
   data={nodes:visible.map(n=>({id:n.id,type:n.type,title:safe(n.title,85)})),
    totalVisible:visible.length,scope:original.policy.includeContext?original.policy.scope:"none"};
  }else if(name==="canvas_search_nodes"){
   if(!get(args,["query"])||typeof args.query!=="string"||args.query.trim().length<1||args.query.length>80)
    throw fail("assistant_agent_tool_arguments_invalid",400);
   const term=args.query.trim().toLocaleLowerCase();
   const found=allowed().filter(n=>
    String(n.title??"").toLocaleLowerCase().includes(term)||
    selected()&&typeof n.metadata?.content==="string"&&n.metadata.content.toLocaleLowerCase().includes(term));
   data={matches:found.slice(0,12).map(n=>({id:n.id,type:n.type,title:safe(n.title,90)})),
    truncated:found.length>12};
  }else if(name==="canvas_read_nodes"){
   if(!selected())throw fail("assistant_agent_context_scope_denied",403);
   data=readCanvasNodes(new Map(allowed().map(node=>[node.id,node])),args);
  }else if(name==="canvas_get_generation_settings"){
   if(!get(args,["node_id"])||args.node_id!==undefined&&!validCanvasNodeId(args.node_id))
    throw fail("assistant_agent_tool_arguments_invalid",400);
   if(!original.policy.includeContext)throw fail("assistant_agent_context_scope_denied",403);
   const node=args.node_id===undefined?undefined:allowed().find(n=>n.id===args.node_id);
   if(args.node_id!==undefined&&(!selected()||!node))throw fail("assistant_agent_context_scope_denied",403);
   const row=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
   const config=row?JSON.parse(row.value_json):{};
   data={settings:formatAssistantGenerationSettings({config,loadTemplate,document:original.document,node}),truncated:false};
  }else if(name==="canvas_get_connections"){
   if(!get(args,[]))throw fail("assistant_agent_tool_arguments_invalid",400);
   const ids=new Set(allowed().map(n=>n.id));
   const edges=(original.document.connections??[]).filter(e=>ids.has(e.fromNodeId)&&ids.has(e.toNodeId));
   data={connections:edges.slice(0,40).map(e=>({
    fromNodeId:e.fromNodeId,toNodeId:e.toNodeId,
    ...(typeof e.fromPortId==="string"?{fromPortId:safe(e.fromPortId,128)}:{}),
    ...(typeof e.toPortId==="string"?{toPortId:safe(e.toPortId,128)}:{})
   })),truncated:edges.length>40};
  }else if(name==="task_read_history"){
   if(!get(args,["limit"])||args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>8))
    throw fail("assistant_agent_tool_arguments_invalid",400);
   const count=args.limit??5;
   const turns=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' ORDER BY seq DESC LIMIT 80").all(taskId);
   const statements=[];
   for(const row of turns){
    const t=JSON.parse(row.payload_json);
    if(t.messageId===turnMessageId||!mayRepeatTurn(original.policy,t.contextPolicy))continue;
    statements.push({messageId:t.messageId,excerpt:safe(t.preview,160)});
    if(statements.length===count)break;
   }
   const steps=db.prepare("SELECT kind,status,receipt_trust FROM assistant_task_steps WHERE task_id=? ORDER BY plan_version DESC,ordinal DESC LIMIT 10").all(taskId);
   data={turns:statements,steps:steps.map(st=>({
    kind:st.kind,status:st.status,
    committed:st.receipt_trust==="server_committed"}))};
  }else if(name==="creative_search"){
   if(!get(args,["kind","query"])||
    args.query!==undefined&&(typeof args.query!=="string"||args.query.length>80)||
    args.kind!==undefined&&!["character","story","scene","style"].includes(args.kind))
    throw fail("assistant_agent_tool_arguments_invalid",400);
   const items=[];
   if(!args.kind||args.kind==="character"){
    const context=discoverAssistantCreativeCharacters(db,{projectId,taskId,turnMessageId});
    for(const group of context.groups)for(const c of group.characters)
     items.push({kind:"character",title:c.title,sourceRef:c.sourceRef,
      provenance:c.provenance,excerpt:safe(c.excerpt,260)});
   }
   if(args.kind!=="character"){
    const context=discoverAssistantCreativeMaterials(db,{projectId,taskId,turnMessageId,
     ...(args.kind?{kinds:[args.kind]}:{})});
    for(const m of context.materials)items.push({kind:m.kind,title:m.title,sourceRef:m.sourceRef,
     provenance:m.provenance,excerpt:safe(m.excerpt,260)});
   }
   const term=args.query?.toLocaleLowerCase();
   const matches=items.filter(m=>!args.kind||args.kind===m.kind)
    .filter(m=>!term||(m.title+" "+m.excerpt).toLocaleLowerCase().includes(term));
   data={matches:matches.slice(0,8),truncated:matches.length>8};
  }else throw fail("assistant_agent_tool_unauthorized");
  // Never blindly truncate JSON into invalid UTF-8/JSON; fail closed.
  const encode=()=>JSON.stringify({callId,ok:true,data,sourceRevision:original.revision});
  let value=encode(),bytes=Buffer.byteLength(value,"utf8");
  // Port-bearing edges vary in size. Return complete records within both
  // budgets rather than rejecting an otherwise readable connection overview.
  if(name==="canvas_get_connections"){
   while(bytes>budget&&data.connections.length){
    data.connections.pop();data.truncated=true;
    value=encode();bytes=Buffer.byteLength(value,"utf8");
   }
  }
  if(name==="canvas_get_generation_settings"){
   while(bytes>budget&&data.settings.length){
    data.settings.pop();data.truncated=true;
    value=encode();bytes=Buffer.byteLength(value,"utf8");
   }
  }
  if(name==="canvas_read_nodes"&&args.offset!==undefined){
   while(bytes>budget&&data.nodes[0].content){
    const item=data.nodes[0];
    item.content=pageText(item.content,0,Math.floor(Buffer.byteLength(item.content,"utf8")/2));
    data.nextOffset=data.endOffset=data.offset+item.content.length;
    value=encode();bytes=Buffer.byteLength(value,"utf8");
   }
   if(data.nextOffset===data.offset&&data.nextOffset!==null)throw fail("assistant_agent_read_budget_exceeded",413);
  }
  if(bytes>MAX_RESULT_BYTES||totalBytes+bytes>MAX_PER_RUN_BYTES)
   throw fail("assistant_agent_read_budget_exceeded",413);
  totalBytes+=bytes;
  usedIds.set(callId,fingerprint);
  const event={runId,requestId,turnMessageId,callId,round,name:definition.name,
   argsDigest:sha(args),resultDigest:sha(data),resultBytes:bytes,
   sourceRevision:original.revision};
  // Persist only hashes + metadata, never the full private tool output.
  writeTransaction(db,()=>{
   const exists=db.prepare("SELECT 1 FROM assistant_task_events WHERE task_id=? AND kind='agent_read_tool_completed' AND json_extract(payload_json,'$.requestId')=? AND json_extract(payload_json,'$.callId')=? LIMIT 1").get(taskId,requestId,callId);
   if(exists)throw fail("assistant_agent_tool_replayed",409);
   db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'agent_read_tool_completed',?,?)")
    .run(taskId,stableJson(event),Date.now());
  });
  readCalls.push({callId,name:definition.name,round,resultBytes:bytes});
  references.push({callId,kind:definition.name,nodeIds:name==="canvas_read_nodes"?data.nodes.map(node=>node.id):[]});
  return value;
 }
 return {runId,definitions:assistantReadToolDefinitions,invoke,check,recordRound,
  get references(){return [...references]},
  get calls(){return [...readCalls]},get bytes(){return totalBytes}};
}
