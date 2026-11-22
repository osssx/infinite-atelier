
import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {initializeSchema} from "./schema.mjs";
import {createShotBatches} from "./shot-groups.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {createProject,saveSingleUserCanvas} from "./projects.mjs";
import {fingerprintSource,stableJson} from "./repository.mjs";
import {canonical,sha256} from "../comfy-workflow/compiler.mjs";

const zero="0".repeat(64);
function template(continuity=false){
 const apiGraph={
  "1":{class_type:"EmptyImage",inputs:{width:64,height:64,batch_size:3,color:14417920}},
  "2":{class_type:"CreateVideo",inputs:{images:["1",0],fps:8}},
  "3":{class_type:"SaveVideo",inputs:{video:["2",0],filename_prefix:"atelier-offline-acceptance/video",format:"auto","format.codec":"auto",codec:"auto"}}
 };
 const ports=[{id:"video",label:"Video",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}];
 let mediaUseCase;
 if(continuity){
  apiGraph["4"]={class_type:"PrimitiveString",inputs:{value:"Offline"}};
  ports.push(
   {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"4",inputName:"value"}]}},
   {id:"opening",label:"Opening",direction:"target",valueKind:"IMAGE",required:true,inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"2",inputName:"images"}]}}
  );
  mediaUseCase={channel:"video",primaryOutputKind:"video",promptPortId:"prompt",primaryOutputPortId:"video",slots:[{id:"opening",label:"Opening",valueKind:"IMAGE",required:true}],
   mediaCapabilities:{schemaVersion:1,kind:"video",defaultMode:"first_frame",modes:[{id:"first_frame",enabled:true,inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]}]},
   modeBindings:{first_frame:{promptPortId:"prompt",parameterPorts:{},rolePorts:{first_frame:["opening"]}}}};
 }
 const payload={name:continuity?"Offline continuation":"Offline clip",apiGraph,ports,requirements:{classTypes:[...new Set(Object.values(apiGraph).map(node=>node.class_type))].sort()},...(mediaUseCase?{mediaUseCase}:{})};
 return {id:continuity?"local-continuity":"local-video",revision:sha256(canonical(payload)),...payload};
}
function fixture(db,{normalVideo=false,videoConfig=false}={}){
 const shots=["a","b","c"].map(id=>({shotId:id,generationNodeId:"node-"+id,mode:id==="b"?"continuity":"independent"}));
 const graph={title:"Offline tests",nodes:[{id:"g",type:"group",metadata:{shotGroup:{shots}}},...shots.map(shot=>{
  const t=template(shot.mode==="continuity");
  const binding={templateId:t.id,templateRevision:t.revision};
  const usesMediaPreset=(normalVideo||videoConfig)&&shot.shotId==="b";
  return {id:shot.generationNodeId,type:usesMediaPreset?(videoConfig?"config":"video"):"comfy:workflow",title:shot.shotId,position:{x:0,y:0},width:200,height:160,
   metadata:{groupId:"g",...(videoConfig&&usesMediaPreset?{generationMode:"video"}:{}),
    ...(usesMediaPreset?{comfyMediaPreset:{...binding,overrides:{},slots:{},mediaMode:"first_frame"}}:{comfyWorkflow:binding})}};
 })],connections:[]};
 const project=createProject(db,{id:"offline-shots",document:graph});
 const items=shots.map(shot=>{
  const continuity=shot.mode==="continuity",nodeId=shot.generationNodeId,t=template(continuity),source="tail-"+shot.shotId;
  const binding=graph.nodes.find(node=>node.id===nodeId).metadata.comfyMediaPreset;
  const comfyTargetBinding=binding?{mode:"video",generationMode:"first_frame",binding}:undefined;
  const graphFingerprint=fingerprintSource(graph,nodeId);
  const sourceNodeFingerprint=comfyTargetBinding?"v2c:"+createHash("sha256").update(stableJson({graphFingerprint,targetBinding:comfyTargetBinding})).digest("hex"):graphFingerprint;
  return {shotId:shot.shotId,nodeId,sourceNodeFingerprint,
   ...(continuity?{previousShotId:"a",continuitySourceId:source}:{}),
   snapshot:{adapterKind:"comfy",instanceId:"local",comfyTemplate:t,...(comfyTargetBinding?{comfyTargetBinding}:{}),comfyRequest:{schemaVersion:2,instanceId:"local",
    nodes:[{id:nodeId,templateId:t.id,templateRevision:t.revision,inputOverrides:{}}],
    rootOutputs:[{nodeId,portId:"video"}],
    edges:continuity?[{fromNodeId:source,fromPortId:"image",toNodeId:nodeId,toPortId:"opening"}]:[],
    externalInputs:continuity?[{kind:"asset",sourceNodeId:source,sourcePortId:"image",valueKind:"IMAGE",assetId:zero,sha256:zero}]:[],
    runOptions:continuity?{mediaMode:"first_frame"}:{}}}};
 });
 return {project,body:{groupId:"g",expectedProjectRevision:project.revision,idempotencyKey:"test-batch",items}};
}

