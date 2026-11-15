/** P4.5f: isolated backend fixture for real Chrome/Edge UI acceptance.
 * NEVER operates against the user's real data directory or the live GPU.
 * Start only through p45f-chrome-browser-e2e.py with a fresh temporary root.
 */
import {tmpdir} from "node:os";
import {resolve,join,sep} from "node:path";
import {existsSync,writeFileSync,mkdirSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {fingerprintSource} from "../server/backend/repository.mjs";
import {getProject} from "../server/backend/projects.mjs";
import {createAssistantRunBudgetGrant} from "../server/backend/assistant-task-run-budget.mjs";
import {getAssistantRunSequence} from "../server/backend/assistant-task-run-sequences.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask} from "../server/backend/assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "../server/backend/assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "../server/backend/assistant-task-canvas-executor.mjs";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {startServer} from "../server/backend/app.mjs";
import {createProject} from "../server/backend/projects.mjs";
import {createAssistantTask} from "../server/backend/assistant-tasks.mjs";
import {registerAssistantRunSequence} from "../server/backend/assistant-task-run-sequences.mjs";

if(process.env.ATELIER_P45F_BROWSER_E2E!=="1")
 throw Error("browser_fixture_requires_explicit_opt_in");
const root=resolve(process.env.ATELIER_DATA_DIR??"");
const prefix=resolve(join(tmpdir(),"infinite-atelier-p45f-browser-"));
if(!root.startsWith(prefix)||root.length<=prefix.length||!existsSync(root))
 throw Error("browser_fixture_refuses_nonisolated_data_directory");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)
 throw Error("browser_fixture_invalid_backend_port");

const projectId="p45f-browser-project",chatId="p45f-browser-chat";
const scenario=process.env.ATELIER_P45F_BROWSER_SCENARIO??"grant";
if(!["grant","recovery","lost-ack"].includes(scenario))throw Error("invalid_p45f_browser_scenario");
const revision="b".repeat(64);
const template={id:"p45f-browser-local-comfy",revision,
 name:"P4.5f local Comfy test (no GPU)",apiGraph:{
  "1":{class_type:"LoadImage",inputs:{image:"not-submitted.png"}},
  "2":{class_type:"SaveImage",inputs:{images:["1",0]}}
 },
 requirements:{classTypes:["LoadImage","SaveImage"]},ports:[
  {id:"first_frame",label:"First frame",direction:"target",valueKind:"IMAGE",
   inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"1",inputName:"image"}]}},
  {id:"image",label:"Image output",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}
 ]};
const source={id:"source-image",type:"image",title:"Image source",position:{x:0,y:0},
 width:340,height:240,metadata:{prompt:"not submitted"}};
const target={id:"p45f-local-workflow",type:"comfy:workflow",title:"Local Comfy browser verification",
 position:{x:490,y:0},width:410,height:270,
 metadata:{comfyWorkflow:{templateId:template.id,templateRevision:revision,inputOverrides:{}},
 comfyPorts:template.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))}};
const runtime=createLocalBackend({dataDir:root,
 comfyInstances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
 enableComfyManagement:true,autoLocalSession:true,autoDispatch:false});
