/** P6 real configured MiniMax FL2V, explicit opt-in, isolated SQLite/CAS.
 * Reads the current preset without modifying it. Creates a short test-only
 * revision with mapped duration/aspect, capped resolution and sampling.
 * No global interrupt, no online requests, no automatic resubmission.
 */
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {mkdtempSync,realpathSync} from "node:fs";
import {join,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import {Readable} from "node:stream";
import {spawnSync} from "node:child_process";
import {loadBackendEnv} from "./load-backend-env.mjs";
import {createLocalBackend,resolveLocalDataDir} from "../server/backend/runtime.mjs";
import {createComfyRegistry} from "../server/backend/comfy-registry.mjs";
import {createProject,getProject} from "../server/backend/projects.mjs";
import {fingerprintSource,stableJson} from "../server/backend/repository.mjs";
import {canonical,sha256,verifyTemplate,compileSingleWorkflow,workflowObjectInfoClasses} from "../server/comfy-workflow/compiler.mjs";
import {readComfyWorkflowObjectInfo,comfyUpstream} from "../server/backend/comfy-v2-adapter.mjs";

const resume=process.argv[2]==="--resume"?realpathSync(process.argv[3]):undefined;
const live=process.argv[2]==="--live"||!!resume;
assert(process.argv.length===(resume?4:3)&&["--live","--probe","--resume"].includes(process.argv[2]),"explicit --probe, --live or --resume <isolated root> required");
if(resume)assert(dirname(resume).toLowerCase()===realpathSync(tmpdir()).toLowerCase()&&basename(resume).startsWith("atelier-drama-video-p6-"),"resume must be isolated test directory");
loadBackendEnv();
const root=resolveLocalDataDir(),reader=new DatabaseSync(join(root,"db","atelier.sqlite"),{readOnly:true});
let original,instance;
try{
 const p=reader.prepare("SELECT template_id,revision FROM comfy_presets WHERE template_id=? ORDER BY name LIMIT 1").get("video-minimax-h3-fl2v-turbo");
 assert(p,"current MiniMax FL2V preset missing");
 instance=reader.prepare("SELECT id,url FROM comfy_instances WHERE id='comfy-local'").get();
 assert(instance?.url==="http://127.0.0.1:8188","expected local instance");
 original=createComfyRegistry(reader,{workflowsDir:join(root,"workflows")}).find(p.template_id,p.revision);
}finally{reader.close()}
const idle=async()=>{
 const q=await comfyUpstream(instance,"/queue",{timeoutMs:8000});
 assert(q.queue_running.length===0&&q.queue_pending.length===0,"ComfyUI queue not idle");
};
await idle();
verifyTemplate(original);
const modes=["first_frame","first_last_frame"];
const duration=1,ratio="1:1 (Square)";
const overrides={duration,aspect_ratio:ratio,megapixels:0.2,lightning:true,lightning_steps:4,seed:42};
const prompt="A red ceramic teapot on a table, gentle static camera, soft studio lighting, continuous shot.";
const payload=structuredClone(original);delete payload.id;delete payload.revision;
payload.name="P6 isolated MiniMax FL2V";
for(const mode of payload.mediaUseCase.mediaCapabilities.modes.filter(m=>m.enabled)){
 mode.parameters=mode.parameters.filter(p=>!["duration_seconds","aspect_ratio"].includes(p.id));
 mode.parameters.push({id:"duration_seconds",type:"number",mode:"adjustable",min:1,max:10},
  {id:"aspect_ratio",type:"enum",mode:"adjustable",values:original.ports.find(p=>p.id==="aspect_ratio").choices.map(c=>c.value)});
 Object.assign(payload.mediaUseCase.modeBindings[mode.id].parameterPorts,{duration_seconds:"duration",aspect_ratio:"aspect_ratio"});
}
const template={id:"p6-minimax-fl2v",revision:sha256(canonical(payload)),...payload};
verifyTemplate(template);
const log=(event,details={})=>console.log("P6_"+event,JSON.stringify(details));
const fake=["a".repeat(64),"b".repeat(64)];
function request(mode,assets,nodeId){
 const mapping=template.mediaUseCase.modeBindings[mode];
 const rolePorts=Object.values(mapping.rolePorts).flat();
 const slots=Object.fromEntries(rolePorts.map((port,i)=>[port,{nodeId:"frame-"+i}]));
 const binding={templateId:template.id,templateRevision:template.revision,mediaMode:mode,instanceId:instance.id,slots,overrides:{...overrides}};
 return {binding,request:{schemaVersion:2,instanceId:instance.id,projectId:"p6-video",canvasRevision:"1",idempotencyKey:"p6-probe-"+mode,
  rootOutputs:[{nodeId,portId:template.mediaUseCase.primaryOutputPortId}],
  nodes:[{id:nodeId,templateId:template.id,templateRevision:template.revision,inputOverrides:{...overrides,[mapping.promptPortId??template.mediaUseCase.promptPortId]:prompt}}],
  edges:rolePorts.map((port,i)=>({fromNodeId:"frame-"+i,fromPortId:"image",toNodeId:nodeId,toPortId:port})),
  externalInputs:rolePorts.map((port,i)=>({kind:"asset",sourceNodeId:"frame-"+i,sourcePortId:"image",valueKind:"IMAGE",assetId:assets[i],sha256:assets[i]})),
  runOptions:{mediaMode:mode}}};
}
function inspectGraph(compiled,mode,nodeId,assets){
 const graph=compiled.graph??compiled;
 const prefix="w_"+nodeId+"__";
 const findPort=id=>template.ports.find(p=>p.id===id).inputBinding.targets[0];
 const check=(port,value)=>{const t=findPort(port);assert.deepEqual(graph[prefix+t.nodeId]?.inputs[t.inputName],value,port)};
 check("prompt",prompt);check("duration",duration);check("aspect_ratio",ratio);check("megapixels",0.2);
 const slots=template.mediaUseCase.modeBindings[mode].rolePorts;
 for(const [i,port] of Object.values(slots).flat().entries())check(port,"atelier_"+assets[i]+".png");
 const generator=Object.values(graph).find(n=>n.class_type==="MiniMaxH3ImageToVideo");
 assert(generator?.inputs.first_frame,"first frame missing");
 assert.equal(Boolean(generator.inputs.last_frame),mode==="first_last_frame","unused last frame pruning");
 const inactive=template.mediaUseCase.modeBindings.first_last_frame.rolePorts.last_frame[0];
 if(mode==="first_frame"){const t=findPort(inactive);assert(!graph[prefix+t.nodeId],"unused last frame loader retained")}
 return Object.keys(graph).length;
}
for(const mode of modes){
 const {request:req}=request(mode,fake,"probe");
 const info=await readComfyWorkflowObjectInfo(instance,workflowObjectInfoClasses(req,template));
 const compiled=compileSingleWorkflow(req,template,{info,mediaFiles:Object.fromEntries(fake.map(a=>[a,"atelier_"+a+".png"]))});
 log("COMPILE",{mode,nodes:inspectGraph(compiled,mode,"probe",fake),duration,ratio,classes:Object.keys(info).length});
}
if(!live){log("PROBE_PASS",{jobs:0});process.exit(0)}
const isolated=resume??mkdtempSync(join(tmpdir(),"atelier-drama-video-p6-"));
log("ISOLATION",{root:isolated,resume:!!resume});
let backend;
let submissions=0;
if(resume){
 const saved=new DatabaseSync(join(isolated,"db","atelier.sqlite"),{readOnly:true});
 try{
  const jobs=saved.prepare("SELECT project_id,target_node_id,status,upstream_task_id,snapshot_json FROM jobs").all();
  assert(jobs.length===1&&jobs[0].project_id==="p6-video"&&jobs[0].target_node_id==="config-0"&&jobs[0].status==="succeeded"&&jobs[0].upstream_task_id,"resume requires exactly one successful first-frame job");
  assert.equal(JSON.parse(jobs[0].snapshot_json).comfyTemplate.revision,template.revision,"template changed; cannot resume");
  assert.equal(saved.prepare("SELECT COUNT(*) AS n FROM materializations WHERE status='materialized'").get().n,1,"resume requires materialized first frame video");
  submissions=1;
 }finally{saved.close()}
}
try{
 backend=createLocalBackend({dataDir:isolated,activationRoot:join(isolated,"activation"),skillsDir:join(isolated,"skills"),comfyInstances:[instance],autoDispatch:true,autoLocalSession:true,dispatchIntervalMs:200,
  comfyUpstreamCall:async(i,path,options={})=>{
   if(path==="/prompt"&&options.method==="POST"){assert(submissions<2,"submission cap");await idle();submissions++;log("SUBMIT",{count:submissions});}
   return comfyUpstream(i,path,options);
  }});
 const hashes=[];
 for(const color of ["red","blue"]){
  const image=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c="+color+":s=448x448","-frames:v","1","-f","image2pipe","-vcodec","png","-"],{maxBuffer:2e6,timeout:15000});
  assert.equal(image.status,0,String(image.stderr));assert(image.stdout.length);
  hashes.push((await backend.blobStore.put(Readable.from([image.stdout]),{mime:"image/png"})).blobId);
 }
 const nodes=hashes.map((hash,i)=>({id:"frame-"+i,type:"image",title:"Test frame",position:{x:0,y:i*400},width:200,height:200,metadata:{storageKey:"cas:"+hash,mimeType:"image/png"}}));
 const fixtures=modes.map((mode,index)=>{
  const nodeId="config-"+index,{binding,request:req}=request(mode,hashes,nodeId);
  nodes.push({id:nodeId,type:"config",title:"Test "+mode,position:{x:400,y:index*400},width:400,height:280,
   metadata:{generationMode:"video",videoMode:mode,comfyWorkflowSelections:{video:binding},prompt,composerContent:prompt,seconds:String(duration),videoRatio:ratio,
    videoReferences:req.edges.map((e,i)=>({id:e.fromNodeId,kind:"image",role:i?"last_frame":"first_frame"}))}});
  return {mode,nodeId,binding,req};
 });
 const doc={title:"P6 isolated configured MiniMax",nodes,connections:fixtures.flatMap(f=>f.req.edges.map((e,i)=>({...e,id:f.nodeId+"-"+i})))};
 if(!resume)createProject(backend.db,{id:"p6-video",document:doc});
 else{
  const saved=getProject(backend.db,"p6-video").document;
  for(const node of nodes)assert.deepEqual(saved.nodes.find(n=>n.id===node.id)?.metadata?.comfyWorkflowSelections??saved.nodes.find(n=>n.id===node.id)?.metadata?.storageKey,node.metadata?.comfyWorkflowSelections??node.metadata?.storageKey,"resume config changed");
 }
 const session=await backend.app.inject({method:"GET",url:"/api/v1/session"});
 const headers={cookie:session.headers["set-cookie"].split(";")[0],origin:"http://localhost","x-atelier-csrf":session.json().csrfToken};
 const api=async(method,url,payload)=>{const r=await backend.app.inject({method,url,headers,...(payload===undefined?{}:{payload})});assert(r.statusCode<400,method+" "+url+" "+r.statusCode+" "+r.body.slice(0,400));return r.json()};
 for(const f of fixtures){
  const project=getProject(backend.db,"p6-video");
  const targetBinding={mode:"video",generationMode:f.mode,binding:f.binding};
  const snapshot={adapterKind:"comfy",instanceId:instance.id,comfyTemplate:template,comfyRequest:f.req,comfyTargetBinding:targetBinding};
  const fingerprint="v2c:"+createHash("sha256").update(stableJson({graphFingerprint:fingerprintSource(project.document,f.nodeId),targetBinding})).digest("hex");
  const base="/api/v1/projects/p6-video/shot-batches";
  const check=await api("POST",base+"/inspect",{instanceId:instance.id,comfyTemplate:template,comfyRequest:f.req});
  assert.equal(check.ready,true,JSON.stringify(check));
  let batch;
  if(resume&&f.mode==="first_frame"){
   const batches=await api("GET",base);
   batch=batches.find(b=>b.items.length===1&&b.items[0].shotId===f.mode&&b.items[0].status==="succeeded");
   assert(batch,"completed first-frame batch missing");
  }else{
   batch=await api("POST",base,{expectedProjectRevision:project.revision,idempotencyKey:"p6-"+f.mode,items:[{shotId:f.mode,nodeId:f.nodeId,sourceNodeFingerprint:fingerprint,snapshot}]});
  }
  let state="",finished=false;
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){
   const view=(await api("GET",base)).find(b=>b.id===batch.id),item=view.items[0];
   if(item.status!==state){state=item.status;log("STATUS",{mode:f.mode,status:state,jobId:item.jobId})}
   if(["failed","blocked","submission_unknown","cancelled"].includes(state)){
    const rows=backend.db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? ORDER BY rowid DESC LIMIT 3").all(item.jobId);
    throw Error("terminal "+state+" "+JSON.stringify(rows).slice(0,1200));
   }
   const artifact=backend.db.prepare("SELECT a.blob_id,m.node_id FROM artifacts a JOIN materializations m ON m.artifact_id=a.id WHERE a.job_id=? AND a.kind='video' AND m.status='materialized'").get(item.jobId??"");
   if(state==="succeeded"&&artifact){
    const prep=backend.db.prepare("SELECT graph_json FROM comfy_job_preparations WHERE job_id=?").get(item.jobId);
    inspectGraph(JSON.parse(prep.graph_json),f.mode,f.nodeId,hashes);
    const blob=await backend.blobStore.stat(artifact.blob_id);
    const ff=spawnSync("ffprobe",["-v","error","-show_entries","format=duration,size:stream=codec_type,width,height,r_frame_rate,nb_frames","-of","json",blob.path],{timeout:15000,encoding:"utf8"});
    assert.equal(ff.status,0,ff.stderr);
    const result=JSON.parse(ff.stdout),video=result.streams.find(s=>s.codec_type==="video");
    assert(video&&video.width>0&&video.width===video.height,"expected square video");
    // MiniMax's exact graph rounds up to 5 mod 17 frames at 24fps.
    const compiled=JSON.parse(prep.graph_json);
    assert(Object.values(compiled).some(n=>n.class_type==="ComfyMathExpression"&&n.inputs.expression==="max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"),"duration expression changed; review frame alignment");
    const baseFrames=Math.max(5,Math.round(duration*24));
    const expectedFrames=baseFrames+((5-baseFrames%17+17)%17);
    assert.equal(video.r_frame_rate,"24/1");
    assert.equal(Number(video.nb_frames),expectedFrames,"unexpected frame count");
    assert(Math.abs(Number(result.format.duration)-expectedFrames/24)<0.05,"unexpected aligned duration");
    const restored=getProject(backend.db,"p6-video").document;
    assert(restored.nodes.some(n=>n.id===artifact.node_id&&n.metadata?.storageKey==="cas:"+artifact.blob_id));
    assert(restored.connections.some(e=>e.fromNodeId===f.nodeId&&e.toNodeId===artifact.node_id));
    log("MATERIALIZED",{mode:f.mode,requestedDuration:duration,duration:Number(result.format.duration),frames:Number(video.nb_frames),width:video.width,height:video.height,bytes:Number(result.format.size),fps:video.r_frame_rate,mime:blob.mimeType});
    finished=true;break;
   }
   await new Promise(r=>setTimeout(r,1500));
  }
  assert(finished,"timed out; do not resubmit");
 }
 assert.equal(submissions,2);
 log("PASS",{submissions,modes});
}finally{await backend?.close()}
