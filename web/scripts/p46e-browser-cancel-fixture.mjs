/** P4.6e isolated SQLite/CAS/Fastify fixture; no user Project or model GPU jobs. */
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {existsSync,writeFileSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {startServer} from "../server/backend/app.mjs";
import {createProject} from "../server/backend/projects.mjs";
import {verifyTemplate,validateSingleRequest} from "../server/comfy-workflow/compiler.mjs";
import {submitJob,fingerprintSource} from "../server/backend/repository.mjs";
if(process.env.ATELIER_P46E_BROWSER_E2E!=="1")throw Error("p46e_explicit_opt_in_required");
const dir=resolve(process.env.ATELIER_DATA_DIR??"");
const prefix=resolve(join(tmpdir(),"infinite-atelier-p46e-browser-"));
if(!dir.startsWith(prefix)||!existsSync(dir))throw Error("p46e_refuses_user_data_directory");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<=1024||port>65535)throw Error("p46e_bad_backend_port");
const instanceId="comfy-local",projectId="p46e-browser-project";
const nodeId="p46e-workflow",templateId="p46e-probe-template";
const template={id:templateId,revision:"0".repeat(64),name:"P4.6e isolated cancel fixture",
 apiGraph:{"1":{class_type:"LoadImage",inputs:{image:"not-submitted.png"}},
 "2":{class_type:"SaveImage",inputs:{images:["1",0]}}},
 requirements:{classTypes:["LoadImage","SaveImage"]},ports:[
 {id:"image",label:"image",direction:"source",valueKind:"IMAGE",
 outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}]};
