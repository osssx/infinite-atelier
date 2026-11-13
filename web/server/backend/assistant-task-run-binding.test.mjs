import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {buildApp} from "./app.mjs";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep,claimAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,recoverAssistantCanvasTasksAtStartup} from "./assistant-task-canvas-executor.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask,recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence,selectAssistantRunInput} from "./assistant-task-run-sequences.mjs";

const sha="a".repeat(64),shaTwo="c".repeat(64),revision="b".repeat(64);
const template={id:"demo-image-refine",revision,name:"Image refine",
 apiGraph:{"1":{class_type:"LoadImage",inputs:{image:"input.png"}},
  "2":{class_type:"SaveImage",inputs:{images:["1",0]}}},
 requirements:{classTypes:["LoadImage","SaveImage"]},ports:[
 {id:"image_in",label:"Input image",direction:"target",valueKind:"IMAGE",
  inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"1",inputName:"image"}]}},
 {id:"result",label:"Output image",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"2",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}
]};
const source={id:"source",type:"image",title:"Source",position:{x:0,y:0},
 width:340,height:240,metadata:{prompt:"one image"}};
const target={id:"wf",type:"comfy:workflow",title:"Refine workflow",position:{x:480,y:0},
 width:420,height:260,metadata:{
  comfyWorkflow:{templateId:template.id,templateRevision:revision,inputOverrides:{}},
  comfyPorts:template.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))
 }};
const original={nodes:[source,target],connections:[]};
const acts=[{type:"run_node",nodeId:"source",mode:"image"},
 {type:"run_workflow",nodeId:"wf",inputFromPrevious:{sourceKind:"image",toPortId:"image_in"}}];