test("batch queues independent shots once, persists waiting shots, and stops only future submissions",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
 const created=service.create(project.id,body);
 assert.deepEqual(created.items.map(item=>[item.status,item.reason]),[["queued",undefined],["waiting",undefined],["queued",undefined]]);
 const reopened=createShotBatches({db,instanceIds:()=>["local"]});
 assert.deepEqual(reopened.create(project.id,body),created);
 assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n,2);
 assert.throws(()=>reopened.create(project.id,{...body,items:body.items.slice(0,2)}),/idempotency_key_conflict/);
 const stopped=reopened.action(project.id,created.id,{action:"stop"});
 assert.deepEqual(stopped.items.map(item=>item.status),["queued","stopped","queued"]);
});

test("a blocked predecessor pauses its dependent shot and preserves independent jobs",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
 const created=service.create(project.id,body);
 db.prepare("UPDATE jobs SET status='submission_unknown' WHERE id=?").run(created.items[0].jobId);
 await service.tick();
 const [result]=service.list(project.id);
 assert.deepEqual(result.items.map(item=>item.status),["submission_unknown","blocked","queued"]);
 assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n,2);
});

test("video-mode generation configuration nodes can join a local continuity batch",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db,{videoConfig:true});
 const service=createShotBatches({db,instanceIds:()=>["local"]});
 const batch=service.create(project.id,body);
 assert.equal(batch.items[1].status,"waiting");
});

test("reordering a pending chain pauses the changed handoff",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
 service.create(project.id,body);
 const document=structuredClone(project.document);
 document.nodes[0].metadata.shotGroup.shots.reverse();
 saveSingleUserCanvas(db,{id:project.id,expectedRevision:project.revision,document});
 await service.tick();
 assert.equal(service.list(project.id)[0].items[1].reason,"shot_group_changed");
 assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n,2);
});

test("waits for all materializations and respects the selected output",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db);
 const extracted=[];
 const service=createShotBatches({db,instanceIds:()=>["local"],tailFrames:{async extract(sourceBlobId){
  extracted.push(sourceBlobId);return {blobId:"f".repeat(64),sourceBlobId,timeMs:250};
 }}});
 const batch=service.create(project.id,body),jobId=batch.items[0].jobId;
 const document=structuredClone(project.document);
 for(const token of ["1","2"]){
  const blobId=token.repeat(64),nodeId="take-"+token,artifactId="artifact-"+token;
  db.prepare("INSERT INTO blobs VALUES (?,?,1,'video/mp4',?,'available')").run(blobId,blobId,blobId);
  db.prepare("INSERT INTO artifacts(id,job_id,item_key,blob_id,kind,mime,sha256) VALUES (?,?,?,?,'video','video/mp4',?)").run(artifactId,jobId,token,blobId,blobId);
  db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES (?,?,?,?,?,?)").run(token,jobId,artifactId,project.id,token==="1"?"materialized":"pending",nodeId);
  document.nodes.push({id:nodeId,type:"video",metadata:{storageKey:"cas:"+blobId}});
 }
 saveSingleUserCanvas(db,{id:project.id,expectedRevision:project.revision,document});
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 await service.tick();
 assert.equal(service.list(project.id)[0].items[1].status,"waiting");
 db.prepare("UPDATE materializations SET status='materialized' WHERE id='2'").run();
 await service.tick();
 const [row]=service.list(project.id);
 assert.equal(row.items[1].status,"choose");
 assert.equal(row.items[1].choices.length,2);
 assert.throws(()=>service.action(project.id,batch.id,{action:"choose",shotId:"b",artifactId:"other"}),/shot_choice_invalid/);
 service.action(project.id,batch.id,{action:"choose",shotId:"b",artifactId:"artifact-2"});
 await service.tick();
 assert.deepEqual(extracted,["2".repeat(64)]);
 assert.equal(service.list(project.id)[0].items[1].tail.sourceArtifactId,"artifact-2");
});

