/** P3b: persist an ordered run *intent*, never a provider request.
 * Each target is resolved/pinned in the graph before inserting the sequence.
 * Actual Job snapshots are rebuilt from the same production generator only
 * when the previous Job has a trusted materialization receipt.
 */
import {randomUUID,createHash} from "node:crypto";
import {stableJson,writeTransaction} from "./repository.mjs";
import {trustedAssistantTaskOutputs} from "./assistant-task-produced-artifacts.mjs";
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hash=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const modes=new Set(["text","image","video","audio"]);
const terminal=new Set(["completed","cancelled","blocked","failed","needs_reconcile","cancelling"]);
const projection=(row)=>({id:row.id,taskId:row.task_id,sourceMessageId:row.source_message_id,
 planVersion:row.plan_version,actions:JSON.parse(row.actions_json),
 status:row.status,expectedProjectRevision:row.expected_project_revision});
function taskWithGraph(db,projectId,taskId){
 if(!id(projectId)||!id(taskId))throw fail("assistant_task_run_invalid",400);
 const task=db.prepare("SELECT t.*,p.revision,p.document_json FROM assistant_tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?").get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 return task;
}
function validActions(actions,doc){
 if(!Array.isArray(actions)||actions.length<2||actions.length>3)
  throw fail("assistant_task_run_invalid",400);
 const nodes=new Map(doc.nodes.map(n=>[n.id,n])),used=new Set();
 for(const [index,action] of actions.entries()){
  if(!action||typeof action!=="object"||Array.isArray(action)||
   !id(action.nodeId)||used.has(action.nodeId))throw fail("assistant_task_run_invalid",400);
  const node=nodes.get(action.nodeId);
  if(action.type==="run_workflow"){
   if(Object.keys(action).some(k=>!["type","nodeId","inputFromPrevious"].includes(k))||
    node?.type!=="comfy:workflow"||!node.metadata?.comfyWorkflow?.templateId||
    !node.metadata?.comfyWorkflow?.templateRevision)throw fail("assistant_task_run_target_invalid",400);
   if(action.inputFromPrevious!==undefined){
    const input=action.inputFromPrevious;
    if(index===0||!input||typeof input!=="object"||Array.isArray(input)||
     Object.keys(input).some(k=>!["sourceKind","toPortId"].includes(k))||
     !Object.hasOwn(mediaKinds,input.sourceKind)||!portId(input.toPortId))
     throw fail("assistant_task_run_input_invalid",400);
   }
  }else if(action.type==="run_node"){
   if(Object.keys(action).some(k=>!["type","nodeId","mode"].includes(k))||
    !["text","image","video","audio","config"].includes(node?.type)||
    (action.mode!==undefined&&!modes.has(action.mode)))throw fail("assistant_task_run_target_invalid",400);
   const mode=node.type==="config"?(node.metadata?.generationMode??"image"):node.type;
   if(action.mode!==undefined&&action.mode!==mode)throw fail("assistant_task_run_target_invalid",400);
  }else throw fail("assistant_task_run_invalid",400);
  used.add(action.nodeId);
 }
}
const mediaKinds={image:"IMAGE",video:"VIDEO",audio:"AUDIO"};
const sensitive=/(?:secret|token|password|api.?key|credential|authorization|密钥|密码|令牌)/i;
const portId=x=>typeof x==="string"&&/^[A-Za-z0-9_:\-.]{1,128}$/.test(x);
function bindingStepFor(db,seq,index){
 return db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND kind='canvas_mutation' AND json_extract(preconditions_json,'$.runSequenceId')=? AND json_extract(preconditions_json,'$.runBindingIndex')=? AND superseded_at IS NULL ORDER BY ordinal DESC LIMIT 1")
  .get(seq.task_id,seq.plan_version,seq.id,index);
}
function resolveTrustedInput(db,projectId,task,seq,action,index,dep,{allowOccupied=false}={}){
 const input=action.inputFromPrevious;
 if(!input)return null;
 const graph=JSON.parse(task.document_json);
 const target=graph.nodes.find(n=>n.id===action.nodeId);
 const targetBinding=target?.metadata?.comfyWorkflow;
 const templateRow=targetBinding&&db.prepare("SELECT payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?")
  .get(targetBinding.templateId,targetBinding.templateRevision);
 const template=templateRow&&JSON.parse(templateRow.payload_json);
 const port=template?.ports?.find(p=>p.id===input.toPortId&&p.direction==="target");
 const canvasPort=target?.metadata?.comfyPorts?.find(p=>p.id===input.toPortId&&p.direction==="target");
 if(!port||port.valueKind!==mediaKinds[input.sourceKind]||
  canvasPort?.valueKind!==port.valueKind||!["socket","media-file"].includes(port.inputBinding?.mode)||
  !port.inputBinding?.targets?.length||sensitive.test(port.id+" "+port.label))
  throw fail("assistant_task_run_input_port_invalid",400);
 const outputs=trustedAssistantTaskOutputs(db,{projectId,taskId:seq.task_id,planVersion:seq.plan_version});
 const candidates=outputs.filter(out=>out.runSequenceId===seq.id&&out.runIndex===index-1&&
  out.materialStepId===dep&&out.kind===input.sourceKind&&
  graph.nodes.some(node=>node.id===out.nodeId&&node.type===input.sourceKind));
 if(candidates.length!==1)throw fail("assistant_task_run_input_unavailable");
 const source=candidates[0];
 if(!allowOccupied&&graph.connections.some(edge=>edge.toNodeId===action.nodeId&&edge.toPortId===input.toPortId))
  throw fail("assistant_task_run_input_occupied");
 return {sourceArtifactId:source.artifactId,sourceSha256:source.sha256,
  sourceMaterialStepId:source.materialStepId,sourceNodeId:source.nodeId,
  sourcePortId:input.sourceKind,toNodeId:action.nodeId,toPortId:input.toPortId,
  sourceKind:input.sourceKind,valueKind:mediaKinds[input.sourceKind]};
}
function validateBoundInput(task,seq,index,step,binding){
 const pre=JSON.parse(step.preconditions_json),receipt=JSON.parse(step.receipt_json);
 const document=JSON.parse(task.document_json),edgeId=receipt.refs?.connections?.edge_0;
 const edge=document.connections.find(c=>c.id===edgeId);
 const action=JSON.parse(step.action_json)?.actions?.[0];
 if(!edgeId||pre.runSequenceId!==seq.id||
  pre.runSourceArtifactId!==binding.sourceArtifactId||
  pre.runSourceSha256!==binding.sourceSha256||
  pre.runBindingIndex!==index||
  !JSON.parse(step.depends_on_json).includes(binding.sourceMaterialStepId)||
  !edge||!action||action.type!=="connect_workflow_port"||
  edge.fromNodeId!==binding.sourceNodeId||edge.fromPortId!==binding.sourcePortId||
  edge.toNodeId!==binding.toNodeId||edge.toPortId!==binding.toPortId)
  throw fail("assistant_task_run_input_binding_unverified");
}
function sequenceRows(db,taskId,planVersion){
 return db.prepare("SELECT * FROM assistant_task_run_sequences WHERE task_id=? AND plan_version=? ORDER BY created_at,id")
  .all(taskId,planVersion);
}
function stepFor(db,seq,index){
 return db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND kind IN ('model_job','comfy_workflow') AND json_extract(preconditions_json,'$.runSequenceId')=? AND json_extract(preconditions_json,'$.runIndex')=? AND superseded_at IS NULL ORDER BY ordinal DESC LIMIT 1")
  .get(seq.task_id,seq.plan_version,seq.id,index);
}
function verifiedMaterialization(db,seq,jobStepId){
 const rows=db.prepare("SELECT id,status,receipt_trust,depends_on_json,superseded_at FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND kind='materialize' ORDER BY ordinal DESC")
  .all(seq.task_id,seq.plan_version);
 return rows.find(row=>!row.superseded_at&&row.status==="succeeded"&&row.receipt_trust==="server_committed"&&
  JSON.parse(row.depends_on_json).includes(jobStepId));
}

