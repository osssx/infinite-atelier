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
import {registerAssistantRunSequence,getAssistantRunSequence,selectAssistantRunInput,skipAssistantRunBranch} from "./assistant-task-run-sequences.mjs";
import {createAssistantRunBudgetGrant,getAssistantRunBudgetGrant,revokeAssistantRunBudgetGrant} from "./assistant-task-run-budget.mjs";
import {assertAssistantRunMediaPlanConsent} from "./assistant-task-run-media-grant.mjs";

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
test("P3c3b skipped alternative still binds original trusted image to third Comfy workflow before any paid submit",t=>{
 const root=setup(t),db=root.db;
 const alternate={id:"alternate",type:"text",title:"Backup path",
  position:{x:0,y:540},width:340,height:200,metadata:{content:"other"}};
 const doc={nodes:[...original.nodes,alternate],connections:[]};
 db.prepare("UPDATE projects SET document_json=? WHERE id='p'").run(JSON.stringify(doc));
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat-branch",rootMessageId:"branch-root",
  originalRequest:"未产生 VIDEO 则用 IMAGE 做图像编辑",requestId:"branch-task"}).task;
 const ctx={db,projectId:"p",taskId:task.id};
 const actions=[
  {type:"run_node",nodeId:"source",mode:"image"},
  {type:"run_node",nodeId:"alternate",mode:"text",
   when:{sourceIndex:0,kind:"video",op:"gte",count:1}},
  {type:"run_workflow",nodeId:"wf",inputFromPrevious:{sourceKind:"image",toPortId:"image_in"},
   when:{sourceIndex:0,kind:"video",op:"lt",count:1}}
 ];
 const seq=registerAssistantRunSequence(db,{...ctx,requestId:"branch-plan",
  sourceMessageId:"branch-prompt",expectedPlanVersion:1,expectedProjectRevision:1,actions});
 ctx.seq=seq;
 const first=generateFirst(ctx);materialize(ctx,first);
 const before=getAssistantRunSequence(db,ctx);
 assert.equal(before.state,"skip_ready");assert.equal(before.index,1);
 const skipped=skipAssistantRunBranch(db,{...ctx,requestId:"skip-unused",
  runSequenceId:seq.sequenceId,runIndex:1,expectedPlanVersion:1,expectedProjectRevision:2,
  evidenceDigest:before.skip.evidenceDigest});
 assert.equal(skipped.skipped,true);
 const waiting=getAssistantRunSequence(db,ctx);
 assert.equal(waiting.state,"ready");assert.equal(waiting.next.index,2);
 assert.equal(waiting.next.needsBinding,true);
 assert.equal(waiting.next.inputBinding.sourceArtifactId,"art-rendered");
 assert.equal(waiting.next.inputBinding.sourceNodeId,"rendered");
 assert.equal(count(db,"jobs"),1);
 const b=waiting.next.inputBinding,actionsForBinding=[{type:"connect_workflow_port",
  fromNodeId:b.sourceNodeId,fromPortId:b.sourcePortId,toNodeId:b.toNodeId,toPortId:b.toPortId}];
 const draft=planAssistantCanvasStep(db,{...ctx,requestId:"branch-bind",
  expectedPlanVersion:1,expectedProjectRevision:2,actions:actionsForBinding,
  dependsOn:waiting.next.dependsOn,center:{x:0,y:0},
  runSequenceId:seq.sequenceId,runIndex:2});
 assert.equal(draft.status,"waiting_approval");
 assert.equal(count(db,"jobs"),1);
 const committed=commit(ctx,draft);
 assert.equal(committed.status,"succeeded");
 const now=getAssistantRunSequence(db,ctx);
 assert.equal(now.next.index,2);
 assert.equal(now.next.needsBinding,false);
 const frozen=nextJob(ctx,spec=>{spec.runIndex=2;spec.requestId="branch-workflow";});
 assert.equal(frozen.status,"waiting_approval");
 assert.equal(count(db,"jobs"),1);
 approve(ctx,frozen);
 const queued=enqueueAssistantExternalJobStep(db,{...ctx,stepId:frozen.stepId,
  requestId:"branch-workflow-enqueue",expectedPlanVersion:1,actionDigest:frozen.actionDigest});
 assert.ok(queued.jobId);
 assert.equal(count(db,"jobs"),2);
 assert.equal(getAssistantRunSequence(db,ctx).state,"waiting_external");
});
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

