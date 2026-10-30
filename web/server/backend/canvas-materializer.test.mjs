import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createCanvasMaterializer} from "./canvas-materializer.mjs";
import {createProject,getProject,patchProject,saveSingleUserCanvas} from "./projects.mjs";
import {fingerprintSource,fingerprintSourceLegacy,submitJob,appendArtifact,transitionJob,readEventsAfter} from "./repository.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createBackendWorker} from "./worker.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {buildApp} from "./app.mjs";
import {randomUUID} from "node:crypto";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]);
const mp4=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const wav=Buffer.from("524946460800000057415645666d7420","hex");
const kinds=[["image","image",png,"image/png","IMAGE"],["video","video",mp4,"video/mp4","VIDEO"],["audio","audio",wav,"audio/wav","AUDIO"],["text","result",Buffer.from("hello"),"text/plain","STRING"]];
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"atelier-materialization-")),db=new DatabaseSync(":memory:");
 initializeSchema(db);
 const blobStore=createBlobStore({dataDir:dir,db});
 const materializer=createCanvasMaterializer({db,blobStore});
 const source={id:"wf-1",type:"comfy:workflow",title:"Comfy",position:{x:12,y:24},width:400,height:300,metadata:{
  comfyPorts:kinds.map(([kind,port,, ,valueKind])=>({id:port,label:port,direction:"source",valueKind}))}};
 const doc={nodes:[source],connections:[]};
 createProject(db,{id:"project-1",document:doc});
 const fingerprint=fingerprintSource(doc,"wf-1");
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 async function addArtifacts({key="job1",count=kinds.length}={}){
  const jobId=submitJob(db,{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:1,sourceNodeFingerprint:fingerprint,
   idempotencyKey:key,requestFingerprint:key,executionMode:"poll",snapshot:{adapterKind:"comfy",instanceId:"comfy-local"}}).jobId;
  const created=[];
  for(let index=0;index<count;index++){
   const [kind,port,bytes,mime]=kinds[index];
   const blob=await blobStore.put([bytes],{mime});
   const artifactId="a-"+key+"-"+index;
   appendArtifact(db,{id:artifactId,jobId,portId:port,itemKey:"item-"+index,blobId:blob.blobId,kind,mime,sha256:blob.sha256,
    metadata:{comfyArtifact:{runId:jobId,artifactId,workflowNodeId:"wf-1",portId:port,kind,index}}});
   created.push(artifactId);
  }
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
  return {jobId,created};
 }
 return {db,blobStore,materializer,source,doc,fingerprint,addArtifacts};
}
test("OpenAI-compatible text fills the originally empty source node without creating an output node",async t=>{
 const f=fixture(t),projectId="compatible-text-project",sourceNodeId="text-1793275584701-j8nx2";
 const original={nodes:[{id:sourceNodeId,type:"text",title:"Text prompt",
  position:{x:24,y:36},width:360,height:220,metadata:{prompt:"Who are you?"}}],
  connections:[]};
 createProject(f.db,{id:projectId,document:original});
 const model="deepseek/deepseek-v4.1-flash-1017";
 const jobId=submitJob(f.db,{projectId,targetNodeId:sourceNodeId,
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(original,sourceNodeId),
  idempotencyKey:"compatible-text-1",requestFingerprint:"compatible-text-1",
  executionMode:"immediate",snapshot:{adapterKind:"model",provider:"openai_compatible",
   endpointBaseUrl:"https://api.cline.bot/api/v1",
   task:{kind:"text",model,prompt:"Who are you?"}}}).jobId;
 const blob=await f.blobStore.put([Buffer.from("Text completed successfully","utf8")],{mime:"text/plain"});
 const artifactId="compatible-text-artifact";
 appendArtifact(f.db,{id:artifactId,jobId,portId:"text",itemKey:"0",
  blobId:blob.blobId,sha256:blob.sha256,mime:blob.mimeType,kind:"text",
  metadata:{modelGeneration:{kind:"text",model}}});
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("old-blocked-entry",jobId,artifactId,projectId,"blocked","materialization_port_mismatch");
 assert.equal(f.materializer.retryBlocked({projectId,artifactId}),true);
 const output=await f.materializer.runOnce();
 assert.deepEqual(output.map(r=>r.status),["materialized"]);
 assert.equal(output[0].nodeId,sourceNodeId);
 const after=getProject(f.db,projectId);
 assert.equal(after.document.nodes.length,1);
 assert.equal(after.document.connections.length,0);
 const result=after.document.nodes[0];
 assert.equal(result.id,sourceNodeId);
 assert.equal(result.title,"Text prompt");
 assert.equal(result.metadata.prompt,"Who are you?");
 assert.equal(result.metadata.content,"Text completed successfully");
 assert.equal(result.metadata.status,"success");
 assert.deepEqual(result.metadata.modelArtifact,{jobId,artifactId,sourceNodeId,kind:"text",model});
 assert.equal(f.materializer.status({jobId})[0].node_id,sourceNodeId);
 assert.deepEqual(await f.materializer.runOnce(),[]);
 assert.equal(getProject(f.db,projectId).revision,2);
 // An older autosave must not erase the model's in-place output.
 const saved=saveSingleUserCanvas(f.db,{id:projectId,expectedRevision:1,document:original});
 assert.equal(saved.document.nodes.length,1);
 assert.equal(saved.document.nodes[0].metadata.content,"Text completed successfully");
 assert.equal(saved.document.nodes[0].metadata.modelArtifact.artifactId,artifactId);
});test("nonempty Text sources and sources edited during model generation keep their text and get a separate artifact",async t=>{
 for(const scenario of [
  {id:"existing",initial:"User's draft",edited:null,expected:"User's draft"},
  {id:"edited-during-run",initial:"",edited:"Typed while generating",expected:"Typed while generating"},
 ])await t.test(scenario.id,async child=>{
  const f=fixture(child),projectId="text-"+scenario.id;
  const node={id:"text-source",type:"text",title:"Original",position:{x:0,y:0},width:320,height:180,
   metadata:{content:scenario.initial,prompt:"Write a paragraph"}};
  const original={nodes:[node],connections:[]};
  createProject(f.db,{id:projectId,document:original});
  const jobId=submitJob(f.db,{projectId,targetNodeId:node.id,
   expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(original,node.id),
   idempotencyKey:scenario.id,requestFingerprint:scenario.id,executionMode:"immediate",
   snapshot:{adapterKind:"model",provider:"openai",task:{kind:"text",model:"gpt-example",prompt:"Write a paragraph"}}}).jobId;
  const artifactId="result-"+scenario.id;
  const blob=await f.blobStore.put([Buffer.from("Generated answer")],{mime:"text/plain"});
  appendArtifact(f.db,{id:artifactId,jobId,portId:"text",itemKey:"0",
   blobId:blob.blobId,sha256:blob.sha256,mime:blob.mimeType,kind:"text",
   metadata:{modelGeneration:{kind:"text",model:"gpt-example"}}});
  f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
  if(scenario.edited!==null){
   const next=getProject(f.db,projectId);
   next.document.nodes[0].metadata.content=scenario.edited;
   patchProject(f.db,{id:projectId,expectedRevision:1,document:next.document});
  }
  const materialized=await f.materializer.runOnce();
  assert.deepEqual(materialized.map(item=>item.status),["materialized"]);
  const graph=getProject(f.db,projectId).document;
  assert.equal(graph.nodes.length,2);
  assert.equal(graph.connections.length,1);
  assert.equal(graph.nodes[0].metadata.content,scenario.expected);
  assert.equal(graph.nodes[0].metadata.modelArtifact,undefined);
  const output=graph.nodes[1];
  assert.equal(output.id,"artifact-"+artifactId);
  assert.equal(output.metadata.content,"Generated answer");
  assert.equal(output.metadata.sourceChangedSinceSubmit,scenario.edited!==null?true:undefined);
  assert.equal(graph.connections[0].toNodeId,output.id);
 });
});
test("compatible model materialization retains strict kind/port and source validation",async t=>{
 const f=fixture(t),projectId="compatible-validation-project";
 const node={id:"text-source",type:"text",title:"Text",position:{x:0,y:0},
  width:320,height:180,metadata:{prompt:"hello"}};
 const original={nodes:[node],connections:[]};
 createProject(f.db,{id:projectId,document:original});
 const jobId=submitJob(f.db,{projectId,targetNodeId:node.id,
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(original,node.id),
  idempotencyKey:"misbound",requestFingerprint:"misbound",executionMode:"immediate",
  snapshot:{adapterKind:"model",provider:"openai_compatible",
   task:{kind:"text",model:"deepseek/deepseek-v4.1-flash-1017",prompt:"hello"}}}).jobId;
 const blob=await f.blobStore.put([Buffer.from("hello","utf8")],{mime:"text/plain"});
 appendArtifact(f.db,{id:"bad-port",jobId,portId:"wrong-port",itemKey:"0",
  blobId:blob.blobId,sha256:blob.sha256,mime:blob.mimeType,kind:"text",
  metadata:{modelGeneration:{kind:"text",model:"deepseek/deepseek-v4.1-flash-1017"}}});
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"blocked");
 assert.equal(result[0].reason,"materialization_port_mismatch");
 assert.equal(getProject(f.db,projectId).document.nodes.length,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("four artifact kinds become typed connected nodes and project revision advances atomically",async t=>{
 const f=fixture(t);
 const {jobId,created}=await f.addArtifacts();
 const result=await f.materializer.runOnce();
 assert.equal(result.length,4);
 assert.ok(result.every(r=>r.status==="materialized"));
 const project=getProject(f.db,"project-1");
 assert.equal(project.revision,5);
 assert.equal(project.document.nodes.length,5);
 assert.equal(project.document.connections.length,4);
 for(const [i,artifactId] of created.entries()){
  const output=project.document.nodes.find(n=>n.id==="artifact-"+artifactId);
  const [kind,port,,,] = kinds[i];
  assert.equal(output.type,kind);
  assert.equal(output.metadata.comfyArtifact.artifactId,artifactId);
  assert.equal(output.metadata.comfyArtifact.workflowNodeId,"wf-1");
  assert.equal(output.metadata.comfyArtifact.portId,port);
  assert.equal(output.metadata.status,"success");
  const edge=project.document.connections.find(e=>e.toNodeId===output.id);
  assert.equal(edge.fromNodeId,"wf-1");
  assert.equal(edge.fromPortId,port);
  assert.equal(edge.toPortId,"comfy-artifact");
  if(kind==="text")assert.equal(output.metadata.content,"hello");
  else assert.match(output.metadata.content,/^\/api\/v1\/blobs\/[a-f0-9]{64}$/);
 }
 assert.equal(f.materializer.status({jobId}).length,4);
 assert.equal((await f.materializer.runOnce()).length,0);
 assert.equal(getProject(f.db,"project-1").revision,5);
 assert.equal(readEventsAfter(f.db,0).filter(e=>e.kind==="artifact_materialized").length,4);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id=? AND kind=?").get("project-1","materialized").n,4);
});
test("materializer replays after interruption; doesn't duplicate nodes/connections",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts();
 await f.materializer.runOnce({maxItems:1});
 const restart=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 assert.equal((await restart.runOnce()).length,3);
 assert.equal((await restart.runOnce()).length,0);
 assert.equal(getProject(f.db,"project-1").document.nodes.length,5);
 assert.equal(restart.status({jobId}).filter(x=>x.status==="materialized").length,4);
});
test("landscape and portrait captured images create correctly proportioned nodes and persistent natural dimensions",async t=>{
 for(const {title,w,h,expected} of [
  {title:"portrait 9:16",w:768,h:1344,expected:{width:240,height:420}},
  {title:"landscape 16:9",w:1344,h:768,expected:{width:420,height:240}},
  {title:"square",w:1024,h:1024,expected:{width:420,height:420}}
 ]){
  await t.test(title,async child=>{
   const f=fixture(child),{created}=await f.addArtifacts({count:1,key:"sized"});
   const bytes=Buffer.alloc(33);
   png.copy(bytes,0,0,8);
   bytes.writeUInt32BE(13,8);
   bytes.write("IHDR",12,"ascii");
   bytes.writeUInt32BE(w,16);bytes.writeUInt32BE(h,20);
   const saved=await f.blobStore.put([bytes],{mime:"image/png"});
   f.db.prepare("UPDATE artifacts SET blob_id=?,sha256=? WHERE id=?")
    .run(saved.blobId,saved.sha256,created[0]);
   assert.equal((await f.materializer.runOnce())[0].status,"materialized");
   const after=getProject(f.db,"project-1").document;
   const generated=after.nodes.find(n=>n.id==="artifact-"+created[0]);
   assert.deepEqual({width:generated.width,height:generated.height},expected);
   assert.equal(generated.metadata.naturalWidth,w);
   assert.equal(generated.metadata.naturalHeight,h);
   assert.equal(generated.metadata.content,"/api/v1/blobs/"+saved.blobId);
   assert.equal(after.connections.find(c=>c.toNodeId===generated.id).fromNodeId,"wf-1");
   assert.equal((await f.materializer.runOnce()).length,0,"no repeated processing");
   const reloaded=getProject(f.db,"project-1").document.nodes.find(n=>n.id===generated.id);
   assert.equal(reloaded.width,expected.width);
   assert.equal(reloaded.height,expected.height);
  });
 }
});
test("generated portrait and landscape video nodes respect real dimensions, persist and never resubmit",async t=>{
 for(const {title,dimensions,expected} of [
  {title:"portrait 9:16",dimensions:{width:768,height:1344},expected:{width:240,height:420}},
  {title:"landscape 16:9",dimensions:{width:1344,height:768},expected:{width:420,height:240}},
  {title:"square",dimensions:{width:1024,height:1024},expected:{width:420,height:420}},
  {title:"missing ffprobe fallback",dimensions:null,expected:{width:420,height:236}}
 ]){
  await t.test(title,async child=>{
   const f=fixture(child),{jobId,created}=await f.addArtifacts({key:"video-ratio",count:2});
   const seen=[];
   const sized=createCanvasMaterializer({db:f.db,blobStore:f.blobStore,
    videoDimensionReader:async(path,mime)=>{
     seen.push(mime);
     assert.equal(mime,"video/mp4");
     assert.ok(path);
     return dimensions;
    }});
   assert.deepEqual((await sized.runOnce()).map(x=>x.status),["materialized","materialized"]);
   assert.deepEqual(seen,["video/mp4"]);
   const document=getProject(f.db,"project-1").document;
   const output=document.nodes.find(n=>n.id==="artifact-"+created[1]);
   assert.equal(output.type,"video");
   assert.deepEqual({width:output.width,height:output.height},expected);
   if(dimensions){
    assert.equal(output.metadata.naturalWidth,dimensions.width);
    assert.equal(output.metadata.naturalHeight,dimensions.height);
   }else{
    assert.equal(output.metadata.naturalWidth,undefined);
    assert.equal(output.metadata.naturalHeight,undefined);
   }
   const link=document.connections.find(c=>c.toNodeId===output.id);
   assert.equal(link.fromNodeId,"wf-1");
   assert.equal(link.fromPortId,"video");
   assert.equal(getProject(f.db,"project-1").document.nodes.find(n=>n.id===output.id).height,expected.height);
   assert.equal((await sized.runOnce()).length,0,"no duplicate videos or tasks");
   assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id=?").get(jobId).n,1);
  });
 }
});
test("changed or removed output port still persists a detached CAS image",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const doc=getProject(f.db,"project-1");
 doc.document.nodes[0].metadata.comfyPorts[0].valueKind="STRING";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 const after=getProject(f.db,"project-1").document;
 assert.equal(after.nodes.length,2);
 assert.equal(after.connections.length,0,"incompatible port must not produce a misleading edge");
 assert.equal(after.nodes[1].metadata.comfyArtifact.portId,"image");
 assert.equal(after.nodes[1].metadata.sourceChangedSinceSubmit,true);
 assert.equal(f.materializer.status({jobId})[0].status,"materialized");
 assert.deepEqual(await f.materializer.runOnce(),[],"no extra materialization or GPU work");
});
test("cosmetic source changes during GPU work do not block v2 materialization",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:1});
 const value=getProject(f.db,"project-1");
 value.document.nodes[0].position={x:777,y:222};
 value.document.nodes[0].width=650;
 value.document.nodes[0].title="Moved after GPU submit";
 value.document.nodes[0].metadata.comfyExecution={runId:jobId,status:"running"};
 value.document.nodes[0].metadata.status="loading";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:value.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
});
test("already-blocked legacy Comfy artifact materializes even after prompt changes, without GPU work",async t=>{
 const f=fixture(t);
 const doc=getProject(f.db,"project-1").document;
 doc.nodes[0].metadata.comfyWorkflow={templateId:"saved",templateRevision:"r1",
  bindingState:"bound",inputOverrides:{prompt:"unchanged",seed:1}};
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc});
 const oldFingerprint=fingerprintSourceLegacy(doc,"wf-1");
 const frozen={adapterKind:"comfy",instanceId:"comfy-local",comfyTemplate:{id:"saved",revision:"r1"},
  comfyRequest:{instanceId:"comfy-local",nodes:[{id:"wf-1",templateId:"saved",templateRevision:"r1",
   inputOverrides:{prompt:"unchanged",seed:1}}],edges:[],externalInputs:[]}};
 const jobId=submitJob(f.db,{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:2,
  sourceNodeFingerprint:oldFingerprint,idempotencyKey:"old-job",requestFingerprint:"old-job",
  executionMode:"poll",snapshot:frozen}).jobId;
 const blob=await f.blobStore.put([png],{mime:"image/png"});
 const artifactId="old-artifact";
 appendArtifact(f.db,{id:artifactId,jobId,portId:"image",itemKey:"image-0",blobId:blob.blobId,
  kind:"image",mime:"image/png",sha256:blob.sha256,
  metadata:{comfyArtifact:{runId:jobId,artifactId,workflowNodeId:"wf-1",portId:"image",kind:"image",index:0}}});
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const changed=getProject(f.db,"project-1").document;
 changed.nodes[0].position.x=777;
 changed.nodes[0].metadata.comfyWorkflow.inputOverrides.seed=2;
 patchProject(f.db,{id:"project-1",expectedRevision:2,document:changed});
 // A previously blocked record from before the fix is safely requeued with
 // its saved CAS blob. Neither old prompt/seed nor provider submission repeats.
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("legacy-blocked",jobId,artifactId,"project-1","blocked","materialization_source_changed");
 assert.equal(f.materializer.retryBlocked({projectId:"project-1",artifactId}),true);
 assert.equal((await f.materializer.runOnce())[0].status,"materialized");
 const output=getProject(f.db,"project-1").document;
 assert.equal(output.nodes.length,2);
 assert.equal(output.connections.length,1);
 assert.equal(output.nodes[0].metadata.comfyWorkflow.inputOverrides.seed,2,"never rewrite edited input");
 assert.equal(output.nodes[1].metadata.sourceChangedSinceSubmit,true);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,1,
  "recovery must not submit another GPU job");
});
test("successful Comfy video with changed prompt and upstream graph can recover a previously blocked result",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:2});
 const current=getProject(f.db,"project-1");
 const workflow=current.document.nodes[0];
 workflow.metadata.comfyWorkflow={templateId:"video-template",templateRevision:"r2",
  bindingState:"bound",inputOverrides:{prompt:"completely replaced prompt"}};
 current.document.nodes.push({id:"new-input",type:"text",title:"New prompt",
  position:{x:0,y:-280},width:300,height:160,metadata:{content:"different from the frozen run"}});
 current.document.connections.push({id:"new-input-edge",fromNodeId:"new-input",toNodeId:workflow.id});
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:current.document});
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore,
  videoDimensionReader:async()=>({width:1344,height:768})});
 // This is a previously successful video with a blocked materialization, not a job retry.
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("blocked-video",jobId,created[1],"project-1","blocked","materialization_source_changed");
 assert.equal(materializer.retryBlocked({projectId:"project-1",artifactId:created[1]}),true);
 const result=await materializer.runOnce();
 assert.ok(result.some(x=>x.artifactId===created[1]&&x.status==="materialized"));
 const after=getProject(f.db,"project-1").document;
 const video=after.nodes.find(n=>n.id==="artifact-"+created[1]);
 assert.equal(video.type,"video");
 assert.equal(video.metadata.sourceChangedSinceSubmit,true);
 assert.equal(video.metadata.comfyArtifact.runId,jobId);
 assert.equal(video.metadata.comfyArtifact.portId,"video");
 assert.equal(video.metadata.storageKey.startsWith("cas:"),true);
 assert.equal(after.connections.some(e=>e.fromNodeId==="wf-1"&&e.toNodeId===video.id&&
   e.fromPortId==="video"),true);
 assert.equal(after.nodes.find(n=>n.id==="wf-1").metadata.comfyWorkflow.inputOverrides.prompt,
  "completely replaced prompt");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.deepEqual(await materializer.runOnce(),[]);
});
test("occupied edge ID does not block a standalone artifact or overwrite user connections",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const doc=getProject(f.db,"project-1").document;
 doc.nodes.push({id:"existing-target",type:"image",title:"User media",
  position:{x:700,y:0},width:400,height:400,metadata:{content:"user-defined"}});
 const occupied="artifact-edge-"+created[0];
 doc.connections.push({id:occupied,fromNodeId:"wf-1",toNodeId:"existing-target",
  fromPortId:"image"});
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc});
 const output=await f.materializer.runOnce();
 assert.equal(output[0].status,"materialized");
 const after=getProject(f.db,"project-1").document;
 assert.equal(after.connections.length,1,"keep the user's original edge");
 assert.equal(after.connections[0].id,occupied);
 assert.equal(after.connections[0].toNodeId,"existing-target");
 const createdNode=after.nodes.find(n=>n.id==="artifact-"+created[0]);
 assert.equal(createdNode.metadata.comfyArtifact.artifactId,created[0]);
 assert.equal(after.nodes.length,3);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE id=?").get(jobId).n,1);
});
test("a conflicting artifact node identity still blocks safely instead of clobbering existing content",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const current=getProject(f.db,"project-1");
 current.document.nodes.push({id:"artifact-"+created[0],type:"text",
  title:"User-owned node",position:{x:600,y:0},width:250,height:200,
  metadata:{content:"Do not replace me"}});
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:current.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"blocked");
 assert.equal(result[0].reason,"materialization_node_collision");
 const after=getProject(f.db,"project-1").document;
 assert.equal(after.nodes.length,2);
 assert.equal(after.nodes[1].metadata.content,"Do not replace me");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("worker automatically requeues old source-changed video blocks on startup, never resubmitting Comfy",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:2});
 const current=getProject(f.db,"project-1");
 current.document.nodes[0].metadata.comfyWorkflow={templateId:"video",templateRevision:"latest",
  inputOverrides:{prompt:"new prompt after submission"}};
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:current.document});
 const videoId=created[1],imageId=created[0];
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("legacy-video",jobId,videoId,"project-1","blocked","materialization_source_changed");
 // A genuine identity conflict stays blocked, even during automatic repair.
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("real-conflict",jobId,imageId,"project-1","blocked","materialization_identity_conflict");
 const before=f.materializer.status({jobId});
 assert.deepEqual(before.map(x=>[x.artifact_id,x.status]),[
  [imageId,"blocked"],[videoId,"blocked"]
 ]);
 assert.deepEqual(await f.materializer.runOnce(),[],"old blocked artifacts are invisible until startup migration");
 let ticks=0,submits=0;
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore,
  videoDimensionReader:async()=>({width:1280,height:720})});
 const coordinator={tick:async()=>{ticks++;return 0}};
 const worker=createBackendWorker({coordinator,materializer,intervalMs:1000});
 assert.equal(await worker.cycle(),1);
 assert.equal(ticks,1);
 const results=materializer.status({jobId});
 assert.equal(results.find(x=>x.artifact_id===videoId).status,"materialized");
 assert.equal(results.find(x=>x.artifact_id===imageId).status,"blocked");
 assert.equal(results.find(x=>x.artifact_id===imageId).reason,"materialization_identity_conflict");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(submits,0);
 const after=getProject(f.db,"project-1").document;
 assert.equal(after.nodes.find(n=>n.id==="artifact-"+videoId).type,"video");
 assert.equal(after.nodes.find(n=>n.id==="artifact-"+videoId).metadata.sourceChangedSinceSubmit,true);
 assert.equal(after.nodes[0].metadata.comfyWorkflow.inputOverrides.prompt,"new prompt after submission");
 const requeued=f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id=? AND kind='artifact_materialization_requeued'").get(jobId).n;
 assert.equal(requeued,1);
 assert.equal(await worker.cycle(),0,"after first startup cycle no repeat materialization");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id=? AND kind='artifact_materialization_requeued'").get(jobId).n,1);
 const restarted=createBackendWorker({coordinator,materializer,intervalMs:1000});
 await restarted.cycle();
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM job_events WHERE job_id=? AND kind='artifact_materialization_requeued'").get(jobId).n,1,
  "restarting should not disturb successful output or blocked identity conflicts");
 await worker.stop();await restarted.stop();
});
test("single-user stale autosave retains worker materializations without conflict or client rebase",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:2});
 const before=getProject(f.db,"project-1");
 const generated=await f.materializer.runOnce();
 assert.equal(generated.length,2);
 assert.ok(generated.every(r=>r.status==="materialized"));
 const afterGeneration=getProject(f.db,"project-1");
 assert.equal(afterGeneration.document.nodes.length,3);
 const stale={...before.document,nodes:before.document.nodes.map(n=>({
  ...n,metadata:{...n.metadata,comfyWorkflow:{inputOverrides:{prompt:"updated by user"}}}
 }))};
 const saved=saveSingleUserCanvas(f.db,{id:"project-1",expectedRevision:before.revision,document:stale});
 assert.equal(saved.revision,afterGeneration.revision+1);
 assert.equal(saved.document.nodes.length,3);
 assert.equal(saved.document.connections.length,2);
 assert.equal(saved.document.nodes[0].metadata.comfyWorkflow.inputOverrides.prompt,"updated by user");
 assert.equal(saved.document.nodes.filter(n=>n.id.startsWith("artifact-")).length,2);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 // When the browser has the latest revision, explicitly deleting one result
 // is a user edit, not an outdated autosave; honor it.
 const deleting={...saved.document,nodes:saved.document.nodes.filter(n=>n.id!==generated[0].nodeId),
  connections:saved.document.connections.filter(e=>e.toNodeId!==generated[0].nodeId)};
 const reduced=saveSingleUserCanvas(f.db,{id:"project-1",expectedRevision:saved.revision,document:deleting});
 assert.equal(reduced.document.nodes.length,2);
 assert.equal(reduced.document.connections.length,1);
});
test("single-user stale autosave never resurrects deleted Comfy sources, keeps completed video detached",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:2});
 const prior=getProject(f.db,"project-1");
 await f.materializer.runOnce();
 const stored=saveSingleUserCanvas(f.db,{id:"project-1",expectedRevision:prior.revision,
  document:{nodes:[],connections:[]}});
 assert.equal(stored.document.nodes.length,2);
 assert.equal(stored.document.connections.length,0);
 assert.ok(stored.document.nodes.every(n=>n.metadata?.comfyArtifact));
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("stale single-user save keeps outputs detached when workflow ports were removed",async t=>{
 const f=fixture(t);
 await f.addArtifacts({count:2});
 const before=getProject(f.db,"project-1");
 await f.materializer.runOnce();
 const edited={...before.document,nodes:before.document.nodes.map(n=>({
  ...n,metadata:{...n.metadata,comfyPorts:[]}
 }))};
 const saved=saveSingleUserCanvas(f.db,{id:"project-1",expectedRevision:before.revision,document:edited});
 assert.equal(saved.document.nodes.length,3);
 assert.equal(saved.document.connections.length,0);
 assert.deepEqual(saved.document.nodes[0].metadata.comfyPorts,[]);
 assert.equal(saved.document.nodes.filter(n=>n.metadata?.comfyArtifact).length,2);
});
test("P4.7 pending artifact recover processes only stored Blob, never generates again",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const app=buildApp({db:f.db,materializer:f.materializer,
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>app.close());
 const call=(project="project-1",headers={"x-test-owner":"owner"})=>app.inject({
  method:"POST",url:"/api/v1/projects/"+project+"/materializations/"+created[0]+"/recover",
  headers,payload:{}
 });
 assert.equal((await call("another-project")).statusCode,409);
 assert.equal((await call("project-1",{})).statusCode,401);
 assert.equal((await call("project-1",{"x-test-owner":"owner",origin:"https://other.example"})).statusCode,403);
 f.db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(jobId);
 assert.equal((await call()).statusCode,409,"ambiguous remote submission cannot materialize");
 f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const first=await call();
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().status,"materialized");
 assert.equal((await call()).statusCode,409,"already materialized cannot run twice");
 assert.equal(getProject(f.db,"project-1").document.nodes.length,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("P4.7 retry endpoint only requeues a succeeded blocked artifact, never GPU submission",async t=>{
 const f=fixture(t),{jobId,created}=await f.addArtifacts({count:1});
 const current=getProject(f.db,"project-1");
 current.document.nodes[0].metadata.comfyPorts[0].valueKind="STRING";
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:current.document});
 // Simulate an old installation that had blocked this already collected CAS
 // artifact before allowing detached materialization on incompatible ports.
 f.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason) VALUES(?,?,?,?,?,?)")
  .run("prior-port-block",jobId,created[0],"project-1","blocked","materialization_port_mismatch");
 const app=buildApp({db:f.db,materializer:f.materializer,
  authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>app.close());
 const post=(project="project-1",headers={"x-test-owner":"owner"})=>app.inject({
  method:"POST",url:"/api/v1/projects/"+project+"/materializations/"+created[0]+"/retry",
  headers,payload:{}
 });
 const before=(await app.inject({method:"GET",url:"/api/v1/projects/project-1/jobs",
  headers:{"x-test-owner":"owner"}})).json().jobs[0];
 assert.equal(before.artifacts[0].status,"blocked");
 assert.equal(before.artifacts[0].reason,"materialization_port_mismatch");
 assert.equal((await post("other-project")).statusCode,409);
 assert.equal((await post("project-1",{})).statusCode,401);
 assert.equal((await post("project-1",{"x-test-owner":"owner",origin:"https://attacker.example"})).statusCode,403);
 const fixed=getProject(f.db,"project-1");
 fixed.document.nodes[0].metadata.comfyPorts[0].valueKind="IMAGE";
 patchProject(f.db,{id:"project-1",expectedRevision:2,document:fixed.document});
 const retry=await post();
 assert.equal(retry.statusCode,200,retry.body);
 assert.equal(retry.json().requeued,true);
 assert.equal((await post()).statusCode,409,"double click cannot requeue twice");
 const requeued=(await app.inject({method:"GET",url:"/api/v1/projects/project-1/jobs",
  headers:{"x-test-owner":"owner"}})).json().jobs[0];
 assert.equal(requeued.artifacts[0].status,"retry");
 assert.equal((await f.materializer.runOnce())[0].status,"materialized");
 const restored=getProject(f.db,"project-1");
 assert.equal(restored.document.nodes.length,2);
 assert.equal(restored.document.connections.length,1);
 assert.equal((await f.materializer.runOnce()).length,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(readEventsAfter(f.db,0).filter(x=>x.kind==="artifact_materialization_requeued").length,1);
});
test("deleted workflow creates a standalone artifact with frozen provenance and no dangling edge",async t=>{
 const f=fixture(t),{jobId}=await f.addArtifacts({count:1});
 const doc=getProject(f.db,"project-1");
 doc.document.nodes=[];doc.document.connections=[];
 patchProject(f.db,{id:"project-1",expectedRevision:1,document:doc.document});
 const result=await f.materializer.runOnce();
 assert.equal(result[0].status,"materialized");
 const after=getProject(f.db,"project-1").document;
 assert.equal(after.nodes.length,1);
 assert.equal(after.connections.length,0);
 assert.equal(after.nodes[0].metadata.sourceChangedSinceSubmit,true);
 assert.equal(after.nodes[0].metadata.comfyArtifact.workflowNodeId,"wf-1");
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
});
test("poll backoff is persisted; restart polls only when due and never issues new submit",async t=>{
 const f=fixture(t);
 let now=10_000,submits=0,polls=0;
 const id=submitJob(f.db,{idempotencyKey:"poll",requestFingerprint:"poll",executionMode:"poll",
  snapshot:{adapterKind:"model"}}).jobId;
 const adapter={
  async submit(){submits++;return{kind:"accepted",remoteTaskId:"remote"}},
  async poll(){polls++;if(polls===1)throw Error("network outage");return{kind:"pending"}}
 };
 const opts={db:f.db,adapters:{model:adapter},clock:()=>now,
  retryPolicy:{pollMs:100,collectMs:250,maxMs:1000}};
 const c=createJobCoordinator(opts);c.recoverAtStartup();
 await c.tick();assert.equal(submits,1);assert.equal(polls,0);
 assert.equal(await c.tick(),0);
 now+=100;
 await c.tick();assert.equal(polls,1);
 assert.equal(f.db.prepare("SELECT poll_failures FROM job_schedules WHERE job_id=?").get(id).poll_failures,1);
 const resumed=createJobCoordinator(opts);resumed.recoverAtStartup();
 assert.equal(await resumed.tick(),0);
 now+=199;assert.equal(await resumed.tick(),0);
 now+=1;await resumed.tick();assert.equal(polls,2);assert.equal(submits,1);
});
test("collect retry delay grows and no repeated GPU submit",async t=>{
 const f=fixture(t);let now=10000,collects=0,posts=0;
 const id=submitJob(f.db,{idempotencyKey:"collect",requestFingerprint:"collect",executionMode:"immediate",snapshot:{adapterKind:"model"}}).jobId;
 const c=createJobCoordinator({db:f.db,clock:()=>now,
  retryPolicy:{pollMs:100,collectMs:200,maxMs:1000},adapters:{model:{
   async submit(){posts++;return{kind:"completed",receipt:{output:"saved"}}},
   async collect(){collects++;throw Error("storage offline")}
  }}});
 c.recoverAtStartup();await c.tick();
 assert.equal(collects,1);assert.equal(posts,1);
 assert.equal(await c.tick(),0);
 now+=399;assert.equal(await c.tick(),0);
 now++;await c.tick();
 assert.equal(collects,2);
 assert.equal(f.db.prepare("SELECT collect_failures FROM job_schedules WHERE job_id=?").get(id).collect_failures,2);
 assert.equal(posts,1);
});
test("opt-in worker serializes ticks and drains in-flight tasks",async t=>{
 const f=fixture(t),key=submitJob(f.db,{idempotencyKey:"w",requestFingerprint:"w",executionMode:"immediate",snapshot:{}}).jobId;
 let entered=0,release;
 const gate=new Promise(resolve=>release=resolve);
 const coordinator=createJobCoordinator({db:f.db,adapters:{model:{
  async submit(){entered++;await gate;return{kind:"completed",receipt:{ok:true}}},
  async collect({job}){const blob=await f.blobStore.put([Buffer.from("text")],{mime:"text/plain"});
   appendArtifact(f.db,{jobId:job.id,blobId:blob.blobId,itemKey:"once",kind:"text",mime:"text/plain",sha256:blob.sha256})}
 }}});
 coordinator.recoverAtStartup();
 const worker=createBackendWorker({coordinator,materializer:f.materializer,intervalMs:25}).start();
 try{
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(entered,1);
  const closing=worker.stop();
  release();await closing;await coordinator.stop();
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(key).status,"succeeded");
  assert.equal(entered,1);
 }finally{release();await worker.stop()}
});
test("autoDispatch completes HTTP job and persists typed canvas output without manual tick",async t=>{
 if(process.platform!=="win32")return;
 const dataDir=mkdtempSync(join(tmpdir(),"atelier-auto-e2e-"));
 let runtime,posts=0;
 try{
  const adapter={
   async submit(){posts++;return {kind:"completed",receipt:{output:"ready"}}},
   async collect({job,db}){
    const store=createBlobStore({dataDir,db});
    const data=Buffer.from("automatic text output");
    const blob=await store.put([data],{mime:"text/plain"});
    const artifactId=randomUUID();
    appendArtifact(db,{id:artifactId,jobId:job.id,portId:"result",itemKey:"text-0",
     blobId:blob.blobId,kind:"text",mime:"text/plain",sha256:blob.sha256,
     metadata:{comfyArtifact:{runId:job.id,artifactId,workflowNodeId:"wf-1",
      portId:"result",kind:"text",index:0}}});
   }
  };
  runtime=createLocalBackend({dataDir,adapters:{model:adapter},autoDispatch:true,dispatchIntervalMs:25});
  const app=runtime.app;
  assert.equal(runtime.worker.status().running,true);
  const auth=await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{
   origin:"http://localhost",host:"localhost",authorization:"Bearer "+runtime.sessionAuth.bootstrapToken
  }});
  assert.equal(auth.statusCode,201);
  const headers={host:"localhost",origin:"http://localhost",
   cookie:auth.headers["set-cookie"].split(";")[0],"x-atelier-csrf":auth.json().csrfToken};
  const doc={nodes:[{id:"wf-1",type:"comfy:workflow",title:"workflow",
   position:{x:10,y:20},width:400,height:300,
   metadata:{comfyPorts:[{id:"result",label:"Text",direction:"source",valueKind:"STRING"}]}}],connections:[]};
  const created=await app.inject({method:"POST",url:"/api/v1/projects",
   headers,payload:{id:"project-1",document:doc}});
  assert.equal(created.statusCode,201,created.body);
  const jobResponse=await app.inject({method:"POST",url:"/api/v1/jobs",headers,
   payload:{projectId:"project-1",targetNodeId:"wf-1",expectedProjectRevision:1,
    sourceNodeFingerprint:fingerprintSource(doc,"wf-1"),
    idempotencyKey:"auto-e2e",requestFingerprint:"auto-e2e",executionMode:"immediate",
    snapshot:{adapterKind:"model"}}});
  assert.equal(jobResponse.statusCode,201,jobResponse.body);
  const jobId=jobResponse.json().id;
  let result;
  for(let i=0;i<160;i++){
   await new Promise(resolve=>setTimeout(resolve,25));
   result=await app.inject({method:"GET",url:"/api/v1/projects/project-1",headers});
   if(result.json().document.nodes.length===2)break;
  }
  assert.equal(result.statusCode,200);
  assert.equal(result.json().revision,2,JSON.stringify(result.json()));
  assert.equal(result.json().document.nodes[1].metadata.content,"automatic text output");
  assert.equal(result.json().document.connections[0].fromPortId,"result");
  assert.equal(result.json().document.connections[0].toPortId,"comfy-artifact");
  assert.equal(posts,1);
  const materials=await app.inject({method:"GET",url:"/api/v1/jobs/"+jobId+"/materializations",headers});
  assert.equal(materials.statusCode,200,materials.body);
  assert.equal(materials.json().materializations[0].status,"materialized");
  const snapshot=await app.inject({method:"GET",url:"/api/v1/worker/status",headers});
  assert.equal(snapshot.json().running,true);
 }finally{
  if(runtime)await runtime.close();
  rmSync(dataDir,{recursive:true,force:true});
 }
});

