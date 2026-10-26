import Fastify from "fastify";
import {randomUUID} from "node:crypto";
import {createProject,getProject,patchProject,deleteProject,listProjectSummaries,projectEventCursor} from "./projects.mjs";
import {getCanvasViewport,putCanvasViewport,getCanvasChats,putCanvasChats} from "./canvas-state.mjs";
import {submitJob,readJobsSnapshot,readEventsAfter} from "./repository.mjs";
import {EXECUTION_MODES} from "./contracts.mjs";
import {CANVAS_NODE_ID_PATTERN} from "../canvas-node-id.mjs";
import {ARCHIVE_MAX_BYTES} from "./project-archive.mjs";
const nonempty={type:"string",minLength:1,maxLength:256};
const idSchema={type:"string",pattern:"^[A-Za-z0-9_-]{1,128}$"};
const canvasNodeIdSchema={type:"string",pattern:CANVAS_NODE_ID_PATTERN};
const documentSchema={type:"object",required:["nodes","connections"],properties:{nodes:{type:"array"},connections:{type:"array"}},additionalProperties:true};
const projectBody={type:"object",required:["document"],properties:{id:idSchema,document:documentSchema},additionalProperties:false};
const editBody={type:"object",required:["expectedRevision","document"],properties:{expectedRevision:{type:"integer",minimum:1},document:documentSchema},additionalProperties:false};
const viewportBody={type:"object",required:["expectedRevision","viewport"],
 properties:{expectedRevision:{type:"integer",minimum:1},viewport:{
  type:"object",required:["x","y","k"],additionalProperties:false,
  properties:{x:{type:"number"},y:{type:"number"},k:{type:"number",exclusiveMinimum:0}}
 }},additionalProperties:false};
const chatsBody={type:"object",required:["expectedRevision","sessions","activeChatId"],
 properties:{expectedRevision:{type:"integer",minimum:1},sessions:{type:"array"},
 activeChatId:{type:["string","null"]}},additionalProperties:false};

const jobBody={type:"object",required:["idempotencyKey","requestFingerprint","executionMode","snapshot"],properties:{
 idempotencyKey:nonempty,requestFingerprint:nonempty,executionMode:{type:"string",enum:[...EXECUTION_MODES]},
 snapshot:{type:"object"},projectId:idSchema,targetNodeId:canvasNodeIdSchema,expectedProjectRevision:{type:"integer",minimum:1},
 sourceNodeFingerprint:nonempty
},additionalProperties:false};

const channelCreateBody={type:"object",required:["provider","displayName","apiKey"],
 properties:{id:idSchema,provider:{type:"string",minLength:1,maxLength:64},
  displayName:{type:"string",minLength:1,maxLength:128},
  apiKey:{type:"string",minLength:1,maxLength:8192}},additionalProperties:false};
const channelRotateBody={type:"object",required:["apiKey","expectedKeyVersion"],
 properties:{apiKey:{type:"string",minLength:1,maxLength:8192},
  expectedKeyVersion:{anyOf:[{type:"string",minLength:1,maxLength:128},{type:"null"}]}},
 additionalProperties:false};
const channelRouteParams={type:"object",required:["id"],properties:{id:idSchema},additionalProperties:false};
const credentialRouteParams={type:"object",required:["id","versionId"],
 properties:{id:idSchema,versionId:{type:"string",minLength:1,maxLength:128}},additionalProperties:false};