let shutdown=false;
async function close(){
 if(shutdown)return;shutdown=true;await runtime.close();
}
for(const sig of ["SIGTERM","SIGINT"])process.on(sig,()=>void close().then(()=>process.exit(0)));
try{
 const db=runtime.db;
 createProject(db,{id:projectId,document:{nodes:[source,target],connections:[]}});
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run(template.id,revision,JSON.stringify(template),Date.now());
 const session={id:chatId,title:"P4.5f 浏览器任务",messages:[
  {id:"p45f-user",role:"user",text:"使用本地 ComfyUI 执行一次图生视频媒体链"}],
  createdAt:"2026-11-15T12:00:00.000Z",updatedAt:"2026-11-15T12:00:00.000Z"};
 db.prepare("UPDATE project_chats SET sessions_json=?,active_chat_id=?,updated_at=? WHERE project_id=?")
  .run(JSON.stringify([session]),chatId,Date.now(),projectId);
 const task=createAssistantTask(db,{projectId,chatSessionId:chatId,
  requestId:"p45f-create",rootMessageId:"p45f-user",
  originalRequest:"P4.5f: only authorize one local Comfy workflow media connection. Do not generate."}).task;
 const sequence=registerAssistantRunSequence(db,{projectId,taskId:task.id,
  requestId:"p45f-sequence",sourceMessageId:"p45f-user",
  expectedPlanVersion:1,expectedProjectRevision:1,
  actions:[{type:"run_node",nodeId:source.id,mode:"image"},
   {type:"run_workflow",nodeId:target.id,inputFromPrevious:{sourceKind:"image",toPortId:"first_frame"}}]});
 if(scenario==="recovery"||scenario==="lost-ack"){
  const ctx={projectId,taskId:task.id};
  const grant=createAssistantRunBudgetGrant(db,{...ctx,requestId:"p45f-grant",
   sequenceId:sequence.sequenceId,expectedPlanVersion:1,mode:"local_comfy_media",
   instanceId:"comfy-local",maxJobs:1,allowedIndices:[1],expiresInMinutes:30,confirmed:true});
  if(!grant.active||grant.remainingJobs!==1)throw Error("p45f_recovery_grant_invalid");
  const first=planAssistantExternalJobStep(db,{...ctx,requestId:"p45f-first",
   kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
   job:{targetNodeId:source.id,sourceNodeFingerprint:fingerprintSource({nodes:[source,target],connections:[]},source.id),
    executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"image",model:"mock",prompt:"isolated fixture"}}},
   runSequenceId:sequence.sequenceId,runIndex:0,dependsOn:[]});
  decideAssistantTaskStep(db,{...ctx,stepId:first.stepId,requestId:"p45f-image-approve",
   expectedPlanVersion:1,actionDigest:first.actionDigest,decision:"approve"});
  const firstJob=enqueueAssistantExternalJobStep(db,{...ctx,stepId:first.stepId,
   requestId:"p45f-image-enqueue",expectedPlanVersion:1,actionDigest:first.actionDigest}).jobId;
  // A one-pixel PNG is adequate for the isolated CAS / UI authorization
  // contract; it is NOT evidence that any GPU media was generated.
  const img=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ywoAAAAASUVORK5CYII=","base64");
  const sha=createHash("sha256").update(img).digest("hex");
  mkdirSync(join(root,"cas"),{recursive:true});
  writeFileSync(join(root,"cas","fixture.png"),img);
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(firstJob);
  db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,?,'image/png','cas/fixture.png','ready')")
   .run(sha,sha,img.length);
  const artifactId="p45f-image-artifact";
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,'image','fixture',?,'image','image/png',?,'{}')")
   .run(artifactId,firstJob,sha,sha);
  reconcileAssistantExternalTask(db,ctx);
  const graph=getProject(db,projectId).document;
  graph.nodes.push({id:"p45f-rendered",type:"image",title:"Trusted fixture image",
   position:{x:120,y:360},width:340,height:240,metadata:{storageKey:"cas:"+sha}});
  db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=?")
   .run(JSON.stringify(graph),projectId);
  db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES('p45f-materialization',?,?,?,'materialized','p45f-rendered')")
   .run(firstJob,artifactId,projectId);
  reconcileAssistantExternalTask(db,ctx);
  const next=getAssistantRunSequence(db,ctx).next;
  if(!next?.needsBinding||next.index!==1)throw Error("p45f_missing_trusted_first_frame");
  const input=next.inputBinding,sourceRevision=getProject(db,projectId).revision;
  const binding=planAssistantCanvasStep(db,{...ctx,requestId:"p45f-binding",
   expectedPlanVersion:1,expectedProjectRevision:sourceRevision,
   actions:[{type:"connect_workflow_port",fromNodeId:input.sourceNodeId,
    fromPortId:input.sourcePortId,toNodeId:input.toNodeId,toPortId:input.toPortId}],
   center:{x:200,y:200},dependsOn:next.dependsOn,
   runSequenceId:sequence.sequenceId,runIndex:1,runMediaGrantId:grant.grantId});
  decideAssistantTaskStep(db,{...ctx,stepId:binding.stepId,requestId:"p45f-bind-approve",
   expectedPlanVersion:1,actionDigest:binding.actionDigest,decision:"approve",grantId:grant.grantId});
  const bound=executeAssistantCanvasStep(db,{...ctx,stepId:binding.stepId,
   requestId:"p45f-bind-execute",expectedPlanVersion:1,actionDigest:binding.actionDigest});
  if(bound.status!=="succeeded")throw Error("p45f_binding_not_committed");
  const project=getProject(db,projectId);
  const eligible=getAssistantRunSequence(db,ctx);
  if(eligible.state!=="ready"||eligible.next?.needsBinding)
   throw Error("p45f_video_not_ready_to_freeze");
  const request={schemaVersion:2,projectId,canvasRevision:String(project.revision),
   instanceId:"comfy-local",idempotencyKey:randomUUID(),
   nodes:[{id:target.id,templateId:template.id,templateRevision:template.revision,inputOverrides:{}}],
   rootOutputs:[{nodeId:target.id,portId:"image"}],
   edges:project.document.connections.map(edge=>({
    fromNodeId:edge.fromNodeId,fromPortId:edge.fromPortId,
    toNodeId:edge.toNodeId,toPortId:edge.toPortId})),
   externalInputs:[{kind:"asset",sourceNodeId:input.sourceNodeId,sourcePortId:input.sourcePortId,
    valueKind:"IMAGE",assetId:sha,sha256:sha}],runOptions:{}};
  const second=planAssistantExternalJobStep(db,{...ctx,requestId:"p45f-video-frozen",
   expectedPlanVersion:1,expectedProjectRevision:project.revision,kind:"comfy_workflow",
   runSequenceId:sequence.sequenceId,runIndex:1,dependsOn:eligible.next.dependsOn,
   job:{targetNodeId:target.id,sourceNodeFingerprint:fingerprintSource(project.document,target.id),
    executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId:"comfy-local",
     comfyRequest:request,comfyTemplate:template}}});
  if(second.status!=="waiting_approval")throw Error("p45f_frozen_video_step_invalid");
  console.log("P45F_RECOVERY_FIXTURE_READY "+JSON.stringify({
   grantId:grant.grantId,firstJob,videoStepId:second.stepId,preexistingJobs:1}));
 }
 const address=await startServer(runtime.app,{host:"127.0.0.1",port});
 const marker={mode:"p45f_browser_fixture",scenario,projectId,taskId:task.id,chatId,
  sequenceId:sequence.sequenceId,backendOrigin:"http://127.0.0.1:"+port,
  initialProjectRevision:db.prepare("SELECT revision FROM projects WHERE id=?").get(projectId).revision,
  mediaScope:"one_grant_no_gpu",root};
 writeFileSync(join(root,"p45f-fixture.json"),JSON.stringify(marker,null,2),"utf8");
 console.log("P45F_FIXTURE_READY "+JSON.stringify(marker));
}catch(error){
 console.error("P45F_FIXTURE_FAILED",error.stack??String(error));
 await close();process.exitCode=1;
}
