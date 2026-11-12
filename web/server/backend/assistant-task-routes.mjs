import {createAssistantTask,listAssistantTasks,getAssistantTask,appendAssistantTaskTurn,
 observeAssistantTask,guideAssistantTaskResume,cancelAssistantTask,listAssistantTaskEvents} from "./assistant-tasks.mjs";
import {listAssistantModelCalls} from "./assistant-model-calls.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";

const id={type:"string",pattern:"^[A-Za-z0-9_-]{1,128}$"};
const policy={type:"object",additionalProperties:false,required:["includeContext","scope","includedIds"],
 properties:{includeContext:{type:"boolean"},scope:{type:"string",enum:["selection","overview"]},
 includedIds:{type:"array",maxItems:12,items:{type:"string",maxLength:128}}}};
const base="/api/v1/projects/:id/assistant/tasks";
const projectParams={type:"object",required:["id"],additionalProperties:false,properties:{id}};
const taskParams={type:"object",required:["id","taskId"],additionalProperties:false,
 properties:{id,taskId:id}};
const stepParams={type:"object",required:["id","taskId","stepId"],additionalProperties:false,
 properties:{id,taskId:id,stepId:id}};
const decisionBody={type:"object",required:["requestId","expectedPlanVersion","actionDigest","decision"],
 additionalProperties:false,properties:{requestId:id,expectedPlanVersion:{type:"integer",minimum:1},
 actionDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},decision:{type:"string",enum:["approve","reject"]}}};
const requestBody={type:"object",required:["requestId"],additionalProperties:false,
 properties:{requestId:id}};
const taskPostBody={type:"object",required:["requestId","chatSessionId","rootMessageId","originalRequest"],
 additionalProperties:false,properties:{requestId:id,chatSessionId:id,rootMessageId:id,
  originalRequest:{type:"string",minLength:1,maxLength:8000},contextPolicy:policy}};
const turnBody={type:"object",required:["requestId","messageId","text"],additionalProperties:false,
 properties:{requestId:id,messageId:id,text:{type:"string",minLength:1,maxLength:8000},contextPolicy:policy}};
const observationBody={type:"object",required:["requestId","kind","preview"],additionalProperties:false,
 properties:{requestId:id,kind:{type:"string",enum:["reply","error"]},
 preview:{type:"string",minLength:1,maxLength:1800}}};

/** P0a is guidance-only; no route can execute, approve, or claim a completed step. */
export function registerAssistantTaskRoutes(app,db){
 const result=(reply,value)=>{reply.header("Cache-Control","no-store");return value};
 app.post(base,{schema:{params:projectParams,body:taskPostBody}},(req,reply)=>{
  const value=createAssistantTask(db,{projectId:req.params.id,...req.body});
  reply.code(value.existing?200:201);return result(reply,value);
 });
 app.get(base,{schema:{params:projectParams}},(req,reply)=>result(reply,
  listAssistantTasks(db,{projectId:req.params.id,chatSessionId:req.query?.chatSessionId,
   limit:Number(req.query?.limit??50)})));
 app.get(base+"/:taskId",{schema:{params:taskParams}},(req,reply)=>result(reply,
  getAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId})));
 app.post(base+"/:taskId/turns",{schema:{params:taskParams,body:turnBody}},(req,reply)=>result(reply,
  appendAssistantTaskTurn(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/observations",{schema:{params:taskParams,body:observationBody}},(req,reply)=>result(reply,
  observeAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/resume",{schema:{params:taskParams,body:requestBody}},(req,reply)=>result(reply,
  guideAssistantTaskResume(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/cancel",{schema:{params:taskParams,body:requestBody}},(req,reply)=>result(reply,
  cancelAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 // P1a approval is tied to a frozen Step, plan version and action digest.
 // There is intentionally NO HTTP Step claim, execute or succeeded endpoint yet.
 app.post(base+"/:taskId/steps/:stepId/approval",
  {schema:{params:stepParams,body:decisionBody}},(req,reply)=>result(reply,
   decideAssistantTaskStep(db,{projectId:req.params.id,taskId:req.params.taskId,
    stepId:req.params.stepId,...req.body})));
 app.get(base+"/:taskId/model-calls",{schema:{params:taskParams}},(req,reply)=>result(reply,
  listAssistantModelCalls(db,{projectId:req.params.id,taskId:req.params.taskId,
   limit:Number(req.query?.limit??100)})));
 app.get(base+"/:taskId/events",{schema:{params:taskParams}},(req,reply)=>result(reply,
  listAssistantTaskEvents(db,{projectId:req.params.id,taskId:req.params.taskId,
   afterSeq:Number(req.query?.afterSeq??0),limit:Number(req.query?.limit??100)})));
}
