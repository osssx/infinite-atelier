/** Explicit local GPU acceptance for the P3c2 trusted-image → MiniMax H3 I2V path.
 * Only reads registered templates from the user's real data. Generates real media
 * in a separately locked temporary SQLite/CAS root. Exactly one Moss image Job
 * and one MiniMax video Job; on uncertain response it NEVER retries /prompt.
 * Usage: ATELIER_MINIMAX_LIVE=1 node web/scripts/minimax-p3c2-live-acceptance.mjs
 */
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import {readFileSync,writeFileSync,existsSync,mkdtempSync,openSync,readSync,closeSync} from "node:fs";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {fingerprintSource,stableJson} from "../server/backend/repository.mjs";
import {validateComfyTemplate} from "../server/backend/comfy-registry.mjs";
import {compileSingleWorkflow} from "../server/comfy-workflow/compiler.mjs";

if(process.env.ATELIER_MINIMAX_LIVE!=="1")throw Error("ATELIER_MINIMAX_LIVE=1 opt-in required");
const origin="http://127.0.0.1:8188",instanceId="comfy-local";
let projectId="minimax-p3c2-"+randomUUID().slice(0,8);
const
 sourceId="moss-image-source",targetId="minimax-i2v-workflow";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(condition,code)=>{if(!condition)throw Error("acceptance_assertion_failed:"+code)};
const at=()=>new Date().toISOString();
const log=(event,details={})=>console.log(JSON.stringify({at:at(),event,...details}));
const report={phase:"preflight",startedAt:at(),live:"Moss→MiniMax H3",isolation:"temporary_SQLite_and_CAS",results:[]};
let root=null,runtime=null;
const resumeRoot=process.env.ATELIER_MINIMAX_RESUME_ROOT||null;
if(resumeRoot){
 assert(resumeRoot.startsWith(join(tmpdir(),"infinite-atelier-minimax-p3c2-"))&&
  existsSync(join(resumeRoot,"db","atelier.sqlite")),"invalid_resume_root");
 const saved=new DatabaseSync(join(resumeRoot,"db","atelier.sqlite"),{readOnly:true});
 try{
  projectId=saved.prepare("SELECT id FROM projects LIMIT 1").get()?.id;
  assert(typeof projectId==="string"&&projectId.startsWith("minimax-p3c2-"),"invalid_resume_project");
 }finally{saved.close()}
}
const templateFor=(db,liveRoot,id)=>{
 const row=db.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? ORDER BY created_at DESC LIMIT 1").get(id);
 assert(row?.workflow_hash,"pinned_template_missing_"+id);
 const path=join(liveRoot,"workflows",row.workflow_hash+".json");
 assert(existsSync(path),"pinned_workflow_graph_missing_"+id);
 return validateComfyTemplate({...JSON.parse(row.payload_json),apiGraph:JSON.parse(readFileSync(path,"utf8"))});
};
const imagePrompt="A small matte red ceramic teapot on an oak table, soft daylight, square studio product photograph, plain background, no text";
const videoPrompt="A small matte red ceramic teapot on a wooden table slowly rotates a few degrees; gentle steam rises; smooth static camera, continuous shot, soft daylight, no text";
const mossOverrides={["103cb43c3c4c"]:"1:1 (Square)",["1295e3e8695d"]:0.5,
 ["a7b915e81b56"]:false};
const miniOverrides={prompt:videoPrompt,duration:1,aspect_ratio:"1:1 (Square)",
 megapixels:0.2,lightning:true,lightning_steps:4,seed:42};
