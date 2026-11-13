import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {createAssistantTask,getAssistantTask} from "./assistant-tasks.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,
 reconcileAssistantExternalTask,recoverAssistantExternalTasksAtStartup} from "./assistant-task-external-jobs.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";

const rev="a".repeat(64);
const doc={nodes:[
 {id:"story",type:"text",title:"Story",position:{x:0,y:0},width:300,height:240,metadata:{content:"Once upon a time"}},
 {id:"wf",type:"comfy:workflow",title:"Comfy",position:{x:350,y:0},width:420,height:260,
  metadata:{comfyWorkflow:{templateId:"workflow",templateRevision:rev,inputOverrides:{}},
   comfyPorts:[{id:"text_in",direction:"target",valueKind:"STRING",label:"Text"},
    {id:"steps",direction:"target",valueKind:"INT",label:"Steps"},
    {id:"output",direction:"source",valueKind:"IMAGE",label:"Image"}]}}
],connections:[]};
const ports=[
 {id:"text_in",label:"Text",direction:"target",valueKind:"STRING",
  inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"prompt"}]}},
 {id:"steps",label:"Steps",direction:"target",valueKind:"INT",
  inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]}},
 {id:"output",label:"Image",direction:"source",valueKind:"IMAGE"}
];
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:doc});
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run("workflow",rev,JSON.stringify({id:"workflow",revision:rev,ports}),Date.now());
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"修改工作流，生成并处理结果",requestId:"task-created"}).task;
 return {db,taskId:task.id};
}
const approve=(ctx,step)=>decideAssistantTaskStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
 stepId:step.stepId,expectedPlanVersion:1,actionDigest:step.actionDigest,
 requestId:"approve-"+step.stepId,decision:"approve"});
const canvas=(ctx,requestId,actions,dependsOn=[],finalizeTask=false)=>{
 const planned=planAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId,expectedPlanVersion:1,expectedProjectRevision:getProject(ctx.db,"p").revision,
  actions,center:{x:100,y:100},dependsOn,finalizeTask});
 approve(ctx,planned);
 const committed=executeAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:planned.stepId,expectedPlanVersion:1,actionDigest:planned.actionDigest,
  requestId:"execute-"+planned.stepId});
 return {planned,committed};
};
test("P3 Canvas→Comfy Job→materialize→Canvas is evidence-gated, crash-safe and does not requeue",t=>{
 const ctx=setup(t);
 const first=canvas(ctx,"edit-and-wire",[
  {type:"set_workflow_param",nodeId:"wf",portId:"steps",value:42},
  {type:"connect_workflow_port",fromNodeId:"story",fromPortId:"text",toNodeId:"wf",toPortId:"text_in"}]);
 assert.equal(first.committed.project.revision,2);
 const prepared=getProject(ctx.db,"p"),snapshot={adapterKind:"comfy",instanceId:"local",
  comfyRequest:{schemaVersion:2,instanceId:"local",projectId:"p",
   idempotencyKey:"temporary-click",nodes:[{id:"wf",templateId:"workflow",templateRevision:rev}],
   edges:[],rootOutputs:[{nodeId:"wf",portId:"output"}],externalInputs:[],runOptions:{}},
  comfyTemplate:{id:"workflow",revision:rev,ports}};
 const generation=planAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId:"generation-plan",kind:"comfy_workflow",expectedPlanVersion:1,
  expectedProjectRevision:prepared.revision,dependsOn:[first.planned.stepId],
  job:{targetNodeId:"wf",sourceNodeFingerprint:fingerprintSource(prepared.document,"wf"),
   executionMode:"poll",snapshot}});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.throws(()=>enqueueAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:generation.stepId,requestId:"invalid-enqueue",expectedPlanVersion:1,
  actionDigest:generation.actionDigest}),{code:"assistant_step_already_claimed"});
 approve(ctx,generation);
 const queued=enqueueAssistantExternalJobStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  stepId:generation.stepId,requestId:"valid-enqueue",expectedPlanVersion:1,
  actionDigest:generation.actionDigest});
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(getAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId}).task.status,"waiting_external");
 assert.throws(()=>planAssistantCanvasStep(ctx.db,{projectId:"p",taskId:ctx.taskId,
  requestId:"too-soon",expectedPlanVersion:1,expectedProjectRevision:2,
  actions:[{type:"set_title",nodeId:"story",title:"premature"}],center:{x:0,y:0},
  dependsOn:[generation.stepId]}),{code:"assistant_step_already_claimed"});
 ctx.db.prepare("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=?")
  .run(Date.now(),queued.jobId);
 const blobId="blob-p3",sha="b".repeat(64);
 ctx.db.prepare("INSERT INTO blobs(id,sha256,byte_size,mime,relative_path,status) VALUES(?,?,10,'text/plain','fixture/p3','ready')")
  .run(blobId,sha);
 ctx.db.prepare("INSERT INTO artifacts(id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json) VALUES(?,?,NULL,'out',?,'text','text/plain',?,'{}')")
  .run("artifact-p3",queued.jobId,blobId,sha);
 assert.ok(reconcileAssistantExternalTask(ctx.db,{projectId:"p",taskId:ctx.taskId}).advanced>=1);
 const material=ctx.db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND kind='materialize'").get(ctx.taskId);
 assert.equal(material.status,"waiting_external");
 assert.equal(getAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId}).task.status,"waiting_external");
 ctx.db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,?,?,?)")
  .run("mat-p3",queued.jobId,"artifact-p3","p","materialized","generated");
 const latest=getProject(ctx.db,"p").document;
 latest.nodes.push({id:"generated",type:"text",title:"Generated",position:{x:850,y:0},
  width:320,height:240,metadata:{content:"output from model"}});
 ctx.db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id='p'").run(JSON.stringify(latest));
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,1);
 assert.equal(recoverAssistantExternalTasksAtStartup(ctx.db).advanced,0);
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(getAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId}).task.status,"ready");
 const after=canvas(ctx,"postprocess",[{type:"set_title",nodeId:"generated",title:"Approved Output"}],
  [material.id],true);
 assert.equal(after.committed.project.document.nodes.find(n=>n.id==="generated").title,"Approved Output");
 assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 assert.equal(getAssistantTask(ctx.db,{projectId:"p",taskId:ctx.taskId}).task.status,"completed");
 assert.deepEqual(JSON.parse(ctx.db.prepare("SELECT depends_on_json FROM assistant_task_steps WHERE id=?")
  .get(generation.stepId).depends_on_json),[first.planned.stepId]);
 assert.deepEqual(JSON.parse(ctx.db.prepare("SELECT depends_on_json FROM assistant_task_steps WHERE id=?")
  .get(after.planned.stepId).depends_on_json),[material.id]);
});
