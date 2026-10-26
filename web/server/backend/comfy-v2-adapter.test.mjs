import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
import {initializeSchema} from "./schema.mjs";
import {submitJob} from "./repository.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createComfyV2Adapters} from "./comfy-v2-adapter.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {canonical,sha256,validateSingleRequest,compileSingleWorkflow} from "../comfy-workflow/compiler.mjs";

const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const info={
 SolidImage:{input:{required:{}},output:["IMAGE"]},
 Motion:{input:{required:{image:["IMAGE",{}]}},output:["VIDEO"]},
 Sound:{input:{required:{}},output:["AUDIO"]},
 Text:{input:{required:{text:["STRING",{}]}},output:["STRING"]},
 Generate:{input:{required:{image:["IMAGE",{}]}},output:["IMAGE"]},
 LoadImage:{input:{required:{image:[["sample.png"],{}]}},output:["IMAGE","MASK"]},
 SaveImage:{input:{required:{images:["IMAGE",{}],filename_prefix:["STRING",{}]}},output:[]},
 SaveVideo:{input:{required:{video:["VIDEO",{}],filename_prefix:["STRING",{}]}},output:[]},
 SaveAudio:{input:{required:{audio:["AUDIO",{}],filename_prefix:["STRING",{}]}},output:[]},
 SaveText:{input:{required:{text:["STRING",{}],filename_prefix:["STRING",{}]}},output:[]}
};
function template({reference=false}={}){
 const apiGraph=reference?{
  "1":{class_type:"SolidImage",inputs:{}},
  "2":{class_type:"Generate",inputs:{image:["1",0]}}
 }:{
  "1":{class_type:"SolidImage",inputs:{}},
  "2":{class_type:"Motion",inputs:{image:["1",0]}},
  "3":{class_type:"Sound",inputs:{}},
  "4":{class_type:"Text",inputs:{text:"hello"}},
  "5":{class_type:"SaveVideo",inputs:{video:["2",0],filename_prefix:"video"}},
  "6":{class_type:"SaveAudio",inputs:{audio:["3",0],filename_prefix:"audio"}},
  "7":{class_type:"SaveText",inputs:{text:["4",0],filename_prefix:"text"}}
 };
 const ports=reference?[
  {id:"source",label:"Input image",direction:"target",valueKind:"IMAGE",
   inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"2",inputName:"image"}]}},
  {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}
 ]:[
  {id:"image",label:"Image",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
  {id:"video",label:"Video",direction:"source",valueKind:"VIDEO",
   outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}},
  {id:"audio",label:"Audio",direction:"source",valueKind:"AUDIO",
   outputBinding:{nodeId:"3",outputIndex:0},capture:{kind:"audio",adapterId:"SaveAudio"}},
  {id:"text-output",label:"Text",direction:"source",valueKind:"STRING",
   outputBinding:{nodeId:"4",outputIndex:0},capture:{kind:"text",adapterId:"SaveText"}}
 ];
 const payload={name:"Pinned fixture",apiGraph,ports,
  requirements:{classTypes:[...new Set(Object.values(apiGraph).map(n=>n.class_type))].sort()}};
 return {id:"pinned-demo",revision:sha256(canonical(payload)),...payload};
}
function request(t,{reference=false,asset}={}){
 return {
  schemaVersion:2,projectId:"test-project",instanceId:"comfy-local",canvasRevision:"saved-rev",
  idempotencyKey:"test-click",nodes:[{id:"wf-1",templateId:t.id,templateRevision:t.revision,inputOverrides:{}}],
  rootOutputs:(reference?["image"]:["image","video","audio","text-output"]).map(portId=>({nodeId:"wf-1",portId})),
  edges:reference?[{fromNodeId:"image-source",fromPortId:"image",toNodeId:"wf-1",toPortId:"source"}]:[],
  externalInputs:reference?[{kind:"asset",sourceNodeId:"image-source",sourcePortId:"image",
    valueKind:"IMAGE",assetId:asset,sha256:asset}]:[],
  runOptions:{}
 };
}
function fixture(t,{transport,requestOverride,reference=false}={}){
 const dir=mkdtempSync(join(tmpdir(),"atelier-comfy-new-"));
 const db=new DatabaseSync(":memory:");
 initializeSchema(db);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const blobStore=createBlobStore({dataDir:dir,db});
 const instances=[{id:"comfy-local",url:"http://127.0.0.1:8188"}];
 const adapters=createComfyV2Adapters({instances,db,blobStore,upstreamCall:transport});
 const tplt=template({reference}),req=request(tplt,requestOverride);
 function queue(name="q",{executionMode="poll",snapshotAdd={}}={}){
  req.idempotencyKey=name;
  return submitJob(db,{idempotencyKey:name,requestFingerprint:name,executionMode,snapshot:{
   adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:tplt,comfyRequest:structuredClone(req),...snapshotAdd
  }}).jobId;
 }
 const row=id=>db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
 return {db,dir,blobStore,queue,adapters,row,tplt,req};
}
function mockTransport({errorAt,failDownloadOnce=false,workflowNodeId="wf-1"}={}){
 const calls=[],prompts=[];let historyCount=0,downloadFailed=false;
 const mock=async(instance,path,opts={})=>{
  assert.equal(instance.url,"http://127.0.0.1:8188");
  calls.push(path);
  if(path==="/object_info")return info;
  if(path==="/upload/image")return {name:opts.body.get("image").name,type:"input",subfolder:""};
  if(path==="/prompt"){
   prompts.push(JSON.parse(opts.body));
   if(errorAt==="lost_response")throw Error("network connection reset after POST");
   if(errorAt==="validation")throw Object.assign(Error("comfy_prompt_rejected"),{confirmedNotAccepted:true});
   return {prompt_id:"remote-test"};
  }
  if(path==="/history/remote-test"){
   historyCount++;
   if(errorAt==="pending"&&historyCount===1)return {};
   return {"remote-test":{status:{completed:true,status_str:"success"},outputs:{
    ["w_"+workflowNodeId+"__capture_image"]:{images:[
     {filename:"one.png",subfolder:"",type:"output"},
     {filename:"two.png",subfolder:"",type:"output"}]},
    ["w_"+workflowNodeId+"__5"]:{images:[{filename:"movie.mp4",type:"output"}]},
    ["w_"+workflowNodeId+"__6"]:{audio:[{filename:"sound.wav",type:"output"}]},
    ["w_"+workflowNodeId+"__7"]:{text:["generated text",""]}
   }}};
  }
  if(path.startsWith("/view?")){
   const name=new URL("http://localhost"+path).searchParams.get("filename");
   if(failDownloadOnce&&name==="movie.mp4"&&!downloadFailed){
    downloadFailed=true;throw Error("download interrupted");
   }
   const [bytes,mime]=name==="movie.mp4"?[mp4,"video/mp4"]:
    name==="sound.wav"?[wav,"audio/wav"]:[png,"image/png"];
   // Exercise streaming capture path, not an in-memory fake storage write.
   if(opts.receive)return opts.receive(Readable.from([bytes.subarray(0,7),bytes.subarray(7)]),mime);
   return {bytes,mime};
  }
  throw Error("unexpected upstream: "+path);
 };
 return {mock,calls,prompts};
}


