
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

