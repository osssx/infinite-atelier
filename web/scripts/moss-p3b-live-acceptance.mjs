/** Explicit opt-in, real GPU P3b/P3c Task / Moss preset acceptance.
 * Only reads the user's registered Moss template; all writes go to an isolated
 * temporary SQLite/CAS data root. Never touches the live user's project.
 * On ambiguous submission, exits without issuing another provider POST.
 * Usage (Windows PowerShell): $env:ATELIER_MOSS_LIVE="1"; node web/scripts/moss-p3b-live-acceptance.mjs
 */
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {join,dirname} from "node:path";
import {readFileSync,writeFileSync,existsSync,mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {fingerprintSource,stableJson} from "../server/backend/repository.mjs";
import {validateComfyTemplate} from "../server/backend/comfy-registry.mjs";
import {compileSingleWorkflow} from "../server/comfy-workflow/compiler.mjs";

if(process.env.ATELIER_MOSS_LIVE!=="1")
 throw Error("Explicit opt-in required: ATELIER_MOSS_LIVE=1");
const origin="http://127.0.0.1:8188",instanceId="comfy-local",projectId="moss-p3b-accept";
const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,label)=>{if(!condition)throw Error("acceptance_assertion_failed:"+label)};
const at=()=>new Date().toISOString();
const report={phase:"preflight",startedAt:at(),results:[],source:"read_only_moss_template",isolation:"temporary_dataset"};
const baseName="moss-p3b-"+Date.now()+"-"+randomUUID().slice(0,8);
let runtime=null,root=null,jobCountAtEnd=0;
const params={ratio:"103cb43c3c4c",megapixels:"1295e3e8695d",enhance:"a7b915e81b56"};
const log=(event,value={})=>console.log(JSON.stringify({at:at(),event,...value}));
try{
 const liveRoot=join(process.env.LOCALAPPDATA||"","InfiniteAtelier","data");
 const liveDb=join(liveRoot,"db","atelier.sqlite");
 assert(existsSync(liveDb),"live_database_missing");
 const reader=new DatabaseSync(liveDb,{readOnly:true});
 let template;
 try{
  const preset=reader.prepare("SELECT template_id,revision,name FROM comfy_presets WHERE name=?")
   .get("Moss Image（文生图）");
  assert(preset,"registered_moss_preset_missing");
  const row=reader.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?")
   .get(preset.template_id,preset.revision);
  assert(row?.workflow_hash,"moss_template_graph_unavailable");
  const file=join(liveRoot,"workflows",row.workflow_hash+".json");
  assert(existsSync(file),"moss_template_graph_file_missing");
  template=validateComfyTemplate({...JSON.parse(row.payload_json),
   apiGraph:JSON.parse(readFileSync(file,"utf8"))});
  report.template={id:template.id,revision:template.revision,name:template.name,
   graphNodes:Object.keys(template.apiGraph).length};
 }finally{reader.close()}
 const queueRes=await fetch(origin+"/queue",{signal:AbortSignal.timeout(8000)});
 assert(queueRes.ok,"comfy_queue_unavailable");
 const queue=await queueRes.json();
 assert((queue.queue_pending?.length??0)+(queue.queue_running?.length??0)===0,"comfy_queue_busy");
 const infoRes=await fetch(origin+"/object_info",{signal:AbortSignal.timeout(30000)});
 assert(infoRes.ok,"comfy_object_info_unavailable");
 const info=await infoRes.json();
 assert(template.requirements.classTypes.every(name=>Boolean(info[name])),"comfy_missing_custom_classes");
 const defaultOverrides={
  [params.ratio]:"1:1 (Square)",
  [params.megapixels]:0.5,
  [params.enhance]:false
 };
 const prompts=[
  "A small matte red ceramic teapot on an oak table, soft daylight, square studio product photograph, no text",
  "A single bright yellow paper origami crane on a slate tabletop, subtle shadows, square studio product photograph, no text"
 ];
 for(let i=0;i<2;i++){
  const nodeId="moss-image-"+(i+1);
  const req={schemaVersion:2,projectId,canvasRevision:"1",instanceId,
   idempotencyKey:randomUUID(),
   rootOutputs:[{nodeId,portId:template.mediaUseCase.primaryOutputPortId}],
   nodes:[{id:nodeId,templateId:template.id,templateRevision:template.revision,
    inputOverrides:{...defaultOverrides,[template.mediaUseCase.promptPortId]:prompts[i]}}],
   edges:[],externalInputs:[],runOptions:{}};
  const compiled=compileSingleWorkflow(req,template,{info,mediaFiles:{}});
  assert(Object.keys(compiled.graph).length>0,"moss_compiler_preflight_failed_"+i);
 }
 log("moss_template_preflight_pass",{
  template:report.template.id,templateRevision:report.template.revision,
  sourceGraphNodes:report.template.graphNodes,queue:"empty",outputKind:"image",
  megapixels:0.5,enhancement:false
 });
 root=mkdtempSync(join(tmpdir(),"infinite-atelier-"+baseName+"-"));
 report.isolatedDataRoot=root;
 runtime=createLocalBackend({dataDir:root,comfyInstances:[{id:instanceId,url:origin}],
  enableComfyManagement:true,autoDispatch:true,autoLocalSession:true,dispatchIntervalMs:100});
 assert(runtime.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version>=27,"fresh_schema_not_v27");
 const auth=runtime.sessionAuth.issueLocalSession();
 const headers={host:"127.0.0.1:8788",origin:"http://127.0.0.1:8788",
  cookie:"atelier_session="+auth.id,"x-atelier-csrf":auth.csrf};
 const call=async(method,url,payload)=>{
  const result=await runtime.app.inject({method,url,headers,...(payload!==undefined?{payload}:{})});
  let body;try{body=result.json()}catch{body={text:result.body.slice(0,100)}}
  if(result.statusCode>=400)throw Error("http_error_"+method+"_"+url+"_"+result.statusCode+"_"+String(body.code??"unknown"));
  return body;
 };
 await call("POST","/api/v1/comfy/templates",{template});
 const projectDoc={nodes:prompts.map((prompt,index)=>({
  id:"moss-image-"+(index+1),type:"image",title:"Moss P3b 验收 "+(index+1),
  width:340,height:240,position:{x:index*430,y:0},
  metadata:{content:"",status:"idle",prompt,composerContent:prompt,
   comfyMediaPreset:{templateId:template.id,templateRevision:template.revision,
    overrides:{...defaultOverrides},slots:{}}}
 })),connections:[]};
 await call("POST","/api/v1/projects",{id:projectId,document:projectDoc});
 const taskCreated=await call("POST","/api/v1/projects/"+projectId+"/assistant/tasks",{
  requestId:"accept-create-task",chatSessionId:"accept-chat",rootMessageId:"accept-root",
  originalRequest:"Moss P3b 本地双目标顺序生成与回执验收"});
 const taskId=taskCreated.task.id,taskBase="/api/v1/projects/"+projectId+"/assistant/tasks/"+taskId;
 report.taskId=taskId;
 const acts=prompts.map((_prompt,index)=>({type:"run_node",nodeId:"moss-image-"+(index+1),mode:"image"}));
 const sequenceBody={requestId:"accept-sequence",sourceMessageId:"accept-turn",
  expectedPlanVersion:1,expectedProjectRevision:1,actions:acts};
 const seq=await call("POST",taskBase+"/run-sequences",sequenceBody);
 assert((await call("POST",taskBase+"/run-sequences",sequenceBody)).sequenceId===seq.sequenceId,
  "sequence_replay_not_idempotent");
 assert(runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n===0,"unexpected_job_before_consent");
 report.sequenceId=seq.sequenceId;
 report.phase="sequence_frozen";
 log("sequence_frozen_no_gpu_submit",{taskId,sequenceId:seq.sequenceId,actions:2});
 for(let index=0;index<2;index++){
  const next=await call("GET",taskBase+"/run-sequences");
  assert(next.state==="ready"&&next.next?.index===index,"next_not_approved_ready_"+index+":"+next.state);
  const project=await call("GET","/api/v1/projects/"+projectId);
  const nodeId=next.next.action.nodeId,node=project.document.nodes.find(n=>n.id===nodeId);
  assert(node&&node.metadata?.comfyMediaPreset?.templateRevision===template.revision,
   "frozen_binding_not_current_"+index);
  const binding=JSON.parse(JSON.stringify(node.metadata.comfyMediaPreset));
  const targetBinding={mode:"image",binding};
  const sourceNodeFingerprint="v2c:"+createHash("sha256").update(stableJson({
   graphFingerprint:fingerprintSource(project.document,nodeId),targetBinding
  })).digest("hex");
  const comfyRequest={
   schemaVersion:2,projectId,canvasRevision:String(project.revision),instanceId,
   rootOutputs:[{nodeId,portId:template.mediaUseCase.primaryOutputPortId}],
   nodes:[{id:nodeId,templateId:template.id,templateRevision:template.revision,
    inputOverrides:{...binding.overrides,[template.mediaUseCase.promptPortId]:prompts[index]}}],
   edges:[],externalInputs:[],runOptions:{},idempotencyKey:randomUUID()
  };
  const job={targetNodeId:nodeId,sourceNodeFingerprint,executionMode:"poll",
   snapshot:{adapterKind:"comfy",instanceId,comfyRequest,comfyTemplate:template,
    comfyTargetBinding:targetBinding}};
  const planned=await call("POST",taskBase+"/external-jobs",{
   requestId:"accept-plan-"+index,expectedPlanVersion:1,
   expectedProjectRevision:project.revision,kind:"comfy_workflow",job,
   dependsOn:next.next.dependsOn,runSequenceId:seq.sequenceId,runIndex:index
  });
  assert(planned.status==="waiting_approval","step_not_frozen_"+index);
  assert(runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n===index,
   "unexpected_paid_job_before_approval_"+index);
  const stepPath=taskBase+"/steps/"+planned.stepId;
  const approval=await call("POST",stepPath+"/approval",{
   requestId:"accept-approve-"+index,expectedPlanVersion:1,
   actionDigest:planned.actionDigest,decision:"approve"
  });
  assert(approval.decision==="approved","step_not_approved_"+index);
  const execution={requestId:"accept-enqueue-"+index,expectedPlanVersion:1,
   actionDigest:planned.actionDigest};
  const queued=await call("POST",stepPath+"/enqueue",execution);
  assert(queued.jobId,"queued_job_missing_"+index);
  const replay=await call("POST",stepPath+"/enqueue",execution);
  assert(replay.jobId===queued.jobId,"job_duplicate_on_replay_"+index);
  report.results.push({index,stepId:planned.stepId,jobId:queued.jobId,queuedAt:at()});
  report.phase="job_"+index+"_queued";
  log("job_queued_and_replayed_same_id",{index,jobId:queued.jobId});
  let previousStatus="",completed=false,stop=false;
  const deadline=Date.now()+480000;
  while(Date.now()<deadline){
   const row=runtime.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(queued.jobId);
   assert(row,"job_disappeared_"+index);
   if(row.status!==previousStatus){
    previousStatus=row.status;
    log("job_status",{index,jobId:queued.jobId,status:row.status});
   }
   if(["failed","cancelled","submission_unknown","blocked","blocked_credential"].includes(row.status)){
    report.results[index].status=row.status;
    report.results[index].remoteTaskId=row.upstream_task_id;
    stop=true;break;
   }
   if(row.status==="succeeded"){
    const rows=runtime.db.prepare("SELECT a.id,a.blob_id,a.kind,a.port_id,b.byte_size,m.status as materialization,m.node_id FROM artifacts a JOIN blobs b ON b.id=a.blob_id LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=? WHERE a.job_id=?").all(projectId,queued.jobId);
    if(rows.length&&rows.every(item=>item.materialization==="materialized")){
     report.results[index].artifacts=rows.map(item=>({id:item.id,kind:item.kind,bytes:item.byte_size,materialization:item.materialization,nodeId:item.node_id}));
     report.results[index].status="succeeded";
     report.results[index].remoteTaskId=row.upstream_task_id;
     completed=true;break;
    }
   }
   await pause(2000);
  }
  if(stop)throw Error("gpu_job_terminal_failure_"+index+"_"+report.results[index].status);
  if(!completed)throw Error("gpu_job_or_materialization_timeout_"+index);
  await call("POST",taskBase+"/reconcile",{});
  await call("POST",taskBase+"/reconcile",{});
  const task=(await call("GET",taskBase)).task;
  const jobStep=task.steps.find(item=>item.id===planned.stepId);
  const material=task.steps.find(item=>item.kind==="materialize"&&item.result?.jobId===queued.jobId);
  assert(jobStep?.status==="succeeded"&&jobStep.receiptTrust==="server_committed",
   "untrusted_job_receipt_"+index);
  assert(material?.status==="succeeded"&&material.receiptTrust==="server_committed",
   "untrusted_materialization_receipt_"+index);
  assert(task.status===(index===0?"ready":"completed"),"unexpected_task_status_"+index+"_"+task.status);
  report.results[index].materializationStepId=material.id;
  report.results[index].taskStatus=task.status;
  report.results[index].completedAt=at();
  const jobCount=runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
  assert(jobCount===index+1,"duplicate_paid_job_created_"+index);
  const readOnlySequence=await call("GET",taskBase+"/run-sequences");
  assert(readOnlySequence.outputs?.length===index+1,"trusted_outputs_missing_"+index);
  assert(readOnlySequence.outputs.every(output=>output.runSequenceId===seq.sequenceId&&
   report.results.some(item=>item.artifacts?.some(a=>a.id===output.artifactId&&a.nodeId===output.nodeId))),
   "trusted_outputs_identity_mismatch_"+index);
  jobCountAtEnd=jobCount;
  report.phase="job_"+index+"_materialized";
  log("trusted_job_and_materialize_receipts",{index,jobId:queued.jobId,
   count:report.results[index].artifacts.length,taskStatus:task.status,jobCount});
 }
 const finalSequence=await call("GET",taskBase+"/run-sequences");
 assert(finalSequence.state==="completed","sequence_not_completed");
 const linked=await call("POST",taskBase+"/link-chat",{
  requestId:"moss-p3c-link-conversation",chatSessionId:"moss-p3c-follow-up"});
 assert(linked.task.chatSessionId==="accept-chat"&&
  linked.task.chatSessionIds.includes("moss-p3c-follow-up"),"cross_chat_link_not_persisted");
 const crossChat=await call("GET","/api/v1/projects/"+projectId+
  "/assistant/tasks?chatSessionId=moss-p3c-follow-up");
 assert(crossChat.tasks.some(t=>t.id===taskId),"cross_chat_task_not_listed");
 const recoverability=await call("GET",taskBase+"/recovery");
 assert(recoverability.canReplan===false,"completed_task_must_not_be_replanned");
 assert(finalSequence.outputs?.length===2,"final_trusted_outputs_not_two");
 const before=runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
 await call("POST",taskBase+"/reconcile",{});
 const after=runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
 assert(before===after&&after===2,"reconcile_triggered_new_job");
 const doc=(await call("GET","/api/v1/projects/"+projectId)).document;
 for(const item of report.results){
  assert(doc.nodes.some(n=>item.artifacts.some(a=>a.nodeId===n.id)&&
   (n.metadata?.storageKey||n.metadata?.comfyArtifact)),"canvas_output_missing_"+item.index);
 }
 report.phase="pass";
 report.completedAt=at();
 report.summary={jobs:2,artifacts:report.results.reduce((n,x)=>n+(x.artifacts?.length??0),0),
  sequence:"completed",task:"completed",trustedOutputs:finalSequence.outputs.length,
  crossChatLink:"verified",completedTaskReplan:"blocked",replayedJobs:0,materialization:"server_committed",
  isolatedDatasetSchema:runtime.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v};
 log("MOSS_P3C_LIVE_PASS",{...report.summary,isolatedDataRoot:root});
}catch(error){
 report.phase="failed";
 report.completedAt=at();
 report.error={name:error?.name??"Error",message:String(error?.message??error).slice(0,350)};
 log("MOSS_P3B_LIVE_FAIL",report.error);
 process.exitCode=1;
}finally{
 try{if(runtime){report.jobsAtExit=runtime.db.prepare("SELECT id,status FROM jobs ORDER BY created_at").all();await runtime.close()}}
 catch(error){log("runtime_shutdown_error",{message:String(error?.message).slice(0,200)})}
 if(root){
  try{writeFileSync(join(root,"moss-p3b-acceptance-result.json"),JSON.stringify(report,null,2),"utf8")}
  catch(error){log("report_write_failed",{message:String(error?.message).slice(0,180)})}
  console.log("ACCEPTANCE_REPORT_PATH="+join(root,"moss-p3b-acceptance-result.json"));
 }
}
