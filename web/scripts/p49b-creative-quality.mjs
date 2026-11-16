/** P4.9b isolated Task + provider quality review. No canvas write or GPU.
 * Default is deterministic mock; actual provider calls require --live --ack-cost
 * and a credential supplied ONLY through P49B_API_KEY in the process env.
 */
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";
import {mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject} from "../server/backend/projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,changeAssistantTaskSemantic,
 linkAssistantTaskToChat} from "../server/backend/assistant-tasks.mjs";
import {createAssistantChatService} from "../server/backend/assistant-chat.mjs";
import {listAssistantModelCalls} from "../server/backend/assistant-model-calls.mjs";
import {createPinnedOpenAiCompatCall} from "../server/backend/openai-compat-endpoints.mjs";
import {buildApp} from "../server/backend/app.mjs";
import {P49B_CASE,reviewP49BCreativeActions} from "../server/backend/assistant-creative-consistency.mjs";

const policy={includeContext:false,scope:"selection",includedIds:[]};
const publicCode=e=>typeof e?.code==="string"&&/^[a-z][a-z0-9_]{1,90}$/.test(e.code)?
 e.code:"p49b_execution_failed";
const usableValue=v=>typeof v==="string"&&v.trim().length>0;
export function parseP49BArgs(argv,env=process.env){
 if(argv.includes("--help"))return {help:true};
 if(argv.some(arg=>!["--mock","--live","--ack-cost"].includes(arg)))throw Error("p49b_unknown_flag");
 if(argv.includes("--live")&&argv.includes("--mock"))throw Error("p49b_mode_conflict");
 const live=argv.includes("--live");
 if(live&&!argv.includes("--ack-cost"))throw Error("p49b_paid_calls_not_acknowledged");
 if(!live&&argv.includes("--ack-cost"))throw Error("p49b_unnecessary_cost_ack");
 if(live&&(!usableValue(env.P49B_API_KEY)||!usableValue(env.P49B_BASE_URL)||
  !usableValue(env.P49B_MODEL)))throw Error("p49b_live_provider_not_configured");
 if(live&&env.P49B_PROVIDER&&env.P49B_PROVIDER!=="openai_compatible")
  throw Error("p49b_only_openai_compatible_live_supported");
 return {mode:live?"live":"mock",ackCost:live,provider:"openai_compatible",
  model:live?env.P49B_MODEL:"p49b-mock",
  baseUrl:live?env.P49B_BASE_URL:"http://127.0.0.1:8188/v1",
  secret:live?env.P49B_API_KEY:"p49b-mock-only"};
}
const mockBody=(stage,index)=>{
 const hint=stage.id==="characters"?"角色毛色服饰与好友关系清晰。":
  stage.id==="scenes"?"场景空间从森林小径通往石桥与草地。":
  stage.id==="storyboard"?"镜头交代景别、摄影机运动与人物动作。":
  "修订后的镜头突出暴雨救援和人物既定关系。";
 return stage.titles.map((title,i)=>({
  type:"create_text",ref:"p49b_"+(index+1)+"_"+(i+1),title,
  content:title+"："+hint+"小兔嘟嘟是雪白毛色，穿蓝色斗篷，和背橄榄绿色龟壳的小龟慢慢一起在晨光森林发现星星，穿棕色围裙的兔妈妈鼓励他们。后来在暴雨石桥救助迷路的小动物，最后抵达观星草地团聚。"
 }));
};
const asCompat=actions=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"以下为等待审批的创作草案。",actions})}
}]}),{status:200,headers:{"content-type":"application/json"}});

