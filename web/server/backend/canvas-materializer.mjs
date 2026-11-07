import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {matchesSourceFingerprint,stableJson,writeTransaction} from "./repository.mjs";
import {validateProjectDocument} from "./projects.mjs";
import {makeComfyArtifactProvenance} from "./comfy-provenance.mjs";
import {emitProjectEvent} from "./projects.mjs";
import {imageNodeSize,readRasterImageDimensions} from "./image-dimensions.mjs";
import {readVideoDimensions,videoNodeSize} from "./video-dimensions.mjs";

function resizeVisualMediaWriteback(source, dimensions) {
 if(!["image","video"].includes(source.type)||source.metadata?.freeResize||!dimensions?.width||!dimensions?.height)return;
 const edge=Math.max(source.width,source.height);
 const scale=edge/Math.max(dimensions.width,dimensions.height);
 source.width=dimensions.width*scale;
 source.height=dimensions.height*scale;
}

const requiredKind={image:"IMAGE",video:"VIDEO",audio:"AUDIO",text:"STRING"};
const dims={image:[420,420],video:[420,236],audio:[520,220],text:[420,320]};
const fail=reason=>Object.assign(Error(reason),{code:reason,statusCode:409});
const validId=id=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
/** Materializes confirmed artifacts into the backend-authoritative project document.
 * One DB transaction owns document revision, node, typed connection, record, event.
 * A failed/blocked materialization NEVER changes the successful generation job.
 */
