
import {createHash,randomUUID} from "node:crypto";
import {getProject} from "./projects.mjs";
import {assertNoRawCredentials,matchesSourceFingerprint,stableJson,submitJobInTransaction,writeTransaction} from "./repository.mjs";
import {compileSingleWorkflow,validateSingleRequest,verifyTemplate} from "../comfy-workflow/compiler.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const zero="0".repeat(64);
const encode=value=>stableJson(JSON.parse(JSON.stringify(value)));
const digest=value=>createHash("sha256").update(encode(value)).digest("hex");
const terminal=new Set(["succeeded","failed","cancelled","blocked_credential"]);
const parse=row=>JSON.parse(row.snapshot_json);
const publicView=(row,items)=>({id:row.id,groupId:row.group_id??undefined,items:items.map(({shotId,status,reason,jobId,tail,choices})=>({shotId,status,reason,jobId,tail,choices}))});

export function createShotBatches({db,blobStore,tailFrames,instanceIds,instanceOrigin=()=>null,objectInfo}){
 const inspections=new Map();
 const lifecycle=new AbortController();
 async function inspect(projectId,{instanceId,comfyTemplate,comfyRequest}={}){
  const project=getProject(db,projectId);
  if(!instanceIds().includes(instanceId)||comfyRequest?.instanceId!==instanceId)throw fail("shot_local_video_workflow_required",422);
  const current=inspections.get(instanceId);
  if(!current||Date.now()-current.at>5000){
   inspections.set(instanceId,{at:Date.now(),promise:Promise.resolve().then(()=>objectInfo(instanceId))});
  }
  const info=await inspections.get(instanceId).promise;
  verifyTemplate(comfyTemplate);
  if(comfyTemplate.requirements.classTypes.some(type=>!info[type]))throw fail("shot_comfy_node_missing",422);
  if(comfyTemplate.requirements.classTypes.some(type=>info[type].api_node||info[type].apiNode))throw fail("shot_online_comfy_node",422);
  const request={...comfyRequest,projectId,canvasRevision:String(project.revision),idempotencyKey:"shot-preflight"};
  validateSingleRequest(request,comfyTemplate);
  const mediaFiles=Object.fromEntries(request.externalInputs.filter(ref=>ref.kind==="asset").map(ref=>[
   ref.assetId,ref.assetId+({IMAGE:".png",MASK:".png",VIDEO:".mp4",AUDIO:".wav"}[ref.valueKind]??".bin")
  ]));
  compileSingleWorkflow(request,comfyTemplate,{info,mediaFiles,mediaMode:request.runOptions.mediaMode});
  return {ready:true};
 }
 const rowFor=(projectId,batchId)=>{
  const row=db.prepare("SELECT * FROM local_shot_batches WHERE project_id=? AND id=?").get(projectId,batchId);
  if(!row)throw fail("shot_batch_not_found",404);
  return row;
 };
 const save=(row,items)=>db.prepare("UPDATE local_shot_batches SET snapshot_json=? WHERE id=?").run(encode(items),row.id);
 const active=(projectId,nodeId)=>db.prepare("SELECT id FROM jobs WHERE project_id=? AND target_node_id=? AND status NOT IN ('succeeded','failed','cancelled')").get(projectId,nodeId);
 function configFence(project,item){
  const node=project.document.nodes.find(value=>value.id===item.nodeId);
  const setting=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
  const config=setting?JSON.parse(setting.value_json):{};
  const explicitVideo=node?.metadata?.comfyMediaPreset??node?.metadata?.comfyWorkflowSelections?.video;
  const workflowDefault=node?.type==="video"&&!explicitVideo?config.comfyWorkflowDefaults?.video:null;
  return digest({origin:instanceOrigin(item.snapshot.instanceId)??null,workflowDefault,
   defaultInstance:item.snapshot.comfyTargetBinding?.binding?.instanceId?null:config.comfyInstanceId});
 }
 const findGroup=(project,groupId)=>project.document.nodes.find(node=>node.id===groupId&&node.type==="group"&&node.metadata?.shotGroup);
 function groupFence(project,groupId,item){
  if(!groupId)return;
  const shots=findGroup(project,groupId)?.metadata.shotGroup.shots??[];
  const index=shots.findIndex(shot=>shot.shotId===item.shotId&&shot.generationNodeId===item.nodeId);
  const shot=shots[index];
  const previous=shot?.mode==="continuity"?shots[index-1]:undefined;
  if(!shot||Boolean(item.continuitySourceId)!==(shot.mode==="continuity")||
     (previous?.shotId??null)!==(item.previousShotId??null)||
     !project.document.nodes.some(node=>node.id===item.nodeId&&node.metadata?.groupId===groupId)||
     (item.take&&previous?.take&&stableJson(previous.take)!==stableJson(item.take)))
   throw fail("shot_group_changed");
  if(item.take&&item.takeSourceNodeId&&previous?.generationNodeId!==item.takeSourceNodeId)throw fail("shot_group_changed");
  return previous;
 }
 function validate(project,groupId,item){
  if(!id(item?.shotId)||!id(item.nodeId)||typeof item.sourceNodeFingerprint!=="string")throw fail("shot_item_invalid",400);
  const snap=item.snapshot,req=snap?.comfyRequest,template=snap?.comfyTemplate;
  if(snap?.adapterKind!=="comfy"||!req||!template||!instanceIds().includes(snap.instanceId)||req.instanceId!==snap.instanceId||
     req.nodes?.length!==1||req.nodes[0]?.id!==item.nodeId||
     !req.rootOutputs?.some(output=>template.ports?.some(port=>port.id===output.portId&&port.capture?.kind==="video")))
   throw fail("shot_local_video_workflow_required",422);
  const node=project.document.nodes.find(value=>value.id===item.nodeId);
  if(!node||!["video","comfy:workflow"].includes(node.type)||!matchesSourceFingerprint(project.document,item.nodeId,item.sourceNodeFingerprint,snap))
   throw fail("stale_generation_source");
  const binding=node.type==="comfy:workflow"?node.metadata?.comfyWorkflow:
   node.metadata?.comfyMediaPreset??node.metadata?.comfyWorkflowSelections?.video??snap.comfyTargetBinding?.binding;
  if(binding?.templateId!==template.id||binding?.templateRevision!==template.revision)
   throw fail("stale_generation_source");
  if(item.configFence&&item.configFence!==configFence(project,item))throw fail("stale_generation_source");
  const previous=groupFence(project,groupId,item);
  if(item.continuitySourceId){
   const ports=template.mediaUseCase?.modeBindings?.[req.runOptions?.mediaMode]?.rolePorts?.first_frame;
   const edges=req.edges?.filter(edge=>edge.toPortId===ports?.[0])??[];
   const refs=req.externalInputs?.filter(ref=>ref.sourceNodeId===item.continuitySourceId)??[];
   if(!groupId||!previous||!id(item.continuitySourceId)||ports?.length!==1||edges.length!==1||
      edges[0].fromNodeId!==item.continuitySourceId||edges[0].fromPortId!=="image"||
      refs.length!==1||refs[0].sourcePortId!=="image"||refs[0].valueKind!=="IMAGE"||refs[0].assetId!==zero||refs[0].sha256!==zero)
    throw fail("explicit_first_frame_port_required",422);
   if(project.document.connections.some(edge=>edge.toNodeId===item.nodeId&&edge.toPortId===ports[0])||
      Object.hasOwn(req.nodes[0].inputOverrides??{},ports[0]))throw fail("manual_first_frame_conflict",422);
   if(item.take&&!/^cas:[a-f0-9]{64}$/.test(item.take.storageKey??""))throw fail("shot_handoff_artifact_missing",422);
  }else if(item.take||item.previousShotId)throw fail("shot_item_invalid",400);
  verifyTemplate(template);
  validateSingleRequest({...req,projectId:project.id,canvasRevision:String(project.revision),idempotencyKey:"shot-preflight"},template);
 }
 function enqueue(row,project,item,tail){
  validate(project,row.group_id,item);
  if(active(project.id,item.nodeId))throw fail("backend_prior_job_not_terminal");
  const idempotencyKey="shot-"+digest([row.id,item.shotId]);
  const original=item.snapshot.comfyRequest;
  const request={...original,projectId:project.id,canvasRevision:String(project.revision),idempotencyKey,
   externalInputs:original.externalInputs.map(ref=>tail&&ref.sourceNodeId===item.continuitySourceId?
    {...ref,assetId:tail.blobId,sha256:tail.blobId}:ref)};
  const snapshot={...item.snapshot,comfyRequest:request,localShotBatch:true};
  const {jobId}=submitJobInTransaction(db,{projectId:project.id,targetNodeId:item.nodeId,expectedProjectRevision:project.revision,
   sourceNodeFingerprint:item.sourceNodeFingerprint,idempotencyKey,requestFingerprint:digest(snapshot),executionMode:"poll",snapshot});
  return {...item,status:"queued",jobId,tail,choices:undefined,reason:undefined};
 }
 function create(projectId,body){
  assertNoRawCredentials(body);
  const {expectedProjectRevision,groupId,idempotencyKey}=body??{};
  const input=body?.items;
  if(!id(idempotencyKey)||groupId!==undefined&&!id(groupId)||!Array.isArray(input)||input.length<1||input.length>128||
     new Set(input.map(item=>item?.shotId)).size!==input.length||new Set(input.map(item=>item?.nodeId)).size!==input.length)
   throw fail("shot_batch_invalid",400);
  const requestDigest=digest(body);
  return writeTransaction(db,()=>{
   const previous=db.prepare("SELECT * FROM local_shot_batches WHERE project_id=? AND request_key=?").get(projectId,idempotencyKey);
   if(previous){if(previous.request_digest!==requestDigest)throw fail("idempotency_key_conflict");return publicView(previous,parse(previous))}
   const project=getProject(db,projectId);
   if(project.revision!==expectedProjectRevision)throw fail("project_revision_conflict");
   const row={id:randomUUID(),project_id:projectId,group_id:groupId??null};
   const items=[];
   for(const item of input){
    try{
     const dependency=groupFence(project,groupId,item);
     validate(project,groupId,item);
     if(active(projectId,item.nodeId))throw fail("backend_prior_job_not_terminal");
     if(item.continuitySourceId){
      if(!item.take&&!items.some(previous=>previous.shotId===dependency.shotId&&previous.status!=="blocked"))throw fail("shot_handoff_wait");
      if(item.take&&items.some(previous=>previous.shotId===dependency.shotId))throw fail("shot_batch_source_conflict");
      items.push({...item,configFence:configFence(project,item),takeSourceNodeId:dependency.generationNodeId,status:"waiting"});
     }else items.push(enqueue(row,project,item));
    }catch(error){items.push({shotId:item.shotId,nodeId:item.nodeId,status:"blocked",reason:error.code??error.message,snapshot:item.snapshot,sourceNodeFingerprint:item.sourceNodeFingerprint,previousShotId:item.previousShotId,take:item.take,continuitySourceId:item.continuitySourceId});}
   }
   db.prepare("INSERT INTO local_shot_batches VALUES(?,?,?,?,?,?,?)").run(row.id,projectId,row.group_id,idempotencyKey,requestDigest,encode(items),Date.now());
   return publicView(row,items);
  });
 }
 function refresh(items){
  return items.map(item=>{
   if(!item.jobId)return item;
   const job=db.prepare("SELECT status FROM jobs WHERE id=?").get(item.jobId);
   return job?{...item,status:job.status}:item;
  });
 }
 function list(projectId){
  getProject(db,projectId);
  return db.prepare("SELECT * FROM local_shot_batches WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100")
   .all(projectId).map(row=>publicView(row,refresh(parse(row))));
 }
 const outputs=jobId=>db.prepare(`SELECT a.id AS artifactId,a.blob_id AS blobId,m.node_id AS nodeId
  FROM artifacts a JOIN materializations m ON m.artifact_id=a.id WHERE a.job_id=? AND a.kind='video' AND m.status='materialized' ORDER BY a.id`).all(jobId)
  .map(item=>({...item,storageKey:"cas:"+item.blobId}));
 function sourceFor(row,items,item){
  const previous=items.find(value=>value.shotId===item.previousShotId);
  if(!previous){
   if(!item.take)return {reason:"shot_handoff_artifact_missing"};
   const project=getProject(db,row.project_id);
   const take=item.take;
   const source=project.document.nodes.find(node=>node.type==="video"&&node.metadata?.storageKey===take.storageKey&&
    (node.id===item.takeSourceNodeId||node.metadata?.comfyArtifact?.workflowNodeId===item.takeSourceNodeId||node.metadata?.modelArtifact?.sourceNodeId===item.takeSourceNodeId));
   const previousShot=groupFence(project,row.group_id,item);
   if(!source&&previousShot?.take?.storageKey!==take.storageKey)return {reason:"shot_handoff_artifact_missing"};
   return {blobId:take.storageKey.slice(4),artifactId:take.artifactId};
  }
  if(!previous.jobId)return previous.status==="blocked"||previous.status==="stopped"?{reason:"shot_previous_failed"}:null;
  const job=db.prepare("SELECT status FROM jobs WHERE id=?").get(previous.jobId);
  if(!job||job.status==="submission_unknown"||terminal.has(job.status)&&job.status!=="succeeded")return {reason:"shot_previous_failed"};
  if(job.status!=="succeeded")return null;
  const pending=db.prepare(`SELECT 1 FROM artifacts a LEFT JOIN materializations m ON m.artifact_id=a.id
   WHERE a.job_id=? AND a.kind='video' AND (m.status IS NULL OR m.status IN ('retry','pending'))`).get(previous.jobId);
  if(pending)return null;
  const project=getProject(db,row.project_id);
  const choices=outputs(previous.jobId).filter(output=>project.document.nodes.some(node=>node.id===output.nodeId&&node.metadata?.storageKey===output.storageKey));
  if(!choices.length)return {reason:"shot_handoff_artifact_missing"};
  if(item.choice)return choices.find(choice=>choice.artifactId===item.choice)??{reason:"shot_handoff_source_changed"};
  if(choices.length===1)return choices[0];
  return {choices};
 }
 async function tailFor(source){
  const old=db.prepare("SELECT receipt_json FROM local_shot_tails WHERE source_blob_id=?").get(source.blobId);
  if(old){
   const tail=JSON.parse(old.receipt_json);
   try{await blobStore.stat(tail.blobId);return {...tail,sourceArtifactId:source.artifactId}}catch{/* Recreate a collected cache entry. */}
  }
  const tail=await tailFrames.extract(source.blobId,{signal:lifecycle.signal});
  db.prepare("INSERT OR REPLACE INTO local_shot_tails VALUES(?,?)").run(source.blobId,stableJson(tail));
  return {...tail,sourceArtifactId:source.artifactId};
 }
 async function advance(row,shotId){
  const items=parse(row),item=items.find(value=>value.shotId===shotId);
  if(!item||!["waiting","choose"].includes(item.status))return;
  let next;
  try{
   validate(getProject(db,row.project_id),row.group_id,item);
   const source=sourceFor(row,items,item);
   if(!source)return;
   if(source.reason)throw fail(source.reason);
   if(source.choices){
    if(item.status==="choose"&&stableJson(item.choices)===stableJson(source.choices))return;
    next={...item,status:"choose",choices:source.choices};
   }else{
    const tail=await tailFor(source);
    next=tail;
   }
  }catch(error){
   if(lifecycle.signal.aborted)return;
   next={...item,status:"blocked",reason:error.code??error.message};
  }
  if(lifecycle.signal.aborted)return;
  writeTransaction(db,()=>{
   const latest=rowFor(row.project_id,row.id),current=parse(latest),index=current.findIndex(value=>value.shotId===shotId);
   if(index<0||encode(current[index])!==encode(item))return;
   if(next.blobId){
    try{
     const source=sourceFor(latest,current,item);
     if(!source||source.blobId!==next.sourceBlobId||source.artifactId!==next.sourceArtifactId)throw fail("shot_handoff_source_changed");
     current[index]=enqueue(latest,getProject(db,row.project_id),item,next);
    }catch(error){current[index]={...item,status:"blocked",reason:error.code??error.message};}
   }else current[index]=next;
   save(latest,current);
  });
 }
 let running;
 function tick(){
  if(running)return running;
  running=(async()=>{
   const rows=db.prepare("SELECT * FROM local_shot_batches WHERE EXISTS (SELECT 1 FROM json_each(snapshot_json) WHERE json_extract(value,'$.status') IN ('waiting','choose')) ORDER BY created_at").all();
   for(const row of rows){
    for(const item of parse(row).filter(value=>["waiting","choose"].includes(value.status))){
     if(lifecycle.signal.aborted)return;
     const latest=rowFor(row.project_id,row.id);
     await advance(latest,item.shotId);
    }
   }
  })().finally(()=>{running=undefined});
  return running;
 }
 function action(projectId,batchId,body){
  assertNoRawCredentials(body);
  return writeTransaction(db,()=>{
   const row=rowFor(projectId,batchId),items=parse(row),project=getProject(db,projectId);
   let updated;
   if(body?.action==="stop")updated=items.map(item=>item.jobId?item:{...item,status:"stopped"});
   else if(body?.action==="choose"){
    const item=items.find(value=>value.shotId===body.shotId&&value.status==="choose");
    const choices=item&&sourceFor(row,items,item)?.choices;
    if(!choices?.some(choice=>choice.artifactId===body.artifactId))throw fail("shot_choice_invalid",400);
    updated=items.map(value=>value===item?{...value,status:"waiting",choice:body.artifactId,choices:undefined}:value);
   }else if(body?.action==="resume"){
    if(project.revision!==body.expectedProjectRevision||!Array.isArray(body.items))throw fail("stale_generation_source");
    const replacements=new Map(body.items.map(item=>[item.shotId,item]));
    updated=items.map(item=>{
     if(item.jobId||item.status!=="blocked"||!replacements.has(item.shotId))return item;
     const replacement=replacements.get(item.shotId);
     try{
      if(replacement.nodeId!==item.nodeId)throw fail("shot_item_invalid");
      const previous=groupFence(project,row.group_id,replacement);
      validate(project,row.group_id,replacement);
      return replacement.continuitySourceId?{...replacement,configFence:configFence(project,replacement),takeSourceNodeId:previous.generationNodeId,status:"waiting"}:enqueue(row,project,replacement);
     }catch(error){return {...item,reason:error.code??error.message};}
    });
   }else throw fail("shot_action_invalid",400);
   save(row,updated);
   return publicView(row,refresh(updated));
  });
 }
 return {create,list,action,tick,inspect,stop:()=>lifecycle.abort(),available:()=>tailFrames.available()};
}