test("P4.8 Comfy unknown response reconciles only matching history marker and exact frozen graph",async t=>{
 const base=mockTransport({errorAt:"lost_response"});
 let scenario="absent";
 const transport=async(instance,path,opts)=>{
  if(path==="/history/remote-test"){
   if(scenario==="absent")return {};
   const original=await base.mock(instance,path,opts);
   const entry=original["remote-test"];
   const sent=base.prompts[0];
   const proof={...sent.extra_data};
   if(scenario==="wrong-marker")proof.infinite_atelier_submit_marker="wrong";
   const graph=scenario==="wrong-graph"?{...sent.prompt,rogue:{class_type:"unrelated"}}:sent.prompt;
   const extra={client_id:sent.client_id,extra_data:proof};
   if(scenario==="wrong-client")extra.client_id="unknown-client";
   return {"remote-test":{...entry,prompt:[0,graph,extra],
    ...(scenario==="pending"?{status:{status_str:"running",completed:false}}:{})}};
  }
  return base.mock(instance,path,opts);
 };
 const f=fixture(t,{transport});
 const workflow={id:"wf-1",type:"comfy:workflow",title:"workflow",
  position:{x:0,y:0},width:400,height:280,
  metadata:{comfyPorts:f.tplt.ports.map(port=>({
   id:port.id,label:port.label,direction:port.direction,valueKind:port.valueKind}))}};
 const document={nodes:[workflow],connections:[]};
 createProject(f.db,{id:"test-project",document});
 const id=submitJob(f.db,{projectId:"test-project",targetNodeId:"wf-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(document,"wf-1"),
  idempotencyKey:"test-click",requestFingerprint:"test-click",executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:f.tplt,
   comfyRequest:structuredClone(f.req)}}).jobId;
 const coordinator=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.row(id).status,"submission_unknown");
 assert.equal(base.prompts.length,1);
 const reconcile=()=>coordinator.reconcileUnknown({jobId:id,projectId:"test-project",remoteTaskId:"remote-test"});
 assert.equal((await reconcile()).reason,"remote_evidence_absent");
 for(const name of ["wrong-marker","wrong-graph","wrong-client"]){
  scenario=name;
  assert.equal((await reconcile()).reason,"remote_evidence_mismatch",name);
  assert.equal(f.row(id).status,"submission_unknown");
 }
 scenario="pending";
 assert.deepEqual(await reconcile(),{verified:true,status:"running"});
 assert.equal(f.row(id).upstream_task_id,"remote-test");
 scenario="success";
 await coordinator.tick();
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(base.prompts.length,1,"no second Comfy /prompt after user reconciliation");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,6);
 const restored=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await restored.runOnce()).filter(row=>row.status==="materialized").length,6);
});
test("P4.8 Comfy matched failed history confirms original failure without another submit",async t=>{
 const base=mockTransport({errorAt:"lost_response"});
 const transport=async(instance,path,opts)=>{
  if(path==="/history/remote-test")return {"remote-test":{
   prompt:[0,base.prompts[0].prompt,{
    client_id:base.prompts[0].client_id,extra_data:base.prompts[0].extra_data
   }],status:{status_str:"error",completed:false},outputs:{}
  }};
  return base.mock(instance,path,opts);
 };
 const f=fixture(t,{transport});
 const document={nodes:[{id:"wf-1",type:"comfy:workflow",
  position:{x:0,y:0},width:400,height:280,metadata:{}}],connections:[]};
 createProject(f.db,{id:"test-project",document});
 const id=submitJob(f.db,{projectId:"test-project",targetNodeId:"wf-1",
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(document,"wf-1"),
  idempotencyKey:"test-click",requestFingerprint:"test-click",executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:f.tplt,
   comfyRequest:structuredClone(f.req)}}).jobId;
 const c=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"submission_unknown");
 assert.deepEqual(await c.reconcileUnknown({jobId:id,projectId:"test-project",
  remoteTaskId:"remote-test"}),{verified:true,status:"failed"});
 assert.equal(f.row(id).status,"failed");
 assert.equal(base.prompts.length,1);
});
test("VIDEO/AUDIO media-file inputs compile only with matching verified staged media, never author filenames",async t=>{
 const upstream=[];
 const extraInfo={
  ...info,
  VHS_LoadVideo:{input:{required:{video:[["author_clip.mp4"],{"video_upload":true}]}},output:["VIDEO"]},
  LoadAudio:{input:{required:{audio:[["author_audio.wav"],{"audio_upload":true}]}},output:["AUDIO"]}
 };
 const mock=async(_instance,path,opts={})=>{
  if(path==="/object_info")return extraInfo;
  if(path==="/upload/image"){
   const entry=opts.body.get("image");
   upstream.push({name:entry.name,mime:entry.type,bytes:Buffer.from(await entry.arrayBuffer())});
   return {name:entry.name,type:"input",subfolder:""};
  }
  if(path==="/prompt")return {prompt_id:"accepted-media"};
  throw Error("unexpected upstream "+path);
 };
 const f=fixture(t,{transport:mock});
 const video=await f.blobStore.put(Readable.from([mp4]),{mime:"video/mp4"});
 const audio=await f.blobStore.put(Readable.from([wav]),{mime:"audio/wav"});
 f.tplt.apiGraph["8"]={class_type:"VHS_LoadVideo",inputs:{video:"author_clip.mp4"}};
 f.tplt.apiGraph["9"]={class_type:"LoadAudio",inputs:{audio:"author_audio.wav"}};
 f.tplt.ports.find(port=>port.id==="video").outputBinding={nodeId:"8",outputIndex:0};
 f.tplt.ports.find(port=>port.id==="audio").outputBinding={nodeId:"9",outputIndex:0};
 f.tplt.ports.push(
  {id:"video_input",label:"Clip",direction:"target",valueKind:"VIDEO",required:true,
   inputBinding:{mode:"media-file",mediaKind:"VIDEO",targets:[{nodeId:"8",inputName:"video"}]}},
  {id:"audio_input",label:"Sound",direction:"target",valueKind:"AUDIO",required:true,
   inputBinding:{mode:"media-file",mediaKind:"AUDIO",targets:[{nodeId:"9",inputName:"audio"}]}}
 );
 f.tplt.requirements.classTypes=[...new Set(Object.values(f.tplt.apiGraph).map(node=>node.class_type))].sort();
 f.tplt.revision=sha256(canonical({name:f.tplt.name,apiGraph:f.tplt.apiGraph,
  ports:f.tplt.ports,requirements:f.tplt.requirements}));
 f.req.nodes[0].templateRevision=f.tplt.revision;
 f.req.edges.push(
  {fromNodeId:"clip",fromPortId:"video",toNodeId:"wf-1",toPortId:"video_input"},
  {fromNodeId:"sound",fromPortId:"audio",toNodeId:"wf-1",toPortId:"audio_input"}
 );
 f.req.externalInputs.push(
  {kind:"asset",sourceNodeId:"clip",sourcePortId:"video",valueKind:"VIDEO",assetId:video.blobId,sha256:video.sha256},
  {kind:"asset",sourceNodeId:"sound",sourcePortId:"audio",valueKind:"AUDIO",assetId:audio.blobId,sha256:audio.sha256}
 );
 assert.doesNotThrow(()=>validateSingleRequest(f.req));
 assert.throws(()=>compileSingleWorkflow(f.req,f.tplt,{info:extraInfo,mediaFiles:{}}),/staged_media_not_uploaded/);
 const pinned={
  [video.blobId]:"atelier_"+video.sha256+".mp4",
  [audio.blobId]:"atelier_"+audio.sha256+".wav"
 };
 const compiled=compileSingleWorkflow(f.req,f.tplt,{info:extraInfo,mediaFiles:pinned});
 assert.equal(compiled.graph["w_wf-1__8"].inputs.video,pinned[video.blobId]);
 assert.equal(compiled.graph["w_wf-1__9"].inputs.audio,pinned[audio.blobId]);
 assert.equal(compiled.graph["w_wf-1__8"].class_type,"VHS_LoadVideo");
 const withoutImageLoader=structuredClone(extraInfo);
 delete withoutImageLoader.LoadImage;
 assert.doesNotThrow(()=>compileSingleWorkflow(f.req,f.tplt,{info:withoutImageLoader,mediaFiles:pinned}));
 const invalid=structuredClone(f.req);
 invalid.externalInputs[0].valueKind="IMAGE";
 assert.throws(()=>validateSingleRequest(invalid),/external_asset_invalid/);
 // The compiler binds filenames by asset ID; the adapter independently
 // validates immutable CAS SHA-256 and media MIME before any upstream upload.
 const id=f.queue("media-input");
 const coordinator=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 coordinator.recoverAtStartup();
 await coordinator.tick();
 assert.equal(f.row(id).status,"running");
 assert.equal(upstream.length,2);
 assert.deepEqual(upstream.map(file=>file.mime).sort(),["audio/wav","video/mp4"]);
 assert.ok(upstream.some(file=>file.bytes.equals(mp4)));
 assert.ok(upstream.some(file=>file.bytes.equals(wav)));
 assert.equal(JSON.parse(f.db.prepare("SELECT graph_json FROM comfy_job_preparations WHERE job_id=?").get(id).graph_json)["w_wf-1__8"].inputs.video,pinned[video.blobId]);
});
test("backend rejects a CAS video masquerading as IMAGE before any Comfy upload or GPU submit",async t=>{
 const calls=[];
 const f=fixture(t,{reference:true,transport:async(_instance,path)=>{
  calls.push(path);
  if(path==="/object_info")return info;
  throw Error("upstream must never receive invalid media: "+path);
 }});
 const video=await f.blobStore.put(Readable.from([mp4]),{mime:"video/mp4"});
 f.req.edges.push({fromNodeId:"image-source",fromPortId:"image",toNodeId:"wf-1",toPortId:"source"});
 f.req.externalInputs.push({kind:"asset",sourceNodeId:"image-source",sourcePortId:"image",
  valueKind:"IMAGE",assetId:video.blobId,sha256:video.sha256});
 const id=f.queue("wrong-media-kind");
 const coordinator=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.row(id).status,"failed");
 assert.deepEqual(calls,["/object_info"]);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM comfy_job_preparations WHERE job_id=?").get(id).n,0);
});
test("Comfy compiler preserves colon-prefixed Canvas node IDs in capture mapping",()=>{
 const tplt=template(),req=request(tplt);
 const nodeId="comfy:workflow-1792758417919-co36n";
 req.nodes[0].id=nodeId;
 req.rootOutputs=req.rootOutputs.map(out=>({...out,nodeId}));
 assert.doesNotThrow(()=>validateSingleRequest(req));
 const compiled=compileSingleWorkflow(req,tplt,{info,imageFiles:{}});
 assert.equal(compiled.captureMap.length,4);
 assert.ok(compiled.captureMap.every(cap=>cap.workflowNodeId===nodeId));
 assert.ok(Object.keys(compiled.graph).some(id=>id.startsWith("w_"+nodeId+"__capture_")));
});

