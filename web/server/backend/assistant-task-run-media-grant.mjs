/** P4.5b: one consent-bound media edge + one local Comfy Job.
 * The durable grant contains only hashes/IDs; source CAS is resolved AFTER
 * a server-committed predecessor materialization. No browser-selected artifact
 * or inferred input can supply authority.
 */
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {trustedAssistantTaskOutputs} from "./assistant-task-produced-artifacts.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const digest=x=>createHash("sha256").update(stableJson(x)).digest("hex");
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const portId=x=>typeof x==="string"&&/^[A-Za-z0-9_:\-.]{1,128}$/.test(x);
const mediaKinds={image:"IMAGE",video:"VIDEO",audio:"AUDIO"};
const keys=(object,allowed)=>object&&typeof object==="object"&&!Array.isArray(object)&&
 Object.keys(object).every(key=>allowed.includes(key));
const secret=/(?:secret|token|password|api.?key|credential|authorization|密钥|密码|令牌)/i;
const activeTask=task=>!task.read_only&&task.cancel_requested_at===null&&
 !["completed","cancelled","blocked","failed","needs_reconcile","cancelling"].includes(task.status);
const pendingFor=db=>db.prepare("SELECT payload_json FROM assistant_task_events "+
 "WHERE task_id=? AND kind='run_budget_granted' AND json_extract(payload_json,'$.grantId')=? LIMIT 1");
const ledgerFor=db=>db.prepare("SELECT kind,payload_json FROM assistant_task_events "+
 "WHERE task_id=? AND kind IN ('run_budget_revoked','run_budget_consumed') "+
 "AND json_extract(payload_json,'$.grantId')=? ORDER BY seq");
const templateFor=(db,node)=>{
 const pin=node?.metadata?.comfyWorkflow;
 if(!pin?.templateId||!pin.templateRevision)throw fail("assistant_run_media_template_invalid",400);
 const row=db.prepare("SELECT payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?")
  .get(pin.templateId,pin.templateRevision);
 if(!row)throw fail("assistant_run_media_template_invalid",400);
 const template=JSON.parse(row.payload_json);
 if(template.id!==pin.templateId||template.revision!==pin.templateRevision)
  throw fail("assistant_run_media_template_invalid",400);
 return template;
};
function scopeNow(db,{doc,action,index,instanceId}){
 const node=doc.nodes.find(n=>n.id===action?.nodeId);
 if(index<1||index>2||action?.type!=="run_workflow"||!action.inputFromPrevious||
  action.when||action.join||node?.type!=="comfy:workflow"||
  !id(action.nodeId)||node.metadata?.comfyMediaPreset||!id(instanceId)||
  doc.connections.some(edge=>edge.toNodeId===node.id))
  throw fail("assistant_run_media_scope_invalid",400);
 const input=action.inputFromPrevious,template=templateFor(db,node);
 const target=template.ports?.find(p=>p.direction==="target"&&p.id===input.toPortId);
 const canvasPort=node.metadata?.comfyPorts?.find(p=>p.direction==="target"&&p.id===input.toPortId);
 if(!Object.hasOwn(mediaKinds,input.sourceKind)||!portId(input.toPortId)||
  !target||target.valueKind!==mediaKinds[input.sourceKind]||
  canvasPort?.valueKind!==target.valueKind||
  !["socket","media-file"].includes(target.inputBinding?.mode)||
  !Array.isArray(target.inputBinding.targets)||!target.inputBinding.targets.length||
  secret.test(String(target.id)+" "+String(target.label)))
  throw fail("assistant_run_media_port_invalid",400);
 const outputs=template.ports?.filter(p=>p.direction==="source"&&p.capture?.kind!=="none"&&
  typeof p.capture?.adapterId==="string"&&p.capture.adapterId.length>0)??[];
 if(!outputs.length||outputs.length>16||
  outputs.some(p=>!portId(p.id))||
  new Set(outputs.map(p=>p.id)).size!==outputs.length)
  throw fail("assistant_run_media_capture_invalid",400);
 const instanceUrl=db.prepare("SELECT url FROM comfy_instances WHERE id=?").get(instanceId)?.url;
 if(!instanceUrl)throw fail("assistant_run_media_instance_invalid",400);
 return {targetNodeId:action.nodeId,sourceKind:input.sourceKind,toPortId:input.toPortId,
  valueKind:mediaKinds[input.sourceKind],targetNodeDigest:digest(node),
  templateId:template.id,templateRevision:template.revision,
  templateDigest:digest(template),outputPortIds:outputs.map(p=>p.id),
  instanceId,instanceUrlDigest:digest(instanceUrl)};
}
export function freezeAssistantRunMediaGrant(db,{doc,actions,runIndex,instanceId}){
 if(!Array.isArray(actions)||!Number.isInteger(runIndex)||!Array.isArray(doc?.nodes)||
  !Array.isArray(doc?.connections))throw fail("assistant_run_media_scope_invalid",400);
 if(actions.slice(0,runIndex).some(action=>action.when||action.join))
  throw fail("assistant_run_media_branch_unsupported",400);
 return scopeNow(db,{doc,action:actions[runIndex],index:runIndex,instanceId});
}
/** Returns no source unless exactly one *trustworthy, CAS-addressable*
 * artifact exists on the immediately preceding RunIndex. Never pick first. */