const one=(db,sql,...args)=>db.prepare(sql).get(...args);
const count=(db,table)=>one(db,"SELECT COUNT(*) AS n FROM "+table).n;
function setup(t,db=new DatabaseSync(":memory:")){
 initializeSchema(db);t.after(()=>{try{db.close()}catch{}});
 createProject(db,{id:"p",document:original});
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run(template.id,revision,JSON.stringify(template),Date.now());
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"先生成图片，再输入 Comfy 图像编辑工作流",requestId:"task-create"}).task;
 const ctx={db,projectId:"p",taskId:task.id};
 const seq=registerAssistantRunSequence(db,{...ctx,requestId:"seq",
  sourceMessageId:"intent",expectedPlanVersion:1,expectedProjectRevision:1,actions:acts});
 return {...ctx,seq};
}
function approve(ctx,step,decision="approve"){
 return decideAssistantTaskStep(ctx.db,{projectId:ctx.projectId,taskId:ctx.taskId,
  stepId:step.stepId,requestId:"approve-"+step.stepId,
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision});
}
function generateFirst(ctx){
 const step=planAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId:"plan-first",kind:"model_job",expectedPlanVersion:1,expectedProjectRevision:1,
  job:{targetNodeId:"source",sourceNodeFingerprint:fingerprintSource(original,"source"),
   executionMode:"poll",snapshot:{adapterKind:"model",task:{kind:"image",model:"mock",prompt:"image"}}},
  runSequenceId:ctx.seq.sequenceId,runIndex:0,dependsOn:[]});
 approve(ctx,step);
 const queued=enqueueAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,stepId:step.stepId,
  requestId:"enqueue-first",expectedPlanVersion:1,actionDigest:step.actionDigest});
 return queued.jobId;
}
function materialize(ctx,jobId,{multi=false}={}){
 const {db}=ctx;
 db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
 db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,100,'image/png','cas/test.png','ready')").run(sha,sha);
 db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES('art-rendered',?,'image','img',?,'image','image/png',?,'{}')")
  .run(jobId,sha,sha);
 if(multi){
  db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,110,'image/png','cas/test-two.png','ready')")
   .run(shaTwo,shaTwo);
  db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES('art-rendered-two',?,'image','img-2',?,'image','image/png',?,'{}')")
   .run(jobId,shaTwo,shaTwo);
 }
 reconcileAssistantExternalTask(db,ctx);
 const result=getProject(db,"p").document;
 result.nodes.push({id:"rendered",type:"image",title:"Generated source",
  position:{x:100,y:350},width:340,height:240,metadata:{storageKey:"cas:"+sha}});
 if(multi)result.nodes.push({id:"rendered-two",type:"image",title:"Second trusted image",
  position:{x:480,y:350},width:340,height:240,metadata:{storageKey:"cas:"+shaTwo}});
 db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(result));
 db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES('mat',?,'art-rendered','p','materialized','rendered')").run(jobId);
 if(multi)db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES('mat-two',?,'art-rendered-two','p','materialized','rendered-two')").run(jobId);
 reconcileAssistantExternalTask(db,ctx);
 assert.equal(getAssistantTask(db,ctx).task.status,"ready");
}
function bind(ctx){
 const view=getAssistantRunSequence(ctx.db,ctx);
 assert.equal(view.state,"ready");
 assert.equal(view.next.index,1);
 assert.equal(view.next.needsBinding,true);
 assert.deepEqual(view.next.inputBinding.sourceKind,"image");
 const b=view.next.inputBinding;
 const actions=[{type:"connect_workflow_port",fromNodeId:b.sourceNodeId,fromPortId:b.sourcePortId,
  toNodeId:b.toNodeId,toPortId:b.toPortId}];
 const draft=planAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,requestId:"bind",
  expectedPlanVersion:1,expectedProjectRevision:getProject(ctx.db,"p").revision,
  actions,dependsOn:view.next.dependsOn,center:{x:0,y:0},
  runSequenceId:ctx.seq.sequenceId,runIndex:1});
 return {draft,actions,b};
}
function commit(ctx,step){
 approve(ctx,step);
 return executeAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:step.stepId,requestId:"commit-binding",expectedPlanVersion:1,
  actionDigest:step.actionDigest});
}
function nextJob(ctx,alter){
 const graph=getProject(ctx.db,"p");
 const next=getAssistantRunSequence(ctx.db,ctx).next;
 const b=next?.inputBinding??{sourceNodeId:"rendered",sourcePortId:"image",
  toNodeId:"wf",toPortId:"image_in",sourceSha256:sha,valueKind:"IMAGE"};
 const snapshot={adapterKind:"comfy",instanceId:"comfy-local",comfyRequest:{
  schemaVersion:2,projectId:"p",canvasRevision:String(graph.revision),instanceId:"comfy-local",
  nodes:[{id:"wf",templateId:template.id,templateRevision:revision,inputOverrides:{}}],
  rootOutputs:[{nodeId:"wf",portId:"result"}],
  edges:[{fromNodeId:b.sourceNodeId,fromPortId:b.sourcePortId,toNodeId:b.toNodeId,toPortId:b.toPortId}],
  externalInputs:[{kind:"asset",sourceNodeId:b.sourceNodeId,sourcePortId:b.sourcePortId,
   valueKind:b.valueKind,assetId:b.sourceSha256,sha256:b.sourceSha256}],
  runOptions:{},idempotencyKey:"provisional-uuid"
 },comfyTemplate:template};
 const spec={projectId:"p",taskId:ctx.taskId,requestId:"plan-second",
  kind:"comfy_workflow",expectedPlanVersion:1,expectedProjectRevision:graph.revision,
  job:{targetNodeId:"wf",sourceNodeFingerprint:fingerprintSource(graph.document,"wf"),
   executionMode:"poll",snapshot},
  dependsOn:next?.dependsOn??[],runSequenceId:ctx.seq.sequenceId,runIndex:1};
 if(alter)alter(spec);
 return planAssistantExternalJobStep(ctx.db,spec);
}
test("P3c3a multiple trusted IMAGE artifacts require explicit immutable choice before binding or second Job",t=>{
 const ctx=setup(t),jobId=generateFirst(ctx);
 materialize(ctx,jobId,{multi:true});
 const pending=getAssistantRunSequence(ctx.db,ctx);
 assert.equal(pending.state,"selection_required");
 assert.equal(pending.index,1);
 assert.equal(pending.selectionCandidates.length,2);
 assert.deepEqual(pending.selectionCandidates.map(v=>v.itemKey).sort(),["img","img-2"]);
 assert.equal(count(ctx.db,"jobs"),1);
 const intent={...ctx,runSequenceId:ctx.seq.sequenceId,runIndex:1,
  expectedPlanVersion:1,expectedProjectRevision:2};
 assert.throws(()=>selectAssistantRunInput(ctx.db,{...intent,requestId:"fake",
  artifactId:"some-other-image"}),{code:"assistant_task_run_input_selection_unverified"});
 assert.throws(()=>selectAssistantRunInput(ctx.db,{...intent,requestId:"wrong-version",
  expectedProjectRevision:1,artifactId:"art-rendered-two"}),{code:"assistant_step_source_changed"});
 assert.throws(()=>planAssistantCanvasStep(ctx.db,{...ctx,requestId:"selection-bypass",expectedPlanVersion:1,
  expectedProjectRevision:2,actions:[{type:"connect_workflow_port",fromNodeId:"rendered",fromPortId:"image",
   toNodeId:"wf",toPortId:"image_in"}],dependsOn:[],center:{x:0,y:0},
  runSequenceId:ctx.seq.sequenceId,runIndex:1}),{code:"assistant_task_run_not_ready"});
 assert.equal(count(ctx.db,"jobs"),1);
 const selected=selectAssistantRunInput(ctx.db,{...intent,requestId:"select-second",
  artifactId:"art-rendered-two"});
 assert.equal(selected.selected,true);
 assert.equal(selected.existing,false);
 assert.equal(selectAssistantRunInput(ctx.db,{...intent,requestId:"select-second",
  artifactId:"art-rendered-two"}).existing,true);
 assert.equal(selectAssistantRunInput(ctx.db,{...intent,requestId:"select-again",
  artifactId:"art-rendered-two"}).existing,true);
 assert.throws(()=>selectAssistantRunInput(ctx.db,{...intent,requestId:"different-choice",
  artifactId:"art-rendered"}),{code:"assistant_task_run_input_selection_conflict"});
 assert.equal(count(ctx.db,"assistant_task_run_input_selections"),1);
 const ready=getAssistantRunSequence(ctx.db,ctx);
 assert.equal(ready.state,"ready");
 assert.equal(ready.next.needsBinding,true);
 assert.equal(ready.next.inputBinding.sourceArtifactId,"art-rendered-two");
 assert.equal(ready.next.inputBinding.sourceSha256,shaTwo);
 assert.equal(ready.next.inputBinding.sourceNodeId,"rendered-two");
 assert.equal(getProject(ctx.db,"p").document.connections.length,0);
 const {draft}=bind(ctx);
 assert.equal(count(ctx.db,"jobs"),1);
 commit(ctx,draft);
 const follow=getAssistantRunSequence(ctx.db,ctx);
 assert.equal(follow.next.needsBinding,false);
 assert.equal(follow.next.inputBinding.sourceArtifactId,"art-rendered-two");
 const frozen=nextJob(ctx);
 const payload=JSON.parse(one(ctx.db,"SELECT action_json FROM assistant_task_steps WHERE id=?",frozen.stepId).action_json);
 assert.equal(payload.job.snapshot.comfyRequest.externalInputs[0].assetId,shaTwo);
 assert.equal(count(ctx.db,"jobs"),1);
 approve(ctx,frozen);
 enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:frozen.stepId,requestId:"enqueue-multi-second",
  expectedPlanVersion:1,actionDigest:frozen.actionDigest});
 assert.equal(count(ctx.db,"jobs"),2);
});
test("P3c3a grouped multi-image batch cannot silently bind non-primary gallery image",t=>{
 const ctx=setup(t),first=generateFirst(ctx);
 materialize(ctx,first,{multi:true});
 const db=ctx.db,graph=getProject(db,"p").document;
 const primary=graph.nodes.find(node=>node.id==="rendered");
 primary.metadata.images=[
  {storageKey:"cas:"+sha,id:"img-a"},
  {storageKey:"cas:"+shaTwo,id:"img-b"}
 ];
 graph.nodes=graph.nodes.filter(node=>node.id!=="rendered-two");
 db.prepare("UPDATE materializations SET node_id='rendered' WHERE artifact_id='art-rendered-two'").run();
 const materialStep=db.prepare("SELECT id,receipt_json FROM assistant_task_steps WHERE kind='materialize' AND task_id=?")
  .get(ctx.taskId);
 const materialReceipt=JSON.parse(materialStep.receipt_json);
 materialReceipt.bindings=materialReceipt.bindings.map(b=>b.artifactId==="art-rendered-two"?
  {...b,nodeId:"rendered"}:b);
 db.prepare("UPDATE assistant_task_steps SET receipt_json=? WHERE id=?")
  .run(JSON.stringify(materialReceipt),materialStep.id);
 db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(graph));
 const before=getAssistantRunSequence(db,ctx);
 assert.equal(before.state,"selection_required");
 assert.equal(before.selectionCandidates.length,2);
 assert.equal(before.selectionCandidates.find(v=>v.artifactId==="art-rendered").addressable,true);
 assert.equal(before.selectionCandidates.find(v=>v.artifactId==="art-rendered-two").addressable,false);
 const args={...ctx,runSequenceId:ctx.seq.sequenceId,runIndex:1,
  expectedPlanVersion:1,expectedProjectRevision:3};
 assert.throws(()=>selectAssistantRunInput(db,{...args,requestId:"non-primary",
  artifactId:"art-rendered-two"}),{code:"assistant_task_run_input_selection_unverified"});
 assert.equal(count(db,"assistant_task_run_input_selections"),0);
 const chosen=selectAssistantRunInput(db,{...args,requestId:"primary",
  artifactId:"art-rendered"});
 assert.equal(chosen.selected,true);
 assert.equal(getAssistantRunSequence(db,ctx).next.inputBinding.sourceSha256,sha);
 // The selected artifact becomes unaddressable if the gallery primary changes.
 // A previously frozen selection must not redirect to that other visible image.
 primary.metadata.storageKey="cas:"+shaTwo;
 primary.metadata.primaryImageId="img-b";
 db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(graph));
 assert.equal(getAssistantRunSequence(db,ctx).state,"selection_invalidated");
 assert.equal(count(db,"jobs"),1);
});
test("P3c3a HTTP selection preserves identity, rejects invalid inputs and never enqueues on selection",async t=>{
 const ctx=setup(t),app=buildApp({db:ctx.db,authorize:()=>true});
 t.after(async()=>app.close());
 const first=generateFirst(ctx);materialize(ctx,first,{multi:true});
 const path="/api/v1/projects/p/assistant/tasks/"+ctx.taskId+"/run-sequences";
 const call=async(method,url,payload)=>{
  const r=await app.inject({method,url,...(payload?{payload}:{})});
  return {status:r.statusCode,body:r.json()};
 };
 const list=await call("GET",path);
 assert.equal(list.status,200);
 assert.equal(list.body.state,"selection_required");
 assert.equal(list.body.selectionCandidates.length,2);
 assert.equal(list.body.selectionCandidates.some(v=>v.itemKey==="img-2"),true);
 const body={requestId:"http-pick-second",runSequenceId:ctx.seq.sequenceId,
  runIndex:1,artifactId:"art-rendered-two",expectedPlanVersion:1,
  expectedProjectRevision:2};
 const invalid=await call("POST",path+"/select",{...body,requestId:"http-forged",
  artifactId:"made-up"});
 assert.equal(invalid.status,409);
 const selection=await call("POST",path+"/select",body);
 assert.equal(selection.status,200,JSON.stringify(selection.body));
 assert.equal(selection.body.selected,true);
 assert.equal((await call("POST",path+"/select",body)).body.existing,true);
 assert.equal((await call("POST",path+"/select",{...body,requestId:"http-swap",
  artifactId:"art-rendered"})).status,409);
 assert.equal((await call("GET",path)).body.next.inputBinding.sourceArtifactId,"art-rendered-two");
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(count(ctx.db,"assistant_task_steps"),2);
});
test("P3c3a selected output survives SQLite restart; missing CAS proof blocks without picking another",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p3c3a-")),file=join(dir,"db.sqlite");
 const db=new DatabaseSync(file),ctx=setup(t,db);
 let active=db;
 t.after(()=>{try{active.close()}catch{};rmSync(dir,{recursive:true,force:true})});
 const first=generateFirst(ctx);materialize(ctx,first,{multi:true});
 selectAssistantRunInput(active,{...ctx,requestId:"disk-choice",
  runSequenceId:ctx.seq.sequenceId,runIndex:1,artifactId:"art-rendered-two",
  expectedPlanVersion:1,expectedProjectRevision:2});
 active.close();active=new DatabaseSync(file);ctx.db=active;initializeSchema(active);
 let recovered=getAssistantRunSequence(active,ctx);
 assert.equal(recovered.next.inputBinding.sourceArtifactId,"art-rendered-two");
 assert.equal(count(active,"jobs"),1);
 active.prepare("UPDATE blobs SET status='missing' WHERE id=?").run(shaTwo);
 assert.equal(getAssistantRunSequence(active,ctx).state,"awaiting_verified_input");
 assert.equal(count(active,"jobs"),1);
 active.prepare("UPDATE blobs SET status='ready' WHERE id=?").run(shaTwo);
 recovered=getAssistantRunSequence(active,ctx);
 assert.equal(recovered.state,"ready");
 assert.equal(recovered.next.inputBinding.sourceArtifactId,"art-rendered-two");
 assert.equal(count(active,"assistant_task_run_input_selections"),1);
});
test("P3c2 trusted media binding HTTP approval and independent downstream enqueue",async t=>{
 const ctx=setup(t),app=buildApp({db:ctx.db,authorize:()=>true});
 t.after(async()=>{await app.close()});
 const call=async(method,url,payload)=>{
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});
  return {status:response.statusCode,body:response.json()};
 };
 const path="/api/v1/projects/p/assistant/tasks/"+ctx.taskId;
 const job=generateFirst(ctx);materialize(ctx,job);
 const next=(await call("GET",path+"/run-sequences")).body.next;
 assert.equal(next.needsBinding,true);
 const b=next.inputBinding,actions=[{type:"connect_workflow_port",
  fromNodeId:b.sourceNodeId,fromPortId:b.sourcePortId,
  toNodeId:b.toNodeId,toPortId:b.toPortId}];
 const bad=await call("POST",path+"/canvas-steps",{requestId:"bypass-http",expectedPlanVersion:1,
  expectedProjectRevision:2,center:{x:0,y:0},actions,dependsOn:next.dependsOn});
 assert.equal(bad.status,409);
 const frozenBody={requestId:"http-bind",expectedPlanVersion:1,expectedProjectRevision:2,
  center:{x:0,y:0},actions,dependsOn:next.dependsOn,
  runSequenceId:ctx.seq.sequenceId,runIndex:1};
 const frozen=await call("POST",path+"/canvas-steps",frozenBody);
 assert.equal(frozen.status,200,JSON.stringify(frozen.body));
 assert.equal((await call("POST",path+"/canvas-steps",frozenBody)).body.stepId,frozen.body.stepId);
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal((await call("GET",path+"/run-sequences")).body.state,"waiting_approval");
 const endpoint=path+"/steps/"+frozen.body.stepId;
 assert.equal((await call("POST",endpoint+"/execute",{requestId:"too-early",
  expectedPlanVersion:1,actionDigest:frozen.body.actionDigest})).status,409);
 const approval=await call("POST",endpoint+"/approval",{requestId:"http-approve",
  expectedPlanVersion:1,actionDigest:frozen.body.actionDigest,decision:"approve"});
 assert.equal(approval.status,200,JSON.stringify(approval.body));
 const committed=await call("POST",endpoint+"/execute",{requestId:"http-commit",
  expectedPlanVersion:1,actionDigest:frozen.body.actionDigest});
 assert.equal(committed.status,200,JSON.stringify(committed.body));
 assert.equal((await call("GET",path+"/run-sequences")).body.next.needsBinding,false);
 const second=(await call("GET",path+"/run-sequences")).body.next;
 assert.deepEqual(second.dependsOn,[frozen.body.stepId]);
 assert.equal(count(ctx.db,"jobs"),1);
 const illegal=await call("POST",path+"/external-jobs",{
  requestId:"http-no-digest",expectedPlanVersion:1,
  expectedProjectRevision:getProject(ctx.db,"p").revision,kind:"comfy_workflow",
  runSequenceId:ctx.seq.sequenceId,runIndex:1,dependsOn:[],
  job:{targetNodeId:"wf",sourceNodeFingerprint:"invalid",executionMode:"poll",
   snapshot:{adapterKind:"comfy",instanceId:"comfy-local",comfyRequest:{nodes:[]}}}});
 assert.equal(illegal.status,409);
 assert.equal(count(ctx.db,"jobs"),1);
});
test("P3c2 freezes prior generated IMAGE -> Comfy typed input as separately approved graph step",t=>{
 const ctx=setup(t),firstJob=generateFirst(ctx);
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"waiting_external");
 materialize(ctx,firstJob);
 assert.throws(()=>nextJob(ctx),{code:"assistant_task_run_input_not_bound"});
 assert.equal(count(ctx.db,"jobs"),1);
 assert.throws(()=>planAssistantCanvasStep(ctx.db,{...ctx,requestId:"bypass",
  expectedPlanVersion:1,expectedProjectRevision:2,
  actions:[{type:"connect_workflow_port",fromNodeId:"rendered",fromPortId:"image",
   toNodeId:"wf",toPortId:"image_in"}],center:{x:0,y:0}}),
  {code:"assistant_task_run_sequence_active"});
 const {draft,actions,b}=bind(ctx);
 assert.deepEqual(b,{sourceArtifactId:"art-rendered",sourceSha256:sha,
  sourceMaterialStepId:getAssistantRunSequence(ctx.db,ctx).outputs[0].materialStepId,
  sourceNodeId:"rendered",sourcePortId:"image",toNodeId:"wf",toPortId:"image_in",
  sourceKind:"image",valueKind:"IMAGE"});
 assert.equal(getProject(ctx.db,"p").document.connections.length,0);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"waiting_approval");
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(bindProof(ctx,draft),true);
 const committed=commit(ctx,draft);
 assert.equal(committed.status,"succeeded");
 assert.equal(committed.project.document.connections.length,1);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"ready");
 assert.equal(getAssistantRunSequence(ctx.db,ctx).next.needsBinding,false);
 assert.deepEqual(getAssistantRunSequence(ctx.db,ctx).next.dependsOn,[draft.stepId]);
 assert.equal(executeAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:draft.stepId,requestId:"repeat-binding",
  expectedPlanVersion:1,actionDigest:draft.actionDigest}).existing,true);
 const frozen=nextJob(ctx);
 assert.equal(frozen.status,"waiting_approval");
 assert.equal(count(ctx.db,"jobs"),1);
 approve(ctx,frozen);
 const queued=enqueueAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:frozen.stepId,requestId:"enqueue-second",expectedPlanVersion:1,actionDigest:frozen.actionDigest});
 assert.equal(queued.status,"waiting_external");
 assert.equal(count(ctx.db,"jobs"),2);
 assert.equal(enqueueAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:frozen.stepId,requestId:"enqueue-second-again",expectedPlanVersion:1,
  actionDigest:frozen.actionDigest}).jobId,queued.jobId);
 assert.equal(count(ctx.db,"jobs"),2);
 assert.equal(recoverAssistantCanvasTasksAtStartup(ctx.db).released,0);
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,0);
});
function bindProof(ctx,step){
 const pre=JSON.parse(one(ctx.db,"SELECT preconditions_json FROM assistant_task_steps WHERE id=?",step.stepId).preconditions_json);
 return pre.runSourceArtifactId==="art-rendered"&&pre.runSourceSha256===sha;
}
test("P3c2 disk restart releases only unsubmitted graph claim and keeps the same paid downstream Job",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-p3c2-disk-")),file=join(dir,"db.sqlite");
 const originalDb=new DatabaseSync(file),ctx=setup(t,originalDb);
 let active=originalDb;
 t.after(()=>{try{active.close()}catch{};rmSync(dir,{recursive:true,force:true})});
 const first=generateFirst(ctx);materialize(ctx,first);
 const {draft}=bind(ctx);approve(ctx,draft);
 const claim=claimAssistantTaskStep(active,{projectId:"p",taskId:ctx.taskId,
  stepId:draft.stepId,expectedPlanVersion:1});
 assert.equal(claim.frozenSnapshot.action.actions[0].type,"connect_workflow_port");
 assert.equal(count(active,"jobs"),1);
 active.close();
 active=new DatabaseSync(file);ctx.db=active;initializeSchema(active);
 assert.equal(recoverAssistantCanvasTasksAtStartup(active).released,1);
 assert.equal(one(active,"SELECT status FROM assistant_task_steps WHERE id=?",draft.stepId).status,"ready");
 assert.equal(count(active,"jobs"),1);
 const committed=executeAssistantCanvasStep(active,{projectId:"p",taskId:ctx.taskId,
  stepId:draft.stepId,requestId:"post-restart-commit",expectedPlanVersion:1,
  actionDigest:draft.actionDigest});
 assert.equal(committed.status,"succeeded");
 assert.equal(committed.project.document.connections.length,1);
 assert.equal(getAssistantRunSequence(active,ctx).next.needsBinding,false);
 const planned=nextJob(ctx);
 assert.equal(count(active,"jobs"),1);
 approve(ctx,planned);
 const queued=enqueueAssistantExternalJobStep(active,{projectId:"p",taskId:ctx.taskId,
  stepId:planned.stepId,requestId:"post-restart-enqueue",expectedPlanVersion:1,
  actionDigest:planned.actionDigest});
 assert.equal(count(active,"jobs"),2);
 active.close();
 active=new DatabaseSync(file);ctx.db=active;initializeSchema(active);
 assert.equal(recoverAssistantExternalTasksAtStartup(active).advanced,0);
 assert.equal(one(active,"SELECT status FROM jobs WHERE id=?",queued.jobId).status,"queued");
 assert.equal(enqueueAssistantExternalJobStep(active,{projectId:"p",taskId:ctx.taskId,
  stepId:planned.stepId,requestId:"after-second-restart",expectedPlanVersion:1,
  actionDigest:planned.actionDigest}).jobId,queued.jobId);
 assert.equal(count(active,"jobs"),2);
});
test("P3c2 binding rejects wrong source, wrong type, missing CAS and forged snapshot before next Job",t=>{
 const ctx=setup(t),firstJob=generateFirst(ctx);
 materialize(ctx,firstJob);
 const b=getAssistantRunSequence(ctx.db,ctx).next.inputBinding;
 const action={type:"connect_workflow_port",fromNodeId:b.sourceNodeId,fromPortId:b.sourcePortId,
  toNodeId:b.toNodeId,toPortId:b.toPortId};
 for(const [label,actions] of [
  ["wrong-target",[{...action,toPortId:"guessed"}]],
  ["wrong-source",[{...action,fromNodeId:"source"}]],
  ["wrong-port-type",[{...action,fromPortId:"text"}]],
  ["extra-action",[action,{type:"set_title",nodeId:"wf",title:"oops"}]]
 ]){
  assert.throws(()=>planAssistantCanvasStep(ctx.db,{...ctx,requestId:label,
   expectedPlanVersion:1,expectedProjectRevision:2,actions,
   dependsOn:getAssistantRunSequence(ctx.db,ctx).next.dependsOn,center:{x:0,y:0},
   runSequenceId:ctx.seq.sequenceId,runIndex:1}));
 }
 assert.equal(getProject(ctx.db,"p").document.connections.length,0);
 assert.equal(count(ctx.db,"assistant_task_steps"),2); // job + materialize
 const {draft}=bind(ctx);approve(ctx,draft);
 ctx.db.prepare("UPDATE blobs SET status='missing' WHERE id=?").run(sha);
 assert.throws(()=>executeAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:draft.stepId,requestId:"attempt-corrupt",expectedPlanVersion:1,
  actionDigest:draft.actionDigest}),{code:"assistant_task_run_input_unavailable"});
 assert.equal(getProject(ctx.db,"p").document.connections.length,0);
 assert.equal(count(ctx.db,"jobs"),1);
 // Freshly confirmed asset can safely resume the same prepared, unsubmitted graph Step.
 ctx.db.prepare("UPDATE blobs SET status='ready' WHERE id=?").run(sha);
 recoverAssistantCanvasTasksAtStartup(ctx.db);
 const signed=executeAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:draft.stepId,requestId:"retry-verified",expectedPlanVersion:1,
  actionDigest:draft.actionDigest});
 assert.equal(signed.status,"succeeded");
 // Forged media IDs, digest, source edge and dependency are rejected before the Step is frozen.
 const previous=count(ctx.db,"assistant_task_steps");
 for(const [name,modify] of [
  ["different-asset",spec=>{spec.job.snapshot.comfyRequest.externalInputs[0].assetId="0".repeat(64)}],
  ["different-sha",spec=>{spec.job.snapshot.comfyRequest.externalInputs[0].sha256="1".repeat(64)}],
  ["different-edge",spec=>{spec.job.snapshot.comfyRequest.edges[0].fromNodeId="source"}],
  ["missing-edge",spec=>{spec.job.snapshot.comfyRequest.edges=[]}],
  ["wrong-dependency",spec=>{spec.dependsOn=[]}]
 ]){
  assert.throws(()=>nextJob(ctx,modify),undefined,name);
  assert.equal(count(ctx.db,"assistant_task_steps"),previous,name);
 }
 assert.equal(count(ctx.db,"jobs"),1);
 const fresh=nextJob(ctx);
 const actionJson=JSON.parse(one(ctx.db,"SELECT action_json FROM assistant_task_steps WHERE id=?",fresh.stepId).action_json);
 assert.equal(actionJson.job.snapshot.comfyRequest.externalInputs[0].sha256,sha);
 assert.equal(count(ctx.db,"jobs"),1);
});