test("colon-prefixed workflow project can submit, capture and materialize all six artifacts",async t=>{
 const workflowNodeId="comfy:workflow-1792758417919-co36n";
 const transport=mockTransport({workflowNodeId});
 const f=fixture(t,{transport:transport.mock});
 const projectId="import-demo";
 const source={id:workflowNodeId,type:"comfy:workflow",title:"Imported workflow",
  position:{x:100,y:200},width:450,height:360,
  metadata:{comfyPorts:f.tplt.ports.map(port=>({id:port.id,label:port.label,
   direction:port.direction,valueKind:port.valueKind}))}
 };
 const document={nodes:[source],connections:[]};
 const project=createProject(f.db,{id:projectId,document});
 assert.equal(project.revision,1);
 const req=structuredClone(f.req);
 req.projectId=projectId;req.idempotencyKey="colon-import";
 req.nodes[0].id=workflowNodeId;
 req.rootOutputs=req.rootOutputs.map(item=>({...item,nodeId:workflowNodeId}));
 const jobId=submitJob(f.db,{projectId,targetNodeId:workflowNodeId,expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(document,workflowNodeId),
  idempotencyKey:"colon-import",requestFingerprint:"colon-import",executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:f.tplt,comfyRequest:req}
 }).jobId;
 const coordinator=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 coordinator.recoverAtStartup();await coordinator.tick();await coordinator.tick();
 assert.equal(f.row(jobId).status,"succeeded");
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const results=await materializer.runOnce();
 assert.equal(results.filter(item=>item.status==="materialized").length,6,JSON.stringify(results));
 const updated=getProject(f.db,projectId);
 assert.equal(updated.document.nodes.length,7);
 assert.equal(updated.document.connections.length,6);
 assert.ok(updated.document.connections.every(edge=>edge.fromNodeId===workflowNodeId));
 assert.equal(updated.document.nodes[0].id,workflowNodeId);
 assert.equal(transport.prompts.length,1);
});
test("adapter factory rejects external and malformed Comfy instance destinations",t=>{
 const f=fixture(t,{transport:async()=>info});
 for(const url of ["http://8.8.8.8:8188","https://127.0.0.1:8188",
  "http://localhost:8188","http://127.0.0.1:8188/path","http://127.0.0.1"]){
  assert.throws(()=>createComfyV2Adapters({instances:[{id:"evil",url}],db:f.db,blobStore:f.blobStore}),/comfy_instance_must_be_exact_loopback_origin/);
 }
 assert.throws(()=>createComfyV2Adapters({instances:[{id:"comfy-local",url:"http://127.0.0.1:8188"},
   {id:"comfy-local",url:"http://127.0.0.1:8188"}],db:f.db,blobStore:f.blobStore}),/duplicate_comfy_instance/);
});
test("new coordinator compiles V2 graph, pins before /prompt, imports two images/video/audio/empty text",async t=>{
 const transport=mockTransport();
 const f=fixture(t,{transport:transport.mock});
 const id=f.queue("mixed-v2");
 const c=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 c.recoverAtStartup();
 await c.tick();assert.equal(f.row(id).status,"running");
 const prep=f.db.prepare("SELECT * FROM comfy_job_preparations WHERE job_id=?").get(id);
 assert.ok(prep);
 const sent=transport.prompts[0];
 assert.equal(sent.client_id, f.db.prepare("SELECT id FROM job_attempts WHERE job_id=?").get(id).id);
 assert.equal(sent.extra_data.infinite_atelier_submit_marker,f.row(id).submit_marker);
 assert.equal(sha256(canonical(sent.prompt)),prep.graph_hash);
 assert.equal(JSON.parse(prep.capture_map_json).length,4);
 assert.ok(sent.prompt["w_wf-1__capture_image"]);
 await c.tick();assert.equal(f.row(id).status,"succeeded");
 assert.equal(transport.prompts.length,1);
 const artifacts=f.db.prepare("SELECT * FROM artifacts WHERE job_id=? ORDER BY port_id,item_key").all(id);
 assert.equal(artifacts.length,6);
 assert.deepEqual(artifacts.map(x=>x.kind).sort(),["audio","image","image","text","text","video"]);
 for(const a of artifacts){
  const meta=JSON.parse(a.metadata_json);
  assert.equal(meta.comfyArtifact.workflowNodeId,"wf-1");
  assert.equal(meta.comfyArtifact.runId,id);
  assert.equal(meta.comfyArtifact.portId,a.port_id);
  assert.equal(meta.comfyArtifact.artifactId,a.id);
  const file=await f.blobStore.stat(a.blob_id);
  assert.equal(file.sha256,a.sha256);
 }
 assert.equal(transport.calls.filter(x=>x==="/prompt").length,1);
 await c.tick();assert.equal(transport.prompts.length,1);
});
test("download interruption preserves partial captures and retries collection without another /prompt",async t=>{
 const transport=mockTransport({failDownloadOnce:true});
 const f=fixture(t,{transport:transport.mock});
 const id=f.queue("retry");
 const c=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 c.recoverAtStartup();await c.tick();await c.tick();
 assert.equal(f.row(id).status,"collecting");
 const done=f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n;
 assert.ok(done>=2);
 await c.tick();
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,6);
 assert.equal(transport.prompts.length,1);
 assert.equal(transport.calls.filter(x=>x.startsWith("/view?")&&x.includes("one.png")).length,1);
});
test("Comfy confirmed 422 allows terminal failure; ambiguous POST response survives restart without resubmission",async t=>{
 const first=mockTransport({errorAt:"validation"});
 const f=fixture(t,{transport:first.mock});
 const id=f.queue("reject");
 const c=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 c.recoverAtStartup();await c.tick();
 assert.equal(f.row(id).status,"failed");
 assert.equal(first.prompts.length,1);
 // Simulate a second job using an injected /prompt that may have been accepted.
 const unstable=mockTransport({errorAt:"lost_response"});
 const ids=f.queue("unknown");
 const adapters=createComfyV2Adapters({instances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
  db:f.db,blobStore:f.blobStore,upstreamCall:unstable.mock});
 const restarted=createJobCoordinator({db:f.db,adapters:{comfy:adapters}});
 restarted.recoverAtStartup();await restarted.tick();
 assert.equal(f.row(ids).status,"submission_unknown");
 assert.equal(unstable.prompts.length,1);
 const newProcess=createJobCoordinator({db:f.db,adapters:{comfy:adapters}});
 newProcess.recoverAtStartup();await newProcess.tick();
 assert.equal(unstable.prompts.length,1);
});
test("reference-image snapshot uses validated blob digest, deterministic Comfy upload filename, and one GPU POST",async t=>{
 const captured=[];
 const transport=async(instance,path,opts={})=>{
  if(path==="/object_info")return info;
  if(path==="/upload/image"){
   const img=opts.body.get("image");
   captured.push({name:img.name,size:img.size});
   return {name:img.name,type:"input",subfolder:""};
  }
  if(path==="/prompt"){captured.push(JSON.parse(opts.body));return{prompt_id:"remote-img"}}
  if(path==="/history/remote-img")return {"remote-img":{status:{completed:true,status_str:"success"},outputs:{
   "w_wf-1__capture_image":{images:[{filename:"ref.png",type:"output"}]}
  }}};
  if(path.startsWith("/view?"))return opts.receive(Readable.from([png]),"image/png");
  throw Error("unexpected: "+path);
 };
 const f=fixture(t,{transport,reference:true});
 const stored=await f.blobStore.put([png],{mime:"image/png"});
 const req=request(f.tplt,{reference:true,asset:stored.blobId});
 const id=submitJob(f.db,{idempotencyKey:"reference-1",requestFingerprint:"reference-1",executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:f.tplt,
    comfyRequest:{...req,idempotencyKey:"reference-1"}}}).jobId;
 const c=createJobCoordinator({db:f.db,adapters:{comfy:f.adapters}});
 c.recoverAtStartup();await c.tick();await c.tick();
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(captured[0].name,"atelier_"+stored.sha256+".png");
 assert.equal(captured[0].size,png.length);
 assert.equal(captured[1].prompt["w_wf-1__loader_source"].inputs.image,captured[0].name);
 assert.equal(captured.filter(x=>x.prompt).length,1);
});
test("runtime HTTP + explicit Comfy adapter wiring never drives old V2 gateway",async t=>{
 if(process.platform!=="win32")return;
 const dir=mkdtempSync(join(tmpdir(),"atelier-comfy-runtime-"));
 const tpt=template(),calls=mockTransport();
 let runtime;
 try{
  runtime=createLocalBackend({dataDir:dir,comfyInstances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
   comfyUpstreamCall:calls.mock});
  const app=runtime.app,token=runtime.sessionAuth.bootstrapToken;
  const login=await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{
   host:"localhost",origin:"http://localhost",authorization:"Bearer "+token}});
  assert.equal(login.statusCode,201);
  const headers={host:"localhost",origin:"http://localhost",
   cookie:login.headers["set-cookie"].split(";")[0],"x-atelier-csrf":login.json().csrfToken};
  const req=request(tpt);req.idempotencyKey="api-1";
  const created=await app.inject({method:"POST",url:"/api/v1/jobs",headers,
   payload:{idempotencyKey:"api-1",requestFingerprint:"api-1",executionMode:"poll",
    snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyRequest:req,comfyTemplate:tpt}}});
  assert.equal(created.statusCode,201,created.body);
  assert.equal(calls.prompts.length,0);
  await runtime.coordinator.tick();await runtime.coordinator.tick();
  const result=await app.inject({method:"GET",url:"/api/v1/jobs/"+created.json().id+"/artifacts",headers});
  assert.equal(result.statusCode,200,result.body);
  assert.equal(result.json().artifacts.length,6);
  assert.ok(result.json().artifacts.every(x=>x.metadata.comfyArtifact));
  assert.equal(calls.prompts.length,1);
 }finally{if(runtime)await runtime.close();rmSync(dir,{recursive:true,force:true})}
});
test("native Comfy HTTP transport submits exactly once and streams four outputs",async t=>{
 let posts=0,views=0;
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1");
  const json=(code,body)=>{res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(body))};
  if(url.pathname==="/object_info")return json(200,info);
  if(url.pathname==="/prompt"){
   posts++;
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const sent=JSON.parse(Buffer.concat(chunks).toString("utf8"));
   assert.ok(sent.extra_data.infinite_atelier_submit_marker);
   assert.ok(sent.prompt["w_wf-1__capture_image"]);
   return json(200,{prompt_id:"native-id"});
  }
  if(url.pathname==="/history/native-id")return json(200,{"native-id":{
   status:{completed:true,status_str:"success"},outputs:{
    "w_wf-1__capture_image":{images:[{filename:"still.png",subfolder:"",type:"output"}]},
    "w_wf-1__5":{images:[{filename:"clip.mp4",subfolder:"",type:"output"}]},
    "w_wf-1__6":{audio:[{filename:"voice.wav",subfolder:"",type:"output"}]},
    "w_wf-1__7":{text:["native result"]}
   }
  }});
  if(url.pathname==="/view"){
   views++;
   const file=url.searchParams.get("filename");
   const [bytes,mime]=file==="clip.mp4"?[mp4,"video/mp4"]:
    file==="voice.wav"?[wav,"audio/wav"]:[png,"image/png"];
   res.writeHead(200,{"content-type":mime});
   res.write(bytes.subarray(0,7));return res.end(bytes.subarray(7));
  }
  return json(404,{error:"not found"});
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve))});
 const url="http://127.0.0.1:"+server.address().port;
 const f=fixture(t,{transport:mockTransport().mock});
 const adapters=createComfyV2Adapters({instances:[{id:"comfy-local",url}],db:f.db,blobStore:f.blobStore});
 const id=f.queue("network");
 const coordinator=createJobCoordinator({db:f.db,adapters:{comfy:adapters}});
 coordinator.recoverAtStartup();await coordinator.tick();
 assert.equal(f.row(id).upstream_task_id,"native-id");
 await coordinator.tick();
 assert.equal(f.row(id).status,"succeeded");
 assert.equal(posts,1);assert.equal(views,3);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(id).n,4);
});
test("Demo HTTP save barrier -> auto Comfy dispatch -> typed CanvasMaterializer and SSE",async t=>{
 if(process.platform!=="win32")return;
 const dir=mkdtempSync(join(tmpdir(),"atelier-comfy-demo-e2e-"));
 const transport=mockTransport(),tplt=template();
 let runtime;
 try{
  runtime=createLocalBackend({dataDir:dir,autoDispatch:true,dispatchIntervalMs:25,
   comfyInstances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
   comfyUpstreamCall:transport.mock});
  const app=runtime.app,token=runtime.sessionAuth.bootstrapToken;
  const login=await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{
   host:"localhost",origin:"http://localhost",authorization:"Bearer "+token}});
  assert.equal(login.statusCode,201);
  const headers={host:"localhost",origin:"http://localhost",
   cookie:login.headers["set-cookie"].split(";")[0],"x-atelier-csrf":login.json().csrfToken};
  const capabilities=await app.inject({method:"GET",url:"/api/v1/execution/capabilities",headers});
  assert.deepEqual(capabilities.json(),{autoDispatch:true,comfyInstanceIds:["comfy-local"],arkAssetUploadReady:false});
  const node={id:"wf-1",type:"comfy:workflow",title:"Demo",width:410,height:290,
   position:{x:10,y:20},metadata:{
    comfyWorkflow:{templateId:tplt.id,templateRevision:tplt.revision,bindingState:"bound",inputOverrides:{}},
    comfyPorts:tplt.ports.map(port=>({id:port.id,label:port.label,
     direction:port.direction,valueKind:port.valueKind}))
   }};
  const doc={nodes:[node],connections:[]},projectId="demo-project";
  const created=await app.inject({method:"POST",url:"/api/v1/projects",headers,
   payload:{id:projectId,document:doc}});
  assert.equal(created.statusCode,201,created.body);
  const req=request(tplt);
  req.projectId=projectId;req.canvasRevision="1";req.idempotencyKey="demo-click";
  const payload={projectId,targetNodeId:"wf-1",expectedProjectRevision:1,
   sourceNodeFingerprint:fingerprintSource(doc,"wf-1"),idempotencyKey:"demo-click",
   requestFingerprint:"demo-click",executionMode:"poll",
   snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyRequest:req,comfyTemplate:tplt}};
  const stale=await app.inject({method:"POST",url:"/api/v1/jobs",headers,
   payload:{...payload,idempotencyKey:"stale-click",requestFingerprint:"stale-click",
    expectedProjectRevision:3,snapshot:{...payload.snapshot,
     comfyRequest:{...req,idempotencyKey:"stale-click"}}}});
  assert.equal(stale.statusCode,409);
  assert.equal(transport.prompts.length,0);
  const queued=await app.inject({method:"POST",url:"/api/v1/jobs",headers,payload});
  assert.equal(queued.statusCode,201,queued.body);
  let project;
  for(let i=0;i<160;i++){
   await new Promise(resolve=>setTimeout(resolve,25));
   const result=await app.inject({method:"GET",url:"/api/v1/projects/"+projectId,headers});
   project=result.json();
   if(project.revision===7)break;
  }
  assert.equal(project?.revision,7,JSON.stringify(project));
  assert.deepEqual(project.document.nodes.slice(1).map(n=>n.type).sort(),
   ["audio","image","image","text","text","video"]);
  assert.equal(project.document.connections.length,6);
  assert.ok(project.document.connections.every(edge=>edge.fromNodeId==="wf-1"&&
   edge.toPortId==="comfy-artifact"));
  assert.equal(transport.prompts.length,1);
  const events=await app.inject({method:"GET",url:"/api/v1/events?after=0&once=1",headers});
  assert.equal(events.statusCode,200);assert.match(events.body,/artifact_materialized/);
  const replay=await app.inject({method:"POST",url:"/api/v1/jobs",headers,payload});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().id,queued.json().id);
  assert.equal(transport.prompts.length,1);
 }finally{if(runtime)await runtime.close();rmSync(dir,{recursive:true,force:true})}
});