const ready=async(method,url,body)=>{
 const result=await runtime.app.inject({method,url,headers,...(body===undefined?{}:{payload:body})});
 let data;try{data=result.json()}catch{data={error:result.body.slice(0,160)}}
 if(result.statusCode>=400)throw Error("http_"+method+"_"+url+"_"+result.statusCode+"_"+String(data.code??data.error??"unknown").slice(0,120));
 return data;
};
let headers;
const countJobs=()=>runtime.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
const stepApprove=async(base,planned,key)=>{
 const path=base+"/steps/"+planned.stepId;
 const result=await ready("POST",path+"/approval",{
  requestId:key+"-approve",expectedPlanVersion:1,actionDigest:planned.actionDigest,
  decision:"approve"});
 assert(result.decision==="approved","step_approval_"+key);
 return path;
};
const waitJob=async(jobId,label,maxMs)=>{
 const end=Date.now()+maxMs;
 let statusBefore="",progressLast=0;
 while(Date.now()<end){
  const row=runtime.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(jobId);
  assert(row,"job_missing_"+label);
  if(row.status!==statusBefore){
   statusBefore=row.status;
   log("job_status",{label,jobId,status:row.status,remoteId:row.upstream_task_id??null});
  }
  if(["failed","cancelled","submission_unknown","blocked","blocked_credential"].includes(row.status))
   throw Error("job_terminal_"+label+"_"+row.status);
  if(row.status==="succeeded"){
   const artifacts=runtime.db.prepare("SELECT a.id,a.blob_id,a.kind,a.port_id,a.sha256,b.byte_size,b.mime,m.status AS material_status,m.node_id FROM artifacts a JOIN blobs b ON b.id=a.blob_id LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=? WHERE a.job_id=?").all(projectId,jobId);
   if(artifacts.length&&artifacts.every(a=>a.material_status==="materialized")){
    log("job_materialized",{label,jobId,artifacts:artifacts.map(a=>({kind:a.kind,bytes:a.byte_size,nodeId:a.node_id}))});
    return {row,artifacts};
   }
  }
  if(Date.now()-progressLast>30000){
   progressLast=Date.now();
   const queue=await fetch(origin+"/queue",{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).catch(()=>null);
   log("poll",{label,status:row.status,queueRunning:queue?.queue_running?.length??null,queuePending:queue?.queue_pending?.length??null});
  }
  await pause(2500);
 }
 throw Error("job_timeout_"+label+"_do_not_resubmit");
};
try{
 const liveRoot=join(process.env.LOCALAPPDATA||"","InfiniteAtelier","data"),liveDb=join(liveRoot,"db","atelier.sqlite");
 assert(existsSync(liveDb),"live_db_missing");
 const reader=new DatabaseSync(liveDb,{readOnly:true});
 let moss,mini;
 try{
  const mossPreset=reader.prepare("SELECT template_id,revision FROM comfy_presets WHERE name=?").get("Moss Image（文生图）");
  assert(mossPreset,"moss_preset_missing");
  moss=templateFor(reader,liveRoot,mossPreset.template_id);
  mini=templateFor(reader,liveRoot,"video-minimax-h3-fl2v-turbo");
  assert(moss.revision===mossPreset.revision,"moss_preset_version_changed");
 }finally{reader.close()}
 report.templateVersions={moss:{id:moss.id,revision:moss.revision},
  mini:{id:mini.id,revision:mini.revision}};
 const queue=await fetch(origin+"/queue",{signal:AbortSignal.timeout(8000)}).then(r=>r.json());
 assert((queue.queue_pending?.length??0)+(queue.queue_running?.length??0)===0,"comfy_queue_busy");
 const infoRes=await fetch(origin+"/object_info",{signal:AbortSignal.timeout(30000)});
 assert(infoRes.ok,"comfy_object_info_unavailable");
 const info=await infoRes.json();
 for(const [tag,template] of [["moss",moss],["minimax",mini]])
  assert(template.requirements.classTypes.every(name=>!!info[name]),"missing_comfy_classes_"+tag);
 const preflightMoss={schemaVersion:2,projectId,canvasRevision:"1",instanceId,
  idempotencyKey:randomUUID(),rootOutputs:[{nodeId:sourceId,portId:moss.mediaUseCase.primaryOutputPortId}],
  nodes:[{id:sourceId,templateId:moss.id,templateRevision:moss.revision,
   inputOverrides:{...mossOverrides,[moss.mediaUseCase.promptPortId]:imagePrompt}}],
  edges:[],externalInputs:[],runOptions:{}};
 const compiledMoss=compileSingleWorkflow(preflightMoss,moss,{info,mediaFiles:{}});
 const placeholder="a".repeat(64);
 const firstInput={kind:"asset",sourceNodeId:"generated-image",sourcePortId:"image",
  valueKind:"IMAGE",assetId:placeholder,sha256:placeholder};
 const mockMini={schemaVersion:2,projectId,canvasRevision:"3",instanceId,
  idempotencyKey:randomUUID(),rootOutputs:[{nodeId:targetId,portId:"video"}],
  nodes:[{id:targetId,templateId:mini.id,templateRevision:mini.revision,
   inputOverrides:miniOverrides}],
  edges:[{fromNodeId:firstInput.sourceNodeId,fromPortId:"image",toNodeId:targetId,toPortId:"first_frame"}],
  externalInputs:[firstInput],runOptions:{}};
 const compiledMini=compileSingleWorkflow(mockMini,mini,{info,
  mediaFiles:{[placeholder]:"atelier_"+placeholder+".png"}});
 assert(compiledMini.decisions.first_frame==="edge"&&
  compiledMini.decisions["8d3f27002a51"]==="auto-prune"&&
  compiledMini.captureMap.some(x=>x.kind==="video"),"real_minimax_compilation_invalid");
 report.preflight={queue:"empty",mossNodes:Object.keys(compiledMoss.graph).length,
  miniNodes:Object.keys(compiledMini.graph).length,
  miniGraphHash:compiledMini.graphHash,port:"first_frame",lastFrame:"auto_prune",
  durationSeconds:miniOverrides.duration,lightning:true,megapixels:miniOverrides.megapixels};
 log("P3C2_MINIMAX_PREFLIGHT_PASS",report.preflight);

 root=resumeRoot??mkdtempSync(join(tmpdir(),"infinite-atelier-minimax-p3c2-"+Date.now()+"-"));
 report.root=root;report.resumed=Boolean(resumeRoot);
 runtime=createLocalBackend({dataDir:root,comfyInstances:[{id:instanceId,url:origin}],
  enableComfyManagement:true,autoDispatch:true,autoLocalSession:true,dispatchIntervalMs:125});
 const auth=runtime.sessionAuth.issueLocalSession();
 headers={host:"127.0.0.1:8788",origin:"http://127.0.0.1:8788",
  cookie:"atelier_session="+auth.id,"x-atelier-csrf":auth.csrf};
 let taskId,base,sequence,firstQueued;
 if(!resumeRoot){
  await ready("POST","/api/v1/comfy/templates",{template:moss});
  await ready("POST","/api/v1/comfy/templates",{template:mini});
  const canvas={nodes:[
   {id:sourceId,type:"image",title:"Moss first frame",position:{x:0,y:0},width:340,height:240,
    metadata:{content:"",status:"idle",prompt:imagePrompt,composerContent:imagePrompt,
     comfyMediaPreset:{templateId:moss.id,templateRevision:moss.revision,overrides:{...mossOverrides},slots:{}}}},
   {id:targetId,type:"comfy:workflow",title:"MiniMax H3 FL2V · trusted first_frame",
    position:{x:520,y:0},width:420,height:280,
    metadata:{comfyWorkflow:{templateId:mini.id,templateRevision:mini.revision,inputOverrides:miniOverrides},
     comfyPorts:mini.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))}}
  ],connections:[]};
  await ready("POST","/api/v1/projects",{id:projectId,document:canvas});
  const taskCreated=await ready("POST","/api/v1/projects/"+projectId+"/assistant/tasks",{
   requestId:"accept-create",chatSessionId:"accept-chat",rootMessageId:"accept-user",
   originalRequest:"P3c2: Moss 图片 → 可信 CAS → MiniMax 图生视频 first_frame → 视频落图"});
  taskId=taskCreated.task.id;
  base="/api/v1/projects/"+projectId+"/assistant/tasks/"+taskId;
  sequence=await ready("POST",base+"/run-sequences",{requestId:"accept-sequence",
   sourceMessageId:"accept-turn",expectedPlanVersion:1,expectedProjectRevision:1,
   actions:[{type:"run_node",nodeId:sourceId,mode:"image"},
    {type:"run_workflow",nodeId:targetId,inputFromPrevious:{sourceKind:"image",toPortId:"first_frame"}}]});
  assert(countJobs()===0,"unexpected_initial_paid_job");
  log("sequence_frozen",{sequenceId:sequence.sequenceId,jobs:0});
  const sourceBinding=canvas.nodes[0].metadata.comfyMediaPreset;
  const sourceNodeFingerprint="v2c:"+createHash("sha256").update(stableJson({
   graphFingerprint:fingerprintSource(canvas,sourceId),
   targetBinding:{mode:"image",binding:sourceBinding}
  })).digest("hex");
  const firstRequest={...preflightMoss,idempotencyKey:randomUUID()};
  const firstPlan=await ready("POST",base+"/external-jobs",{
   requestId:"accept-image-plan",kind:"comfy_workflow",expectedPlanVersion:1,
   expectedProjectRevision:1,runSequenceId:sequence.sequenceId,runIndex:0,dependsOn:[],
   job:{targetNodeId:sourceId,sourceNodeFingerprint,executionMode:"poll",
    snapshot:{adapterKind:"comfy",instanceId,comfyRequest:firstRequest,comfyTemplate:moss,
     comfyTargetBinding:{mode:"image",binding:sourceBinding}}}
  });
  assert(countJobs()===0&&firstPlan.status==="waiting_approval","image_must_be_approved");
  const firstPath=await stepApprove(base,firstPlan,"image");
  firstQueued=await ready("POST",firstPath+"/enqueue",{
   requestId:"accept-image-enqueue",expectedPlanVersion:1,actionDigest:firstPlan.actionDigest});
  assert(firstQueued.jobId&&countJobs()===1,"moss_job_must_enqueue_once");
  const repeated=await ready("POST",firstPath+"/enqueue",{
   requestId:"accept-image-enqueue-replay",expectedPlanVersion:1,actionDigest:firstPlan.actionDigest});
  assert(repeated.jobId===firstQueued.jobId&&countJobs()===1,"moss_enqueue_replay_duplicated");
  report.results.push({stage:"moss_image",jobId:firstQueued.jobId,stepId:firstPlan.stepId});
 }else{
  const pastProject=runtime.db.prepare("SELECT id FROM projects LIMIT 1").get();
  const pastTask=runtime.db.prepare("SELECT id FROM assistant_tasks LIMIT 1").get();
  const pastSeq=runtime.db.prepare("SELECT id FROM assistant_task_run_sequences LIMIT 1").get();
  const first=runtime.db.prepare("SELECT s.id,a.external_id AS jobId FROM assistant_task_steps s JOIN assistant_task_attempts a ON a.step_id=s.id WHERE s.kind='comfy_workflow' AND json_extract(s.preconditions_json,'$.runIndex')=0 AND a.external_kind='job' LIMIT 1").get();
  assert(pastProject?.id===projectId&&pastTask?.id&&pastSeq?.id&&
   first?.jobId&&countJobs()===1,"resume_original_job_not_found");
  taskId=pastTask.id;sequence={sequenceId:pastSeq.id};firstQueued={jobId:first.jobId};
  base="/api/v1/projects/"+projectId+"/assistant/tasks/"+taskId;
  report.results.push({stage:"moss_image",jobId:firstQueued.jobId,stepId:first.id,resumed:true});
  log("RESUME_EXISTING_MOSS_JOB_NO_REENQUEUE",{jobId:firstQueued.jobId,status:runtime.db.prepare("SELECT status FROM jobs WHERE id=?").get(firstQueued.jobId)?.status});
 }
 report.projectId=projectId;report.taskId=taskId;report.sequenceId=sequence.sequenceId;
 report.phase="first_image";
 const imageDone=await waitJob(firstQueued.jobId,"moss",10*60*1000);
 await ready("POST",base+"/reconcile",{});
 const firstState=await ready("GET",base+"/run-sequences");
 assert(firstState.state==="ready"&&firstState.next?.index===1&&firstState.next.needsBinding,
  "trusted_binding_next_missing_"+firstState.state);
 const imageOutput=firstState.outputs.filter(x=>x.runIndex===0&&x.kind==="image");
 assert(imageOutput.length===1,"exactly_one_trusted_image_required");
 const sourceProof=imageOutput[0];
 const imageArtifact=imageDone.artifacts.find(x=>x.id===sourceProof.artifactId);
 assert(imageArtifact&&imageArtifact.sha256===sourceProof.sha256,"image_cas_proof_invalid");
 report.results[0]={...report.results[0],artifactId:sourceProof.artifactId,
  blobSha256:sourceProof.sha256,nodeId:sourceProof.nodeId,bytes:imageArtifact.byte_size,
  jobStatus:imageDone.row.status,materialization:"server_committed"};
 log("image_verified",{nodeId:sourceProof.nodeId,shaPrefix:sourceProof.sha256.slice(0,12),
  bytes:imageArtifact.byte_size,jobId:firstQueued.jobId});

 // Independent, approval-bound graph connection from genuine Moss CAS artifact.
 const binding=firstState.next.inputBinding;
 assert(binding.sourceArtifactId===sourceProof.artifactId&&
  binding.sourceSha256===sourceProof.sha256&&
  binding.toPortId==="first_frame"&&binding.sourceNodeId===sourceProof.nodeId,
  "trusted_input_binding_mismatch");
 const bindAction={type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
  fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId};
 const graphBefore=await ready("GET","/api/v1/projects/"+projectId);
 const boundPlan=await ready("POST",base+"/canvas-steps",{
  requestId:"accept-bind-plan",expectedPlanVersion:1,
  expectedProjectRevision:graphBefore.revision,actions:[bindAction],center:{x:340,y:300},
  dependsOn:firstState.next.dependsOn,runSequenceId:sequence.sequenceId,runIndex:1
 });
 assert(countJobs()===1&&boundPlan.status==="waiting_approval","bind_must_not_enqueue_video");
 const bindPath=await stepApprove(base,boundPlan,"bind");
 const bound=await ready("POST",bindPath+"/execute",{
  requestId:"accept-bind-execute",expectedPlanVersion:1,actionDigest:boundPlan.actionDigest});
 assert(bound.status==="succeeded"&&bound.receipt.applied===1,"trusted_graph_step_uncommitted");
 const afterBind=await ready("GET",base+"/run-sequences");
 assert(afterBind.state==="ready"&&afterBind.next.index===1&&
  afterBind.next.needsBinding===false&&
  afterBind.next.dependsOn.length===1&&
  afterBind.next.dependsOn[0]===boundPlan.stepId,"bind_receipt_not_trusted");
 report.bindingStepId=boundPlan.stepId;
 report.phase="video_job";
 log("first_frame_bound",{sourceNodeId:binding.sourceNodeId,targetNodeId:binding.toNodeId,
  targetPort:binding.toPortId,artId:binding.sourceArtifactId,connectionId:bound.receipt.refs?.connections?.edge_0});
 // The actual uploaded media is the first Task Job's content-addressed blob.
 const snapDoc=await ready("GET","/api/v1/projects/"+projectId);
 const mediaEdges=snapDoc.document.connections.filter(e=>e.toNodeId===targetId&&e.toPortId==="first_frame");
 assert(mediaEdges.length===1&&mediaEdges[0].fromNodeId===binding.sourceNodeId,
  "canvas_graph_edge_missing");
 const mediaBlob=await runtime.blobStore.stat(imageArtifact.blob_id);
 assert(mediaBlob.sha256===binding.sourceSha256&&mediaBlob.mimeType==="image/png","image_blob_integrity_failed");
 const miniRequest={...mockMini,canvasRevision:String(snapDoc.revision),idempotencyKey:randomUUID(),
  externalInputs:[{kind:"asset",sourceNodeId:binding.sourceNodeId,sourcePortId:"image",valueKind:"IMAGE",
   assetId:mediaBlob.id,sha256:mediaBlob.sha256}],
  edges:mediaEdges.map(e=>({fromNodeId:e.fromNodeId,fromPortId:e.fromPortId,
   toNodeId:e.toNodeId,toPortId:e.toPortId}))
 };
 assert(miniRequest.externalInputs[0].assetId===sourceProof.sha256,
  "minimax_trusted_cas_identity_failed");
 const compiledReal=compileSingleWorkflow(miniRequest,mini,{info,
  mediaFiles:{[mediaBlob.sha256]:"atelier_"+mediaBlob.sha256+".png"}});
 assert(compiledReal.decisions.first_frame==="edge"&&
  compiledReal.captureMap.some(x=>x.kind==="video"),"compiled_real_sha_missing");
 const miniPlan=await ready("POST",base+"/external-jobs",{
  requestId:"accept-video-plan",expectedPlanVersion:1,
  expectedProjectRevision:snapDoc.revision,kind:"comfy_workflow",
  runSequenceId:sequence.sequenceId,runIndex:1,dependsOn:afterBind.next.dependsOn,
  job:{targetNodeId:targetId,sourceNodeFingerprint:fingerprintSource(snapDoc.document,targetId),
   executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId,
    comfyRequest:miniRequest,comfyTemplate:mini}}
 });
 assert(countJobs()===1&&miniPlan.status==="waiting_approval","minimax_must_be_approved");
 const miniPath=await stepApprove(base,miniPlan,"minimax");
 const miniQueued=await ready("POST",miniPath+"/enqueue",{
  requestId:"accept-video-enqueue",expectedPlanVersion:1,actionDigest:miniPlan.actionDigest});
 assert(miniQueued.jobId&&countJobs()===2,"video_job_not_unique");
 const miniReplay=await ready("POST",miniPath+"/enqueue",{
  requestId:"accept-video-enqueue-replay",expectedPlanVersion:1,actionDigest:miniPlan.actionDigest});
 assert(miniReplay.jobId===miniQueued.jobId&&countJobs()===2,"video_replay_duplicates");
 report.results.push({stage:"minimax_h3_i2v",jobId:miniQueued.jobId,stepId:miniPlan.stepId,
  fromArtifactId:sourceProof.artifactId});
 log("minimax_job_queued_once",{jobId:miniQueued.jobId,workNodes:Object.keys(compiledReal.graph).length,
  graphHash:compiledReal.graphHash,duration:miniOverrides.duration,lightningSteps:miniOverrides.lightning_steps});
 const videoDone=await waitJob(miniQueued.jobId,"minimax",30*60*1000);
 await ready("POST",base+"/reconcile",{});
 const completed=await ready("GET",base),finalSequence=await ready("GET",base+"/run-sequences");
 assert(completed.task.status==="completed"&&finalSequence.state==="completed","task_or_sequence_incomplete");
 const trusted=finalSequence.outputs.filter(x=>x.runIndex===1&&x.kind==="video");
 assert(trusted.length>=1,"video_output_not_trusted");
 const videos=videoDone.artifacts.filter(x=>x.kind==="video");
 assert(videos.length>=1&&videos.every(v=>v.material_status==="materialized"),"video_not_materialized");
 for(const v of videos){
  const blob=await runtime.blobStore.stat(v.blob_id);
  const fd=openSync(blob.path,"r"),start=Buffer.alloc(32);
  try{readSync(fd,start,0,start.length,0)}finally{closeSync(fd)}
  const startsMp4=start.subarray(4,8).toString("ascii")==="ftyp";
  const startsWebm=start[0]===0x1a&&start[1]===0x45&&start[2]===0xdf&&start[3]===0xa3;
  const startsMkv=startsWebm;
  assert(blob.byteSize>4096&&["video/mp4","video/webm","video/x-matroska"].includes(blob.mimeType)&&
   (startsMp4||startsWebm||startsMkv),"video_file_signature_invalid");
  const metadata={kind:v.kind,blobId:v.blob_id,bytes:blob.byteSize,mime:blob.mimeType,
   sha256:v.sha256,nodeId:v.node_id};
  const ffprobe=spawnSync("ffprobe",["-v","error","-select_streams","v:0",
   "-show_entries","stream=codec_name,width,height,duration,nb_frames",
   "-of","json",blob.path],{timeout:20000,encoding:"utf8"});
  if(ffprobe.status===0)try{metadata.ffprobe=JSON.parse(ffprobe.stdout).streams?.[0]}catch{}
  report.results[1].video=metadata;
 }
 assert(countJobs()===2,"unexpected_third_generation");
 report.results[1].jobStatus=videoDone.row.status;
 const finish=await ready("POST",base+"/reconcile",{});
 assert(countJobs()===2,"reconcile_resubmitted_gpu");
 report.phase="pass";report.completedAt=at();
 report.summary={jobs:2,mossImages:imageDone.artifacts.length,
  videoArtifacts:videos.length,sourceVerified:true,bindingStep:boundPlan.stepId,
  videoJob:miniQueued.jobId,trust:"server_committed",state:completed.task.status,
  sequence:finalSequence.state,noDuplicatePaidSubmit:true};
 log("MINIMAX_P3C2_LIVE_PASS",report.summary);
}catch(error){
 report.phase="failed";report.completedAt=at();
 report.error={name:error?.name??"Error",code:error?.code??null,
  message:String(error?.message??error).slice(0,360)};
 log("MINIMAX_P3C2_LIVE_FAIL",report.error);process.exitCode=1;
}finally{
 if(root){
  try{if(runtime){
   report.jobsAtExit=runtime.db.prepare("SELECT id,status,upstream_task_id FROM jobs ORDER BY created_at").all();
   await runtime.close();
  }}catch(error){log("shutdown_error",{error:String(error?.message??error).slice(0,130)})}
  const outName=report.resumed?"minimax-p3c2-acceptance-resume-result.json":"minimax-p3c2-acceptance-result.json";
  try{writeFileSync(join(root,outName),JSON.stringify(report,null,2),"utf8")}
  catch(error){log("report_write_error",{error:String(error?.message??error).slice(0,130)})}
  console.log("ACCEPTANCE_REPORT_PATH="+join(root,report.resumed?"minimax-p3c2-acceptance-resume-result.json":"minimax-p3c2-acceptance-result.json"));
 }
}
