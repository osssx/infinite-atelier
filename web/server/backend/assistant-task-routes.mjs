import {createAssistantTask,listAssistantTasks,getAssistantTask,appendAssistantTaskTurn,
 observeAssistantTask,guideAssistantTaskResume,cancelAssistantTask,listAssistantTaskEvents,
 linkAssistantTaskToChat,changeAssistantTaskSemantic} from "./assistant-tasks.mjs";
import {listAssistantModelCalls} from "./assistant-model-calls.mjs";
import {listAssistantSemanticProposals,decideAssistantSemanticProposal} from "./assistant-semantic-proposals.mjs";
import {decideAssistantTaskStep} from "./assistant-task-step-gate.mjs";
import {planAssistantCanvasStep,executeAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
import {planAssistantExternalJobStep,enqueueAssistantExternalJobStep,reconcileAssistantExternalTask} from "./assistant-task-external-jobs.mjs";
import {planAssistantSkillStep,executeAssistantSkillStep} from "./assistant-task-skills.mjs";
import {registerAssistantRunSequence,getAssistantRunSequence,selectAssistantRunInput,skipAssistantRunBranch,commitAssistantRunJoin} from "./assistant-task-run-sequences.mjs";
import {inspectAssistantTaskRecovery,replanAssistantTaskSafely} from "./assistant-task-safe-replan.mjs";
import {inspectAssistantRunFailureRecovery,confirmAssistantRunFailureRecovery} from "./assistant-task-failure-recovery.mjs";
import {registerAssistantTextDeliverable,verifyAssistantTextDeliverable} from "./assistant-task-deliverables.mjs";
import {discoverAssistantCreativeCharacters} from "./assistant-creative-context.mjs";
import {discoverAssistantCreativeMaterials,selectAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";

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
const linkChatBody={type:"object",required:["requestId","chatSessionId"],additionalProperties:false,
 properties:{requestId:id,chatSessionId:id}};
const safeReplanBody={type:"object",required:["requestId","expectedPlanVersion","expectedProjectRevision"],additionalProperties:false,
 properties:{requestId:id,expectedPlanVersion:{type:"integer",minimum:1},expectedProjectRevision:{type:"integer",minimum:1}}};
const taskPostBody={type:"object",required:["requestId","chatSessionId","rootMessageId","originalRequest"],
 additionalProperties:false,properties:{requestId:id,chatSessionId:id,rootMessageId:id,
  originalRequest:{type:"string",minLength:1,maxLength:8000},contextPolicy:policy}};
const turnBody={type:"object",required:["requestId","messageId","text"],additionalProperties:false,
 properties:{requestId:id,messageId:id,text:{type:"string",minLength:1,maxLength:8000},contextPolicy:policy}};
const semanticBody={type:"object",additionalProperties:false,
 required:["requestId","expectedRevision","operation","confirmed","contextPolicy"],
 properties:{requestId:id,expectedRevision:{type:"integer",minimum:0},
  operation:{type:"string",enum:["set_goal","clear_goal","add_constraint","add_decision","update_note","remove_note"]},
  confirmed:{type:"boolean",const:true},
  text:{type:"string",minLength:1,maxLength:600},noteId:id,contextPolicy:policy}};
const semanticProposalDecisionBody={type:"object",additionalProperties:false,
 required:["requestId","proposalId","decision","expectedRevision","confirmed","contextPolicy"],
 properties:{requestId:id,proposalId:id,decision:{type:"string",enum:["accept","reject"]},
  expectedRevision:{type:"integer",minimum:0},confirmed:{type:"boolean",const:true},contextPolicy:policy}};
const observationBody={type:"object",required:["requestId","kind","preview"],additionalProperties:false,
 properties:{requestId:id,kind:{type:"string",enum:["reply","error"]},
 preview:{type:"string",minLength:1,maxLength:1800}}};

const creativeMaterialsSelectionBody={type:"object",additionalProperties:false,
 required:["requestId","turnMessageId","references","confirmed"],properties:{
 requestId:id,turnMessageId:id,confirmed:{type:"boolean",const:true},
 references:{type:"array",minItems:1,maxItems:4,items:{type:"object",additionalProperties:false,
  required:["kind","sourceRef","sourceDigest"],properties:{
   kind:{type:"string",enum:["story","scene","style"]},sourceRef:id,
   sourceDigest:{type:"string",pattern:"^[a-f0-9]{64}$"}}}}}};
const creativeTurnQuery={type:"object",additionalProperties:false,required:["turnMessageId"],
 properties:{turnMessageId:id}};
const creativeMaterialsQuery={...creativeTurnQuery,properties:{...creativeTurnQuery.properties,
 kinds:{type:"string",pattern:"^(story|scene|style)(,(story|scene|style)){0,2}$"}}};
const textDeliverableBody={type:"object",additionalProperties:false,
 required:["requestId","sourceTurnMessageId","characters","confirmed"],properties:{
 requestId:id,sourceTurnMessageId:id,confirmed:{type:"boolean",const:true},
 characters:{type:"array",minItems:1,maxItems:5,items:{type:"object",additionalProperties:false,
  required:["ref","title"],properties:{ref:id,title:{type:"string",minLength:1,maxLength:100},sourceNodeId:id,
    sourceRef:id,sourceDigest:{type:"string",pattern:"^[a-f0-9]{64}$"}}}},
 requiredFields:{type:"array",maxItems:6,items:{type:"string",minLength:1,maxLength:60}},
 allowEmptyTemplate:{type:"boolean"}}};
const textVerifyBody={type:"object",additionalProperties:false,
 required:["requestId","stepId","expectedPlanVersion","actionDigest"],properties:{
 requestId:id,stepId:id,expectedPlanVersion:{type:"integer",minimum:1},
 actionDigest:{type:"string",pattern:"^[a-f0-9]{64}$"}}};
const canvasStepBody={type:"object",additionalProperties:false,
 required:["requestId","expectedPlanVersion","expectedProjectRevision","actions","center"],
 properties:{requestId:id,expectedPlanVersion:{type:"integer",minimum:1},
  expectedProjectRevision:{type:"integer",minimum:1},
  actions:{type:"array",minItems:1,maxItems:16,items:{type:"object"}},
  center:{type:"object",additionalProperties:false,required:["x","y"],properties:{
   x:{type:"number",minimum:-1000000,maximum:1000000},y:{type:"number",minimum:-1000000,maximum:1000000}}},
  dependsOn:{type:"array",maxItems:20,uniqueItems:true,items:id},finalizeTask:{type:"boolean"},
  runSequenceId:id,runIndex:{type:"integer",minimum:1,maximum:2}}};
const executeBody={type:"object",additionalProperties:false,
 required:["requestId","expectedPlanVersion","actionDigest"],properties:{
  requestId:id,expectedPlanVersion:{type:"integer",minimum:1},
  actionDigest:{type:"string",pattern:"^[a-f0-9]{64}$"}}};

const externalJobBody={type:"object",additionalProperties:false,
 required:["requestId","kind","expectedPlanVersion","expectedProjectRevision","job"],
 properties:{requestId:id,kind:{type:"string",enum:["model_job","comfy_workflow"]},
 expectedPlanVersion:{type:"integer",minimum:1},expectedProjectRevision:{type:"integer",minimum:1},
 job:{type:"object",required:["targetNodeId","sourceNodeFingerprint","executionMode","snapshot"],
 additionalProperties:false,properties:{
 targetNodeId:{type:"string",minLength:1,maxLength:256},
 sourceNodeFingerprint:{type:"string",minLength:1,maxLength:256},
 executionMode:{type:"string",enum:["immediate","stream","poll"]},
 snapshot:{type:"object"},skillAuthorizationId:{type:"string",pattern:"^[0-9a-f-]{36}$"}}},
 dependsOn:{type:"array",maxItems:20,uniqueItems:true,items:id},
 finalizeTask:{type:"boolean"},runSequenceId:id,runIndex:{type:"integer",minimum:0,maximum:3}}};
const runSequenceBody={type:"object",additionalProperties:false,
 required:["requestId","sourceMessageId","expectedPlanVersion","expectedProjectRevision","actions"],
 properties:{requestId:id,sourceMessageId:id,
  expectedPlanVersion:{type:"integer",minimum:1},expectedProjectRevision:{type:"integer",minimum:1},
  actions:{type:"array",minItems:2,maxItems:4,items:{type:"object"}}}};
const runInputSelectionBody={type:"object",additionalProperties:false,
 required:["requestId","runSequenceId","runIndex","artifactId","expectedPlanVersion","expectedProjectRevision"],
 properties:{requestId:id,runSequenceId:id,runIndex:{type:"integer",minimum:1,maximum:2},
  artifactId:id,expectedPlanVersion:{type:"integer",minimum:1},
  expectedProjectRevision:{type:"integer",minimum:1}}};
const runBranchSkipBody={type:"object",additionalProperties:false,
 required:["requestId","runSequenceId","runIndex","evidenceDigest","expectedPlanVersion","expectedProjectRevision"],
 properties:{requestId:id,runSequenceId:id,runIndex:{type:"integer",minimum:1,maximum:2},
  evidenceDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
  expectedPlanVersion:{type:"integer",minimum:1},
  expectedProjectRevision:{type:"integer",minimum:1}}};
const failoverConfirmBody={type:"object",additionalProperties:false,
 required:["requestId","expectedPlanVersion","expectedProjectRevision","evidenceDigest"],
 properties:{requestId:id,expectedPlanVersion:{type:"integer",minimum:1},
  expectedProjectRevision:{type:"integer",minimum:1},
  evidenceDigest:{type:"string",pattern:"^[a-f0-9]{64}$"}}};
const runJoinBody={type:"object",additionalProperties:false,
 required:["requestId","runSequenceId","runIndex","evidenceDigest","expectedPlanVersion","expectedProjectRevision"],
 properties:{requestId:id,runSequenceId:id,runIndex:{type:"integer",const:3},
  evidenceDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
  expectedPlanVersion:{type:"integer",minimum:1},
  expectedProjectRevision:{type:"integer",minimum:1}}};
const skillProposal={type:"object",additionalProperties:false,
 required:["skill_id","version"],properties:{
 skill_id:{type:"string",pattern:"^[a-z0-9]+(?:-[a-z0-9]+)*$",maxLength:80},
 version:{type:"string",pattern:"^[a-f0-9]{12}$"},
 script_path:{type:"string",minLength:1,maxLength:240},
 entry_id:{type:"string",minLength:1,maxLength:64},
 runtime:{type:"string",minLength:1,maxLength:260},
 args:{type:"array",maxItems:64,items:{type:"string",maxLength:8192}},
 input_files:{type:"object",maxProperties:32,additionalProperties:{type:"string",maxLength:262144}},
 output_files:{type:"array",maxItems:32,items:{type:"string",maxLength:240}}
 }};
const skillPlanBody={type:"object",additionalProperties:false,
 required:["requestId","expectedPlanVersion","expectedProjectRevision","proposal"],properties:{
 requestId:id,expectedPlanVersion:{type:"integer",minimum:1},
 expectedProjectRevision:{type:"integer",minimum:1},proposal:skillProposal,
 dependsOn:{type:"array",uniqueItems:true,maxItems:20,items:id},finalizeTask:{type:"boolean"}
 }};
/** P2b: Task Skill execution is reserved before child process spawn. */
export function registerAssistantTaskRoutes(app,db,{skillRegistry,blobStore}={}){
 const result=(reply,value)=>{reply.header("Cache-Control","no-store");return value};
 app.post(base,{schema:{params:projectParams,body:taskPostBody}},(req,reply)=>{
  const value=createAssistantTask(db,{projectId:req.params.id,...req.body});
  reply.code(value.existing?200:201);return result(reply,value);
 });
 app.get(base,{schema:{params:projectParams}},(req,reply)=>result(reply,
  listAssistantTasks(db,{projectId:req.params.id,chatSessionId:req.query?.chatSessionId,
   limit:Number(req.query?.limit??50),includeOther:req.query?.includeOther==="true"})));
 app.get(base+"/:taskId",{schema:{params:taskParams}},(req,reply)=>result(reply,
  getAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId})));
 app.post(base+"/:taskId/link-chat",{schema:{params:taskParams,body:linkChatBody}},(req,reply)=>result(reply,
  linkAssistantTaskToChat(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.get(base+"/:taskId/recovery",{schema:{params:taskParams}},(req,reply)=>result(reply,
  inspectAssistantTaskRecovery(db,{projectId:req.params.id,taskId:req.params.taskId})));
 app.post(base+"/:taskId/replan",{schema:{params:taskParams,body:safeReplanBody}},(req,reply)=>result(reply,
  replanAssistantTaskSafely(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
  app.post(base+"/:taskId/turns",{schema:{params:taskParams,body:turnBody}},(req,reply)=>result(reply,
   appendAssistantTaskTurn(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
  // Explicit user action only; semantic edits never enqueue a Job.
  app.post(base+"/:taskId/semantic",{schema:{params:taskParams,body:semanticBody}},
   (req,reply)=>result(reply,changeAssistantTaskSemantic(db,{
    projectId:req.params.id,taskId:req.params.taskId,...req.body})));
  app.get(base+"/:taskId/semantic-proposals",{schema:{params:taskParams}},(req,reply)=>result(reply,
   listAssistantSemanticProposals(db,{projectId:req.params.id,taskId:req.params.taskId})));
  app.post(base+"/:taskId/semantic-proposals/decision",{schema:{params:taskParams,body:semanticProposalDecisionBody}},
   (req,reply)=>result(reply,decideAssistantSemanticProposal(db,{projectId:req.params.id,
    taskId:req.params.taskId,...req.body})));
  app.post(base+"/:taskId/observations",{schema:{params:taskParams,body:observationBody}},(req,reply)=>result(reply,
  observeAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/resume",{schema:{params:taskParams,body:requestBody}},(req,reply)=>result(reply,
  guideAssistantTaskResume(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/cancel",{schema:{params:taskParams,body:requestBody}},(req,reply)=>result(reply,
  cancelAssistantTask(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 // P4.1b: read-only references, with user-approved server-frozen selection.
 app.get(base+"/:taskId/creative-context/materials",{
  schema:{params:taskParams,querystring:creativeMaterialsQuery}},(req,reply)=>result(reply,
   discoverAssistantCreativeMaterials(db,{projectId:req.params.id,taskId:req.params.taskId,
    turnMessageId:req.query.turnMessageId,...(req.query.kinds?{kinds:req.query.kinds.split(",")}: {})})));
 app.post(base+"/:taskId/creative-context/materials/select",{
  schema:{params:taskParams,body:creativeMaterialsSelectionBody}},(req,reply)=>result(reply,
   selectAssistantCreativeMaterials(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 // P4.1 discovery is read-only, scoped to the frozen current user turn.
 app.get(base+"/:taskId/creative-context/characters",{
  schema:{params:taskParams,querystring:creativeTurnQuery}},(req,reply)=>result(reply,
   discoverAssistantCreativeCharacters(db,{projectId:req.params.id,taskId:req.params.taskId,
    turnMessageId:req.query.turnMessageId})));
 // Explicit text deliverable: the guard is durable before any model POST.
  app.post(base+"/:taskId/deliverables/text",{schema:{params:taskParams,body:textDeliverableBody}},
   (req,reply)=>result(reply,registerAssistantTextDeliverable(db,{
    projectId:req.params.id,taskId:req.params.taskId,...req.body})));
  app.post(base+"/:taskId/deliverables/text/verify",{schema:{params:taskParams,body:textVerifyBody}},
   (req,reply)=>result(reply,verifyAssistantTextDeliverable(db,{
    projectId:req.params.id,taskId:req.params.taskId,...req.body})));
  app.post(base+"/:taskId/canvas-steps",{schema:{params:taskParams,body:canvasStepBody}},(req,reply)=>result(reply,
  planAssistantCanvasStep(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/run-sequences",{schema:{params:taskParams,body:runSequenceBody}},(req,reply)=>result(reply,
  registerAssistantRunSequence(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.get(base+"/:taskId/run-sequences",{schema:{params:taskParams}},(req,reply)=>result(reply,
  getAssistantRunSequence(db,{projectId:req.params.id,taskId:req.params.taskId})));
  app.post(base+"/:taskId/run-sequences/select",{schema:{params:taskParams,body:runInputSelectionBody}},
   (req,reply)=>result(reply,selectAssistantRunInput(db,{
    projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/run-sequences/skip",{schema:{params:taskParams,body:runBranchSkipBody}},
  (req,reply)=>result(reply,skipAssistantRunBranch(db,{
   projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.get(base+"/:taskId/run-sequences/failure-recovery",{schema:{params:taskParams}},
  (req,reply)=>result(reply,inspectAssistantRunFailureRecovery(db,{
   projectId:req.params.id,taskId:req.params.taskId})));
 app.post(base+"/:taskId/run-sequences/failure-recovery",{schema:{params:taskParams,body:failoverConfirmBody}},
  (req,reply)=>result(reply,confirmAssistantRunFailureRecovery(db,{
   projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/run-sequences/join",{schema:{params:taskParams,body:runJoinBody}},
  (req,reply)=>result(reply,commitAssistantRunJoin(db,{
   projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 // Local Job queue creation, Attempt and Step are one transaction.
 // No provider request is performed in these routes.
 app.post(base+"/:taskId/external-jobs",{bodyLimit:600*1024,
  schema:{params:taskParams,body:externalJobBody}},(req,reply)=>result(reply,
  planAssistantExternalJobStep(db,{projectId:req.params.id,taskId:req.params.taskId,...req.body})));
 app.post(base+"/:taskId/skill-steps",{
  bodyLimit:64*1024,schema:{params:taskParams,body:skillPlanBody}
 },(req,reply)=>result(reply,planAssistantSkillStep(db,{projectId:req.params.id,
  taskId:req.params.taskId,...req.body,skillRegistry})));
 app.post(base+"/:taskId/reconcile",{schema:{params:taskParams,body:{type:"object",additionalProperties:false}}},(req,reply)=>result(reply,
  reconcileAssistantExternalTask(db,{projectId:req.params.id,taskId:req.params.taskId})));
 // Approval binds the frozen Step; execute never accepts new action JSON.
 app.post(base+"/:taskId/steps/:stepId/approval",
  {schema:{params:stepParams,body:decisionBody}},(req,reply)=>result(reply,
   decideAssistantTaskStep(db,{projectId:req.params.id,taskId:req.params.taskId,
    stepId:req.params.stepId,...req.body})));
 app.post(base+"/:taskId/steps/:stepId/execute",{schema:{params:stepParams,body:executeBody}},(req,reply)=>result(reply,
  executeAssistantCanvasStep(db,{projectId:req.params.id,taskId:req.params.taskId,
   stepId:req.params.stepId,...req.body})));
 app.post(base+"/:taskId/steps/:stepId/enqueue",{schema:{params:stepParams,body:executeBody}},(req,reply)=>result(reply,
  enqueueAssistantExternalJobStep(db,{projectId:req.params.id,taskId:req.params.taskId,
   stepId:req.params.stepId,...req.body})));
 app.post(base+"/:taskId/steps/:stepId/run-skill",{
  bodyLimit:16*1024,schema:{params:stepParams,body:executeBody}
 },async(req,reply)=>{
  reply.header("Cache-Control","no-store");
  const controller=new AbortController(),onAbort=()=>controller.abort(),
   onClose=()=>{if(!reply.raw.writableEnded)controller.abort()};
  req.raw.once("aborted",onAbort);reply.raw.once("close",onClose);
  try{return await executeAssistantSkillStep({db,skillRegistry,blobStore,
   projectId:req.params.id,taskId:req.params.taskId,stepId:req.params.stepId,
   ...req.body,signal:controller.signal});}
  finally{req.raw.removeListener("aborted",onAbort);reply.raw.removeListener("close",onClose)}
 });
 app.get(base+"/:taskId/model-calls",{schema:{params:taskParams}},(req,reply)=>result(reply,
  listAssistantModelCalls(db,{projectId:req.params.id,taskId:req.params.taskId,
   limit:Number(req.query?.limit??100)})));
 app.get(base+"/:taskId/events",{schema:{params:taskParams}},(req,reply)=>result(reply,
  listAssistantTaskEvents(db,{projectId:req.params.id,taskId:req.params.taskId,
   afterSeq:Number(req.query?.afterSeq??0),limit:Number(req.query?.limit??100)})));
}