test("P3.2f: a failed upstream Job can be explicitly retried with a NEW immutable key; independent success is retained",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db);
 const extracted=[];
 const service=createShotBatches({db,instanceIds:()=>["local"],tailFrames:{async extract(blobId){
  extracted.push(blobId);return {blobId:"f".repeat(64),sourceBlobId:blobId,timeMs:250};
 }}});
 const batch=service.create(project.id,body),oldA=batch.items[0].jobId,independentC=batch.items[2].jobId;
 const originalKey=db.prepare("SELECT idempotency_key FROM jobs WHERE id=?").get(oldA).idempotency_key;
 db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(oldA);
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(independentC);
 await service.tick();
 assert.deepEqual(service.list(project.id)[0].items.map(x=>x.status),["failed","blocked","succeeded"]);
 assert.equal(service.list(project.id)[0].items[1].reason,"shot_previous_failed");
 const resumed=service.action(project.id,batch.id,{action:"resume",expectedProjectRevision:project.revision,
  items:[body.items[0],body.items[1]]});
 assert.deepEqual(resumed.items.map(x=>x.status),["queued","waiting","succeeded"]);
 const newA=resumed.items[0].jobId;
 assert.notEqual(newA,oldA);
 assert.equal(resumed.items[0].retryCount,1);
 assert.equal(resumed.items[0].retryFromJobId,oldA); const retryJob=JSON.parse(db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(newA).snapshot_json);
 assert.deepEqual(retryJob.localShotRetry,{batchId:batch.id,shotId:"a",retryCount:1,retryFromJobId:oldA});
 assert.notEqual(db.prepare("SELECT idempotency_key FROM jobs WHERE id=?").get(newA).idempotency_key,originalKey);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(oldA).status,"failed");
 assert.equal(resumed.items[2].jobId,independentC);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,3);
 assert.equal(service.action(project.id,batch.id,{action:"resume",expectedProjectRevision:project.revision,
  items:[body.items[0],body.items[1]]}).items[0].jobId,newA);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,3,"replayed explicit resume never submits twice");
 const nodeId="take-from-retried-a",blobId="a".repeat(64),artifactId="artifact-from-retry";
 db.prepare("INSERT INTO blobs VALUES (?,?,1,'video/mp4',?,'available')").run(blobId,blobId,blobId);
 db.prepare("INSERT INTO artifacts(id,job_id,item_key,blob_id,kind,mime,sha256) VALUES (?,?,?,?,'video','video/mp4',?)")
  .run(artifactId,newA,"video",blobId,blobId);
 db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES (?,?,?,?,?,?)")
  .run("m-retried",newA,artifactId,project.id,"materialized",nodeId);
 const document=structuredClone(project.document);
 document.nodes.push({id:nodeId,type:"video",metadata:{storageKey:"cas:"+blobId}});
 saveSingleUserCanvas(db,{id:project.id,expectedRevision:project.revision,document});
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(newA);
 await service.tick();
 const after=service.list(project.id)[0];
 assert.equal(after.items[1].status,"queued");
 assert.deepEqual(extracted,[blobId]);
 assert.equal(after.items[1].tail.sourceArtifactId,artifactId);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,4);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(independentC).status,"succeeded");
 assert.equal(after.items[2].jobId,independentC);
 const snapshot=JSON.parse(db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(after.items[1].jobId).snapshot_json);
 assert.equal(snapshot.comfyRequest.externalInputs[0].assetId,"f".repeat(64));
});

test("P3.2f: submission_unknown/active original Job can NEVER be retried or assigned a new key",async t=>{
 for(const status of ["submission_unknown","queued","running","collecting","blocked_credential"]){
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
  const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
  const batch=service.create(project.id,body),old=batch.items[0].jobId;
  db.prepare("UPDATE jobs SET status=? WHERE id=?").run(status,old);
  const result=service.action(project.id,batch.id,{action:"resume",expectedProjectRevision:project.revision,
   items:[body.items[0]]});
  assert.equal(result.items[0].jobId,old,"unsafe original "+status+" was incorrectly replaced");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
 }
});

