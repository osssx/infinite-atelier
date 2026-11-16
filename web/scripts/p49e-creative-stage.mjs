/** P4.9e: isolated, durable, one-stage-per-invocation creative evaluation.
 * A model POST is never initiated by init, inspect, approval, or reopening
 * an existing stage. Every new paid stage requires --ack-cost again.
 */
import {DatabaseSync} from "node:sqlite";
import {randomUUID,createHash} from "node:crypto";
import {mkdtempSync,existsSync,realpathSync,lstatSync,openSync,closeSync,unlinkSync,writeFileSync,renameSync} from "node:fs";
import {join,basename,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject} from "../server/backend/projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,changeAssistantTaskSemantic,linkAssistantTaskToChat} from "../server/backend/assistant-tasks.mjs";
import {createAssistantChatService} from "../server/backend/assistant-chat.mjs";
import {listAssistantModelCalls} from "../server/backend/assistant-model-calls.mjs";
import {recoverAssistantModelCallsAtStartup} from "../server/backend/assistant-model-calls.mjs";
import {createPinnedOpenAiCompatCall} from "../server/backend/openai-compat-endpoints.mjs";
import {buildApp} from "../server/backend/app.mjs";
import {P49B_CASE,reviewP49BCreativeActions} from "../server/backend/assistant-creative-consistency.mjs";

const prefix="infinite-atelier-p49e-", dbName="acceptance.sqlite";
const fingerprint=x=>createHash("sha256").update(x).digest("hex");
const fail=code=>Object.assign(new Error(code),{code});
const publicError=x=>typeof x==="string"&&/^p49e_[a-z0-9_]{2,100}$/.test(x)?x:"p49e_execution_failed";
const frozenPolicy={includeContext:false,scope:"selection",includedIds:[]};
const stages=P49B_CASE.stages;
const stageIndex=id=>stages.findIndex(x=>x.id===id);
const configFingerprint=config=>fingerprint(JSON.stringify({
 provider:config.provider,model:config.model,baseUrl:config.baseUrl,
 channelId:config.channelId??"test-only",credentialVersion:config.credentialVersion??"none",mode:config.mode
}));
function guardConfig(config,{paid=false}={}){
 if(!config||!["mock","live"].includes(config.mode)||typeof config.model!=="string"||
  typeof config.baseUrl!=="string"||typeof config.provider!=="string")throw fail("p49e_config_invalid");
 if(config.mode==="live"&&paid&&config.ackCost!==true)
  throw fail("p49e_paid_stage_requires_explicit_ack");
}
function validDirectory(directory){
 const canonical=realpathSync(directory),tmp=realpathSync(tmpdir());
 // A single direct child of the OS temp directory only; never open the user's
 // working project SQLite or arbitrary files passed through --dir.
 if(dirname(canonical).toLowerCase()!==tmp.toLowerCase()||
  !basename(canonical).startsWith(prefix)||lstatSync(canonical).isSymbolicLink())
  throw fail("p49e_run_path_forbidden");
 const file=join(canonical,dbName);
 if(!existsSync(file)||lstatSync(file).isSymbolicLink())throw fail("p49e_run_database_missing");
 return {directory:canonical,file};
}
const open=(directory,readOnly=true)=>{
 const {directory:canonical,file}=validDirectory(directory);
 return {db:new DatabaseSync(file,{readOnly}),directory:canonical};
};
const lock=directory=>{
 let fd;
 try{fd=openSync(join(directory,".single-writer.lock"),"wx")}catch{throw fail("p49e_run_locked")}
 return ()=>{closeSync(fd);unlinkSync(join(directory,".single-writer.lock"))};
};
const autoApprovalEnabled=db=>{
 const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='p49e_auto_approval'").get();
 return Boolean(table&&db.prepare("SELECT enabled FROM p49e_auto_approval WHERE singleton=1").get()?.enabled===1);
};
const canAutoApprove=(db,state,index)=>{
 const row=db.prepare("SELECT * FROM p49e_stages WHERE stage_index=?").get(index);
 if(!row||row.status!=="review_pending"||
  !/^[a-f0-9]{64}$/.test(row.result_digest??""))return false;
 if(index>0){
  const prior=db.prepare("SELECT status FROM p49e_stages WHERE stage_index=?").get(index-1);
  if(!["approved_for_continuation","auto_approved_for_continuation"].includes(prior?.status))
   return false;
 }
 let review;
 try{review=JSON.parse(row.review_json)}catch{return false}
 const expected=stages[index];
 if(!expected||review?.stageId!==expected.id||review.expectedCount!==expected.count||
  review.actualCount!==expected.count||review.objectiveChecksPassed!==true||
  !Array.isArray(review.flags)||review.flags.length!==0||
  !Array.isArray(review.cards)||review.cards.length!==expected.count||
  review.cards.some(card=>card?.truncated!==false))return false;
 const modelAudit=modelCalls(db,state,row.request_id);
 if(modelAudit.length===0||modelAudit.some(call=>call.status!=="succeeded"))return false;
 const project=getProject(db,state.project_id);
 if(project.revision!==1||project.document.nodes.length!==1||
  project.document.nodes[0].metadata.content!=="PRIVATE_P49E_NOT_AUTHORIZED"||
  db.prepare("SELECT COUNT(*) n FROM jobs").get().n!==0)return false;
 return true;
};
/** Auto-approval only permits a verified AI draft to continue as UNCONFIRMED
 * context. It never updates confirmed Task facts or a Canvas Graph.
 */
