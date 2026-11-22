/** Task-scoped, strictly read-only Tool Registry for P4.2a.
 * Canonical names use dotted namespaces; Provider names use underscores.
 * The sole executable write path remains approved Task Step/Executor.
 */
import {canvasDramaAssetFields,canvasTextContentPatch,isAssistantDramaNodeType,readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";
import {createHash} from "node:crypto";
import {hydrateCreativeDocument} from "./creative-payloads.mjs";
import {readPagedDramaScope} from "./drama-scoped-storage.mjs";
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
function redactDramaFields(value){
 if(Array.isArray(value))return value.map(redactDramaFields);
 if(plain(value))return Object.fromEntries(Object.entries(value).map(([key,field])=>[key,redactDramaFields(field)]));
 return safe(value,Infinity,{preserveFormatting:true});
}
function canvasNodeBody(node,{redact=true,version}={}){
 const fields=isAssistantDramaNodeType(node.type)?
  version==="confirmed"?["dramaConfirmed"]:version==="draft"?["dramaDraft"]:
  node.type==="drama:source"?["dramaDraft","content","dramaConfirmed"]:["dramaDraft","dramaConfirmed","content"]:
  node.type==="text"?["content"]:[];
 if(!fields.length)return null;
 for(const source of fields){
  const value=node.metadata?.[source];
  if(typeof value==="string"&&(value.trim()||node.type==="drama:source"&&source==="dramaDraft")){
   if(!redact)return {source,content:value};
   const assets=node.type==="drama:assets"?readAssetDraft(value)?.assets:undefined;
   if(node.type==="drama:assets"&&!assets)return {source,content:"",status:"invalid_draft"};
   const content=assets?JSON.stringify({assets:assets.map(asset=>redactDramaFields(canvasDramaAssetFields(asset)))}):
    safe(value,Infinity,{preserveFormatting:true});
   return {source,content,...(!value.trim()?{status:"empty"}:{})};
  }
 }
 return {source:null,content:""};
}
export function describeAssistantReadableCanvasNode(node,version){
 const body=canvasNodeBody(node,{version});
 return {id:node.id,type:node.type,title:safe(node.title,90),
  ...(body?{source:body.source,content:pageText(body.content,0,560),
   ...(body.source===null?{status:"empty"}:body.status?{status:body.status}:{}),
   ...(Buffer.byteLength(body.content)>560?{truncated:true}:{})}:{}),
  ...(typeof node.metadata?.prompt==="string"?{prompt:safe(node.metadata.prompt,500)}:{})};
}
const shotTextFields=["id","episodeId","description","sceneId","sceneVariantId","shotSize","camera","action","dialogue"];
const shotListFields=["characterVariantIds","propIds","keyPropIds","sourceRefs"];
function readStoryboardShot(node,{shot_id,shot_number,episode_id,offset,version}){
 const body=canvasNodeBody(node,{redact:false,version});
 const item={id:node.id,type:node.type,title:safe(node.title,90),source:body.source};
 if(!body.source)return {nodes:[{...item,status:"empty"}]};
 const draft=readStoryboardDraft(body.content);
 if(!draft)return {nodes:[{...item,status:"invalid_storyboard"}]};
 const groups=new Map();
 for(const shot of draft.shots){
  const group=groups.get(shot.episodeId)??[];
  group.push(shot);
  groups.set(shot.episodeId,group);
 }
 const matches=[];
 for(const [episodeId,shots] of groups){
  if(episode_id!==undefined&&episodeId!==episode_id)continue;
  shots.sort((a,b)=>a.order-b.order);
  if(shot_id!==undefined){
   const index=shots.findIndex(shot=>shot.id===shot_id);
   if(index!==-1)matches.push({shot:shots[index],number:index+1});
  }else if(shots[shot_number-1])matches.push({shot:shots[shot_number-1],number:shot_number});
 }
 if(!matches.length)return {nodes:[{...item,status:"shot_not_found"}]};
 const clean=value=>safe(value,Infinity,{preserveFormatting:true});
 if(matches.length>1)return {nodes:[{...item,status:"ambiguous_shot",
  candidates:matches.slice(0,8).map(({shot})=>({episodeId:safe(shot.episodeId,90),shotId:safe(shot.id,90)})),
  moreMatches:matches.length>8}]};
 const {shot,number}=matches[0];
 const data={order:shot.order};
 for(const key of shotTextFields)if(shot[key]!==undefined)data[key]=clean(shot[key]);
 for(const key of shotListFields)if(shot[key]!==undefined)data[key]=shot[key].map(clean);
 const match={...item,shotId:safe(shot.id,128),episodeId:safe(shot.episodeId,128),shotNumber:number};
 const full={nodes:[{...match,shot:data}]};
 if(offset===undefined&&Buffer.byteLength(JSON.stringify(full))<=MAX_RESULT_BYTES-256)return full;
 return pageNodeBody(match,JSON.stringify(data),offset??0);
}
function pageNodeBody(item,text,offset){
 if(offset>text.length||(text.charCodeAt(offset)&0xfc00)===0xdc00)
  throw fail("assistant_agent_tool_arguments_invalid",400);
 item.content=pageText(text,offset,2400);
 const result={nodes:[item],offset,endOffset:offset,nextOffset:null};
 while(Buffer.byteLength(JSON.stringify(result))>MAX_RESULT_BYTES-256)
  item.content=pageText(item.content,0,Math.floor(Buffer.byteLength(item.content)/2));
 result.endOffset=offset+item.content.length;
 result.nextOffset=result.endOffset<text.length?result.endOffset:null;
 return result;
}
const validSelector=value=>typeof value==="string"&&Boolean(value.trim())&&value.length<=256;
function readDramaEntry(node,{asset_id,episode_id,version,offset}){
 const body=canvasNodeBody(node,{redact:false,version});
 const item={id:node.id,type:node.type,title:safe(node.title,90),source:body.source};
 if(!body.source)return {nodes:[{...item,status:"empty"}]};
 const draft=asset_id!==undefined?readAssetDraft(body.content):readEpisodeDraft(body.content);
 if(!draft)return {nodes:[{...item,status:"invalid_draft"}]};
 const entry=asset_id!==undefined?draft.assets.find(asset=>asset.id===asset_id):
  draft.episodes.find(episode=>episode.id===episode_id);
 if(!entry)return {nodes:[{...item,status:"entry_not_found"}]};
 // Project only editor fields before redaction. Legacy draft extras may include media metadata.
 const fields=asset_id!==undefined?canvasDramaAssetFields(entry):
  Object.fromEntries(["id","title","synopsis","events","sourceRefs","ending"].map(key=>[key,entry[key]]));
 const data=redactDramaFields(fields);
 const full={nodes:[{...item,[asset_id!==undefined?"asset":"episode"]:data}]};
 if(offset===undefined&&Buffer.byteLength(JSON.stringify(full))<=MAX_RESULT_BYTES-256)return full;
 return pageNodeBody(item,JSON.stringify(data),offset??0);
}
/** Read one authorized, indexed creative entry without hydrating a
 * storyboard/asset/episode body into the Agent process. The frozen Task turn
 * still bounds which nodes can be read. Other request forms use the legacy
 * selected-node reader for precise compatibility (shot_number, arbitrary
 * text pagination, unindexed legacy or malformed drafts).
 */
function tryReadIndexedAgentEntry(db,projectId,byId,args){
 if(!Array.isArray(args.node_ids)||args.node_ids.length!==1)return null;
 const nodeId=args.node_ids[0];
 if(!validCanvasNodeId(nodeId)||!byId.has(nodeId))
  throw fail("assistant_agent_context_scope_denied",403);
 const node=byId.get(nodeId),ref=node?.metadata?.creativePayloadRef;
 if(!ref)return null;
 const asset=args.asset_id!==undefined&&node.type==="drama:assets"&&
  validSelector(args.asset_id)&&args.episode_id===undefined&&args.shot_id===undefined&&args.shot_number===undefined;
 const episode=args.episode_id!==undefined&&node.type==="drama:episodes"&&
  validSelector(args.episode_id)&&args.asset_id===undefined&&args.shot_id===undefined&&args.shot_number===undefined;
 const shot=args.shot_id!==undefined&&node.type==="drama:storyboard"&&validSelector(args.shot_id)&&
  args.asset_id===undefined&&args.shot_number===undefined&&
  (args.episode_id===undefined||validSelector(args.episode_id));
 if(!asset&&!episode&&!shot)return null;
 if(!get(args,["node_ids","offset","shot_id","episode_id","asset_id","version"])||
  args.version!==undefined&&!["draft","confirmed"].includes(args.version)||
  args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))
  throw fail("assistant_agent_tool_arguments_invalid",400);
 if(ref.nodeId!==nodeId||ref.schemaVersion!==1||
  ["dramaDraft","dramaConfirmed","content"].some(key=>Object.hasOwn(node.metadata??{},key)))
  throw fail("creative_payload_reference_invalid",422);
 const entryId=asset?args.asset_id:episode?args.episode_id:args.shot_id;
 const draft=args.version!=="confirmed",kind=asset?"assets":episode?"episodes":"shots";
 const stage=draft?"draft":"confirmed";
 const pinned=draft?null:node.metadata?.dramaConfirmedVersionId??null;
 // No index -> the original authorized one-node reader handles fenced legacy
 // bodies and old version rows. Never guess a missing authoritative source.
 const state=pinned?db.prepare(`SELECT 1 FROM creative_scope_history_state
   WHERE project_id=? AND node_id=? AND version_id=? AND kind=?`).get(projectId,nodeId,pinned,kind):
  db.prepare(`SELECT 1 FROM creative_scope_index_state
   WHERE project_id=? AND node_id=? AND stage=? AND kind=?`).get(projectId,nodeId,stage,kind);
 if(!state)return null;
 const page=readPagedDramaScope(db,projectId,nodeId,{draft,entryId,
  ...(shot&&args.episode_id?{episodeId:args.episode_id}:{}),
  limit:1,offset:0,includeReferenceChoices:false});
 const source=draft?db.prepare(`SELECT CASE
   WHEN length(trim(COALESCE(json_extract(payload_json,'$.dramaDraft'),'')))>0 THEN 'dramaDraft'
   WHEN length(trim(COALESCE(json_extract(payload_json,'$.dramaConfirmed'),'')))>0 THEN 'dramaConfirmed'
   WHEN length(trim(COALESCE(json_extract(payload_json,'$.content'),'')))>0 THEN 'content'
   ELSE NULL END AS source FROM creative_node_payloads
   WHERE project_id=? AND node_id=?`).get(projectId,nodeId)?.source:
   "dramaConfirmed";
 const meta={id:nodeId,type:node.type,title:safe(node.title,90),source};
 if(!page.total||!page.entries.length)
  return {nodes:[{...meta,status:source?"entry_not_found":"empty"}]};
 const entry=page.entries[0];
 if(asset||episode){
  const fields=asset?canvasDramaAssetFields(entry):
   Object.fromEntries(["id","title","synopsis","events","sourceRefs","ending"].map(key=>[key,entry[key]]));
  const data=redactDramaFields(fields);
  const full={nodes:[{...meta,[asset?"asset":"episode"]:data}]};
  if(args.offset===undefined&&Buffer.byteLength(JSON.stringify(full))<=MAX_RESULT_BYTES-256)return full;
  return pageNodeBody(meta,JSON.stringify(data),args.offset??0);
 }
 // A shot's UI ordinal means sorted order within its own episode, not its
 // position in the raw persisted array. Compute its rank with indexed JSON1.
 const table=pinned?"creative_scope_history_entries":"creative_scope_entry_index";
 const stageColumn=pinned?"version_id":"stage",stageValue=pinned??stage;
 const rank=db.prepare(`SELECT (
    SELECT COUNT(*) FROM ${table} AS before
     WHERE before.project_id=target.project_id AND before.node_id=target.node_id
      AND before.${stageColumn}=target.${stageColumn} AND before.kind='shots'
      AND before.episode_id=target.episode_id AND
       (CAST(json_extract(before.entry_json,'$.order') AS REAL)<
        CAST(json_extract(target.entry_json,'$.order') AS REAL)
        OR (CAST(json_extract(before.entry_json,'$.order') AS REAL)=
        CAST(json_extract(target.entry_json,'$.order') AS REAL)
        AND before.ordinal<target.ordinal))
   )+1 AS number FROM ${table} AS target
   WHERE target.project_id=? AND target.node_id=? AND target.${stageColumn}=?
    AND target.kind='shots' AND target.entry_id=?`)
  .get(projectId,nodeId,stageValue,entryId);
 if(!rank||!Number.isSafeInteger(rank.number))return null;
 const data={order:entry.order};
 const clean=value=>safe(value,Infinity,{preserveFormatting:true});
 for(const key of shotTextFields)if(entry[key]!==undefined)data[key]=clean(entry[key]);
 for(const key of shotListFields)if(entry[key]!==undefined)data[key]=entry[key].map(clean);
 const match={...meta,shotId:safe(entry.id,128),episodeId:safe(entry.episodeId,128),shotNumber:rank.number};
 const full={nodes:[{...match,shot:data}]};
 if(args.offset===undefined&&Buffer.byteLength(JSON.stringify(full))<=MAX_RESULT_BYTES-256)return full;
 return pageNodeBody(match,JSON.stringify(data),args.offset??0);
}
function readCanvasNodes(byId,args){
 if(!get(args,["node_ids","offset","shot_id","shot_number","episode_id","asset_id","version"])||!Array.isArray(args.node_ids)||
  args.version!==undefined&&!["draft","confirmed"].includes(args.version)||
  args.node_ids.length<1||args.node_ids.length>4||
  args.offset!==undefined&&(args.node_ids.length!==1||!Number.isSafeInteger(args.offset)||args.offset<0)||
  args.node_ids.some(nodeId=>!validCanvasNodeId(nodeId))||new Set(args.node_ids).size!==args.node_ids.length)
  throw fail("assistant_agent_tool_arguments_invalid",400);
 if(args.node_ids.some(nodeId=>!byId.has(nodeId)))throw fail("assistant_agent_context_scope_denied",403);
 const targeted=args.shot_id!==undefined||args.shot_number!==undefined;
 const node=byId.get(args.node_ids[0]);
 if(args.version!==undefined&&args.node_ids.some(nodeId=>!isAssistantDramaNodeType(byId.get(nodeId).type)))
  throw fail("assistant_agent_tool_arguments_invalid",400);
 if(args.asset_id!==undefined||(!targeted&&args.episode_id!==undefined&&node.type==="drama:episodes")){
  if(args.node_ids.length!==1||(args.asset_id!==undefined?
   node.type!=="drama:assets"||!validSelector(args.asset_id)||targeted||args.episode_id!==undefined:
   !validSelector(args.episode_id)))throw fail("assistant_agent_tool_arguments_invalid",400);
  return readDramaEntry(node,args);
 }
 if(targeted||args.episode_id!==undefined){
  if(args.node_ids.length!==1||node.type!=="drama:storyboard"||
   (args.shot_id!==undefined?!validSelector(args.shot_id)||args.shot_number!==undefined:
    !Number.isSafeInteger(args.shot_number)||args.shot_number<1)||
   args.episode_id!==undefined&&!validSelector(args.episode_id))
   throw fail("assistant_agent_tool_arguments_invalid",400);
  return readStoryboardShot(node,args);
 }
 if(args.offset===undefined)
  return {nodes:args.node_ids.map(nodeId=>describeAssistantReadableCanvasNode(byId.get(nodeId),args.version))};
 const body=canvasNodeBody(node,{version:args.version});
 if(!body)throw fail("assistant_agent_tool_arguments_invalid",400);
 return pageNodeBody({id:node.id,type:node.type,title:safe(node.title,90),source:body.source,
  ...(body.source===null?{status:"empty"}:body.status?{status:body.status}:{})},body.content,args.offset);
}

