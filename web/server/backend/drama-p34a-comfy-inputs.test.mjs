/** P3.4a: real Comfy (not a stub) consumes saved CAS PNGs through the three video
 * input contracts. Run from web: ATELIER_TEST_LOCAL_COMFY=1 node --test server/backend/drama-p34a-comfy-inputs.test.mjs
 * No diffusion model/online channel. Video frames reveal actual image-port wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {deflateSync} from "node:zlib";
import {spawnSync} from "node:child_process";
import {createLocalBackend} from "./runtime.mjs";
import {comfyUpstream} from "./comfy-v2-adapter.mjs";
import {performance} from "node:perf_hooks";
import {createProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {canonical,sha256,verifyTemplate,compileSingleWorkflow} from "../comfy-workflow/compiler.mjs";

const instanceId="local";
const url="http://127.0.0.1:8188";
// Optional safe timing trace: no graph, media filename, request body or credentials.
async function tracedComfy(instance,path,options={}){
 const start=performance.now(),route=path.split("?")[0].replace(/^(\/history\/).+$/,"$1:id");
 try{
  const result=await comfyUpstream(instance,path,options);
  console.log("P34A_COMFY_TIMING "+JSON.stringify({route,method:options.method??"GET",ms:Math.round(performance.now()-start),ok:true}));
  return result;
 }catch(error){
  console.log("P34A_COMFY_TIMING "+JSON.stringify({route,method:options.method??"GET",ms:Math.round(performance.now()-start),ok:false,error:error.code??error.name}));
  throw error;
 }
}
const configs=[
 {shot:"first",mode:"first_frame",roles:["first_frame"],ports:["first"]},
 {shot:"both",mode:"first_last_frame",roles:["first_frame","last_frame"],ports:["first","last"]},
 {shot:"refs",mode:"omni_reference",roles:["reference_image","reference_image","reference_image"],ports:["reference1","reference2","reference3"]}
];
const colors=[[250,12,10],[9,245,15],[15,25,250]];
const fullInfo={LoadImage:{output:["IMAGE"]}}; // No fake node info is used for actual tests.

// Create 64x64 full-color RGBA PNGs deterministically without a test image dependency.
function crc32(data){
 let c=0xffffffff;
 for(const byte of data){c^=byte;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1}
 return (c^0xffffffff)>>>0;
}
function chunk(name,bytes){
 const type=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);
 length.writeUInt32BE(bytes.length);
 crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));
 return Buffer.concat([length,type,bytes,crc]);
}
function png([r,g,b]){
 const width=64,height=64,raw=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=y*(width*4+1)+1+x*4;
  raw[at]=r;raw[at+1]=g;raw[at+2]=b;raw[at+3]=255;
 }
 const head=Buffer.alloc(13);head.writeUInt32BE(width,0);head.writeUInt32BE(height,4);
 head[8]=8;head[9]=6;
 return Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),
  chunk("IHDR",head),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
function buildTemplate(config){
 const extra=config.mode==="omni_reference";
 const graph={
  "1":{class_type:"EmptyImage",inputs:{width:64,height:64,batch_size:1,color:0}},
  "2":{class_type:"ImageBatch",inputs:{image1:["1",0],image2:["1",0]}},
  ...(extra?{"6":{class_type:"ImageBatch",inputs:{image1:["2",0],image2:["1",0]}}}:{}),
  "3":{class_type:"CreateVideo",inputs:{images:[extra?"6":"2",0],fps:8}},
  "4":{class_type:"SaveVideo",inputs:{video:["3",0],filename_prefix:"atelier-p34a/video",format:"auto","format.codec":"auto",codec:"auto"}},
  "5":{class_type:"PrimitiveString",inputs:{value:"P3.4a video input test"}}
 };
 const mapping={first:["2","image1"],last:["2","image2"],
  reference1:["2","image1"],reference2:["2","image2"],reference3:["6","image2"]};
 const ports=[
  {id:"video",label:"Video",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"3",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}},
  {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"5",inputName:"value"}]}},
  ...config.ports.map(name=>({id:name,label:name,valueKind:"IMAGE",direction:"target",required:true,
   inputBinding:{mode:"socket",replaceInternalLink:true,
    targets:[{nodeId:mapping[name][0],inputName:mapping[name][1]}]}}))
 ];
 const mediaUseCase={channel:"video",primaryOutputKind:"video",promptPortId:"prompt",
  primaryOutputPortId:"video",slots:config.ports.map(id=>({id,label:id,valueKind:"IMAGE",required:true})),
  mediaCapabilities:{schemaVersion:1,kind:"video",defaultMode:config.mode,
   modes:[{id:config.mode,enabled:true,inputs:config.mode==="omni_reference"?
    [{role:"reference_image",kind:"image",minItems:1,maxItems:3}]:
    config.roles.map(role=>({role,kind:"image",minItems:1,maxItems:1})),parameters:[]}]},
  modeBindings:{[config.mode]:{promptPortId:"prompt",parameterPorts:{},
   rolePorts:config.mode==="omni_reference"?{reference_image:config.ports}:
    Object.fromEntries(config.roles.map((role,i)=>[role,[config.ports[i]]]))}}
 };
 const payload={name:"P3.4a "+config.shot,apiGraph:graph,ports,
  requirements:{classTypes:[...new Set(Object.values(graph).map(n=>n.class_type))].sort()},
  mediaUseCase};
 const t={id:"p34a-"+config.shot,revision:sha256(canonical(payload)),...payload};
 verifyTemplate(t);return t;
}
function requestFor(config,t,assets){
 const nodeId="node-"+config.shot;
 return {
  schemaVersion:2,instanceId,nodes:[{id:nodeId,templateId:t.id,templateRevision:t.revision,inputOverrides:{}}],
  rootOutputs:[{nodeId,portId:"video"}],
  edges:config.ports.map((port,i)=>({fromNodeId:"src-"+i,fromPortId:"image",toNodeId:nodeId,toPortId:port})),
  externalInputs:assets.map((asset,i)=>({kind:"asset",sourceNodeId:"src-"+i,sourcePortId:"image",
   valueKind:"IMAGE",assetId:asset.blobId,sha256:asset.blobId})),
  runOptions:{mediaMode:config.mode}
 };
}
function decodeFrames(path){
 const result=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-i",path,
  "-f","rawvideo","-pix_fmt","rgb24","-"],{maxBuffer:2_000_000});
 assert.equal(result.status,0,result.stderr?.toString());
 const frameBytes=64*64*3;
 assert.equal(result.stdout.length%frameBytes,0,"Expected 64x64 RGB video frames");
 const frameCount=result.stdout.length/frameBytes;
 return Array.from({length:frameCount},(_,i)=>{
  const offset=i*frameBytes+(32*64+32)*3;
  return [...result.stdout.subarray(offset,offset+3)];
 });
}
function assertColor(actual,expected){
 assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<=48),
  "actual RGB "+JSON.stringify(actual)+" differs from source "+JSON.stringify(expected));
}
const requiredNodes=["EmptyImage","ImageBatch","CreateVideo","SaveVideo","PrimitiveString","LoadImage"];

test("P3.4a: all three video modes have valid pinned template/port contracts",()=>{
 for(const config of configs){
  const t=buildTemplate(config);
  assert.equal(t.mediaUseCase.modeBindings[config.mode].rolePorts[config.roles[0]][0],config.ports[0]);
 }
});
test("P3.4a: missing image, unclaimed target or wrong media mode fails BEFORE upload",()=>{
 const config=configs[1],t=buildTemplate(config);
 const refs=[{blobId:"a".repeat(64)},{blobId:"b".repeat(64)}];
 const base={...requestFor(config,t,refs),projectId:"p34a-negative",canvasRevision:"1",idempotencyKey:"negative"};
 const info={...fullInfo,ImageBatch:{output:["IMAGE"]},CreateVideo:{output:["VIDEO"]}};
 const mediaFiles=Object.fromEntries(refs.map(r=>[r.blobId,"atelier_"+r.blobId+".png"]));
 assert.throws(()=>compileSingleWorkflow({...base,externalInputs:base.externalInputs.slice(0,1),
  edges:base.edges.slice(0,1)},t,{info,mediaFiles}),/template_media_request_invalid/);
 assert.throws(()=>compileSingleWorkflow({...base,runOptions:{mediaMode:"omni_reference"}},t,{info,mediaFiles}),
  /template_media_mode_binding_missing/);
 assert.throws(()=>compileSingleWorkflow({...base,edges:[...base.edges,{...base.edges[0]}]},t,{info,mediaFiles}),
  /multiple_sources_for_input/);
 assert.throws(()=>compileSingleWorkflow(base,t,{info,mediaFiles:{[refs[0].blobId]:mediaFiles[refs[0].blobId]}}),
  /staged_image_not_uploaded/);
});

test("P3.4a real local Comfy: first, first+last and three-reference CAS images reach VIDEO frames and save",{
 skip:!process.env.ATELIER_TEST_LOCAL_COMFY,timeout:120000
},async()=>{
 const folder=await mkdtemp(join(tmpdir(),"atelier-p34a-live-"));
 let backend;
 try{
  backend=createLocalBackend({dataDir:folder,activationRoot:join(folder,"activation"),
   skillsDir:join(folder,"skills"),comfyInstances:[{id:instanceId,url}],autoDispatch:true,
   autoLocalSession:true,dispatchIntervalMs:160,
   ...(process.env.ATELIER_TEST_COMFY_TRACE==="1"?{comfyUpstreamCall:tracedComfy}:{})});
  const assets=[];
  for(const color of colors)assets.push(await backend.blobStore.put(Readable.from([png(color)]),{mime:"image/png"}));
  assert.equal(new Set(assets.map(a=>a.blobId)).size,3);
  const nodes=[];
  const items=[];
  const fixtures=[];
  for(const config of configs){
   const t=buildTemplate(config),refAssets=assets.slice(0,config.ports.length);
   const req=requestFor(config,t,refAssets),nodeId="node-"+config.shot;
   const edges=req.edges.map(edge=>({...edge}));
   const refs=refAssets.map((asset,i)=>({id:"src-"+i,type:"image",position:{x:i*260,y:fixtures.length*240},width:200,height:200,
    metadata:{storageKey:"cas:"+asset.blobId}}));
   // Each shot uses the same CAS images but sources must be stable,
   // so source node IDs are namespaced by shot.
   for(const ref of refs)ref.id=config.shot+"-"+ref.id;
   for(let i=0;i<refs.length;i++){req.edges[i].fromNodeId=refs[i].id;req.externalInputs[i].sourceNodeId=refs[i].id;}
   nodes.push(...refs,{id:nodeId,type:"comfy:workflow",title:config.mode,
    position:{x:1200,y:fixtures.length*240},width:300,height:180,
    metadata:{comfyWorkflow:{templateId:t.id,templateRevision:t.revision},
     comfyPorts:[{id:"video",direction:"source",valueKind:"VIDEO"}]}});
   fixtures.push({config,t,req,refAssets,nodeId});
  }
  const doc={title:"P3.4a local CAS video inputs",nodes,connections:fixtures.flatMap(x=>x.req.edges.map(e=>({
   id:"connection-"+e.fromNodeId+"-"+e.toPortId,
   fromNodeId:e.fromNodeId,fromPortId:e.fromPortId,toNodeId:e.toNodeId,toPortId:e.toPortId
  })))};
  const project=createProject(backend.db,{id:"p34a-media-inputs",document:doc});
  const session=await backend.app.inject({method:"GET",url:"/api/v1/session"});
  assert.equal(session.statusCode,200,session.body);
  const headers={cookie:session.headers["set-cookie"].split(";")[0],origin:"http://localhost",
   "x-atelier-csrf":session.json().csrfToken};
  for(const fixture of fixtures){
   const {config,t,req,nodeId}=fixture;
   const inspected=await backend.app.inject({method:"POST",url:`/api/v1/projects/${project.id}/shot-batches/inspect`,
    headers,payload:{instanceId,comfyTemplate:t,comfyRequest:req}});
   assert.equal(inspected.statusCode,200,inspected.body);
   assert.deepEqual(inspected.json(),{ready:true});
   // Real HTTP preflight of each mode must reject missing required CAS
   // slots and wrong mode without submitting any /prompt or Job.
   for(const invalid of [
    {...req,edges:[],externalInputs:[]},
    {...req,runOptions:{mediaMode:"text_to_video"}}
   ]){
    const response=await backend.app.inject({method:"POST",
     url:`/api/v1/projects/${project.id}/shot-batches/inspect`,headers,
     payload:{instanceId,comfyTemplate:t,comfyRequest:invalid}});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().ready,false,"invalid "+config.mode+" was accepted");
   }
   items.push({shotId:config.shot,nodeId,sourceNodeFingerprint:fingerprintSource(doc,nodeId),
    snapshot:{adapterKind:"comfy",instanceId,comfyTemplate:t,comfyRequest:req}});
  }
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0,"preflight must not enqueue");
  const submit=await backend.app.inject({method:"POST",url:`/api/v1/projects/${project.id}/shot-batches`,
   headers,payload:{expectedProjectRevision:project.revision,idempotencyKey:"p34a-three-real-modes",items}});
  assert.equal(submit.statusCode,201,submit.body);
  const batch=submit.json();
  assert.equal(batch.items.length,3);
  assert.deepEqual(batch.items.map(x=>x.status),["queued","queued","queued"]);
  let terminal,lastView;
  for(let i=0;i<65;i++){
   const response=await backend.app.inject({url:`/api/v1/projects/${project.id}/shot-batches`,headers});
   assert.equal(response.statusCode,200,response.body);
   const view=response.json().find(x=>x.id===batch.id);
   lastView=view;
   assert.ok(!view.items.some(item=>["failed","blocked","submission_unknown","cancelled"].includes(item.status)),
    JSON.stringify({items:view.items,jobs:backend.db.prepare("SELECT id,status FROM jobs").all(),
     events:backend.db.prepare("SELECT kind,payload_json FROM job_events ORDER BY rowid DESC LIMIT 12").all()}));
   if(view.items.every(x=>x.status==="succeeded")&&
     backend.db.prepare("SELECT COUNT(*) n FROM materializations WHERE status='materialized' AND project_id=?").get(project.id).n>=3){
    terminal=view;break;
   }
   await new Promise(resolve=>setTimeout(resolve,320));
  }
  assert.ok(terminal,"three real input-mode videos were not materialized: "+JSON.stringify({
   items:lastView?.items,
   jobs:backend.db.prepare("SELECT id,status,upstream_task_id FROM jobs").all(),
   materializations:backend.db.prepare("SELECT status,job_id,node_id FROM materializations").all(),
   preparations:backend.db.prepare("SELECT job_id FROM comfy_job_preparations").all(),
   latestEvents:backend.db.prepare("SELECT kind,payload_json FROM job_events ORDER BY rowid DESC LIMIT 15").all(),
   worker:backend.worker?.status()
  }));
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=?").get(project.id).n,3);
  for(const fixture of fixtures){
   const {config,req,nodeId,refAssets}=fixture;
   const job=terminal.items.find(item=>item.shotId===config.shot);
   assert.equal(job.status,"succeeded");
   const prepared=backend.db.prepare("SELECT graph_json,image_files_json FROM comfy_job_preparations WHERE job_id=?").get(job.jobId);
   assert.ok(prepared,"missing durable compiled Comfy graph");
   const graph=JSON.parse(prepared.graph_json),files=JSON.parse(prepared.image_files_json);
   for(let i=0;i<config.ports.length;i++){
    const loader="w_"+nodeId+"__loader_"+config.ports[i];
    assert.equal(graph[loader].class_type,"LoadImage");
    assert.equal(graph[loader].inputs.image,"atelier_"+refAssets[i].blobId+".png");
    assert.equal(files[refAssets[i].blobId],graph[loader].inputs.image);
    const target=config.shot==="refs"&&i===2?["6","image2"]:i===0?["2","image1"]:["2","image2"];
    assert.deepEqual(graph["w_"+nodeId+"__"+target[0]].inputs[target[1]],[loader,0]);
   }
   const artifact=backend.db.prepare(`SELECT a.blob_id FROM artifacts a
    JOIN materializations m ON m.artifact_id=a.id
    WHERE a.job_id=? AND a.kind='video' AND m.status='materialized'`).get(job.jobId);
   assert.ok(artifact,"real video output missing");
   const file=await backend.blobStore.stat(artifact.blob_id);
   assert.equal(file.mimeType,"video/mp4");
   const frames=decodeFrames(file.path);
   const expected=config.shot==="first"?[colors[0],[0,0,0]]:
    config.shot==="both"?colors.slice(0,2):colors;
   assert.equal(frames.length,expected.length,"unexpected video frame count for "+config.mode);
   for(let i=0;i<expected.length;i++)assertColor(frames[i],expected[i]);
  }
 }finally{await backend?.close();await rm(folder,{recursive:true,force:true})}
});