export async function runP49BAcceptance(config=parseP49BArgs(["--mock"]),
 {outDir,mockUpstreamCall,vaultOverride}={}){
 if(!["mock","live"].includes(config.mode))throw Error("p49b_mode_invalid");
 if(config.mode==="live"&&config.ackCost!==true)throw Error("p49b_explicit_live_authorization_required");
 if(mockUpstreamCall!==undefined&&(config.mode!=="mock"||typeof mockUpstreamCall!=="function"))
  throw Error("p49b_mock_injection_forbidden_in_live_mode");
 if(vaultOverride!==undefined&&(config.mode!=="live"||typeof vaultOverride?.get!=="function"||
  typeof vaultOverride?.withSecretVersion!=="function"||
  !/^[A-Za-z0-9_-]{1,128}$/.test(config.channelId??"")))
  throw Error("p49b_live_vault_invalid");
 if(config.mode==="live"&&!vaultOverride&&(!config.secret||typeof config.secret!=="string"))
  throw Error("p49b_live_secret_missing");
 const directory=outDir??mkdtempSync(join(tmpdir(),"infinite-atelier-p49b-"));
 const reportPath=join(directory,"p49b-quality-report.json");
 const report={schemaVersion:1,scenario:P49B_CASE.id,mode:config.mode,
  provider:config.provider,model:config.model,stages:[],providerPosts:0,
  providerContextChecks:[],
  startedAt:new Date().toISOString(),semanticVerdict:"human_review_required",
  warnings:["自动规则只能提示遗漏/冲突，不能判断角色及叙事语义质量。",
   config.mode==="mock"?"仅模拟 Provider；未进行真实模型验收。":"真实模型输出仍需人工逐项复核。"]};
 const persist=()=>writeFileSync(reportPath,JSON.stringify(report,null,2),"utf8");
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const projectId="p49b-"+randomUUID(),privateMarker="PRIVATE_CANVAS_NOT_AUTHORIZED";
 let app,activeStage=0,success=false;
 try{
  createProject(db,{id:projectId,document:{title:"P4.9b 隔离测试",
   nodes:[{id:"private-node",type:"text",title:"私有节点",
    metadata:{content:privateMarker}}],connections:[]}});
  const task=createAssistantTask(db,{projectId,chatSessionId:"chat-a",
   rootMessageId:"root",requestId:"create-task",
   originalRequest:P49B_CASE.originalRequest,contextPolicy:policy}).task;
  let revision=0;
  const confirm=(operation,text)=>changeAssistantTaskSemantic(db,{projectId,
   taskId:task.id,requestId:"confirm-"+(revision+1),expectedRevision:revision++,
   operation,text,confirmed:true,contextPolicy:policy});
  confirm("set_goal",P49B_CASE.confirmedGoal);
  for(const note of P49B_CASE.confirmedNotes)confirm("add_constraint",note);
  // The configured-channel path supplies a read-only DPAPI-backed vault;
  // never export, copy, or persist its decrypted API key.
  const vault=vaultOverride??{get:()=>({provider:config.provider,hasKey:true,keyVersion:"ephemeral"}),
   withSecretVersion:(_v,fn)=>fn(Buffer.from(config.secret,"utf8"))};
  const pinned=createPinnedOpenAiCompatCall();
  const upstream=async(url,options)=>{
   // Check what the provider would actually receive, without persisting its
   // full serialized request, user content, or any credential.
   const payload=JSON.parse(options.body),system=payload.messages?.[0]?.content??"";
   const check={stageId:P49B_CASE.stages[activeStage].id,
    goalIncluded:system.includes(P49B_CASE.confirmedGoal),
    constraintsIncluded:P49B_CASE.confirmedNotes.every(note=>system.includes(note)),
    unapprovedCanvasAbsent:!options.body.includes(privateMarker),
    priorDraftIncluded:activeStage===0?null:system.includes("历史 AI 创作草案")};
   report.providerContextChecks.push(check);
   if(!check.goalIncluded||!check.constraintsIncluded||!check.unapprovedCanvasAbsent||
    check.priorDraftIncluded===false)
    throw Object.assign(Error("p49b_context_provenance_failed"),{code:"p49b_context_provenance_failed"});
   if(report.providerPosts>=8)throw Object.assign(Error("p49b_model_post_budget_exceeded"),
    {code:"p49b_model_post_budget_exceeded"});
   report.providerPosts++;
   return config.mode==="mock"?
    mockUpstreamCall?mockUpstreamCall({stage:P49B_CASE.stages[activeStage],
     stageIndex:activeStage,postNumber:report.providerPosts}):
    asCompat(mockBody(P49B_CASE.stages[activeStage],activeStage)):
    pinned(url,options);
  };
  const chat=createAssistantChatService({vault,compatibleUpstreamCall:upstream,
   maxRetries:0,requestTimeoutMs:90000});
  app=buildApp({db,authorize:()=>true,assistantChat:chat});
  const endpoint="/api/v1/projects/"+projectId+"/assistant/chat";
  for(let index=0;index<P49B_CASE.stages.length;index++){
   activeStage=index;
   const stage=P49B_CASE.stages[index];
   if(index===2)linkAssistantTaskToChat(db,{projectId,taskId:task.id,
    requestId:"link-new-session",chatSessionId:"chat-after-reload"});
   const messageId="user-"+(index+1),requestId="infer-"+(index+1);
   appendAssistantTaskTurn(db,{projectId,taskId:task.id,
    requestId:"append-"+(index+1),messageId,text:stage.request,contextPolicy:policy});
   const previousPosts=report.providerPosts;
   const response=await app.inject({method:"POST",url:endpoint,payload:{
    channelId:config.channelId??"temporary-channel",provider:config.provider,baseUrl:config.baseUrl,
    model:config.model,messages:[{role:"user",content:stage.request}],canvasActions:true,
    task:{taskId:task.id,turnMessageId:messageId,requestId}
   }});
   const result=response.json();
   // Safe, bounded diagnostic fields from the durable model-call journal.
   // Never export upstream response bodies, request headers or credentials.
   const audit=listAssistantModelCalls(db,{projectId,taskId:task.id,limit:200}).calls
    .filter(row=>row.requestId===requestId)
    .sort((a,b)=>a.index-b.index)
    .map(row=>({call_kind:row.kind,status:row.status,
     ...(typeof row.errorCode==="string"&&/^assistant_[a-z0-9_]{1,80}$/.test(row.errorCode)?
      {errorCode:row.errorCode}:{}),
     ...(row.diagnostic?{diagnostic:row.diagnostic}:{}),
     elapsedMs:row.finishedAt!==null?Math.max(0,row.finishedAt-row.startedAt):null}));
   if(response.statusCode!==200){
    report.stages.push({stageId:stage.id,status:response.statusCode,
     errorCode:/^[a-z][a-z0-9_]{1,90}$/.test(result.code??"")?result.code:"p49b_unknown_error",
     modelCalls:audit,posts:report.providerPosts-previousPosts});
    report.executionStatus=audit.some(row=>["submitting","needs_reconcile"].includes(row.status))?
     "needs_reconcile":"provider_or_validation_error";
    persist();break;
   }
   // A model must never cause a credential supplied through the process
   // environment to be persisted into the human-review artifact.
   const redacted=(result.actions??[]).map(action=>({...action,
    ...(typeof action.title==="string"&&config.secret?
     {title:action.title.split(config.secret).join("[redacted]")}:{}),
    ...(typeof action.content==="string"&&config.secret?
     {content:action.content.split(config.secret).join("[redacted]")}:{}),
   }));
   const review=reviewP49BCreativeActions(stage,redacted);
   report.stages.push({...review,status:response.statusCode,
    modelCalls:audit,posts:report.providerPosts-previousPosts});
   persist();
  }
  const project=getProject(db,projectId);
  report.graphUnchanged=project.revision===1&&project.document.nodes.length===1&&
   project.document.nodes[0].metadata.content===privateMarker;
  report.jobCount=db.prepare("SELECT COUNT(*) n FROM jobs").get().n;
  report.totalTaskModelCalls=db.prepare("SELECT COUNT(*) n FROM assistant_model_calls WHERE task_id=?").get(task.id).n;
  report.userTurnCount=db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE task_id=? AND kind='user_turn'").get(task.id).n;
  report.linkedChatCount=db.prepare("SELECT COUNT(*) n FROM assistant_task_chat_links WHERE task_id=?").get(task.id).n+1;
  if(!report.executionStatus)report.executionStatus=report.stages.length===4?
   "completed_pending_human_review":"incomplete";
  if(!report.graphUnchanged||report.jobCount!==0)throw Error("p49b_isolation_broken");
  success=report.executionStatus==="completed_pending_human_review";
 }catch(error){
  report.executionStatus="runner_failed";report.errorCode=publicCode(error);
 }finally{
  report.finishedAt=new Date().toISOString();
  persist();
  await app?.close();db.close();
 }
 return {report,reportPath,success};
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===
 process.argv[1].toLowerCase()){
 try{
  const config=parseP49BArgs(process.argv.slice(2));
  if(config.help)console.log("P4.9b isolated quality review: node scripts/p49b-creative-quality.mjs [--mock] OR --live --ack-cost with P49B_API_KEY, P49B_BASE_URL, P49B_MODEL environment variables.");
  else{
   const outcome=await runP49BAcceptance(config);
   console.log("P49B_ACCEPTANCE",JSON.stringify({mode:config.mode,
    executionStatus:outcome.report.executionStatus,
    stages:outcome.report.stages.length,providerPosts:outcome.report.providerPosts,
    graphUnchanged:outcome.report.graphUnchanged,
    reportPath:outcome.reportPath,semanticVerdict:outcome.report.semanticVerdict}));
   if(!outcome.success)process.exitCode=1;
  }
 }catch(error){
  console.error("P49B_ACCEPTANCE_PRECHECK_FAILED",publicCode(error));
  process.exitCode=2;
 }
}