test("P3.2f: forged retryCount, jobId and status from client cannot bypass server-owned retry provenance",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
 const batch=service.create(project.id,body),old=batch.items[0].jobId;
 db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(old);
 const poisoned={...body.items[0],jobId:"fake",retryCount:99,retryFromJobId:"fake",status:"succeeded",
  tail:{blobId:"f".repeat(64)},choices:[{artifactId:"fake"}]};
 const result=service.action(project.id,batch.id,{action:"resume",expectedProjectRevision:project.revision,items:[poisoned]});
 assert.equal(result.items[0].retryCount,1);
 assert.equal(result.items[0].retryFromJobId,old);
 assert.equal(result.items[0].status,"queued");
 assert.notEqual(result.items[0].jobId,"fake");
 assert.equal(result.items[0].tail,undefined);
});
test("P3.2f: a new batch cannot forge retry attempt numbers or predecessor take witness",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),service=createShotBatches({db,instanceIds:()=>["local"]});
 const tampered={...body,idempotencyKey:"initial-forged",
  items:body.items.map(item=>({...item,retryCount:17,retryFromJobId:"forged",predecessorTakeDigest:"forged"}))};
 const result=service.create(project.id,tampered);
 assert.equal(result.items[0].retryCount,undefined);
 assert.equal(result.items[0].retryFromJobId,undefined);
 assert.equal(result.items[1].status,"waiting");
 const snap=JSON.parse(db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(result.items[0].jobId).snapshot_json);
 assert.equal(snap.localShotRetry,undefined);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
});

test("P3.2f: changing the selected predecessor take fences a pending continuation until explicit review",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {project,body}=fixture(db),extracted=[];
 const service=createShotBatches({db,instanceIds:()=>["local"],tailFrames:{async extract(blobId){
  extracted.push(blobId);return {blobId:"f".repeat(64),sourceBlobId:blobId,timeMs:250};
 }}});
 const batch=service.create(project.id,body),jobId=batch.items[0].jobId,blobId="8".repeat(64);
 const artifactId="chosen-take",nodeId="chosen-video";
 db.prepare("INSERT INTO blobs VALUES (?,?,1,'video/mp4',?,'available')").run(blobId,blobId,blobId);
 db.prepare("INSERT INTO artifacts(id,job_id,item_key,blob_id,kind,mime,sha256) VALUES (?,?,?,?,'video','video/mp4',?)")
  .run(artifactId,jobId,"video",blobId,blobId);
 db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES (?,?,?,?,?,?)")
  .run("chosen-m",jobId,artifactId,project.id,"materialized",nodeId);
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 const graph=structuredClone(project.document);
 graph.nodes[0].metadata.shotGroup.shots[0].take={storageKey:"cas:"+blobId,artifactId,jobId};
 graph.nodes.push({id:nodeId,type:"video",metadata:{storageKey:"cas:"+blobId}});
 saveSingleUserCanvas(db,{id:project.id,expectedRevision:project.revision,document:graph});
 await service.tick();
 const paused=service.list(project.id)[0];
 assert.equal(paused.items[1].status,"blocked");
 assert.equal(paused.items[1].reason,"shot_group_changed");
 assert.deepEqual(extracted,[]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
 const revision=db.prepare("SELECT revision FROM projects WHERE id=?").get(project.id).revision;
 const resumed=service.action(project.id,batch.id,{action:"resume",expectedProjectRevision:revision,items:[body.items[1]]});
 assert.equal(resumed.items[1].status,"waiting");
 await service.tick();
 const next=service.list(project.id)[0];
 assert.equal(next.items[1].status,"queued");
 assert.equal(next.items[1].tail.sourceArtifactId,artifactId);
 assert.deepEqual(extracted,[blobId]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get().n,3);
 assert.equal(next.items[0].jobId,jobId);
});

