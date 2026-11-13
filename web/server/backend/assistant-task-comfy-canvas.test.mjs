import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {createAssistantTask} from "./assistant-tasks.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";

const revision="a".repeat(64);
const ports=[
 {id:"steps",label:"Steps",direction:"target",valueKind:"INT",
  inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"steps"}]},choices:[{label:"42",value:42},{label:"20",value:20}]},
 {id:"text_in",label:"Text input",direction:"target",valueKind:"STRING",
  inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"text"}]}},
 {id:"result",label:"Image",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"2",outputIndex:0}}
];
const node=(id,content)=>({id,type:"text",title:id,position:{x:0,y:0},
 width:300,height:240,metadata:{content}});
const workflow={id:"wf",type:"comfy:workflow",title:"workflow",position:{x:400,y:0},
 width:400,height:280,metadata:{comfyWorkflow:{templateId:"wf-demo",templateRevision:revision,inputOverrides:{}},
 comfyPorts:ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))}};
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const original={nodes:[node("a","one"),node("b","two"),workflow],connections:[]};
 createProject(db,{id:"p",document:original});
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run("wf-demo",revision,JSON.stringify({id:"wf-demo",revision,ports}),Date.now());
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"绑定工作流并运行",requestId:"create-task"}).task;
 return {db,task,original};
}
const plan=(fx,actions,requestId="plan")=>planAssistantCanvasStep(fx.db,{
 projectId:"p",taskId:fx.task.id,requestId,expectedPlanVersion:1,
 expectedProjectRevision:getProject(fx.db,"p").revision,actions,
 center:{x:100,y:100}});
const approveAndCommit=(fx,step)=>{
 decideAssistantTaskStep(fx.db,{projectId:"p",taskId:fx.task.id,
  stepId:step.stepId,requestId:"decision-"+step.stepId,
  expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest,decision:"approve"});
 return executeAssistantCanvasStep(fx.db,{projectId:"p",taskId:fx.task.id,
  stepId:step.stepId,requestId:"commit-"+step.stepId,
  expectedPlanVersion:step.planVersion,actionDigest:step.actionDigest});
};
test("P3 Comfy scalar override and typed source link are one trusted canvas Step",t=>{
 const fx=fixture(t);
 const step=plan(fx,[{type:"set_workflow_param",nodeId:"wf",portId:"steps",value:42},
  {type:"connect_workflow_port",fromNodeId:"a",fromPortId:"text",toNodeId:"wf",toPortId:"text_in"}]);
 assert.equal(getProject(fx.db,"p").revision,1);
 const result=approveAndCommit(fx,step);
 assert.equal(result.receipt.applied,2);
 assert.equal(result.project.document.nodes.find(n=>n.id==="wf").metadata.comfyWorkflow.inputOverrides.steps,42);
 assert.deepEqual(result.project.document.connections,[{
  id:step.preconditions.refs.connections.edge_1,fromNodeId:"a",fromPortId:"text",
  toNodeId:"wf",toPortId:"text_in"}]);
 assert.equal(approveAndCommit(fx,step).existing,true);
 assert.equal(getProject(fx.db,"p").revision,2);
 assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
});
test("P3 replace then disconnect input commits independently with deterministic edges",t=>{
 const fx=fixture(t);
 const first=plan(fx,[{type:"connect_workflow_port",fromNodeId:"a",fromPortId:"text",toNodeId:"wf",toPortId:"text_in"}]);
 approveAndCommit(fx,first);
 const replace=plan(fx,[{type:"replace_workflow_port",fromNodeId:"b",fromPortId:"text",toNodeId:"wf",toPortId:"text_in"}],"replace");
 const replaced=approveAndCommit(fx,replace);
 assert.equal(replaced.project.document.connections.length,1);
 assert.equal(replaced.project.document.connections[0].fromNodeId,"b");
 assert.equal(replaced.project.document.connections[0].id,replace.preconditions.refs.connections.edge_0);
 const disconnect=plan(fx,[{type:"disconnect_workflow_port",nodeId:"wf",portId:"text_in"}],"disconnect");
 const cleared=approveAndCommit(fx,disconnect);
 assert.deepEqual(cleared.project.document.connections,[]);
});
test("P3 rejects wrong scalar choices, types, connected input, forged schema and image-to-text link",t=>{
 const fx=fixture(t),total=()=>fx.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n;
 const invalid=[
 [{type:"set_workflow_param",nodeId:"wf",portId:"steps",value:43}],
 [{type:"set_workflow_param",nodeId:"wf",portId:"steps",value:"42"}],
 [{type:"set_workflow_param",nodeId:"wf",portId:"guessed",value:20}],
 [{type:"connect_workflow_port",fromNodeId:"a",fromPortId:"image",toNodeId:"wf",toPortId:"text_in"}],
 [{type:"connect_workflow_port",fromNodeId:"a",fromPortId:"text",toNodeId:"wf",toPortId:"steps"}]
 ];
 for(let i=0;i<invalid.length;i++){
  assert.throws(()=>plan(fx,invalid[i],"invalid-"+i));
  assert.equal(total(),0);
  assert.equal(getProject(fx.db,"p").revision,1);
 }
 const linked=plan(fx,[{type:"connect_workflow_port",fromNodeId:"a",fromPortId:"text",toNodeId:"wf",toPortId:"text_in"}],"good");
 approveAndCommit(fx,linked);
 assert.throws(()=>plan(fx,[{type:"set_workflow_param",nodeId:"wf",portId:"text_in",value:"overwrite"}],"connected"),
  {code:"assistant_comfy_param_not_editable"});
 assert.equal(total(),1);
});
test("P3 pinning registry: missing template version fails closed before approval",t=>{
 const fx=fixture(t);
 fx.db.prepare("DELETE FROM comfy_template_versions").run();
 assert.throws(()=>plan(fx,[{type:"set_workflow_param",nodeId:"wf",portId:"steps",value:42}]),
  {code:"assistant_comfy_template_unavailable"});
 assert.equal(getProject(fx.db,"p").revision,1);
});