function mediaAuthorization(ctx,opts={}){
 ctx.db.prepare("INSERT OR IGNORE INTO comfy_instances(id,url) VALUES('comfy-local','http://127.0.0.1:8188')").run();
 return createAssistantRunBudgetGrant(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId:"media-grant",sequenceId:ctx.seq.sequenceId,expectedPlanVersion:1,
  mode:"local_comfy_media",instanceId:"comfy-local",
  maxJobs:1,allowedIndices:[1],expiresInMinutes:30,confirmed:true,...opts});
}
function consentBoundMediaStep(ctx){
 const view=getAssistantRunSequence(ctx.db,ctx),binding=view.next.inputBinding;
 const graph=getProject(ctx.db,"p");
 const step=planAssistantCanvasStep(ctx.db,{...ctx,requestId:"media-binding",
  expectedPlanVersion:1,expectedProjectRevision:graph.revision,
  actions:[{type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
   fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId}],
  center:{x:0,y:0},dependsOn:view.next.dependsOn,
  runSequenceId:ctx.seq.sequenceId,runIndex:1,
  runMediaGrantId:ctx.mediaGrant.grantId});
 return step;
}
test("P4.5b one user consent freezes unique image CAS edge then authorizes exactly one downstream Comfy Job",t=>{
 const ctx=setup(t),grant=mediaAuthorization(ctx);ctx.mediaGrant=grant;
 assert.equal(grant.mode,"local_comfy_media");
 assert.equal(grant.remainingJobs,1);
 assert.equal(count(ctx.db,"jobs"),0);
 const first=generateFirst(ctx);
 assert.equal(count(ctx.db,"jobs"),1,"Consent alone must not enqueue a downstream Job");
 materialize(ctx,first);
 const step=consentBoundMediaStep(ctx);
 assert.equal(step.status,"waiting_approval");
 assert.equal(count(ctx.db,"jobs"),1);
 assert.throws(()=>decideAssistantTaskStep(ctx.db,{...ctx,stepId:step.stepId,
  requestId:"unprivileged-decision",expectedPlanVersion:1,
  actionDigest:step.actionDigest,decision:"approve"}),{code:"assistant_run_media_grant_required"});
 const approved=decideAssistantTaskStep(ctx.db,{...ctx,stepId:step.stepId,
  requestId:"consented-decision",expectedPlanVersion:1,
  actionDigest:step.actionDigest,decision:"approve",grantId:grant.grantId});
 assert.equal(approved.status,"ready");
 const applied=executeAssistantCanvasStep(ctx.db,{...ctx,stepId:step.stepId,
  requestId:"consented-graph-commit",expectedPlanVersion:1,actionDigest:step.actionDigest});
 assert.equal(applied.status,"succeeded");
 const edge=applied.project.document.connections.find(e=>e.toNodeId==="wf");
 assert.equal(edge.fromNodeId,"rendered");assert.equal(edge.toPortId,"image_in");
 assert.equal(getAssistantRunSequence(ctx.db,ctx).next.needsBinding,false);
 const planned=nextJob(ctx);
 assert.equal(planned.status,"waiting_approval");
 const sent=enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:planned.stepId,
  requestId:"media-once",expectedPlanVersion:1,actionDigest:planned.actionDigest,
  grantId:grant.grantId});
 assert.ok(sent.jobId);
 assert.equal(count(ctx.db,"jobs"),2);
 assert.equal(getAssistantRunBudgetGrant(ctx.db,{...ctx,grantId:grant.grantId}).remainingJobs,0);
 const stored=JSON.parse(one(ctx.db,"SELECT snapshot_json FROM jobs WHERE id=?",sent.jobId).snapshot_json);
 assert.equal(stored.comfyRequest.externalInputs[0].assetId,sha);
 assert.equal(stored.comfyRequest.nodes[0].templateRevision,revision);
 assert.equal(enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:planned.stepId,
  requestId:"media-replay-different-request",expectedPlanVersion:1,
  actionDigest:planned.actionDigest,grantId:grant.grantId}).jobId,sent.jobId);
 assert.equal(count(ctx.db,"jobs"),2,"No duplicate Comfy submit may be created");
});
test("P4.5b multiple verified images stop rather than silently choosing a media input",t=>{
 const ctx=setup(t);ctx.mediaGrant=mediaAuthorization(ctx);
 materialize(ctx,generateFirst(ctx),{multi:true});
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"selection_required");
 assert.equal(count(ctx.db,"jobs"),1);
 // Even a previous explicit selection does not authorize auto-binding multiple candidates.
 const view=getAssistantRunSequence(ctx.db,ctx);
 const graph=getProject(ctx.db,"p");
 selectAssistantRunInput(ctx.db,{...ctx,requestId:"human-select",runSequenceId:ctx.seq.sequenceId,
  runIndex:1,artifactId:view.selectionCandidates[0].artifactId,
  expectedPlanVersion:1,expectedProjectRevision:graph.revision});
 assert.equal(getAssistantRunSequence(ctx.db,ctx).state,"ready");
 assert.throws(()=>consentBoundMediaStep(ctx),{code:"assistant_run_media_unique_source_required"});
 assert.equal(count(ctx.db,"jobs"),1);
 assert.equal(count(ctx.db,"assistant_task_steps"),2);
});
test("P4.5b missing CAS, repointed instance and changed Comfy pin invalidate the grant before graph mutation",t=>{
 for(const variant of ["cas","endpoint","template"]){
  const ctx=setup(t);ctx.mediaGrant=mediaAuthorization(ctx);
  materialize(ctx,generateFirst(ctx));
  if(variant==="cas")ctx.db.prepare("UPDATE blobs SET status='missing' WHERE id=?").run(sha);
  if(variant==="endpoint")ctx.db.prepare("UPDATE comfy_instances SET url='http://127.0.0.1:9999'").run();
  if(variant==="template"){
   const graph=getProject(ctx.db,"p").document;graph.nodes.find(n=>n.id==="wf").metadata.comfyWorkflow.inputOverrides={seed:999};
   ctx.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(graph));
  }
  assert.throws(()=>consentBoundMediaStep(ctx),undefined,variant);
  assert.equal(count(ctx.db,"jobs"),1);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps WHERE kind='canvas_mutation'").get().n,0);
 }
});
test("P4.5b media grant revocation after freeze blocks claim and never changes the graph",t=>{
 const ctx=setup(t);ctx.mediaGrant=mediaAuthorization(ctx);
 materialize(ctx,generateFirst(ctx));
 const step=consentBoundMediaStep(ctx);
 decideAssistantTaskStep(ctx.db,{...ctx,stepId:step.stepId,requestId:"approved-by-consent",
  expectedPlanVersion:1,actionDigest:step.actionDigest,decision:"approve",grantId:ctx.mediaGrant.grantId});
 revokeAssistantRunBudgetGrant(ctx.db,{...ctx,grantId:ctx.mediaGrant.grantId,requestId:"revoked"});
 assert.throws(()=>executeAssistantCanvasStep(ctx.db,{...ctx,stepId:step.stepId,
  requestId:"revoked-binding",expectedPlanVersion:1,actionDigest:step.actionDigest}),
  {code:"assistant_run_media_grant_not_active"});
 assert.equal(getProject(ctx.db,"p").document.connections.length,0);
 assert.equal(count(ctx.db,"jobs"),1);
});