export function uniqueAssistantRunMediaInput(db,{projectId,taskId,seq,grant,doc}){
 const previous=grant.runIndex-1;
 const steps=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? "+
  "AND kind IN ('model_job','comfy_workflow') AND json_extract(preconditions_json,'$.runSequenceId')=? "+
  "AND json_extract(preconditions_json,'$.runIndex')=? AND superseded_at IS NULL ORDER BY ordinal DESC")
  .all(taskId,grant.planVersion,seq.id,previous);
 const producer=steps[0];
 if(!producer||producer.status!=="succeeded"||producer.receipt_trust!=="server_committed")
  throw fail("assistant_run_media_predecessor_not_verified");
 const mat=db.prepare("SELECT id FROM assistant_task_steps WHERE task_id=? AND plan_version=? "+
  "AND kind='materialize' AND status='succeeded' AND receipt_trust='server_committed' AND superseded_at IS NULL "+
  "AND EXISTS (SELECT 1 FROM json_each(depends_on_json) WHERE value=?) ORDER BY ordinal DESC")
  .get(taskId,grant.planVersion,producer.id);
 if(!mat)throw fail("assistant_run_media_predecessor_not_verified");
 const items=trustedAssistantTaskOutputs(db,{projectId,taskId,planVersion:grant.planVersion})
  .filter(item=>item.runSequenceId===seq.id&&item.runIndex===previous&&
   item.materialStepId===mat.id&&item.sourceStepId===producer.id&&item.kind===grant.mediaScope.sourceKind);
 if(items.length!==1)throw fail("assistant_run_media_unique_source_required");
 const output=items[0],source=doc.nodes.find(n=>n.id===output.nodeId);
 if(!source||source.type!==grant.mediaScope.sourceKind||
  source.metadata?.storageKey!=="cas:"+output.sha256)
  throw fail("assistant_run_media_source_invalidated");
 return {sourceArtifactId:output.artifactId,sourceSha256:output.sha256,
  sourceNodeId:output.nodeId,sourcePortId:grant.mediaScope.sourceKind,
  sourceMaterialStepId:mat.id,toNodeId:grant.mediaScope.targetNodeId,
  toPortId:grant.mediaScope.toPortId,sourceKind:grant.mediaScope.sourceKind,
  valueKind:grant.mediaScope.valueKind};
}
export function getAssistantMediaGrantForCheck(db,{projectId,taskId,grantId}){
 if(!id(grantId))throw fail("assistant_run_media_grant_invalid",400);
 const task=db.prepare("SELECT t.*,p.document_json,p.revision FROM assistant_tasks t JOIN projects p "+
  "ON p.id=t.project_id AND p.deleted_at IS NULL WHERE t.id=? AND t.project_id=?")
  .get(taskId,projectId);
 if(!task)throw fail("assistant_task_not_found",404);
 const row=pendingFor(db).get(taskId,grantId),grant=row&&JSON.parse(row.payload_json);
 if(!grant||grant.mode!=="local_comfy_media"||grant.payloadPolicyVersion!==3)
  throw fail("assistant_run_media_grant_not_found",404);
 const records=ledgerFor(db).all(taskId,grantId);
 const revoked=records.some(record=>record.kind==="run_budget_revoked");
 const consumed=records.some(record=>record.kind==="run_budget_consumed");
 const active=activeTask(task)&&!revoked&&!consumed&&
  task.active_plan_version===grant.planVersion&&Date.now()<grant.expiresAt;
 if(!active)throw fail("assistant_run_media_grant_not_active");
 const seq=db.prepare("SELECT * FROM assistant_task_run_sequences WHERE id=? AND task_id=? AND project_id=?")
  .get(grant.sequenceId,taskId,projectId);
 if(!seq||seq.status!=="active"||seq.plan_version!==grant.planVersion||
  seq.intent_digest!==grant.intentDigest)
  throw fail("assistant_run_media_sequence_changed");
 const actions=JSON.parse(seq.actions_json),action=actions[grant.runIndex];
 if(action?.type!=="run_workflow"||action.nodeId!==grant.mediaScope.targetNodeId||
  action.inputFromPrevious?.sourceKind!==grant.mediaScope.sourceKind||
  action.inputFromPrevious?.toPortId!==grant.mediaScope.toPortId)
  throw fail("assistant_run_media_sequence_changed");
 const doc=JSON.parse(task.document_json),target=doc.nodes.find(n=>n.id===action.nodeId);
 const currentUrl=db.prepare("SELECT url FROM comfy_instances WHERE id=?").get(grant.mediaScope.instanceId)?.url;
 if(!target||!currentUrl||digest(target)!==grant.mediaScope.targetNodeDigest||
  digest(templateFor(db,target))!==grant.mediaScope.templateDigest||
  digest(currentUrl)!==grant.mediaScope.instanceUrlDigest)
  throw fail("assistant_run_media_scope_changed");
 return {task,seq,grant,doc,action,revoked,consumed};
}
/** Plan-time check: the client cannot turn a media grant into a general
 * graph writer, even before the frozen Step exists. */