test("P3.2f real local Comfy: pre-submit failed predecessor resumes after two backend restarts; independent Job never repeats",{
 skip:!process.env.ATELIER_TEST_LOCAL_COMFY,timeout:120000
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"atelier-shot-p32f-live-"));
 const origin="http://127.0.0.1:8188";
 const options={dataDir:dir,activationRoot:join(dir,"activation"),skillsDir:join(dir,"skills"),
  comfyInstances:[{id:"local",url:origin}],autoLocalSession:true};
 let backend;
 try{
  // Durable failure injection BEFORE any /prompt submission: the original
  // failed Job has no remote evidence. A real failed GPU job must instead
  // reach a verified terminal state before this same explicit retry path.
  backend=createLocalBackend({...options,autoDispatch:false});
  const {project,body}=fixture(backend.db,{videoConfig:true});
  const seeded=createShotBatches({db:backend.db,instanceIds:()=>["local"],instanceOrigin:()=>origin});
  const batch=seeded.create(project.id,body);
  const first=batch.items[0].jobId,independent=batch.items[2].jobId;
  backend.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(first);
  assert.equal(backend.db.prepare("SELECT upstream_task_id FROM jobs WHERE id=?").get(first).upstream_task_id,null);
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
  await backend.close();backend=null;

  // First restart processes the unaffected independent Comfy video while
  // only the dependent branch remains paused due to the injected failure.
  backend=createLocalBackend({...options,autoDispatch:true});
  let ready=false;
  for(let i=0;i<150;i++){
   const [state]=backend.db.prepare("SELECT snapshot_json FROM local_shot_batches WHERE id=?").all(batch.id)
    .map(row=>JSON.parse(row.snapshot_json));
   const independentJob=backend.db.prepare("SELECT status FROM jobs WHERE id=?").get(independent);
   if(independentJob.status==="succeeded"&&
    backend.db.prepare("SELECT COUNT(*) n FROM materializations WHERE job_id=? AND status='materialized'").get(independent).n>=1&&
    state[1].status==="blocked"){ready=true;break;}
   await new Promise(resolve=>setTimeout(resolve,300));
  }
  assert.ok(ready,"original independent video did not finish or dependent branch was not blocked");
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,2);
  assert.equal(backend.db.prepare("SELECT status FROM jobs WHERE id=?").get(first).status,"failed");
  await backend.worker.stop(); // no new /prompt may be emitted while preparing the replacement
  const headers=await auth(backend);
  const revision=backend.db.prepare("SELECT revision FROM projects WHERE id=?").get(project.id).revision;
  const response=await backend.app.inject({method:"POST",
   url:`/api/v1/projects/${project.id}/shot-batches/${batch.id}/actions`,
   headers,payload:{action:"resume",expectedProjectRevision:revision,items:[body.items[0],body.items[1]]}});
  assert.equal(response.statusCode,200,response.body);
  const resume=response.json();
  assert.deepEqual(resume.items.map(item=>item.status),["queued","waiting","succeeded"]);
  assert.equal(resume.items[0].retryFromJobId,first);
  const retried=resume.items[0].jobId;
  assert.notEqual(retried,first);
  assert.equal(resume.items[2].jobId,independent);
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,3);
  await backend.close();backend=null;

  // Second restart must dispatch only the new retry and its continuation:
  // the old failed Job never gets another /prompt, independent Job unchanged.
  backend=createLocalBackend({...options,autoDispatch:true});
  let completed;
  for(let i=0;i<220;i++){
   const res=await backend.app.inject({method:"GET",url:`/api/v1/projects/${project.id}/shot-batches`,headers:await auth(backend)});
   assert.equal(res.statusCode,200,res.body);
   const current=res.json().find(entry=>entry.id===batch.id);
   assert.ok(current,"durable batch was lost");
   assert.ok(!current.items.some(item=>["submission_unknown","blocked"].includes(item.status)),
    JSON.stringify({items:current.items,jobs:backend.db.prepare("SELECT id,status,upstream_task_id FROM jobs").all()}));
   if(current.items.every(item=>item.status==="succeeded")){
    // Comfy Job terminal receipt is ahead of the separate asynchronous CAS
    // materializer. Await all three materializations, not just Job status.
    const ids=current.items.map(item=>item.jobId);
    const ready=backend.db.prepare(`SELECT COUNT(*) n FROM artifacts a JOIN materializations m ON m.artifact_id=a.id
     WHERE a.job_id IN (?,?,?) AND a.kind='video' AND m.status='materialized'`)
     .get(...ids).n;
    if(ready>=3){completed=current;break;}
   }
   await new Promise(resolve=>setTimeout(resolve,300));
  }
  assert.ok(completed,"real Comfy retry+continuation did not complete after SQLite restart");
  assert.equal(backend.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,4);
  assert.equal(backend.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(first).status,"failed");
  assert.equal(backend.db.prepare("SELECT upstream_task_id FROM jobs WHERE id=?").get(first).upstream_task_id,null);
  assert.equal(completed.items[0].jobId,retried);
  assert.equal(completed.items[2].jobId,independent);
  assert.equal(completed.items[0].retryCount,1);
  assert.equal(completed.items[1].tail.timeMs,250);
  assert.equal((await backend.blobStore.stat(completed.items[1].tail.blobId)).mimeType,"image/png");
  const bSnap=JSON.parse(backend.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(completed.items[1].jobId).snapshot_json);
  assert.equal(bSnap.comfyRequest.externalInputs[0].assetId,completed.items[1].tail.blobId);
  const snapshots=backend.db.prepare("SELECT idempotency_key FROM jobs WHERE id IN (?,?)").all(first,retried);
  assert.equal(new Set(snapshots.map(item=>item.idempotency_key)).size,2);
  const artifacts=backend.db.prepare("SELECT COUNT(*) n FROM artifacts a JOIN materializations m ON m.artifact_id=a.id WHERE a.job_id IN (?,?,?) AND a.kind='video' AND m.status='materialized'")
   .get(retried,completed.items[1].jobId,independent).n;
  assert.ok(artifacts>=3,"all three real Comfy video artifacts must survive");
 }finally{await backend?.close();await rm(dir,{recursive:true,force:true});}
});