function autoApproveEligibleStage(db,state,index){
 if(!autoApprovalEnabled(db)||!canAutoApprove(db,state,index))return false;
 return db.prepare("UPDATE p49e_stages SET status='auto_approved_for_continuation' WHERE stage_index=? AND status='review_pending'").run(index).changes===1;
}

function metadata(db){
 const state=db.prepare("SELECT * FROM p49e_state WHERE singleton=1").get();
 if(!state||state.scenario!==P49B_CASE.id)throw fail("p49e_run_identity_invalid");
 return state;
}
const modelCalls=(db,state,requestId)=>listAssistantModelCalls(db,{
 projectId:state.project_id,taskId:state.task_id,limit:200
}).calls.filter(x=>x.requestId===requestId).sort((a,b)=>a.index-b.index).map(x=>({
 kind:x.kind,status:x.status,errorCode:x.errorCode??null,
 diagnostic:x.diagnostic??null,
 elapsedMs:x.finishedAt===null?null:Math.max(0,x.finishedAt-x.startedAt)
}));
function materialize(db,state,directory,{persist=true}={}){
 const stageRows=db.prepare("SELECT * FROM p49e_stages ORDER BY stage_index").all();
 const all=stageRows.map(row=>({
  stageId:row.stage_id,index:row.stage_index,status:row.status,
  digest:row.result_digest,modelCalls:modelCalls(db,state,row.request_id),
  review:row.review_json?JSON.parse(row.review_json):null,
  failureCode:row.error_code??null
 }));
 const pj=getProject(db,state.project_id);
 const summary={version:1,scenario:state.scenario,mode:state.mode,
  model:state.model,provider:state.provider,
  graphUnchanged:pj.revision===1&&pj.document.nodes.length===1&&
   pj.document.nodes[0].metadata.content==="PRIVATE_P49E_NOT_AUTHORIZED",
  jobs:db.prepare("SELECT COUNT(*) n FROM jobs").get().n,
  stages:all,autoApproveDrafts:autoApprovalEnabled(db),
  semanticVerdict:"human_review_required",
  boundary:"isolated_test_only_not_task_completion"};
 // Atomic replace to avoid a half-written summary on process crash.
 if(persist){
  const tmp=join(directory,"summary-"+randomUUID()+".json");
  writeFileSync(tmp,JSON.stringify(summary,null,2),"utf8");
  renameSync(tmp,join(directory,"summary.json"));
 }
 return summary;
}
function setup(db,config){
 initializeSchema(db);
 db.exec("CREATE TABLE p49e_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),scenario TEXT NOT NULL, mode TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, config_fingerprint TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL)");
 db.exec("CREATE TABLE p49e_stages(stage_index INTEGER PRIMARY KEY,stage_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,result_digest TEXT,review_json TEXT,error_code TEXT)");
 db.exec("CREATE TABLE p49e_auto_approval(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),enabled_at INTEGER)");
 db.prepare("INSERT INTO p49e_auto_approval(singleton,enabled) VALUES(1,0)").run();
 const projectId="p49e-"+randomUUID();
 createProject(db,{id:projectId,document:{title:"P4.9e isolated test",
  nodes:[{id:"private",type:"text",title:"not-authorized",
   metadata:{content:"PRIVATE_P49E_NOT_AUTHORIZED"}}],connections:[]}});
 const task=createAssistantTask(db,{projectId,chatSessionId:"initial-chat",
  rootMessageId:"initial-root",requestId:"create",
  originalRequest:P49B_CASE.originalRequest,contextPolicy:frozenPolicy}).task;
 let revision=0;
 const confirm=(operation,text)=>changeAssistantTaskSemantic(db,{
  projectId,taskId:task.id,requestId:"confirm-"+(++revision),
  expectedRevision:revision-1,operation,text,confirmed:true,contextPolicy:frozenPolicy
 });
 confirm("set_goal",P49B_CASE.confirmedGoal);
 for(const note of P49B_CASE.confirmedNotes)confirm("add_constraint",note);
 db.prepare("INSERT INTO p49e_state VALUES(1,?,?,?,?,?,?,?)").run(
  P49B_CASE.id,config.mode,config.provider,config.model,configFingerprint(config),projectId,task.id);
}
export function initP49E(config,{parent=tmpdir()}={}){
 guardConfig(config);
 if(resolve(parent).toLowerCase()!==resolve(tmpdir()).toLowerCase())
  throw fail("p49e_non_temp_root_forbidden");
 const directory=mkdtempSync(join(parent,prefix));
 const db=new DatabaseSync(join(directory,dbName));
 try{setup(db,config);const status=materialize(db,metadata(db),directory);
  return {directory,status};
 }finally{db.close()}
}
export function inspectP49E(directory){
 const conn=open(directory,true);
 try{return materialize(conn.db,metadata(conn.db),conn.directory,{persist:false})}
 finally{conn.db.close()}
}
const mockProvider=(stage,index)=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"未审核的创作草案",
  actions:stage.titles.map((title,i)=>({
   type:"create_text",ref:stage.id+"_"+i,title,
   content:title+"：小兔嘟嘟有雪白毛色、蓝色斗篷，兔妈妈穿棕色围裙且米白毛色，小龟慢慢有橄榄绿龟壳，三人沿森林、石桥、草地的旅程寻找星星，经过暴雨救助迷路小动物，最后在观星草地团聚。"
  }))
 })}}]}),{status:200});