test("P4.5b media grant rejects hidden Comfy options and altered frozen payload before enqueue",t=>{
 for(const [label,modify] of [
  ["unapproved-run-options",spec=>{spec.job.snapshot.comfyRequest.runOptions={skipValidation:true}}],
  ["extra-root",spec=>{spec.job.snapshot.comfyRequest.rootOutputs.push({nodeId:"wf",portId:"image_in"})}],
  ["extra-request",spec=>{spec.job.snapshot.comfyRequest.otherPrompt="unapproved"}],
  ["extra-snapshot",spec=>{spec.job.snapshot.comfyTargetBinding={mode:"video"}}],
  ["changed-template",spec=>{spec.job.snapshot.comfyTemplate={...template,name:"changed"}}]
 ]){
  const ctx=setup(t);ctx.mediaGrant=mediaAuthorization(ctx);
  materialize(ctx,generateFirst(ctx));
  const binding=consentBoundMediaStep(ctx);
  decideAssistantTaskStep(ctx.db,{...ctx,stepId:binding.stepId,requestId:"approve",
   expectedPlanVersion:1,actionDigest:binding.actionDigest,decision:"approve",grantId:ctx.mediaGrant.grantId});
  executeAssistantCanvasStep(ctx.db,{...ctx,stepId:binding.stepId,
   requestId:"commit",expectedPlanVersion:1,actionDigest:binding.actionDigest});
  let planned;
  try{planned=nextJob(ctx,modify)}catch{
   assert.equal(count(ctx.db,"jobs"),1,label);continue;
  }
  assert.throws(()=>enqueueAssistantExternalJobStep(ctx.db,{...ctx,stepId:planned.stepId,
   requestId:"cannot-enqueue",expectedPlanVersion:1,
   actionDigest:planned.actionDigest,grantId:ctx.mediaGrant.grantId}),undefined,label);
  assert.equal(count(ctx.db,"jobs"),1,label);
  assert.equal(getAssistantRunBudgetGrant(ctx.db,{...ctx,grantId:ctx.mediaGrant.grantId}).remainingJobs,1,label);
 }
});