export function assertAssistantRunMediaPlanConsent(db,{projectId,taskId,grantId,
 runSequenceId,runIndex,actions,dependsOn,bindingProof}){
 const {seq,grant,doc}=getAssistantMediaGrantForCheck(db,{projectId,taskId,grantId});
 if(seq.id!==runSequenceId||grant.runIndex!==runIndex||
  doc.connections.some(edge=>edge.toNodeId===grant.mediaScope.targetNodeId))
  throw fail("assistant_run_media_binding_changed");
 const binding=uniqueAssistantRunMediaInput(db,{projectId,taskId,seq,grant,doc});
 if(binding.sourceArtifactId!==bindingProof?.sourceArtifactId||
  binding.sourceSha256!==bindingProof?.sourceSha256||
  stableJson(dependsOn)!==stableJson([binding.sourceMaterialStepId])||
  stableJson(actions)!==stableJson([{type:"connect_workflow_port",
   fromNodeId:binding.sourceNodeId,fromPortId:binding.sourcePortId,
   toNodeId:binding.toNodeId,toPortId:binding.toPortId}]))
  throw fail("assistant_run_media_binding_changed");
}
/** Checks a planned canvas Step's immutable identities before any consent-
 * authorized decision, claim or graph commit. */
export function assertAssistantRunMediaBindingConsent(db,{projectId,taskId,step,grantId}){
 const {task,seq,grant,doc}=getAssistantMediaGrantForCheck(db,{projectId,taskId,grantId});
 const pre=JSON.parse(step.preconditions_json),action=JSON.parse(step.action_json);
 if(step.kind!=="canvas_mutation"||step.plan_version!==grant.planVersion||
  pre.runMediaGrantId!==grantId||pre.runSequenceId!==seq.id||
  pre.runBindingIndex!==grant.runIndex||step.superseded_at!==null||
  task.revision!==pre.projectRevision)
  throw fail("assistant_run_media_binding_changed");
 const incoming=doc.connections.filter(edge=>edge.toNodeId===grant.mediaScope.targetNodeId);
 if(incoming.length)throw fail("assistant_run_media_binding_conflict");
 const binding=uniqueAssistantRunMediaInput(db,{projectId,taskId,seq,grant,doc});
 const expected=[{type:"connect_workflow_port",fromNodeId:binding.sourceNodeId,
  fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId}];
 if(stableJson(action.actions)!==stableJson(expected)||
  pre.runSourceArtifactId!==binding.sourceArtifactId||
  pre.runSourceSha256!==binding.sourceSha256||
  stableJson(JSON.parse(step.depends_on_json))!==stableJson([binding.sourceMaterialStepId]))
  throw fail("assistant_run_media_binding_changed");
 return binding;
}
/** Invoked in the same BEGIN IMMEDIATE that creates the only permitted Job. */
export function authorizeAssistantRunMediaJob(db,{projectId,taskId,grantId,step}){
 const {task,seq,grant,doc}=getAssistantMediaGrantForCheck(db,{projectId,taskId,grantId});
 const pre=JSON.parse(step.preconditions_json),action=JSON.parse(step.action_json);
 if(step.kind!=="comfy_workflow"||action.kind!=="comfy_workflow"||
  step.plan_version!==grant.planVersion||pre.runSequenceId!==seq.id||
  pre.runIndex!==grant.runIndex||!["waiting_approval","ready"].includes(step.status)||
  action.job.targetNodeId!==grant.mediaScope.targetNodeId||
  action.job.executionMode!=="poll"||
  String(task.revision)!==action.job.snapshot?.comfyRequest?.canvasRevision)
  throw fail("assistant_run_media_job_scope_changed");
 const binding=uniqueAssistantRunMediaInput(db,{projectId,taskId,seq,grant,doc});
 const bindingStep=db.prepare("SELECT * FROM assistant_task_steps WHERE task_id=? AND plan_version=? "+
  "AND kind='canvas_mutation' AND json_extract(preconditions_json,'$.runSequenceId')=? "+
  "AND json_extract(preconditions_json,'$.runBindingIndex')=? AND superseded_at IS NULL "+
  "ORDER BY ordinal DESC LIMIT 1").get(taskId,grant.planVersion,seq.id,grant.runIndex);
 const edgeId=JSON.parse(bindingStep?.receipt_json??"null")?.refs?.connections?.edge_0;
 const edge=doc.connections.find(item=>item.id===edgeId);
 if(!bindingStep||bindingStep.status!=="succeeded"||
  bindingStep.receipt_trust!=="server_committed"||
  JSON.parse(bindingStep.preconditions_json).runMediaGrantId!==grantId||
  !edge||edge.fromNodeId!==binding.sourceNodeId||
  edge.fromPortId!==binding.sourcePortId||edge.toNodeId!==binding.toNodeId||
  edge.toPortId!==binding.toPortId||
  doc.connections.filter(item=>item.toNodeId===binding.toNodeId).length!==1||
  stableJson(JSON.parse(step.depends_on_json))!==stableJson([bindingStep.id]))
  throw fail("assistant_run_media_binding_unverified");
 const snap=action.job.snapshot,req=snap?.comfyRequest,scope=grant.mediaScope;
 if(!keys(snap,["adapterKind","instanceId","comfyTemplate","comfyRequest"])||
  !keys(req,["schemaVersion","projectId","canvasRevision","instanceId",
   "rootOutputs","nodes","edges","externalInputs","runOptions","idempotencyKey"])||
  !keys(req?.nodes?.[0],["id","templateId","templateRevision","inputOverrides"])||
  typeof req.idempotencyKey!=="string"||!req.idempotencyKey||
  snap.adapterKind!=="comfy"||snap.instanceId!==scope.instanceId||
  req?.instanceId!==scope.instanceId||req.projectId!==projectId||
  req.schemaVersion!==2||!Array.isArray(req.nodes)||req.nodes.length!==1||
  req.nodes[0].id!==scope.targetNodeId||req.nodes[0].templateId!==scope.templateId||
  req.nodes[0].templateRevision!==scope.templateRevision||
  stableJson(req.nodes[0].inputOverrides)!==stableJson(doc.nodes.find(n=>n.id===scope.targetNodeId)?.metadata?.comfyWorkflow?.inputOverrides??{})||
  digest(snap.comfyTemplate)!==scope.templateDigest||
  stableJson(req.rootOutputs)!==stableJson(scope.outputPortIds.map(portId=>({nodeId:scope.targetNodeId,portId})))||
  stableJson(req.runOptions)!=="{}"||
  !Array.isArray(req.edges)||req.edges.length!==1||
  stableJson(req.edges[0])!==stableJson({fromNodeId:binding.sourceNodeId,
   fromPortId:binding.sourcePortId,toNodeId:binding.toNodeId,toPortId:binding.toPortId})||
  !Array.isArray(req.externalInputs)||req.externalInputs.length!==1||
  stableJson(req.externalInputs[0])!==stableJson({kind:"asset",sourceNodeId:binding.sourceNodeId,
   sourcePortId:binding.sourcePortId,valueKind:binding.valueKind,
   assetId:binding.sourceSha256,sha256:binding.sourceSha256}))
  throw fail("assistant_run_media_job_scope_changed");
 return {grantId,runIndex:grant.runIndex,media:true};
}