const NODE_READ_ARGUMENT_GUIDANCE="Use node_ids as an array of exact IDs from the authorized canvas references. To read the body, use one ID and offset:0. Continue with the returned nextOffset only when it is a number. For one storyboard, use shot_id or the 1-based shot_number shown in the editor, optionally with episode_id. For a single asset use asset_id, or an episode plan use episode_id. For drama nodes, version can be draft or confirmed; omit it for the effective draft. Prefer targeted reads for individual edits. If ambiguous, ask which episode. For a paged shot, repeat the same selector and pass the returned nextOffset.";

export function recoverCanvasReadArguments(invoke){
 try{return invoke();}
 catch(error){
  if(error?.code!=="assistant_agent_tool_arguments_invalid")throw error;
  return JSON.stringify({ok:false,error:error.code,message:NODE_READ_ARGUMENT_GUIDANCE});
 }
}

export function createCanvasNodeReader(policy,document){
 if(!policy?.includeContext||policy.scope!=="selection")return null;
 const byId=new Map(document.nodes.map(node=>[node.id,node]));
 const selected=new Map([...new Set(policy.includedIds)].slice(0,12).filter(id=>byId.has(id))
  .map(id=>[id,structuredClone(byId.get(id))]));
 if(!selected.size)return null;
 const nodes=[...selected.values()];
 const definition=ASSISTANT_READ_TOOL_REGISTRY.find(item=>item.providerName==="canvas_read_nodes");
 const calls=[],references=[],evidence=[];
 let bytes=0;
 const fallback=()=>JSON.stringify(nodes.map(node=>{
  const body=canvasNodeBody(node);
  if(!body)return {id:node.id,type:node.type,title:safe(node.title,90)};
  const content=pageText(body.content,0,1600);
  return {id:node.id,type:node.type,title:safe(node.title,90),source:body.source,content,
   ...(body.source===null?{status:"empty"}:body.status?{status:body.status}:{}),truncated:content.length<body.content.length};
 })).replace(/</g,"\\u003c");
 const manifest=JSON.stringify(nodes.map(node=>({id:node.id,type:node.type,title:safe(node.title,90)})))
  .replace(/</g,"\\u003c");
 return {evidence,validateDraftActions(actions){
  for(const action of actions){
   if(action.type!=="set_text")continue;
   const type=selected.get(action.nodeId)?.type;
   if((type==="drama:episodes"||type==="drama:storyboard"||type==="drama:assets")&&!canvasTextContentPatch(type,action.content))
    throw Object.assign(Error("assistant_actions_invalid"),{reason:type==="drama:storyboard"?
     "set_text.content must be a JSON string containing a nonempty, valid shots array.":
     type==="drama:assets"?"set_text.content must be a JSON string containing a valid assets array.":
     "set_text.content must be a JSON string containing a nonempty, valid episodes array.",
     userMessage:type==="drama:storyboard"?"模型未能提交完整、有效的分镜草案，画布未修改。":
      type==="drama:assets"?"模型未能提交有效的资产草案，画布未修改。":"模型未能提交完整、有效的剧集草案，画布未修改。"});
  }
 },withContext(context){
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
   evidence.push(output);
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
  description:"Read up to 4 selected nodes. Supports paginated bodies for text, stories, assets, episode plans, and storyboards. "+NODE_READ_ARGUMENT_GUIDANCE,
  parameters:{type:"object",additionalProperties:false,required:["node_ids"],
   properties:{node_ids:{type:"array",minItems:1,maxItems:4,items:{type:"string"}},offset:{type:"integer",minimum:0},shot_id:{type:"string"},
    shot_number:{type:"integer",minimum:1},episode_id:{type:"string"},asset_id:{type:"string"},version:{type:"string",enum:["draft","confirmed"]}}}},
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
 // Read-only model rounds use a compact graph manifest, not all creative bodies.
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
  const hydrateSelected=items=>hydrateCreativeDocument(db,projectId,{nodes:items}).nodes;
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
   const found=allowed().filter(n=>{
    if(String(n.title??"").toLocaleLowerCase().includes(term))return true;
    if(!selected())return false;
    if(typeof n.metadata?.content==="string"&&n.metadata.content.toLocaleLowerCase().includes(term))
     return true;
    const ref=n.metadata?.creativePayloadRef;
    if(!ref)return false;
    if(ref.nodeId!==n.id||ref.schemaVersion!==1)throw fail("creative_payload_reference_invalid",422);
    // Search selected text in SQLite without materializing full creative bodies.
    const match=db.prepare(`SELECT instr(lower(COALESCE(
      json_extract(payload_json,'$.content'),'')),?)>0 AS found
      FROM creative_node_payloads WHERE project_id=? AND node_id=?`)
     .get(term,projectId,n.id);
    if(!match)throw fail("creative_payload_missing",422);
    return !!match.found;
   });
    data={matches:found.slice(0,12).map(n=>({id:n.id,type:n.type,title:safe(n.title,90)})),
    truncated:found.length>12};
  }else if(name==="canvas_read_nodes"){
   if(!selected())throw fail("assistant_agent_context_scope_denied",403);
    const compact=new Map(allowed().map(node=>[node.id,node]));
    // Check the selection before fetching any creative payload, including
    // when a request has invalid IDs or attempts to name an unselected node.
    if(!Array.isArray(args.node_ids)||args.node_ids.length<1||args.node_ids.length>4||
     args.node_ids.some(id=>!validCanvasNodeId(id))||
     new Set(args.node_ids).size!==args.node_ids.length)
     throw fail("assistant_agent_tool_arguments_invalid",400);
    if(args.node_ids.some(id=>!compact.has(id)))
     throw fail("assistant_agent_context_scope_denied",403);
    const indexed=tryReadIndexedAgentEntry(db,projectId,compact,args);
    data=indexed??readCanvasNodes(new Map(hydrateSelected(
     args.node_ids.map(id=>compact.get(id))).map(node=>[node.id,node])),args);
   }else if(name==="canvas_get_generation_settings"){
   if(!get(args,["node_id"])||args.node_id!==undefined&&!validCanvasNodeId(args.node_id))
    throw fail("assistant_agent_tool_arguments_invalid",400);
   if(!original.policy.includeContext)throw fail("assistant_agent_context_scope_denied",403);
   const compactNode=args.node_id===undefined?undefined:allowed().find(n=>n.id===args.node_id);
    const node=compactNode?hydrateSelected([compactNode])[0]:undefined;
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
  if(name==="canvas_read_nodes"&&data.offset!==undefined){
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