test("P4.5b HTTP requires explicit dynamic media consent for approval and downstream enqueue",async t=>{
 const ctx=setup(t);
 ctx.db.prepare("INSERT INTO comfy_instances(id,url) VALUES('comfy-local','http://127.0.0.1:8188')").run();
 const app=buildApp({db:ctx.db,authorize:async()=>true});t.after(()=>app.close());
 const url="/api/v1/projects/p/assistant/tasks/"+ctx.taskId;
 const payload={requestId:"media-consent-http",sequenceId:ctx.seq.sequenceId,
  expectedPlanVersion:1,mode:"local_comfy_media",instanceId:"comfy-local",
  maxJobs:1,allowedIndices:[1],confirmed:true};
 const denied=await app.inject({method:"POST",url:url+"/run-budget",
  payload:{...payload,confirmed:false}});
 assert.equal(denied.statusCode,400);
 const consent=await app.inject({method:"POST",url:url+"/run-budget",payload});
 assert.equal(consent.statusCode,200,consent.body);
 const grantId=consent.json().grantId;
 materialize(ctx,generateFirst(ctx));
 const view=getAssistantRunSequence(ctx.db,ctx),binding=view.next.inputBinding;
 const step=await app.inject({method:"POST",url:url+"/canvas-steps",payload:{
  requestId:"http-media-bind",expectedPlanVersion:1,
  expectedProjectRevision:getProject(ctx.db,"p").revision,center:{x:0,y:0},
  runSequenceId:ctx.seq.sequenceId,runIndex:1,runMediaGrantId:grantId,
  dependsOn:view.next.dependsOn,
  actions:[{type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
   fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId}]
 }});
 assert.equal(step.statusCode,200,step.body);
 const path=url+"/steps/"+step.json().stepId;
 const approval={requestId:"http-media-approve",expectedPlanVersion:1,
  actionDigest:step.json().actionDigest,decision:"approve"};
 const noConsent=await app.inject({method:"POST",url:path+"/approval",payload:approval});
 assert.equal(noConsent.statusCode,409);
 const approved=await app.inject({method:"POST",url:path+"/approval",
  payload:{...approval,grantId}});
 assert.equal(approved.statusCode,200,approved.body);
 const committed=await app.inject({method:"POST",url:path+"/execute",payload:{
  requestId:"http-media-exec",expectedPlanVersion:1,actionDigest:step.json().actionDigest}});
 assert.equal(committed.statusCode,200,committed.body);
 assert.equal(getAssistantRunSequence(ctx.db,ctx).next.needsBinding,false);
 // The HTTP app reconciles stored templates on startup. The production
 // browser uses this same canonical pinned registry payload for its snapshot.
 const pinned=JSON.parse(ctx.db.prepare("SELECT payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?")
  .get(template.id,revision).payload_json);
 const downstream=nextJob(ctx,spec=>{spec.job.snapshot.comfyTemplate=pinned});
 const enqueued=await app.inject({method:"POST",url:url+"/steps/"+downstream.stepId+"/enqueue-authorized",
  payload:{requestId:"http-media-job",expectedPlanVersion:1,
   actionDigest:downstream.actionDigest,grantId}});
 assert.equal(enqueued.statusCode,200,enqueued.body);
 assert.equal(count(ctx.db,"jobs"),2);
 assert.equal(getAssistantRunBudgetGrant(ctx.db,{...ctx,grantId}).remainingJobs,0);
});