export async function executeP49EStage(directory,config,stageId,{vaultOverride,mockUpstreamCall}={}){
 guardConfig(config,{paid:true});
 if(vaultOverride&&(config.mode!=="live"||typeof vaultOverride.get!=="function"||
  typeof vaultOverride.withSecretVersion!=="function"))
  throw fail("p49e_live_vault_invalid");
 if(config.mode==="live"&&!vaultOverride&&typeof config.secret!=="string")
  throw fail("p49e_live_secret_required");
 if(mockUpstreamCall&&(config.mode!=="mock"||typeof mockUpstreamCall!=="function"))
  throw fail("p49e_mock_in_live_forbidden");
 const index=stageIndex(stageId);
 if(index<0)throw fail("p49e_unknown_stage");
 const conn=open(directory,false);
 let release;
 try{release=lock(conn.directory)}catch(error){conn.db.close();throw error}
 const db=conn.db;
 let app;
 try{
  const state=metadata(db);
  if(state.config_fingerprint!==configFingerprint(config))throw fail("p49e_frozen_model_changed");
  if(db.prepare("SELECT 1 FROM p49e_stages WHERE stage_index=?").get(index))
   throw fail("p49e_stage_already_reserved_no_replay");
  if(index>0){
   const prior=db.prepare("SELECT status FROM p49e_stages WHERE stage_index=?").get(index-1);
   if(!["approved_for_continuation","auto_approved_for_continuation"].includes(prior?.status))
    throw fail("p49e_prior_human_approval_required");
  }
  const stage=stages[index],requestId="provider-"+stage.id;
  const messageId="user-"+stage.id;
  // Durable reservation BEFORE appending the turn/starting Provider POST.
  // If killed in the middle, next invocation sees the reservation and fails
  // closed instead of retrying with a new requestId.
  db.prepare("INSERT INTO p49e_stages(stage_index,stage_id,status,request_id,message_id) VALUES(?,?,'reserved',?,?)")
   .run(index,stage.id,requestId,messageId);
  if(index===2)linkAssistantTaskToChat(db,{
   projectId:state.project_id,taskId:state.task_id,requestId:"link-session",
   chatSessionId:"continued-chat"});
  appendAssistantTaskTurn(db,{projectId:state.project_id,taskId:state.task_id,
   requestId:"append-"+stage.id,messageId,text:stage.request,contextPolicy:frozenPolicy});
  const vault=vaultOverride??{
   get:()=>({provider:config.provider,hasKey:true,keyVersion:"fixture"}),
   withSecretVersion:(_v,fn)=>fn(Buffer.from(config.secret??"test-only"))
  };
  const pinned=createPinnedOpenAiCompatCall();
  let count=0;
  const upstream=async(url,options)=>{
   const payload=JSON.parse(options.body),sys=payload.messages?.[0]?.content??"";
   if(!sys.includes(P49B_CASE.confirmedGoal)||
    P49B_CASE.confirmedNotes.some(n=>!sys.includes(n))||
    options.body.includes("PRIVATE_P49E_NOT_AUTHORIZED")||
    index>0&&!sys.includes("历史 AI 创作草案"))
    throw fail("p49e_context_or_provenance_failed");
   if(++count>2)throw fail("p49e_one_stage_post_budget_exceeded");
   return config.mode==="mock"?
    mockUpstreamCall?mockUpstreamCall({stage,index,count}):mockProvider(stage,index):
    pinned(url,options);
  };
  const service=createAssistantChatService({vault,compatibleUpstreamCall:upstream,
   maxRetries:0,requestTimeoutMs:120000});
  app=buildApp({db,authorize:()=>true,assistantChat:service});
  // Persistent audit is written by the existing Task model-call coordinator.
  db.prepare("UPDATE p49e_stages SET status='submitted' WHERE stage_index=?").run(index);
  const response=await app.inject({method:"POST",
   url:"/api/v1/projects/"+state.project_id+"/assistant/chat",
   payload:{channelId:config.channelId??"temporary-channel",provider:config.provider,
    baseUrl:config.baseUrl,model:config.model,canvasActions:true,
    messages:[{role:"user",content:stage.request}],
    task:{taskId:state.task_id,turnMessageId:messageId,requestId}}});
  const body=response.json();
  if(response.statusCode!==200){
   const history=modelCalls(db,state,requestId);
   const unknown=history.some(c=>c.status==="needs_reconcile"||c.status==="submitting");
   db.prepare("UPDATE p49e_stages SET status=?,error_code=? WHERE stage_index=?")
    .run(unknown?"needs_reconcile":"rejected",
     /^assistant_[a-z0-9_]{2,80}$/.test(body.code??"")?body.code:"p49e_opaque_error",index);
  }else{
   const review=reviewP49BCreativeActions(stage,body.actions??[]);
   const digest=fingerprint(JSON.stringify(body.actions??[]));
   db.prepare("UPDATE p49e_stages SET status='review_pending',result_digest=?,review_json=? WHERE stage_index=?")
    .run(digest,JSON.stringify(review),index);
   autoApproveEligibleStage(db,state,index);
  }
  const status=materialize(db,state,conn.directory);
  return {directory:conn.directory,stageId,status,providerPosts:count};
 }finally{
  await app?.close();db.close();release();
 }
}
/** User opt-in for this *isolated run only*: safe draft checks may grant
 * continuing-context permission without waiting for another manual approval.
 * No Provider POST, no user_confirmed Task fact mutation, no Canvas commit.
 */