const canonical=value=>Array.isArray(value)?value.map(canonical):
 value&&typeof value==="object"?Object.fromEntries(
 Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const revision=createHash("sha256").update(JSON.stringify(canonical({
 apiGraph:template.apiGraph,ports:template.ports,requirements:template.requirements
}))).digest("hex");
template.revision=revision;
const node={id:nodeId,type:"comfy:workflow",title:"Scoped cancel acceptance",
 position:{x:10,y:0},width:360,height:230,metadata:{
 comfyWorkflow:{templateId,templateRevision:revision,inputOverrides:{}},
 comfyPorts:[{id:"image",direction:"source",valueKind:"IMAGE",label:"image"}]}};
const graph={nodes:[node],connections:[]};
const runtime=createLocalBackend({dataDir:dir,
 comfyInstances:[{id:instanceId,url:"http://127.0.0.1:8188"}],
 enableComfyManagement:true,autoLocalSession:true,autoDispatch:false});
// Isolated fixture diagnostics only: observe the coordinator's actual result
// without changing cancellation semantics or performing extra remote calls.
const originalCancel=runtime.coordinator.cancel.bind(runtime.coordinator);
runtime.coordinator.cancel=async(...args)=>{
 const answer=await originalCancel(...args);
 console.log("P46E_COORDINATOR_CANCEL_RESULT "+JSON.stringify(answer));
 return answer;
};
const cancelAdapter=runtime.comfyRegistry?.adapters?.[instanceId];
if(cancelAdapter?.cancel){
 const originalScopedCancel=cancelAdapter.cancel.bind(cancelAdapter);
 cancelAdapter.cancel=async(...args)=>{
  try{return await originalScopedCancel(...args)}
  catch(error){console.log("P46E_SCOPED_CANCEL_DIAGNOSTIC "+String(error?.code??error?.message??error));throw error}
 };
}
const db=runtime.db,token=randomUUID(),idempotencyKey=randomUUID();
const request={schemaVersion:2,projectId,canvasRevision:"1",
 instanceId,idempotencyKey,nodes:[{id:nodeId,templateId,templateRevision:revision,inputOverrides:{}}],
 rootOutputs:[{nodeId,portId:"image"}],edges:[],externalInputs:[],runOptions:{}};
verifyTemplate(template);
validateSingleRequest(request);
const expectedGraph={
 "1":{class_type:"EmptyImage",inputs:{width:64,height:64,batch_size:1,color:0}},
 "2":{class_type:"Sleep",inputs:{input:["1",0],minutes:0,seconds:50}},
 "3":{class_type:"PreviewImage",inputs:{images:["2",0]}}
};
let attached=false,submittedOnce=false,closed=false;
const ownedRemoteIds=new Set();
async function close(){
 if(closed)return;closed=true;await runtime.close();
}
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>void close().then(()=>process.exit(0)));
try{
 createProject(db,{id:projectId,document:graph});
 const jobId=submitJob(db,{projectId,targetNodeId:nodeId,expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(graph,nodeId),
  idempotencyKey,requestFingerprint:idempotencyKey,executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId,comfyTemplate:template,comfyRequest:request}}).jobId;
 runtime.app.post("/__p46e/attach",async(req,reply)=>{
  if(attached||submittedOnce||req.body?.token!==token){
   reply.code(409);return {error:"p46e_start_not_allowed"};
  }
  // Check the shared Comfy queue ONLY before submitting. KJNodes Sleep can
  // block the upstream queue handler while executing, so querying it after
  // /prompt would miss the cancellation window.
  const before=await fetch("http://127.0.0.1:8188/queue",{signal:AbortSignal.timeout(6000)});
  if(!before.ok){reply.code(503);return {error:"p46e_remote_queue_unavailable"}}
  const state=await before.json();
  if((state.queue_running??[]).length||(state.queue_pending??[]).length){
   reply.code(409);return {error:"p46e_refuses_foreign_live_queue"};
  }
  const current=db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId);
  if(current?.status!=="queued"){reply.code(409);return {error:"p46e_job_not_queued"}}
  // One-shot in-process guard for the isolated test fixture; a lost HTTP
  // acknowledgement must not cause this process to retry /prompt. The
  // production coordinator has its separate durable SQLite submit barrier.
  submittedOnce=true;
  const submitOwned=async(graph,role)=>{
   const response=await fetch("http://127.0.0.1:8188/prompt",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({client_id:"p46e-"+token,prompt:graph,
     extra_data:{p46e_fixture_token:token,p46e_only:role}}),
    signal:AbortSignal.timeout(9000)});
   if(!response.ok)throw Error("p46e_comfy_prompt_rejected_"+role);
   const data=await response.json();
   if(typeof data?.prompt_id!=="string"||!/^[0-9a-f-]{36}$/i.test(data.prompt_id))
    throw Error("p46e_comfy_prompt_receipt_unknown_"+role);
   ownedRemoteIds.add(data.prompt_id);
   return data.prompt_id;
  };
  let blockerId,remoteTaskId;
  try{
   // Keep the single Comfy execution lane busy with a disposable no-model
   // Sleep. The project Job's separate prompt remains pending; its scoped
   // cancel response can be measured without waiting for the running node.
   blockerId=await submitOwned(expectedGraph,"blocker_running");
   remoteTaskId=await submitOwned({
    "1":{class_type:"EmptyImage",inputs:{width:64,height:64,batch_size:1,color:0}},
    "2":{class_type:"PreviewImage",inputs:{images:["1",0]}}
   },"target_pending");
  }catch{
   reply.code(503);return {error:"p46e_prompt_result_unknown_no_resubmit"};
  }
  db.prepare("UPDATE jobs SET status='running',upstream_task_id=? WHERE id=?")
   .run(remoteTaskId,jobId);
  db.prepare("DELETE FROM job_schedules WHERE job_id=?").run(jobId);
  attached=true;
  return {attached:true,jobId,remoteTaskId,blockerId};
 });
 await startServer(runtime.app,{host:"127.0.0.1",port});
 const marker={mode:"p46e_real_chrome_scoped_cancel",projectId,jobId,
  backendOrigin:"http://127.0.0.1:"+port,token,expectedGraph,root:dir};
 writeFileSync(join(dir,"p46e-fixture.json"),JSON.stringify(marker),"utf8");
 console.log("P46E_FIXTURE_READY "+JSON.stringify({projectId,jobId,port}));
}catch(error){
 console.error("P46E_FIXTURE_FAILED",error.stack??String(error));
 await close();process.exitCode=1;
}
