import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep,
 recoverAssistantCanvasTasksAtStartup} from "./assistant-task-canvas-executor.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
const nodes=[
 {id:"img",type:"image",position:{x:0,y:0},width:340,height:240,metadata:{prompt:"a fox"}},
 {id:"txt",type:"text",position:{x:400,y:0},width:340,height:240,metadata:{content:"Once"}},
 {id:"config",type:"config",position:{x:0,y:350},width:340,height:240,
  metadata:{generationMode:"video",prompt:"forest"}},
 {id:"video",type:"video",position:{x:400,y:350},width:420,height:240,metadata:{prompt:"bird"}},
 {id:"audio",type:"audio",position:{x:900,y:0},width:340,height:120,metadata:{prompt:"voice"}}
];
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{nodes,connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"调整生成参数",requestId:"task"}).task;
 return {db,taskId:task.id};
}
const plan=(fx,actions,req="plan")=>planAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
 requestId:req,expectedPlanVersion:1,expectedProjectRevision:getProject(fx.db,"p").revision,
 actions,center:{x:0,y:0}});
const execute=(fx,candidate)=>{decideAssistantTaskStep(fx.db,{projectId:"p",taskId:fx.taskId,
 stepId:candidate.stepId,requestId:"approve-"+candidate.stepId,expectedPlanVersion:1,
 actionDigest:candidate.actionDigest,decision:"approve"});
 return executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
 stepId:candidate.stepId,expectedPlanVersion:1,requestId:"exec-"+candidate.stepId,
 actionDigest:candidate.actionDigest});};
test("P3b plain model parameter edits preserve frontend storage and complete with trusted receipt",t=>{
 const fx=fixture(t);
 const c=plan(fx,[
  {type:"set_node_param",nodeId:"img",key:"count",value:3},
  {type:"set_node_param",nodeId:"config",key:"seconds",value:8},
  {type:"set_node_param",nodeId:"audio",key:"audioSpeed",value:1.5},
  {type:"set_node_param",nodeId:"video",key:"generateAudio",value:false},
  {type:"set_node_param",nodeId:"txt",key:"reasoningEffort",value:"high"},
 ]);
 const result=execute(fx,c);
 assert.equal(result.receipt.applied,5);
 const metadata=id=>result.project.document.nodes.find(n=>n.id===id).metadata;
 assert.equal(metadata("img").count,3);
 assert.equal(metadata("config").seconds,"8");
 assert.equal(metadata("audio").audioSpeed,"1.5");
 assert.equal(metadata("video").generateAudio,"false");
 assert.equal(metadata("txt").reasoningEffort,"high");
 assert.equal(executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
  stepId:c.stepId,expectedPlanVersion:1,requestId:"replay",actionDigest:c.actionDigest}).existing,true);
});
test("P3b rejects wrong parameter modes, unexpected keys and Comfy bound metadata before graph writes",t=>{
 const fx=fixture(t);
 const invalid=[
  {type:"set_node_param",nodeId:"img",key:"seconds",value:9},
  {type:"set_node_param",nodeId:"txt",key:"quality",value:"high"},
  {type:"set_node_param",nodeId:"img",key:"count",value:11},
  {type:"set_node_param",nodeId:"img",key:"count",value:2.5},
  {type:"set_node_param",nodeId:"video",key:"videoRatio",value:"16:10"},
  {type:"set_node_param",nodeId:"img",key:"apiKey",value:"sk-secret"},
  {type:"set_node_param",nodeId:"img",key:"model",value:"unknown::image"},
  {type:"set_node_param",nodeId:"audio",key:"audioSpeed",value:"1.2"}
 ];
 for(let i=0;i<invalid.length;i++)assert.throws(()=>plan(fx,[invalid[i]],"bad-"+i));
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(getProject(fx.db,"p").revision,1);
});
test("P3b model selection pinned to real channel metadata and UI config revision",t=>{
 const fx=fixture(t);
 fx.db.prepare("UPDATE ui_settings SET revision=revision+1,value_json=? WHERE name='model_config'")
  .run(JSON.stringify({channels:[{id:"provider",models:[{name:"gpt-img",capability:"image"}]}]}));
 const candidate=plan(fx,[{type:"set_node_param",nodeId:"img",key:"model",value:"provider::gpt-img"}]);
 decideAssistantTaskStep(fx.db,{projectId:"p",taskId:fx.taskId,stepId:candidate.stepId,
  requestId:"approve",expectedPlanVersion:1,actionDigest:candidate.actionDigest,decision:"approve"});
 fx.db.prepare("UPDATE ui_settings SET revision=revision+1,value_json=? WHERE name='model_config'")
  .run(JSON.stringify({channels:[{id:"other",models:[{name:"new",capability:"image"}]}]}));
 assert.throws(()=>executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.taskId,
  stepId:candidate.stepId,expectedPlanVersion:1,requestId:"exec",actionDigest:candidate.actionDigest}),
  {code:"assistant_step_source_changed"});
 assert.equal(getProject(fx.db,"p").revision,1);
 recoverAssistantCanvasTasksAtStartup(fx.db);
});
test("P3b global workflow fallback rejects ineffective ordinary channel params",t=>{
 const fx=fixture(t);
 fx.db.prepare("UPDATE ui_settings SET revision=revision+1,value_json=? WHERE name='model_config'")
  .run(JSON.stringify({comfyWorkflowDefaults:{image:{templateId:"preset",templateRevision:"a".repeat(64)}}}));
 assert.throws(()=>plan(fx,[{type:"set_node_param",nodeId:"img",key:"quality",value:"high"}]),
  {code:"assistant_node_parameter_uses_workflow"});
});