export function createCanvasMaterializer({db,blobStore,videoDimensionReader=readVideoDimensions}={}){
 if(!db||!blobStore)throw Error("invalid_canvas_materializer");
 const select=({projectId=null,artifactId=null}={})=>db.prepare(`SELECT a.*,j.project_id,j.target_node_id,j.source_fingerprint,j.status AS job_status,
  m.id AS materialization_id,m.status AS materialization_status
  FROM artifacts a JOIN jobs j ON j.id=a.job_id
  LEFT JOIN materializations m ON m.artifact_id=a.id AND m.project_id=j.project_id
  WHERE j.status='succeeded' AND j.project_id IS NOT NULL
    AND (? IS NULL OR j.project_id=?) AND (? IS NULL OR a.id=?) AND a.port_id IS NOT 'skill-script'
    AND (m.id IS NULL OR m.status IN ('pending','retry') AND (m.next_due_at IS NULL OR m.next_due_at<=CAST(strftime('%s','now') AS INTEGER)*1000))
  ORDER BY j.created_at,a.port_id,a.item_key,a.id`).all(projectId,projectId,artifactId,artifactId);
 function mark(artifact,code,status){
  return writeTransaction(db,()=>{
   const current=db.prepare("SELECT id,status,fail_count FROM materializations WHERE project_id=? AND artifact_id=?")
    .get(artifact.project_id,artifact.id);
   if(current?.status==="materialized")return;
   const failures=status==="retry"?(current?.fail_count??0)+1:0;
   const due=status==="retry"?Date.now()+Math.min(60000,1000*2**Math.min(12,failures-1)):null;
   if(current)db.prepare("UPDATE materializations SET status=?,reason=?,fail_count=?,next_due_at=? WHERE id=?")
    .run(status,code,failures,due,current.id);
   else db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,reason,fail_count,next_due_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(),artifact.job_id,artifact.id,artifact.project_id,status,code,failures,due);
   db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
    .run(artifact.job_id,"artifact_materialization",stableJson({
     artifactId:artifact.id,status,reason:code
    }),Date.now());
  });
 }
 // A completed model batch is adopted atomically; historical per-image records
 // deliberately keep their original nodes.
 async function processImageBatch(artifact){
  const job=db.prepare("SELECT snapshot_json,source_fingerprint FROM jobs WHERE id=?").get(artifact.job_id);
  const snapshot=job?JSON.parse(job.snapshot_json):null;
  if(snapshot?.adapterKind!=="model"||snapshot.task?.kind!=="image"||snapshot.task.writeBack||
     !["openai","openai_compatible","google_gemini"].includes(snapshot.provider))return null;
  const project=db.prepare("SELECT document_json FROM projects WHERE id=? AND deleted_at IS NULL").get(artifact.project_id);
  const source=project?JSON.parse(project.document_json).nodes.find(n=>n.id===artifact.target_node_id):null;
  const sourceType=snapshot.sourceNodeType??source?.type;
  const rows=db.prepare("SELECT * FROM artifacts WHERE job_id=? ORDER BY CAST(item_key AS INTEGER),item_key,id").all(artifact.job_id);
  if((rows.length<2||sourceType!=="image"&&sourceType!=="config")||
     rows.some(a=>a.kind!=="image"||a.port_id!=="image"))return null;
  const records=db.prepare("SELECT * FROM materializations WHERE job_id=? AND project_id=?").all(artifact.job_id,artifact.project_id);
  if(records.some(m=>m.status==="materialized")){
   const prior=records.find(m=>m.artifact_id===artifact.id);
   if(prior?.status==="materialized")return {artifactId:artifact.id,status:"materialized",existing:true};
   return null;
  }
  let images;
  try{
   images=await Promise.all(rows.map(async a=>{
    if(!validId(a.id)||JSON.parse(a.metadata_json)?.modelGeneration?.kind!=="image")throw fail("materialization_port_mismatch");
    const blob=await blobStore.stat(a.blob_id);
    if(blob.sha256!==a.sha256||blob.mimeType!==a.mime)throw fail("materialization_blob_mismatch");
    const dimensions=await readRasterImageDimensions(blob.path,blob.mimeType);
    return {id:a.id,status:"success",content:"/api/v1/blobs/"+a.blob_id,storageKey:"cas:"+a.blob_id,
     naturalWidth:dimensions?.width??0,naturalHeight:dimensions?.height??0,bytes:blob.byteSize,mimeType:a.mime,
     modelArtifact:{jobId:a.job_id,artifactId:a.id,sourceNodeId:artifact.target_node_id,kind:"image",model:snapshot.task.model}};
   }));
   return writeTransaction(db,()=>{
    const current=db.prepare("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(artifact.project_id);
    if(!current)throw fail("materialization_project_deleted");
    // Another watcher may have adopted the batch while CAS reads were pending.
    if(db.prepare("SELECT 1 FROM materializations WHERE artifact_id=? AND project_id=? AND status='materialized'")
      .get(artifact.id,artifact.project_id))return {artifactId:artifact.id,status:"materialized",existing:true};
    const doc=JSON.parse(current.document_json),source=doc.nodes.find(n=>n.id===artifact.target_node_id);
    let sourceUnchanged=false;
    if(source&&job)try{sourceUnchanged=matchesSourceFingerprint(doc,source.id,job.source_fingerprint,snapshot)}catch{}
    const sourceEmpty=source?.type==="image"&&!String(source.metadata?.content??"").trim()&&
     !source.metadata?.storageKey&&!source.metadata?.modelArtifact&&!source.metadata?.comfyArtifact&&
     !source.metadata?.images?.length;
    const writeInPlace=Boolean(source?.type==="image"&&sourceUnchanged&&sourceEmpty);
    const nodeId=writeInPlace?source.id:"artifact-"+images[0].id,edgeId="artifact-edge-"+images[0].id;
    if(!validId(nodeId)||!validId(edgeId))throw fail("materialization_invalid_id");
    if(doc.nodes.some(n=>(!writeInPlace&&n.id===nodeId)||images.some(image=>n.metadata?.modelArtifact?.artifactId===image.id||
       n.metadata?.images?.some(i=>i.modelArtifact?.artifactId===image.id))))throw fail("materialization_identity_conflict");
    const first=images[0],{id:primaryImageId,modelArtifact,...media}=first;
    const groupMetadata={...media,modelArtifact,images,primaryImageId,count:images.length,prompt:snapshot.task.prompt};
    if(writeInPlace){
     const sourceGroupMetadata={...groupMetadata};
     delete sourceGroupMetadata.prompt;
     resizeVisualMediaWriteback(source,{width:first.naturalWidth,height:first.naturalHeight});
     source.metadata={...source.metadata,...sourceGroupMetadata,status:"success"};
    }else{
     const size=imageNodeSize(first.naturalWidth&&first.naturalHeight?{width:first.naturalWidth,height:first.naturalHeight}:null);
     const count=doc.nodes.filter(n=>n.metadata?.modelArtifact?.sourceNodeId===artifact.target_node_id).length;
     const fallbackX=Math.max(0,...doc.nodes.map(n=>Number(n.position?.x)+Number(n.width)||0))+48;
     doc.nodes.push({id:nodeId,type:"image",title:"Generated image",...size,
      position:{x:source?source.position.x+source.width+48+Math.floor(count/4)*444:fallbackX,
       y:source?source.position.y+(count%4)*444:80},
      metadata:{...groupMetadata,...(source&&!sourceUnchanged?{sourceChangedSinceSubmit:true}:{})}});
    }
    if(!writeInPlace&&source&&["config","text","image"].includes(source.type)&&!doc.connections.some(c=>c.id===edgeId))
     doc.connections.push({id:edgeId,fromNodeId:source.id,toNodeId:nodeId});
    const content=validateProjectDocument(doc);
    db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=? AND revision=?")
     .run(content,artifact.project_id,current.revision);
    for(const a of rows){
     db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,artifact_id) DO UPDATE SET status='materialized',node_id=excluded.node_id,reason=NULL,fail_count=0,next_due_at=NULL")
      .run(randomUUID(),a.job_id,a.id,artifact.project_id,"materialized",nodeId);
     db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
      .run(a.job_id,"artifact_materialized",stableJson({projectId:artifact.project_id,artifactId:a.id,nodeId,revision:current.revision+1}),Date.now());
    }
    emitProjectEvent(db,{id:artifact.project_id,revision:current.revision+1,kind:"materialized"});
    return {artifactId:artifact.id,status:"materialized",nodeId,revision:current.revision+1};
   });
  }catch(error){
   const reason=error.code??"materialization_failed";
   const status=["materialization_identity_conflict","materialization_invalid_id","materialization_port_mismatch","materialization_project_deleted"].includes(reason)?"blocked":"retry";
   for(const a of rows)mark({...a,project_id:artifact.project_id},reason,status);
   return {artifactId:artifact.id,status,reason};
  }
 }
 async function processArtifact(artifact){
  const batch=await processImageBatch(artifact);
  if(batch)return batch;
  let contents=null,mediaDimensions=null;
  try{
   if(!validId(artifact.project_id)||!artifact.target_node_id||!artifact.port_id||
      !Object.hasOwn(requiredKind,artifact.kind))throw fail("materialization_source_missing");
   const blob=await blobStore.stat(artifact.blob_id);
   if(blob.sha256!==artifact.sha256||blob.mimeType!==artifact.mime)throw fail("materialization_blob_mismatch");
   if(artifact.kind==="image")mediaDimensions=await readRasterImageDimensions(blob.path,blob.mimeType);
   if(artifact.kind==="video")mediaDimensions=await videoDimensionReader(blob.path,blob.mimeType);
   if(artifact.kind==="text"){
    if(blob.byteSize>2_000_000)throw fail("materialization_text_too_large");
    const bytes=await readFile(blob.path);
    try{contents=new TextDecoder("utf-8",{fatal:true}).decode(bytes)}
    catch{throw fail("materialization_text_invalid")}
   }
  }catch(e){
   mark(artifact,e.code??"materialization_blob_unavailable","retry");
   return {artifactId:artifact.id,status:"retry"};
  }
  try{
   return writeTransaction(db,()=>{
    const prior=db.prepare("SELECT * FROM materializations WHERE project_id=? AND artifact_id=?")
     .get(artifact.project_id,artifact.id);
    if(prior?.status==="materialized")return {artifactId:artifact.id,status:"materialized",existing:true};
    const project=db.prepare("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL")
      .get(artifact.project_id);
    if(!project)throw fail("materialization_project_deleted");
    const doc=JSON.parse(project.document_json);
    const source=doc.nodes.find(n=>n.id===artifact.target_node_id);
    // A successful immutable artifact survives deletion or edits of its source.
    // An absent/incompatible source prevents a link, not persistence of the blob.
    const job=db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(artifact.job_id);
    const snapshot=job?JSON.parse(job.snapshot_json):null;
    const isModel=snapshot?.adapterKind==="model"&&
     (snapshot.provider==="openai"||snapshot.provider==="openai_compatible"||snapshot.provider==="google_gemini"||
      snapshot.provider==="volcengine_ark"&&artifact.kind==="video")&&
     snapshot.task?.kind===artifact.kind&&artifact.port_id===artifact.kind;
    const metadata=JSON.parse(artifact.metadata_json);
    // Legacy worker tests and old jobs may have model adapter snapshots
    // without a typed task but a valid Comfy capture record.
    const isComfy=snapshot?.adapterKind==="comfy"||
     snapshot?.adapterKind==="model"&&!snapshot.task?.kind&&!!metadata?.comfyArtifact;
    if(!isModel&&!isComfy)throw fail("materialization_port_mismatch");
    if(isModel&&metadata?.modelGeneration?.kind!==artifact.kind)
     throw fail("materialization_port_mismatch");
    const compatibleModelSource=source&&(["config","text"].includes(source.type)||
     source.type===artifact.kind&&["image","audio","video"].includes(source.type));
    const hasWorkflowPort=source?.type==="comfy:workflow"&&source.metadata?.comfyPorts?.some(p=>
     p.id===artifact.port_id&&p.direction==="source"&&p.valueKind===requiredKind[artifact.kind]);
    const mediaUseCase=snapshot?.comfyTemplate?.mediaUseCase;
    const hasMediaPresetPort=source?.type===artifact.kind&&source.metadata?.comfyMediaPreset?.templateId===snapshot?.comfyTemplate?.id&&
     source.metadata?.comfyMediaPreset?.templateRevision===snapshot?.comfyTemplate?.revision&&
     [mediaUseCase?.primaryOutputPortId,...(mediaUseCase?.additionalOutputPortIds??[])].includes(artifact.port_id);
    const targetBinding=snapshot?.comfyTargetBinding;
    const targetBindingPort=(source?.type==="config"||source?.type===targetBinding?.mode)&&targetBinding?.mode===mediaUseCase?.channel&&
     targetBinding?.binding?.templateId===snapshot?.comfyTemplate?.id&&
     targetBinding?.binding?.templateRevision===snapshot?.comfyTemplate?.revision&&
     [mediaUseCase?.primaryOutputPortId,...(mediaUseCase?.additionalOutputPortIds??[])].includes(artifact.port_id);
    const hasPort=Boolean(hasWorkflowPort||hasMediaPresetPort||targetBindingPort);
    // Input fingerprints belong to the pre-submit save barrier. Once generated,
    // an edited prompt, reference connection or workflow binding must not
    // strand its verified CAS result. Original inputs remain in the frozen job.
    let sourceChangedSinceSubmit=!source;
    if(source)try{
     sourceChangedSinceSubmit=!matchesSourceFingerprint(doc,source.id,artifact.source_fingerprint,snapshot);
    }catch{sourceChangedSinceSubmit=true}
    const linkable=Boolean(source&&(isModel?compatibleModelSource:hasPort));
    const index=metadata?.comfyArtifact?.index;
    const origin=isModel?{jobId:artifact.job_id,artifactId:artifact.id,sourceNodeId:artifact.target_node_id,
     kind:artifact.kind,model:snapshot.task.model}:
     makeComfyArtifactProvenance({runId:artifact.job_id,artifactId:artifact.id,
      workflowNodeId:artifact.target_node_id,portId:artifact.port_id,kind:artifact.kind,index});
    // An unchanged, empty Text source can receive its own generated response.
    // If the user typed into it while the model ran, append a new node instead.
    const sourceImageEmpty=Boolean(source?.type==="image"&&
      !String(source.metadata?.content??"").trim()&&!source.metadata?.storageKey&&
      !source.metadata?.modelArtifact&&!source.metadata?.comfyArtifact&&!source.metadata?.images?.length);
    const sourceMediaEmpty=Boolean(source&&["video","audio"].includes(source.type)&&
      source.type===artifact.kind&&!String(source.metadata?.content??"").trim()&&
      !source.metadata?.storageKey&&!source.metadata?.modelArtifact&&!source.metadata?.comfyArtifact);
    const writeBack=Boolean(isModel&&snapshot.task?.writeBack===true&&artifact.kind==="image"&&
      source&&!sourceChangedSinceSubmit);
    const emptyImageWriteBack=Boolean(isModel&&snapshot.task?.writeBack!==true&&artifact.kind==="image"&&
      source?.type==="image"&&sourceImageEmpty&&!sourceChangedSinceSubmit);
    const emptyMediaWriteBack=Boolean(isModel&&["video","audio"].includes(artifact.kind)&&
      source?.type===artifact.kind&&sourceMediaEmpty&&!sourceChangedSinceSubmit);
    const emptyComfyMediaWriteBack=Boolean(isComfy&&(hasMediaPresetPort||targetBindingPort)&&mediaUseCase?.primaryOutputPortId===artifact.port_id&&
      source&&!sourceChangedSinceSubmit&&(artifact.kind==="image"?sourceImageEmpty:sourceMediaEmpty));
    const fillEmptyText=Boolean(isModel&&artifact.kind==="text"&&source?.type==="text"&&
     !sourceChangedSinceSubmit&&!String(source.metadata?.content??"").trim()&&
     !source.metadata?.modelArtifact&&typeof contents==="string"&&contents.trim());
    const writeToSource=fillEmptyText||writeBack||emptyImageWriteBack||emptyMediaWriteBack||emptyComfyMediaWriteBack;
    const nodeId=writeToSource?source.id:"artifact-"+artifact.id;
    const edgeId="artifact-edge-"+artifact.id;
    if(!validId(nodeId)||!validId(edgeId))throw fail("materialization_invalid_id");
    if(fillEmptyText){
     source.metadata={...source.metadata,content:contents,status:"success",modelArtifact:origin};
    }else if(writeBack||emptyImageWriteBack||emptyMediaWriteBack||emptyComfyMediaWriteBack){
     resizeVisualMediaWriteback(source,mediaDimensions);
     source.metadata={...source.metadata,content:"/api/v1/blobs/"+artifact.blob_id,
      storageKey:"cas:"+artifact.blob_id,mimeType:artifact.mime,status:"success",
      ...(isModel?{modelArtifact:origin}:{comfyArtifact:origin}),
      bytes:db.prepare("SELECT byte_size FROM blobs WHERE id=?").get(artifact.blob_id).byte_size,
      ...(mediaDimensions?{naturalWidth:mediaDimensions.width,naturalHeight:mediaDimensions.height}:{})};
    }else{
     const matches=doc.nodes.filter(n=>(isModel?n.metadata?.modelArtifact?.artifactId:
      n.metadata?.comfyArtifact?.artifactId)===artifact.id);
     if(matches.length>1||(matches.length===1&&matches[0].id!==nodeId))
      throw fail("materialization_identity_conflict");
     const other=doc.nodes.find(n=>n.id===nodeId);
     if(other&&!matches.includes(other))throw fail("materialization_node_collision");
     const {width,height}=artifact.kind==="image"?imageNodeSize(mediaDimensions):
      artifact.kind==="video"?videoNodeSize(mediaDimensions):
      {width:dims[artifact.kind][0],height:dims[artifact.kind][1]};
     const existingCount=doc.nodes.filter(n=>isModel?n.metadata?.modelArtifact?.sourceNodeId===artifact.target_node_id:
      n.metadata?.comfyArtifact?.workflowNodeId===artifact.target_node_id).length;
     const column=Math.floor(existingCount/4),row=existingCount%4;
     const fallbackX=Math.max(0,...doc.nodes.map(n=>Number(n.position?.x)+Number(n.width)||0))+48;
     const node=other??{
      id:nodeId,type:artifact.kind,title:"Generated "+artifact.kind,
      position:{x:source?source.position.x+source.width+48+column*444:fallbackX+column*444,
       y:source?source.position.y+row*444:80+row*444},width,height,
      metadata:{status:"success",mimeType:artifact.mime,
       ...(sourceChangedSinceSubmit?{sourceChangedSinceSubmit:true}:{}),
       ...(mediaDimensions?{naturalWidth:mediaDimensions.width,naturalHeight:mediaDimensions.height}:{}),
       ...(isModel?{modelArtifact:origin}:{comfyArtifact:origin}),
       ...(artifact.kind==="text"?{content:contents}:{content:"/api/v1/blobs/"+artifact.blob_id,
        storageKey:"cas:"+artifact.blob_id,
        bytes:db.prepare("SELECT byte_size FROM blobs WHERE id=?").get(artifact.blob_id).byte_size})}
     };
     if(!other)doc.nodes.push(node);
     const existingLink=doc.connections.find(c=>c.toNodeId===nodeId);
     const edgeCollision=doc.connections.some(c=>c.id===edgeId&&
       !(linkable&&c.fromNodeId===source.id&&c.toNodeId===nodeId));
     // Preserve existing user links; a detached artifact keeps its provenance.
     if(linkable&&!existingLink&&!edgeCollision)doc.connections.push(isModel?{
      id:edgeId,fromNodeId:source.id,toNodeId:nodeId
     }:{
      id:edgeId,fromNodeId:source.id,fromPortId:artifact.port_id,
      toNodeId:nodeId,toPortId:"comfy-artifact"
     });
    }
    const content=validateProjectDocument(doc);
    db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=? AND revision=?")
      .run(content,artifact.project_id,project.revision);
    emitProjectEvent(db,{id:artifact.project_id,revision:project.revision+1,kind:"materialized"});
    if(prior)db.prepare("UPDATE materializations SET status='materialized',node_id=?,reason=NULL,fail_count=0,next_due_at=NULL WHERE id=?")
      .run(nodeId,prior.id);
    else db.prepare("INSERT INTO materializations(id,job_id,artifact_id,project_id,status,node_id) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(),artifact.job_id,artifact.id,artifact.project_id,"materialized",nodeId);
    db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
     .run(artifact.job_id,"artifact_materialized",stableJson({
      projectId:artifact.project_id,artifactId:artifact.id,nodeId,revision:project.revision+1
     }),Date.now());
    return {artifactId:artifact.id,status:"materialized",nodeId,revision:project.revision+1};
   });
  }catch(e){
   const reason=e.code??"materialization_failed";
   const blocked=new Set(["materialization_project_deleted",
    "materialization_port_mismatch",
    "materialization_identity_conflict","materialization_node_collision",
    "materialization_invalid_id","invalid_comfy_artifact_provenance"]);
   mark(artifact,reason,blocked.has(reason)?"blocked":"retry");
   return {artifactId:artifact.id,status:blocked.has(reason)?"blocked":"retry",reason};
  }
 }
 async function runOnce({maxItems=32}={}){
  if(!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>100)
   throw Error("invalid_materialization_limit");
  const rows=select().slice(0,maxItems),out=[];
  for(const item of rows)out.push(await processArtifact(item));
  return out;
 }
 /** Processes only an already-collected succeeded artifact. No model submit. */
 async function recoverPending({projectId,artifactId}={}){
  if(!validId(projectId)||!validId(artifactId))throw fail("invalid_materialization_reference");
  const row=select({projectId,artifactId})[0];
  if(!row)return false;
  return processArtifact(row);
 }
 function retryBlocked({projectId,artifactId}={}){
  if(!validId(projectId)||!validId(artifactId))throw fail("invalid_materialization_reference");
  // This is ONLY a replay of an already-collected immutable artifact.
  // Never requeue a GPU/remote job. Re-evaluate the current graph for safe
  // links, while preserving immutable origin and CAS validation.
  return writeTransaction(db,()=>{
   const row=db.prepare(`SELECT m.id,m.job_id FROM materializations m
    JOIN jobs j ON j.id=m.job_id
    WHERE m.project_id=? AND m.artifact_id=? AND m.status='blocked'
     AND j.status='succeeded' AND j.project_id=?`)
    .get(projectId,artifactId,projectId);
   if(!row)return false;
   db.prepare("UPDATE materializations SET status='retry',reason=NULL,next_due_at=NULL,fail_count=0 WHERE id=?")
    .run(row.id);
   db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
    .run(row.job_id,"artifact_materialization_requeued",
     stableJson({projectId,artifactId,status:"retry"}),Date.now());
   return true;
  });
 }
 /** One-time startup recovery for the older materializer's too-strict
  * graph/input checks. Only previously completed, frozen CAS artifacts move
  * back to the local *materialization* queue. Never queue a GPU/model job.
  * Conflicts discovered under the current rules can remain blocked.
  */
 function requeueLegacyBlocked(){
  return writeTransaction(db,()=>{
   const rows=db.prepare(`UPDATE materializations SET
    status='retry',reason=NULL,next_due_at=NULL,fail_count=0
    WHERE status='blocked'
      AND reason IN (
       'materialization_source_changed','materialization_source_deleted',
       'materialization_port_mismatch','materialization_link_conflict',
       'materialization_edge_collision'
      )
      AND EXISTS (
       SELECT 1 FROM jobs j JOIN projects p ON p.id=j.project_id
       WHERE j.id=materializations.job_id
         AND j.project_id=materializations.project_id
         AND j.status='succeeded' AND p.deleted_at IS NULL
      )
    RETURNING job_id,artifact_id,project_id`).all();
   const insert=db.prepare(
    "INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)"
   );
   const now=Date.now();
   for(const row of rows)insert.run(row.job_id,"artifact_materialization_requeued",
    stableJson({projectId:row.project_id,artifactId:row.artifact_id,
     status:"retry",reason:"legacy_materialization_policy_updated"}),now);
   return rows.length;
  });
 }
 function status({jobId}={}){
  return jobId?db.prepare("SELECT id,artifact_id,project_id,status,node_id,reason FROM materializations WHERE job_id=? ORDER BY artifact_id").all(jobId):
   db.prepare("SELECT status,COUNT(*) AS count FROM materializations GROUP BY status").all();
 }
 return {runOnce,recoverPending,retryBlocked,requeueLegacyBlocked,status};
}
