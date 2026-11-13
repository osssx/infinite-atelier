import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
const rev="d".repeat(64);
const binding={templateId:"media-preset",templateRevision:rev,overrides:{},slots:{}};
const input=(id,valueKind,defaultValue)=>({
 id,label:id,direction:"target",valueKind,
 inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:id}]},
 ...(defaultValue!==undefined?{defaultValue}:{})
});
const ports=[
 input("prompt","STRING"),input("steps","INT",20),input("aspect","STRING","1:1"),
 input("api_key","STRING"),{id:"image_out",direction:"source",label:"Image",valueKind:"IMAGE"}
];
const mediaUseCase={channel:"image",primaryOutputKind:"image",promptPortId:"prompt",
 primaryOutputPortId:"image_out",slots:[],aspectSync:{mode:"ratio",portId:"aspect"}};
const image={id:"image",type:"image",position:{x:5,y:7},width:340,height:240,
 metadata:{prompt:"flower",comfyMediaPreset:binding}};
const config={id:"config",type:"config",position:{x:10,y:300},width:340,height:240,
 metadata:{generationMode:"image",prompt:"tree"}};
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{nodes:[image,config],connections:[]}});
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run(binding.templateId,rev,JSON.stringify({id:binding.templateId,revision:rev,
   ports,mediaUseCase}),Date.now());
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"c",rootMessageId:"r",
  originalRequest:"调整预设参数",requestId:"create"}).task;
 return {db,taskId:task.id};
}
const action=(nodeId,portId,value)=>({type:"set_workflow_param",nodeId,portId,value});
function plan(fx,actions,requestId="plan"){
 return planAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,requestId,
 expectedPlanVersion:1,expectedProjectRevision:getProject(fx.db,"p").revision,
 actions,center:{x:0,y:0}});
}
function execute(fx,step){
 decideAssistantTaskStep(fx.db,{projectId:"p",taskId:fx.taskId,stepId:step.stepId,
  requestId:"approve-"+step.stepId,expectedPlanVersion:1,
  actionDigest:step.actionDigest,decision:"approve"});
 return executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,stepId:step.stepId,
  requestId:"execute-"+step.stepId,expectedPlanVersion:1,actionDigest:step.actionDigest});
}
test("P3b media preset scalar and ratio override follow pinned template, preview aspect and size",t=>{
 const fx=fixture(t);
 const first=plan(fx,[action("image","steps",40),action("image","aspect","16:9")]);
 const done=execute(fx,first);
 const node=done.project.document.nodes.find(n=>n.id==="image");
 assert.equal(node.metadata.comfyMediaPreset.overrides.steps,40);
 assert.equal(node.metadata.comfyMediaPreset.overrides.aspect,"16:9");
 assert.equal(node.metadata.comfyMediaPreviewRatio,"1777778:1000000");
 assert.equal(node.width,340);assert.ok(node.height<200&&node.height>180);
 assert.equal(done.receipt.applied,2);
 assert.equal(executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
  stepId:first.stepId,requestId:"replay",expectedPlanVersion:1,
  actionDigest:first.actionDigest}).existing,true);
});
test("P3b Config node global media fallback becomes effective bound selection override",t=>{
 const fx=fixture(t);
 fx.db.prepare("UPDATE ui_settings SET revision=revision+1,value_json=? WHERE name='model_config'")
  .run(JSON.stringify({comfyWorkflowDefaults:{image:binding}}));
 const candidate=plan(fx,[action("config","steps",40)]);
 const done=execute(fx,candidate);
 const meta=done.project.document.nodes.find(n=>n.id==="config").metadata;
 assert.equal(meta.comfyWorkflowSelections.image.overrides.steps,40);
 assert.equal(meta.comfyWorkflowSelections.image.templateRevision,rev);
});
test("P3b fail closed on prompt, secret fields, invalid enum, missing version and stale UI config",t=>{
 const fx=fixture(t);
 for(const portId of ["prompt","api_key","not_real"])
  assert.throws(()=>plan(fx,[action("image",portId,"bad")],"bad-"+portId));
 assert.throws(()=>plan(fx,[action("image","steps","not-an-integer")],"wrong-int"));
 const saved=plan(fx,[action("image","steps",40)]);
 decideAssistantTaskStep(fx.db,{projectId:"p",taskId:fx.taskId,
  stepId:saved.stepId,requestId:"approval",expectedPlanVersion:1,actionDigest:saved.actionDigest,
  decision:"approve"});
 fx.db.prepare("UPDATE ui_settings SET revision=revision+1,value_json=? WHERE name='model_config'")
  .run(JSON.stringify({comfyWorkflowDefaults:{}}));
 assert.throws(()=>executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
  stepId:saved.stepId,requestId:"try",expectedPlanVersion:1,actionDigest:saved.actionDigest}),
  {code:"assistant_step_source_changed"});
 assert.equal(getProject(fx.db,"p").revision,1);
});