function localHost(host){
 try{const u=new URL("http://"+host);return ["127.0.0.1","localhost","[::1]"].includes(u.hostname)&&!u.username&&!u.password}catch{return false}
}
function localRequestError(req){
 if(!localHost(req.headers.host||"localhost"))return "invalid_host";
 if(req.headers["sec-fetch-site"]==="cross-site")return "cross_site_request";
 if(["POST","PATCH","PUT","DELETE"].includes(req.method)){
  if(req.headers.origin){
   try{const origin=new URL(req.headers.origin),own=new URL("http://"+(req.headers.host||"localhost"));
    if(origin.protocol!==own.protocol||origin.host!==own.host)return "cross_site_request";
   }catch{return "cross_site_request"}
  }else if(req.headers.cookie)return "origin_required";
 }
 return null;
}
const jobView=row=>({id:row.id,projectId:row.project_id,targetNodeId:row.target_node_id,status:row.status,executionMode:row.execution_mode,createdAt:row.created_at,updatedAt:row.updated_at,upstreamTaskId:row.upstream_task_id,attemptId:row.attempt_id,submitMarker:row.submit_marker,submissionStartedAt:row.submission_started_at});
const eventView=row=>({eventId:row.seq,jobId:row.job_id,kind:row.kind,timestamp:row.created_at,payload:JSON.parse(row.payload_json)});
function cursorOf(value){
 const v=String(value??"0");
 if(!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(Number(v)))throw Object.assign(Error("invalid_event_cursor"),{statusCode:400,code:"invalid_event_cursor"});
 return Number(v);
}
export function buildApp({db,authorize,sessionAuth,autoLocalSession=false,blobStore,mediaPreview,blobGc,projectArchive,vault,coordinator,materializer,worker,comfyInstanceIds=[],modelKinds=[],logger=false,streamPollMs=200}={}){
 if(!db||(!sessionAuth&&typeof authorize!=="function"))throw Error("backend_authorizer_required");
 const app=Fastify({logger,bodyLimit:5*1024*1024,trustProxy:false,genReqId:()=>randomUUID()});
 if(blobStore)app.addContentTypeParser("application/octet-stream",(req,stream,done)=>done(null,stream));
 if(projectArchive)app.addContentTypeParser("application/zip",(req,stream,done)=>done(null,stream));
 app.addHook("onRequest",async(req,reply)=>{
  const violation=localRequestError(req);
  if(violation){reply.code(403).send({code:violation,message:violation,requestId:req.id});return}
  if(req.url==="/health" || (sessionAuth&&req.url==="/api/v1/session"&&
    (req.method==="POST"||(autoLocalSession&&req.method==="GET"))))return;
  if(!(sessionAuth?sessionAuth.authorize(req):await authorize(req)))
   reply.code(401).send({code:"unauthorized",message:"unauthorized",requestId:req.id});
 });
 app.setErrorHandler((error,req,reply)=>{
  const status=error.statusCode>=400&&error.statusCode<500?error.statusCode:500;
  const publicCodes=new Set(["project_revision_conflict","project_not_found","project_id_conflict","invalid_project_document",
   "invalid_project_id","project_document_too_large","expected_revision_required","invalid_project_reference",
   "invalid_canvas_chats","invalid_canvas_viewport","canvas_chats_too_large",
   "chats_revision_conflict","viewport_revision_conflict",
   "stale_generation_source","cyclic_generation_source","generation_save_barrier_required","invalid_job_request","idempotency_key_conflict",
   "invalid_event_cursor","event_cursor_expired","raw_credentials_forbidden",
   "invalid_bootstrap_token","unsupported_blob_mime","invalid_sha256","blob_quota_exceeded",
   "empty_blob","blob_mime_mismatch","blob_digest_mismatch","blob_identity_conflict",
   "blob_not_found","blob_missing_on_disk","blob_integrity_error","invalid_blob_range",
   "preview_unsupported_mime","preview_transcoder_unavailable","preview_timeout",
   "preview_render_failed","preview_invalid_output","preview_busy",
   "gc_confirmation_required","invalid_gc_limit","gc_upload_in_progress",
   "gc_blob_integrity_error","gc_delete_race",
   "archive_nonportable_media_reference","archive_invalid_manifest",
   "archive_media_manifest_mismatch","archive_size_exceeded","archive_file_limit_exceeded",
   "archive_invalid_entry","archive_invalid_zip","archive_unexpected_files",
   "archive_media_integrity_error","archive_blob_integrity_error",
   "channel_not_found","channel_id_conflict","invalid_channel_config","invalid_credential_value",
   "expected_credential_version_required","credential_version_conflict",
   "credential_reference_required","credential_missing","credential_revoked",
   "credential_protection_unavailable","credential_decryption_failed"]);
  const code=error.validation?"invalid_request":(publicCodes.has(error.code)?error.code:
    (status===400?"invalid_request":"internal_error"));
  // Field names and request lanes are safe to reveal; values and user media
  // are not. Avoid logging or echoing the rejected request body (keys/media).
  const invalidField=error.validation?.[0];
  const saveLane=req.url.match(/^\/api\/v1\/projects\/[^/?]+(?:\/(viewport|chats))?(?:\?.*)?$/);
  const validationDetails=code==="invalid_request"&&invalidField&&saveLane
    ?{lane:saveLane[1]??"graph",
      field:invalidField.instancePath||
       (invalidField.keyword==="required"&&
        /^(expectedRevision|document|nodes|connections|viewport|x|y|k|sessions|activeChatId)$/.test(
         invalidField.params?.missingProperty??"")
        ?"/"+invalidField.params.missingProperty:"/"),
      keyword:invalidField.keyword==="required"?"required":invalidField.keyword==="type"?"type":
       invalidField.keyword==="additionalProperties"?"additionalProperties":
       invalidField.keyword==="minimum"?"minimum":invalidField.keyword==="exclusiveMinimum"?"exclusiveMinimum":"validation"}
    :undefined;
  reply.code(status).send({code,message:code,requestId:req.id,
   ...(validationDetails?{details:validationDetails}:{}),
   ...(["project_revision_conflict","invalid_project_document"].includes(code)&&error.details?{details:error.details}:{})});
 });
 app.get("/health",()=>({ok:true}));
 if(sessionAuth){
  app.post("/api/v1/session",{schema:{body:{type:"object",additionalProperties:false}}},async(req,reply)=>{
   const header=req.headers.authorization;
   const token=typeof header==="string"&&header.startsWith("Bearer ")?header.slice(7):"";
   const result=sessionAuth.exchange(token);
   reply.header("Set-Cookie",sessionAuth.cookie(result.id,{secure:req.protocol==="https"}))
    .header("Cache-Control","no-store").code(201);
   return {csrfToken:result.csrf,expiresAt:result.expiresAt};
  });
  app.get("/api/v1/session",(req,reply)=>{
   let result=sessionAuth.current(req);
   if(!result&&autoLocalSession){
    const site=req.headers["sec-fetch-site"];
    if(site&&site!=="same-origin"&&site!=="none")
     throw Object.assign(Error("cross_site_request"),{statusCode:403});
    const issued=sessionAuth.issueLocalSession();
    reply.header("Set-Cookie",sessionAuth.cookie(issued.id,{secure:req.protocol==="https"}));
    result=issued;
   }
   if(!result)throw Object.assign(Error("unauthorized"),{code:"unauthorized",statusCode:401});
   reply.header("Cache-Control","no-store");
   return {csrfToken:result.csrf,expiresAt:result.expiresAt};
  });
  app.delete("/api/v1/session",(req,reply)=>{
   sessionAuth.revoke(req);
   reply.header("Set-Cookie",sessionAuth.clearCookie({secure:req.protocol==="https"})).code(204);
   return "";
  });
 }
 if(blobStore){
  app.post("/api/v1/blobs",{bodyLimit:blobStore.maxBlobBytes+1},async(req,reply)=>{
   const stored=await blobStore.put(req.body,{mime:req.headers["x-atelier-mime"],
    expectedSha256:req.headers["x-content-sha256"]});
   reply.code(stored.existing?200:201);return stored;
  });
  if(mediaPreview)app.get("/api/v1/blobs/:id/preview",{schema:{params:{
   type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[0-9a-f]{64}$"}}
  }}},async(req,reply)=>{
   const bytes=await mediaPreview.get(req.params.id);
   reply.header("Content-Type","image/png").header("X-Content-Type-Options","nosniff")
    .header("Cache-Control","private, max-age=86400").header("Content-Length",String(bytes.length));
   return reply.send(bytes);
  });
  app.get("/api/v1/blobs/:id",{schema:{params:{type:"object",required:["id"],
   properties:{id:{type:"string",pattern:"^[0-9a-f]{64}$"}}}}},async(req,reply)=>{
   const blob=await blobStore.stat(req.params.id);
   reply.header("Content-Type",blob.mimeType).header("X-Content-Type-Options","nosniff")
    .header("Accept-Ranges","bytes").header("ETag",'"'+blob.sha256+'"')
    .header("Cache-Control","private, max-age=86400");
   let range;
   try{range=blobStore.parseRange(req.headers.range,blob.byteSize)}
   catch(e){if(e.code==="invalid_blob_range")reply.header("Content-Range","bytes */"+blob.byteSize);throw e}
   if(range)reply.code(206).header("Content-Range",`bytes ${range.start}-${range.end}/${blob.byteSize}`);
   const size=range?range.end-range.start+1:blob.byteSize;
   reply.header("Content-Length",String(size));
   if(req.method==="HEAD"){
    reply.hijack();
    reply.raw.writeHead(reply.statusCode,reply.getHeaders());
    reply.raw.end();
    return;
   }
   return reply.send(blobStore.getStream(blob,range??{}));
  });
 }


 if(blobGc)app.post("/api/v1/storage/gc",{schema:{body:{type:"object",
  properties:{dryRun:{type:"boolean"},confirmation:{type:"string"}},additionalProperties:false}
 }},req=>blobGc.sweep(req.body??{}));

 if(vault){
  app.get("/api/v1/channels",(req,reply)=>{
   reply.header("Cache-Control","no-store");return {channels:vault.list()};
  });
  app.post("/api/v1/channels",{schema:{body:channelCreateBody}},async(req,reply)=>{
   const record=vault.create(req.body);reply.header("Cache-Control","no-store").code(201);return record;
  });
  app.get("/api/v1/channels/:id",{schema:{params:channelRouteParams}},async(req,reply)=>{
   reply.header("Cache-Control","no-store");return vault.get(req.params.id);
  });
  app.get("/api/v1/channels/:id/versions",{schema:{params:channelRouteParams}},async(req,reply)=>{
   reply.header("Cache-Control","no-store");return {versions:vault.listVersions(req.params.id)};
  });
  app.patch("/api/v1/channels/:id/credential",{schema:{params:channelRouteParams,body:channelRotateBody}},async(req,reply)=>{
   const record=vault.rotate(req.params.id,req.body);reply.header("Cache-Control","no-store");return record;
  });
  app.post("/api/v1/channels/:id/versions/:versionId/revoke",{
   schema:{params:credentialRouteParams,body:{type:"object",additionalProperties:false}}
  },async(req,reply)=>{
   const record=vault.revoke(req.params.id,req.params.versionId);
   reply.header("Cache-Control","no-store");return record;
  });
 }

 // Project library and its own transactional change cursor (job SSE is separate).
 app.get("/api/v1/projects",()=>({projects:listProjectSummaries(db),eventCursor:projectEventCursor(db)}));
 app.get("/api/v1/projects/events",{schema:{querystring:{type:"object",properties:{
  after:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},once:{type:"string",enum:["1"]}
 },additionalProperties:false}}},async(req,reply)=>{
  const after=cursorOf(req.headers["last-event-id"]??req.query.after??0);
  const latest=projectEventCursor(db);
  const first=db.prepare("SELECT MIN(seq) AS first FROM project_events").get().first;
  if(after>latest)throw Object.assign(Error("invalid_event_cursor"),{code:"invalid_event_cursor",statusCode:400});
  if(first!==null&&after<first-1)throw Object.assign(Error("event_cursor_expired"),{code:"event_cursor_expired",statusCode:409});
  const raw=reply.raw;reply.hijack();
  raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform",
   "Connection":"keep-alive","X-Accel-Buffering":"no"});
  let cursor=after,closed=false;
  const push=()=>{
   if(closed)return;
   let rows;
   do{
    rows=db.prepare("SELECT seq,project_id,revision,kind,created_at FROM project_events WHERE seq>? ORDER BY seq LIMIT 200").all(cursor);
    for(const item of rows){
     const data={eventId:item.seq,projectId:item.project_id,revision:item.revision,
      kind:item.kind,timestamp:item.created_at};
     raw.write("id: "+item.seq+"\nevent: project\ndata: "+JSON.stringify(data)+"\n\n");
     cursor=item.seq;
    }
   }while(rows.length===200&&!closed);
  };
  raw.write(": connected\n\n");push();
  if(req.query.once==="1"){closed=true;raw.end();return}
  const timer=setInterval(()=>{
   if(closed)return;
   if(sessionAuth&&!sessionAuth.authorize(req)){closed=true;raw.end();return}
   try{push();if(!closed)raw.write(": heartbeat\n\n")}catch{closed=true;raw.destroy()}
  },streamPollMs);
  timer.unref?.();raw.on("close",()=>{closed=true;clearInterval(timer)});
 });
 app.post("/api/v1/projects",{schema:{body:projectBody}},async(req,reply)=>{
  const created=createProject(db,req.body);reply.header("ETag",'"'+created.revision+'"').code(201);return created;
 });
 app.get("/api/v1/projects/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}},async(req,reply)=>{
  const project=getProject(db,req.params.id);reply.header("ETag",'"'+project.revision+'"');return project;
 });
 app.patch("/api/v1/projects/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}},body:editBody}},async(req,reply)=>{
  if(req.headers["if-match"]!==undefined&&req.headers["if-match"]!=='"'+req.body.expectedRevision+'"'){
   reply.code(400);return {code:"revision_header_mismatch",message:"revision_header_mismatch",requestId:req.id};
  }
  const project=patchProject(db,{id:req.params.id,...req.body});reply.header("ETag",'"'+project.revision+'"');return project;
 });

 // These independent revisions never increment the graph revision or pollute
 // JobSnapshot source fingerprints; P2 canvas autosave owns them separately.
 const canvasParams={type:"object",required:["id"],properties:{id:idSchema}};
 app.get("/api/v1/projects/:id/viewport",{schema:{params:canvasParams}},req=>getCanvasViewport(db,req.params.id));
 app.put("/api/v1/projects/:id/viewport",{schema:{params:canvasParams,body:viewportBody}},req=>
  putCanvasViewport(db,req.params.id,req.body));
 app.get("/api/v1/projects/:id/chats",{schema:{params:canvasParams}},req=>getCanvasChats(db,req.params.id));
 app.put("/api/v1/projects/:id/chats",{schema:{params:canvasParams,body:chatsBody}},req=>
  putCanvasChats(db,req.params.id,req.body));
 if(projectArchive){
  app.get("/api/v1/projects/:id/archive",{schema:{params:canvasParams}},async(req,reply)=>{
   const archive=await projectArchive.exportProject(req.params.id);
   reply.header("Content-Type","application/zip")
    .header("Content-Disposition",'attachment; filename="'+archive.fileName+'"')
    .header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff");
   return reply.send(archive.stream);
  });
  app.post("/api/v1/projects/import-archive",{bodyLimit:ARCHIVE_MAX_BYTES+1},async(req,reply)=>{
   const imported=await projectArchive.importProject(req.body);
   reply.header("Cache-Control","no-store").code(201);
   return imported;
  });
 }
 app.delete("/api/v1/projects/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}},async(req,reply)=>{
  const result=deleteProject(db,req.params.id);
  reply.header("Cache-Control","no-store");return result;
 });
 app.post("/api/v1/jobs",{schema:{body:jobBody}},async(req,reply)=>{
  // Validation of secretVersionRef occurs inside repository's write transaction,
  // preserving idempotent replies even if a version is later revoked.
  const result=submitJob(db,req.body),row=db.prepare("SELECT * FROM jobs WHERE id=?").get(result.jobId);
  reply.code(result.existing?200:201);return {...jobView(row),existing:result.existing};
 });

 app.get("/api/v1/jobs/:id/attempts",{schema:{params:{type:"object",required:["id"],
  properties:{id:idSchema},additionalProperties:false}}},async(req,reply)=>{
  const job=db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id);
  if(!job){reply.code(404);return {code:"job_not_found",message:"job_not_found",requestId:req.id}}
  const rows=db.prepare("SELECT id,job_id,phase,upstream_task_id,started_at,finished_at,outcome FROM job_attempts WHERE job_id=? ORDER BY started_at,id").all(req.params.id);
  return {attempts:rows.map(row=>({id:row.id,jobId:row.job_id,phase:row.phase,
   upstreamTaskId:row.upstream_task_id,startedAt:row.started_at,finishedAt:row.finished_at,outcome:row.outcome}))};
 });
 if(coordinator)app.get("/api/v1/coordinator/status",()=>coordinator.status());
 if(worker)app.get("/api/v1/worker/status",()=>worker.status());
 app.get("/api/v1/execution/capabilities",()=>({autoDispatch:Boolean(worker),comfyInstanceIds:[...comfyInstanceIds],
  ...(modelKinds.length?{modelKinds:[...modelKinds]}:{})}));
 if(materializer){
  app.get("/api/v1/jobs/:id/materializations",{schema:{params:{type:"object",required:["id"],
   properties:{id:idSchema},additionalProperties:false}}},async(req,reply)=>{
   if(!db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id)){
    reply.code(404);return {code:"job_not_found",message:"job_not_found",requestId:req.id}
   }
   return {materializations:materializer.status({jobId:req.params.id})};
  });
  app.post("/api/v1/projects/:id/materializations/:artifactId/retry",{
   schema:{params:{type:"object",required:["id","artifactId"],
    properties:{id:idSchema,artifactId:idSchema},additionalProperties:false},
    body:{type:"object",additionalProperties:false}}
  },async(req,reply)=>{
   if(!materializer.retryBlocked({projectId:req.params.id,artifactId:req.params.artifactId})){
    reply.code(409);return {code:"materialization_not_blocked",message:"materialization_not_blocked",requestId:req.id}
   }
   return {requeued:true};
  });
 }


 app.get("/api/v1/jobs/:id/artifacts",{schema:{params:{type:"object",required:["id"],
  properties:{id:idSchema},additionalProperties:false}}},async(req,reply)=>{
  const exists=db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id);
  if(!exists){reply.code(404);return{code:"job_not_found",message:"job_not_found",requestId:req.id}}
  const rows=db.prepare("SELECT id,job_id,port_id,item_key,blob_id,kind,mime,sha256,metadata_json FROM artifacts WHERE job_id=? ORDER BY port_id,item_key").all(req.params.id);
  return {artifacts:rows.map(row=>({
   artifactId:row.id,jobId:row.job_id,portId:row.port_id,itemKey:row.item_key,
   blobId:row.blob_id,kind:row.kind,mimeType:row.mime,sha256:row.sha256,
   metadata:JSON.parse(row.metadata_json)
  }))};
 });
 app.get("/api/v1/jobs/snapshot",()=>{
  const {jobs,eventCursor}=readJobsSnapshot(db);return {jobs:jobs.map(jobView),eventCursor};
 });
 app.get("/api/v1/jobs/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}},async(req,reply)=>{
  const row=db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
  if(!row){reply.code(404);return{code:"job_not_found",message:"job_not_found",requestId:req.id}}
  return jobView(row);
 });
 // Replaying committed database events from the last seq on every poll has no subscribe/replay race.
 app.get("/api/v1/events",{schema:{querystring:{type:"object",properties:{
  after:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},once:{type:"string",enum:["1"]}
 },additionalProperties:false}}},async(req,reply)=>{
  const after=cursorOf(req.headers["last-event-id"]??req.query.after??0);
  const {eventCursor}=readJobsSnapshot(db);
  const first=db.prepare("SELECT MIN(seq) AS first FROM job_events").get().first;
  if(after>eventCursor)throw Object.assign(Error("invalid_event_cursor"),{statusCode:400,code:"invalid_event_cursor"});
  if(first!==null&&after<first-1)throw Object.assign(Error("event_cursor_expired"),{statusCode:409,code:"event_cursor_expired"});
  const raw=reply.raw;reply.hijack();
  raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
  let cursor=after,closed=false,pushing=false;
  const push=()=>{
   if(closed||pushing)return;
   pushing=true;
   try{
    let page;
    do{
     page=readEventsAfter(db,cursor,200);
     for(const row of page){
      const event=eventView(row);
      raw.write("id: "+event.eventId+"\nevent: job\ndata: "+JSON.stringify(event)+"\n\n");
      cursor=event.eventId;
     }
    }while(page.length===200&&!closed);
   }catch{closed=true;raw.destroy()}finally{pushing=false}
  };
  raw.write(": connected\n\n");push();
  if(req.query.once==="1"){closed=true;raw.end();return}
  const timer=setInterval(()=>{if(closed)return;if(sessionAuth&&!sessionAuth.authorize(req)){closed=true;raw.end();return}push();if(!closed)raw.write(": heartbeat\n\n")},streamPollMs);
  timer.unref?.();raw.on("close",()=>{closed=true;clearInterval(timer)});
 });
 return app;
}
export async function startServer(app,{host="127.0.0.1",port=0}={}){
 if(!["127.0.0.1","::1"].includes(host))throw Error("loopback_only");
 return app.listen({host,port});
}
export async function stopServer(app){await app.close()}