/** Re-score a successful, already cached creative response after a validator
 * adjustment. This never calls the Provider, creates a Task command, or
 * changes the immutable response content. Only a former title-alias flag is
 * eligible to be cleared; any other flag requires separate human review.
 */
export function recheckP49EStageFromCache(directory,stageId){
 const index=stageIndex(stageId);
 if(index<0)throw fail("p49e_unknown_stage");
 const conn=open(directory,false);
 let release;
 try{release=lock(conn.directory)}catch(error){conn.db.close();throw error}
 try{
  const db=conn.db,state=metadata(db);
  const row=db.prepare("SELECT * FROM p49e_stages WHERE stage_index=?").get(index);
  if(row?.status!=="review_pending"||!/^[a-f0-9]{64}$/.test(row.result_digest??""))
   throw fail("p49e_recheck_stage_not_pending");
  let previous;
  try{previous=JSON.parse(row.review_json)}catch{throw fail("p49e_recheck_review_invalid")}
  if(!Array.isArray(previous?.flags)||previous.flags.length===0||
   previous.flags.some(item=>item?.code!=="expected_title_missing"))
   throw fail("p49e_recheck_requires_title_only_flags");
  const calls=modelCalls(db,state,row.request_id);
  if(calls.length===0||calls.some(call=>call.status!=="succeeded"))
   throw fail("p49e_recheck_upstream_not_confirmed");
  const command=db.prepare("SELECT status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
   .get(state.project_id,row.request_id);
  if(command?.status!=="completed")throw fail("p49e_recheck_cached_response_missing");
  let response;
  try{response=JSON.parse(command.response_json)}catch{throw fail("p49e_recheck_cached_response_invalid")}
  if(!Array.isArray(response?.actions)||
   fingerprint(JSON.stringify(response.actions))!==row.result_digest)
   throw fail("p49e_recheck_digest_mismatch");
  const current=reviewP49BCreativeActions(stages[index],response.actions);
  if(current.cards.length!==previous.cards?.length||
   current.cards.some((card,i)=>card.digest!==previous.cards[i]?.digest))
   throw fail("p49e_recheck_content_changed");
  db.prepare("UPDATE p49e_stages SET review_json=? WHERE stage_index=? AND status='review_pending'")
   .run(JSON.stringify(current),index);
  const autoApproved=autoApproveEligibleStage(db,state,index);
  return {rechecked:stageId,autoApproved,
   resolvedTitleFlags:previous.flags.length-current.flags.filter(f=>f.code==="expected_title_missing").length,
   status:materialize(db,state,conn.directory)};
 }finally{conn.db.close();release()}
}
export function enableP49EAutoApproval(directory){
 const conn=open(directory,false);
 let release;
 try{release=lock(conn.directory)}catch(error){conn.db.close();throw error}
 try{
  const db=conn.db,state=metadata(db);
  // Older P4.9e isolated runs predate this optional settings table.
  db.exec("CREATE TABLE IF NOT EXISTS p49e_auto_approval(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),enabled_at INTEGER)");
  db.prepare("INSERT INTO p49e_auto_approval(singleton,enabled,enabled_at) VALUES(1,1,?) ON CONFLICT(singleton) DO UPDATE SET enabled=1,enabled_at=excluded.enabled_at")
   .run(Date.now());
  const approved=[];
  for(const row of db.prepare("SELECT stage_index,stage_id FROM p49e_stages ORDER BY stage_index").all()){
   if(autoApproveEligibleStage(db,state,row.stage_index))approved.push(row.stage_id);
  }
  return {approved,status:materialize(db,state,conn.directory)};
 }finally{conn.db.close();release()}
}

export function approveP49EStage(directory,stageId,digest){
 const index=stageIndex(stageId);
 if(index<0||!/^[a-f0-9]{64}$/.test(digest??""))throw fail("p49e_approval_invalid");
 const conn=open(directory,false);
 let release;
 try{release=lock(conn.directory)}catch(error){conn.db.close();throw error}
 try{
  const state=metadata(conn.db);
  const stage=conn.db.prepare("SELECT * FROM p49e_stages WHERE stage_index=?").get(index);
  if(stage?.status!=="review_pending"||stage.result_digest!==digest)
   throw fail("p49e_approval_requires_matching_evidence");
  // This approves the DRAFT for use as unconfirmed creative context. It does
  // NOT mark model additions as user-confirmed facts, or authorize Graph ops.
  conn.db.prepare("UPDATE p49e_stages SET status='approved_for_continuation' WHERE stage_index=?")
   .run(index);
  return materialize(conn.db,state,conn.directory);
 }finally{conn.db.close();release()}
}
/** Local-only crash reconciliation. This function NEVER creates Task commands,
 * calls a Provider or retries an existing stage. Recovering a cached,
 * completed command rehydrates the report from its immutable SQLite result.
 */
export function recoverP49E(directory){
 const conn=open(directory,false),db=conn.db;
 let release;
 try{release=lock(conn.directory)}catch(error){db.close();throw error}
 try{
  const state=metadata(db);
  recoverAssistantModelCallsAtStartup(db);
  const rows=db.prepare("SELECT * FROM p49e_stages WHERE status IN ('reserved','submitted') ORDER BY stage_index").all();
  for(const row of rows){
   const command=db.prepare("SELECT status,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?")
    .get(state.project_id,row.request_id);
   if(command?.status==="completed"){
    let response;
    try{response=JSON.parse(command.response_json)}catch{response=null}
    if(response&&Array.isArray(response.actions)){
     const stage=stages[row.stage_index];
     const digest=fingerprint(JSON.stringify(response.actions));
     const review=reviewP49BCreativeActions(stage,response.actions);
     db.prepare("UPDATE p49e_stages SET status='review_pending',result_digest=?,review_json=? WHERE stage_index=?")
      .run(digest,JSON.stringify(review),row.stage_index);
     // Restoring a completed, locally cached model reply can honor a
     // previously enabled auto-continuation policy. Never issue a new POST.
     autoApproveEligibleStage(db,state,row.stage_index);
     continue;
    }
   }
   const history=modelCalls(db,state,row.request_id);
   const unknown=command?.status==="needs_reconcile"||
    history.some(call=>call.status==="submitting"||call.status==="needs_reconcile");
   db.prepare("UPDATE p49e_stages SET status=?,error_code=? WHERE stage_index=?")
    .run(unknown?"needs_reconcile":"held_for_manual_inspection",
     unknown?"p49e_remote_outcome_unknown":"p49e_no_recoverable_model_response",
     row.stage_index);
  }
  return materialize(db,state,conn.directory);
 }finally{db.close();release()}
}
/** Exports P4.9c-compatible evidence only when all four isolated model
 * stages succeeded. The seven-dimension human score sheet remains separate.
 * Draft approval for continuation never becomes Task completion approval.
 */
export function exportP49EReviewSource(directory){
 const {directory:canonical,file}=validDirectory(directory);
 const db=new DatabaseSync(file,{readOnly:true});
 let summary;
 try{summary=materialize(db,metadata(db),canonical,{persist:false})}
 finally{db.close()}
 if(summary.stages.length!==4||!summary.graphUnchanged||summary.jobs!==0||
  summary.stages.slice(0,3).some(s=>!["approved_for_continuation","auto_approved_for_continuation"].includes(s.status))||
  !["review_pending","approved_for_continuation","auto_approved_for_continuation"].includes(summary.stages[3].status)||
  summary.stages.some(s=>!s.review||s.modelCalls.some(c=>c.status!=="succeeded")))
  throw fail("p49e_complete_review_evidence_required");
 const report={schemaVersion:1,scenario:summary.scenario,mode:summary.mode,
  provider:summary.provider,model:summary.model,
  semanticVerdict:"human_review_required",
  executionStatus:"completed_pending_human_review",
  graphUnchanged:summary.graphUnchanged,jobCount:summary.jobs,
  stages:summary.stages.map(s=>({...s.review,modelCalls:s.modelCalls})),
  warnings:["阶段继续授权仅允许模型草案作为未确认上下文；不得视为用户已确认的人物事实或 Task 完成。"]};
 const destination=join(canonical,"p49e-human-review-source.json");
 writeFileSync(destination,JSON.stringify(report,null,2),{flag:"wx",encoding:"utf8"});
 return {reportPath:destination,stages:report.stages.length,
  mode:report.mode,semanticVerdict:report.semanticVerdict};
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===process.argv[1].toLowerCase()){
 const args=process.argv.slice(2);
 const flag=key=>args.indexOf(key),value=key=>{const i=flag(key);return i>=0?args[i+1]:undefined};
 try{
  if(args.join(" ")==="--init --mock"){
   const result=initP49E({mode:"mock",provider:"openai_compatible",model:"p49e-mock",
    baseUrl:"http://127.0.0.1:8188/v1"});
   console.log("P49E_INIT",JSON.stringify({directory:result.directory,mode:"mock",stages:0}));
  }else if(flag("--status")>=0&&value("--dir")){
   const result=inspectP49E(value("--dir"));
   console.log("P49E_STATUS",JSON.stringify({mode:result.mode,model:result.model,
    stages:result.stages.map(s=>({stageId:s.stageId,status:s.status,digest:s.digest,
     diagnostic:s.modelCalls?.at(-1)?.diagnostic}))}));
  }else if(flag("--export")>=0&&value("--dir")){
   const result=exportP49EReviewSource(value("--dir"));
   console.log("P49E_REVIEW_EXPORT",JSON.stringify(result));
  }else if(flag("--recover")>=0&&value("--dir")){
   const result=recoverP49E(value("--dir"));
   console.log("P49E_RECOVER",JSON.stringify({stages:result.stages.map(s=>({stageId:s.stageId,status:s.status,diagnostic:s.modelCalls.at(-1)?.diagnostic??null})),graphUnchanged:result.graphUnchanged}));
  }else if(flag("--recheck")>=0&&value("--dir")){
   const result=recheckP49EStageFromCache(value("--dir"),value("--recheck"));
   console.log("P49E_RECHECK",JSON.stringify({stageId:result.rechecked,
    autoApproved:result.autoApproved,resolvedTitleFlags:result.resolvedTitleFlags,
    status:result.status.stages.at(-1)?.status,
    semanticVerdict:result.status.semanticVerdict,
    modelPosts:0,graphUnchanged:result.status.graphUnchanged}));
  }else if(flag("--auto-approve")>=0&&value("--dir")){
   const {approved,status}=enableP49EAutoApproval(value("--dir"));
   console.log("P49E_AUTO_APPROVAL",JSON.stringify({enabled:status.autoApproveDrafts,
    approved,stages:status.stages.map(s=>({stageId:s.stageId,status:s.status})),
    semanticVerdict:status.semanticVerdict,boundary:status.boundary}));
  }else if(flag("--approve")>=0&&value("--dir")&&value("--digest")){
   const result=approveP49EStage(value("--dir"),value("--approve"),value("--digest"));
   console.log("P49E_APPROVAL",JSON.stringify({status:result.stages.at(-1).status,
    boundary:result.boundary}));
  }else if(flag("--stage")>=0&&flag("--mock")>=0&&value("--dir")){
   const config={mode:"mock",provider:"openai_compatible",model:"p49e-mock",
    baseUrl:"http://127.0.0.1:8188/v1"};
   const result=await executeP49EStage(value("--dir"),config,value("--stage"));
   console.log("P49E_STAGE",JSON.stringify({stageId:result.stageId,
    status:result.status.stages.at(-1).status,providerPosts:result.providerPosts,
    digest:result.status.stages.at(-1).digest,
    directory:result.directory}));
  }else throw fail("p49e_usage_invalid");
 }catch(error){
  console.error("P49E_ERROR",publicError(error?.code));
  process.exitCode=2;
 }
}