test("real local Comfy creates three videos across backend restart and uses the extracted final PNG",{
 skip:!process.env.ATELIER_TEST_LOCAL_COMFY,timeout:90000
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"atelier-shot-batch-"));
 const options={dataDir:dir,activationRoot:join(dir,"activation"),skillsDir:join(dir,"skills"),
  comfyInstances:[{id:"local",url:"http://127.0.0.1:8188"}],autoDispatch:true,autoLocalSession:true};
 let backend;
 try{
  backend=createLocalBackend(options);
  const {project,body}=fixture(backend.db,{videoConfig:true});
  for(const item of body.items){
   const inspected=await backend.app.inject({method:"POST",url:`/api/v1/projects/${project.id}/shot-batches/inspect`,headers:await auth(backend),payload:item.snapshot});
   assert.equal(inspected.statusCode,200,inspected.body);
   assert.deepEqual(inspected.json(),{ready:true});
  }
  assert.equal(backend.db.prepare("SELECT count(*) AS n FROM jobs").get().n,0);
  const submit=await backend.app.inject({method:"POST",url:`/api/v1/projects/${project.id}/shot-batches`,
   headers:await auth(backend),payload:body});
  assert.equal(submit.statusCode,201,submit.body);
  assert.deepEqual(submit.json().items.map(item=>item.status),["queued","waiting","queued"]);
  await backend.close();
  backend=createLocalBackend(options);
  const headers=await auth(backend);
  for(let i=0;i<150;i++){
   const response=await backend.app.inject({url:`/api/v1/projects/${project.id}/shot-batches`,headers});
   assert.equal(response.statusCode,200,response.body);
   const [batch]=response.json();
   assert.ok(!batch.items.some(item=>["failed","blocked","submission_unknown"].includes(item.status)),
    JSON.stringify({batch,jobs:backend.db.prepare("SELECT status FROM jobs").all(),events:backend.db.prepare("SELECT kind,payload_json FROM job_events").all()}));
   if(batch.items.every(item=>item.status==="succeeded")){
    const second=batch.items[1];
    assert.equal(second.tail.timeMs,250);
    assert.equal((await backend.blobStore.stat(second.tail.blobId)).mimeType,"image/png");
    const snap=JSON.parse(backend.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(second.jobId).snapshot_json);
    assert.equal(snap.comfyRequest.externalInputs[0].assetId,second.tail.blobId);
    assert.equal(backend.db.prepare("SELECT count(*) AS n FROM jobs").get().n,3);
    return;
   }
   await new Promise(resolve=>setTimeout(resolve,400));
  }
  assert.fail("batch did not finish");
 }finally{await backend?.close();await rm(dir,{recursive:true,force:true});}
});

async function auth(backend){
 const session=await backend.app.inject({method:"GET",url:"/api/v1/session"});
 assert.equal(session.statusCode,200,session.body);
 return {cookie:session.headers["set-cookie"].split(";")[0],origin:"http://localhost","x-atelier-csrf":session.json().csrfToken};
}