export function nextAssistantRunInTransaction(db,projectId,taskId,seq){
 const task=taskWithGraph(db,projectId,taskId),actions=JSON.parse(seq.actions_json);
 const out={sequence:projection(seq),next:null};
 if(seq.plan_version!==task.active_plan_version||seq.status!=="active"||
  task.read_only||task.cancel_requested_at!==null||
  (terminal.has(task.status)&&task.status!=="completed"))
  return {...out,state:"blocked"};
 let dep=seq.base_step_id;
 for(let index=0;index<actions.length;index++){
  const existing=stepFor(db,seq,index);
  if(existing){
   if(existing.status!=="succeeded"||existing.receipt_trust!=="server_committed")
    return {...out,state:existing.status,stepId:existing.id,index};
   const mat=verifiedMaterialization(db,seq,existing.id);
   if(!mat)return {...out,state:"awaiting_materialization",stepId:existing.id,index};
   dep=mat.id;
   continue;
  }
   const action=actions[index],bindingStep=action.type==="run_workflow"&&
    action.inputFromPrevious?bindingStepFor(db,seq,index):null;
   if(bindingStep&&(bindingStep.status!=="succeeded"||bindingStep.receipt_trust!=="server_committed"))
    return {...out,state:bindingStep.status,stepId:bindingStep.id,index};
   if(task.active_step_id!==null||!["ready","planning"].includes(task.status))
    return {...out,state:"waiting_for_task",index};
   if(db.prepare("SELECT 1 FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL AND status NOT IN ('succeeded') LIMIT 1")
    .get(taskId,seq.plan_version))return {...out,state:"waiting_for_task",index};
   if(action.type==="run_workflow"&&action.inputFromPrevious){
    let binding;
    try{binding=resolveTrustedInput(db,projectId,task,seq,action,index,dep,{allowOccupied:!!bindingStep})}
    catch(error){
     if(error.code==="assistant_task_run_input_unavailable")return {...out,state:"awaiting_verified_input",index};
     if(error.code==="assistant_task_run_input_occupied")return {...out,state:"binding_conflict",index};
     throw error;
    }
    if(bindingStep){
     try{validateBoundInput(task,seq,index,bindingStep,binding)}
     catch{return {...out,state:"binding_unverified",index,stepId:bindingStep.id}}
     return {...out,state:"ready",next:{index,action,dependsOn:[bindingStep.id],
      last:index===actions.length-1,inputBinding:binding,needsBinding:false}};
    }
    return {...out,state:"ready",next:{index,action,dependsOn:dep?[dep]:[],
     last:index===actions.length-1,inputBinding:binding,needsBinding:true}};
   }
   return {...out,state:"ready",next:{index,action,dependsOn:dep?[dep]:[],
    last:index===actions.length-1}}; }
 return {...out,state:"completed"};
}
export function getAssistantRunSequence(db,{projectId,taskId}){
 const task=taskWithGraph(db,projectId,taskId);
 const seq=sequenceRows(db,taskId,task.active_plan_version).at(-1);
 const state=seq?nextAssistantRunInTransaction(db,projectId,taskId,seq):{sequence:null,state:"none",next:null};
 const outputs=trustedAssistantTaskOutputs(db,{projectId,taskId,planVersion:task.active_plan_version});
 return {...state,outputs:seq?outputs.filter(output=>output.runSequenceId===seq.id):outputs};
}
export function registerAssistantRunSequence(db,{projectId,taskId,requestId,sourceMessageId,
 expectedPlanVersion,expectedProjectRevision,actions}){
 if(!id(requestId)||!id(sourceMessageId)||!Number.isSafeInteger(expectedPlanVersion)||
  !Number.isSafeInteger(expectedProjectRevision)||expectedProjectRevision<1)
  throw fail("assistant_task_run_invalid",400);
 const payload={taskId,sourceMessageId,expectedPlanVersion,expectedProjectRevision,actions};
 const digest=hash(payload);
 return writeTransaction(db,()=>{
  const prior=db.prepare("SELECT command_kind,payload_digest,response_json FROM assistant_task_commands WHERE project_id=? AND request_id=?").get(projectId,requestId);
  if(prior){
   if(prior.command_kind!=="run_sequence"||prior.payload_digest!==digest)throw fail("assistant_task_command_conflict");
   const value=JSON.parse(prior.response_json);
   return {...value,existing:true};
  }
  const task=taskWithGraph(db,projectId,taskId);
  if(task.read_only||task.cancel_requested_at!==null||terminal.has(task.status)||
   task.active_plan_version!==expectedPlanVersion||task.active_step_id!==null)
   throw fail("assistant_task_not_editable");
  if(task.revision!==expectedProjectRevision)throw fail("assistant_step_source_changed");
  validActions(actions,JSON.parse(task.document_json));
  const previous=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? AND superseded_at IS NULL ORDER BY ordinal").all(taskId,expectedPlanVersion);
  if(task.status!=="ready"&&task.status!=="planning"||
   previous.some(step=>step.status!=="succeeded"||step.receipt_trust!=="server_committed"))
   throw fail("assistant_task_run_not_ready");
  const last=previous.at(-1);
  if(previous.some(step=>["model_job","comfy_workflow"].includes(step.kind)&&
   !previous.some(mat=>mat.kind==="materialize"&&mat.status==="succeeded"&&
    mat.receipt_trust==="server_committed"&&
    JSON.parse(mat.depends_on_json).includes(step.id))))
   throw fail("assistant_task_run_not_ready");
  const other=sequenceRows(db,taskId,expectedPlanVersion).at(-1);
  if(other&&nextAssistantRunInTransaction(db,projectId,taskId,other).state!=="completed")
   throw fail("assistant_task_run_already_planned");
  const existing=db.prepare("SELECT id FROM assistant_task_run_sequences WHERE task_id=? AND source_message_id=?").get(taskId,sourceMessageId);
  if(existing)throw fail("assistant_task_command_conflict");
  const now=Date.now(),sequenceId=randomUUID(),json=stableJson(actions);
  db.prepare("INSERT INTO assistant_task_run_sequences(id,project_id,task_id,plan_version,source_message_id,base_step_id,actions_json,intent_digest,expected_project_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .run(sequenceId,projectId,taskId,expectedPlanVersion,sourceMessageId,last?.id??null,json,digest,expectedProjectRevision,now,now);
  db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(taskId,"run_sequence_frozen",stableJson({sequenceId,count:actions.length,planVersion:expectedPlanVersion}),now);
  const response={sequenceId,planVersion:expectedPlanVersion,count:actions.length,
   executionStarted:false,status:"planned"};
  db.prepare("INSERT INTO assistant_task_commands(project_id,request_id,task_id,command_kind,payload_digest,status,response_json,created_at) VALUES(?,?,?,'run_sequence',?,'completed',?,?)")
   .run(projectId,requestId,taskId,digest,stableJson(response),now);
  return {...response,existing:false};
 });
}
/** P3c: one explicit graph Step can bind exactly one verified prior media artifact. */
export function verifyAssistantRunInputBinding(db,{projectId,taskId,runSequenceId,runIndex,
 expectedPlanVersion,actions,dependsOn}){
 if(!id(runSequenceId)||!Number.isInteger(runIndex)||runIndex<1||runIndex>2)
  throw fail("assistant_task_run_input_invalid",400);
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND task_id=? AND project_id=?")
  .get(runSequenceId,taskId,projectId);
 if(!seq||seq.plan_version!==expectedPlanVersion)throw fail("assistant_task_run_not_found",404);
 const state=nextAssistantRunInTransaction(db,projectId,taskId,seq);
 if(state.state!=="ready"||state.next?.index!==runIndex||
  state.next.needsBinding!==true||!state.next.inputBinding)
  throw fail("assistant_task_run_not_ready");
 const binding=state.next.inputBinding;
 const expected=[{type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
  fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId}];
 if(stableJson(actions)!==stableJson(expected)||
  stableJson(dependsOn)!==stableJson(state.next.dependsOn))
  throw fail("assistant_task_run_input_binding_unverified");
 return {sourceArtifactId:binding.sourceArtifactId,sourceSha256:binding.sourceSha256};
}
/** Re-check durable producer evidence at graph commit; no Job/Skill side effects. */
export function verifyAssistantCommittedRunInput(db,{projectId,taskId,runSequenceId,runBindingIndex,
 expectedPlanVersion,actions,dependsOn,sourceArtifactId,sourceSha256}){
 if(!id(runSequenceId)||!Number.isInteger(runBindingIndex)||runBindingIndex<1||
  !Number.isInteger(expectedPlanVersion))throw fail("assistant_task_run_input_invalid",400);
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND task_id=? AND project_id=? AND plan_version=? AND status='active'")
  .get(runSequenceId,taskId,projectId,expectedPlanVersion);
 if(!seq)throw fail("assistant_task_run_not_found",404);
 const task=taskWithGraph(db,projectId,taskId),list=JSON.parse(seq.actions_json);
 const action=list[runBindingIndex],preceding=stepFor(db,seq,runBindingIndex-1);
 if(task.active_plan_version!==expectedPlanVersion||action?.type!=="run_workflow"||
  !action.inputFromPrevious||!preceding||preceding.status!=="succeeded"||
  preceding.receipt_trust!=="server_committed")throw fail("assistant_task_run_not_ready");
 const mat=verifiedMaterialization(db,seq,preceding.id);
 if(!mat||stableJson(dependsOn)!==stableJson([mat.id]))
  throw fail("assistant_step_dependency_unverified");
 const binding=resolveTrustedInput(db,projectId,task,seq,action,runBindingIndex,mat.id);
 const expected=[{type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
  fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId}];
 if(stableJson(actions)!==stableJson(expected)||sourceArtifactId!==binding.sourceArtifactId||
  sourceSha256!==binding.sourceSha256)throw fail("assistant_task_run_input_binding_unverified");
}
/** Guard against bypassing an unfinished ordered generation intent. */
export function assertNoPendingAssistantRunSequence(db,{projectId,taskId}){
 const task=taskWithGraph(db,projectId,taskId);
 const seq=sequenceRows(db,taskId,task.active_plan_version).at(-1);
 if(seq&&nextAssistantRunInTransaction(db,projectId,taskId,seq).state!=="completed")
  throw fail("assistant_task_run_sequence_active");
}
/** Called INSIDE external job planning transaction, before freezing parameters. */
export function verifyAssistantRunSequenceJob(db,{projectId,taskId,runSequenceId,runIndex,
 expectedPlanVersion,job,kind,dependsOn}){
 if(!id(runSequenceId)||!Number.isInteger(runIndex)||runIndex<0||runIndex>2)
  throw fail("assistant_task_run_invalid",400);
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND task_id=? AND project_id=?").get(runSequenceId,taskId,projectId);
 if(!seq||seq.plan_version!==expectedPlanVersion)throw fail("assistant_task_run_not_found",404);
 const result=nextAssistantRunInTransaction(db,projectId,taskId,seq),next=result.next;
 if(result.state!=="ready"||next?.index!==runIndex)
  throw fail("assistant_task_run_not_ready");
 if(stableJson(dependsOn)!==stableJson(next.dependsOn))throw fail("assistant_step_dependency_unverified");
 if(next.action.nodeId!==job.targetNodeId||
  next.action.type==="run_workflow"&&kind!=="comfy_workflow")
  throw fail("assistant_task_run_target_invalid",400);
 const task=taskWithGraph(db,projectId,taskId);
 const node=JSON.parse(task.document_json).nodes.find(n=>n.id===next.action.nodeId);
 if(!node)throw fail("assistant_task_run_target_invalid",400);
 if(next.action.type==="run_workflow"){
  const pinned=node.metadata?.comfyWorkflow;
  const instance=job.snapshot?.comfyRequest?.nodes;
  if(node.type!=="comfy:workflow"||!pinned?.templateId||!pinned.templateRevision||
   !Array.isArray(instance)||!instance.some(n=>n.id===node.id&&
    n.templateId===pinned.templateId&&n.templateRevision===pinned.templateRevision))
   throw fail("assistant_task_run_target_invalid",400);
 }else{
  const mode=node.type==="config"?node.metadata?.generationMode??"image":node.type;
  if(!modes.has(mode)||next.action.mode!==undefined&&next.action.mode!==mode||
   kind==="model_job"&&job.snapshot?.task?.kind!==mode)
   throw fail("assistant_task_run_target_invalid",400);
 }
 if(next.needsBinding===true)throw fail("assistant_task_run_input_not_bound");
 if(next.inputBinding){
  const binding=next.inputBinding,req=job.snapshot?.comfyRequest;
  if(kind!=="comfy_workflow"||!Array.isArray(req?.edges)||!Array.isArray(req?.externalInputs)||
   req.edges.filter(e=>e.fromNodeId===binding.sourceNodeId&&
    e.fromPortId===binding.sourcePortId&&e.toNodeId===binding.toNodeId&&
    e.toPortId===binding.toPortId).length!==1||
   req.externalInputs.filter(e=>e.kind==="asset"&&
    e.sourceNodeId===binding.sourceNodeId&&e.sourcePortId===binding.sourcePortId&&
    e.valueKind===binding.valueKind&&e.sha256===binding.sourceSha256&&
    e.assetId===binding.sourceSha256).length!==1)
   throw fail("assistant_task_run_input_binding_unverified");
 }
 return {finalizeTask:next.last};
}
