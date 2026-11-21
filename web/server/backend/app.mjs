import Fastify from "fastify";
import {randomUUID,createHash} from "node:crypto";
import {resolveAuthorizedSkillScript} from "./skill-script-source.mjs";
import {readTextVersions,mutateTextVersions,readDramaRevisionScope,patchDramaShotDraft} from "./canvas-text-versions.mjs";
import {validateProjectDocument,emitProjectEvent,createProject,getProject,saveSingleUserCanvas,deleteProject,listProjectSummaries,projectEventCursor} from "./projects.mjs";
import {getCanvasViewport,putCanvasViewport,getCanvasChats,putCanvasChats} from "./canvas-state.mjs";
import {registerAssistantTaskRoutes} from "./assistant-task-routes.mjs";
import {getAssistantTask,getAssistantTaskTurnPolicy} from "./assistant-tasks.mjs";
import {beginAssistantModelCommand,createAssistantModelObserver,completeAssistantModelCommand,failAssistantModelCommand} from "./assistant-model-calls.mjs";
import {assertAssistantAgentReadClaim,createAssistantAgentReadSession,createCanvasNodeReader} from "./assistant-agent-read-tools.mjs";
import {agentReadRunId} from "./assistant-agent-run-ledger.mjs";
import {prepareAssistantSemanticProposals} from "./assistant-semantic-proposals.mjs";
import {assistantHistoryQuoteSchema,formatAssistantHistoryQuote,resolveAssistantHistoryQuote} from "./assistant-history-quote.mjs";
import {buildAssistantTaskProviderContext,formatAssistantCanvasContext,formatSelectedCanvasText,loadAssistantTaskCreativeHistory} from "./assistant-task-context.mjs";
import {loadAuthorizedStoryEventRevisionHints} from "./assistant-story-event-context.mjs";
import {trustedAssistantTaskOutputs} from "./assistant-task-produced-artifacts.mjs";
import {submitJob,readJobsSnapshot,readEventsAfter,stableJson} from "./repository.mjs";
import {EXECUTION_MODES} from "./contracts.mjs";
import {CANVAS_NODE_ID_PATTERN} from "../canvas-node-id.mjs";
import {ARCHIVE_MAX_BYTES} from "./project-archive.mjs";
import {createComfyRegistry} from "./comfy-registry.mjs";
import {freezeAuthorizedSkillGrant} from "./skill-job-grants.mjs";
import {resolveAssistantSkills} from "./assistant-skills.mjs";
import {resolveAssistantVisualContext} from "./assistant-visual-context.mjs";
import {resolveMediaCapabilities,supportedMediaModes,supportedMediaParameters,validateMediaRequest} from "../../shared/media-capabilities.mjs";
import {readMediaDurationMs} from "./media-duration.mjs";
import {currentAssistantTextDeliverable,assertAssistantStructuredSourceCurrent} from "./assistant-task-deliverables.mjs";
import {resolveAuthorizedCreativeCharacters,formatAssistantCreativeSources} from "./assistant-creative-context.mjs";
import {hasSelectedAssistantCreativeMaterials,loadSelectedAssistantCreativeMaterials,formatSelectedAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";
import {runSkillScript} from "./skill-script-runner.mjs";
import {getProjectSkillAudit,replayProjectSkillJob,lookupProjectSkillReplay} from "./skill-job-audit.mjs";
import {listProjectJobs,hideProjectJobHistory,closeUnverifiedModelJob} from "./project-job-history.mjs";
import {getAssetCatalog,putAssetCatalog} from "./asset-catalog.mjs";
import {listSkillRegistry,getSkillRegistryPackage,getAuthorizedSkillCatalog,updateSqliteSkill} from "./sqlite-skill-registry.mjs";
import {getUiSetting,putUiSetting} from "./ui-settings.mjs";
import {listScriptAssetReconciliation,reconcileScriptAsset,resumeReconciledVideoJob} from "./script-asset-reconciliation.mjs";
import {registerShotGroupRoutes} from "./shot-group-routes.mjs";
import {validateDramaPipelineSnapshot,buildDramaStagePrompt} from "./drama-pipeline.mjs";
import {createDramaRunService,initDramaRuns} from "./drama-runs.mjs";
import {inspectDramaDependencies} from "./drama-dependencies.mjs";
import {readCreativePayload} from "./creative-payloads.mjs";
import {createAssistantChatStreamLedger} from "./assistant-chat-stream-ledger.mjs";
import {assistantCurrentReferenceData,MAX_ASSISTANT_MESSAGE_BYTES} from "./assistant-chat.mjs";
import {assertConversationTaskTurn,beginConversationRequest,buildConversationMessages,completeConversationRequest,
 completeConversationRequestInTransaction,failConversationRequest,findConversationRequest,listConversationTurns,ordinaryConversationPolicy,removeConversation,
 resolveConversationToolReferences,sanitizeConversationReply,startConversationSubmission} from "./assistant-conversation.mjs";
const nonempty={type:"string",minLength:1,maxLength:256};
const idSchema={type:"string",pattern:"^[A-Za-z0-9_-]{1,128}$"};
const canvasNodeIdSchema={type:"string",pattern:CANVAS_NODE_ID_PATTERN};
const documentSchema={type:"object",required:["nodes","connections"],properties:{nodes:{type:"array"},connections:{type:"array"}},additionalProperties:true};
const projectBody={type:"object",required:["document"],properties:{id:idSchema,document:documentSchema},additionalProperties:false};
const editBody={type:"object",required:["document"],properties:{expectedRevision:{type:"integer",minimum:1},document:documentSchema},additionalProperties:false};
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
 sourceNodeFingerprint:nonempty,skillAuthorizationId:{type:"string",pattern:"^[0-9a-f-]{36}$"}
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
const jobView=row=>{
 const snapshot=JSON.parse(row.snapshot_json);
 return {id:row.id,projectId:row.project_id,targetNodeId:row.target_node_id,
 status:row.status,executionMode:row.execution_mode,createdAt:row.created_at,
 updatedAt:row.updated_at,upstreamTaskId:row.upstream_task_id,
 attemptId:row.attempt_id,submitMarker:row.submit_marker,
 submissionStartedAt:row.submission_started_at,
 // Expose only the task category needed for UI restoration. Never leak a
 // frozen model prompt, media reference, channel ID or credential version.
 ...(snapshot.adapterKind==="model"?{modelKind:snapshot.task?.kind}:{}),
  ...(snapshot.adapterKind==="comfy"?{adapterKind:"comfy"}:{}),
 };
};
const eventView=row=>({eventId:row.seq,jobId:row.job_id,kind:row.kind,timestamp:row.created_at,payload:JSON.parse(row.payload_json)});
function cursorOf(value){
 const v=String(value??"0");
 if(!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(Number(v)))throw Object.assign(Error("invalid_event_cursor"),{statusCode:400,code:"invalid_event_cursor"});
 return Number(v);
}
function defaultAssistantCacheRollout({stage,channelId,model,mode}){
 const flags={prefix:"ATELIER_ASSISTANT_CACHE_PREFIX",batch_history:"ATELIER_ASSISTANT_CACHE_BATCH_HISTORY",
  plain_chat:"ATELIER_ASSISTANT_CACHE_PLAIN_CHAT"};
 const enabled=process.env[flags[stage]]??"1";
 if(enabled!=="1")return false;
 return [["CHANNELS",channelId],["MODELS",model],["MODES",mode]].every(([filter,value])=>{
  const configured=process.env["ATELIER_ASSISTANT_CACHE_"+filter];
  return !configured||configured.split(",").some(item=>item.trim()===value);
 });
}
const promptUsageLog=(event,sample)=>process.stdout.write(JSON.stringify({event,...sample})+"\n");
export function buildApp({db,authorize,sessionAuth,autoLocalSession=false,blobStore,mediaPreview,audioExtraction,blobGc,projectArchive,comfyWorkflowDir,vault,coordinator,materializer,worker,comfyRegistry,comfyLive,comfyInstanceIds=[],modelKinds=[],arkAssetUploadReady=false,
 arkChannelHealth,modelCatalog,mediaDownloader,skillRegistry,onTaskSkillSettled,assistantChat,assistantChatStreamLedger=createAssistantChatStreamLedger(),shotBatches,logger=false,streamPollMs=200,
 assistantCacheRollout=defaultAssistantCacheRollout,
 onAssistantPromptUsage=process.env.ATELIER_ASSISTANT_CACHE_TELEMETRY_LOG==="1"?
  sample=>promptUsageLog("assistant_prompt_usage",sample):null,
 onAssistantPromptTurnUsage=process.env.ATELIER_ASSISTANT_CACHE_TELEMETRY_LOG==="1"?
  sample=>promptUsageLog("assistant_prompt_turn_usage",sample):null}={}){
 if(!db||(!sessionAuth&&typeof authorize!=="function"))throw Error("backend_authorizer_required");
 const app=Fastify({logger,bodyLimit:5*1024*1024,trustProxy:false,genReqId:()=>randomUUID()});
 const assistantStreamControllers=new Map();
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
  const status=error.statusCode>=400&&error.statusCode<600?error.statusCode:500;
  const publicCodes=new Set(["assistant_local_comfy_approval_required","assistant_local_comfy_scope_unsupported","project_revision_conflict","project_not_found","project_id_conflict","invalid_project_document","shot_batch_invalid","shot_batch_not_found","shot_choice_invalid","shot_action_invalid",
   "invalid_project_id","project_document_too_large","expected_revision_required","invalid_project_reference",
   "invalid_canvas_chats","invalid_canvas_viewport","canvas_chats_too_large",
    "assistant_task_invalid","assistant_task_not_found","assistant_task_not_editable","assistant_task_payload_too_large","assistant_task_command_conflict",
     "assistant_task_semantic_invalid","assistant_task_semantic_sensitive_text",
     "assistant_task_semantic_conflict","assistant_task_semantic_not_found","assistant_task_semantic_limit",
     "assistant_semantic_proposal_invalid","assistant_semantic_proposal_not_found",
     "assistant_semantic_proposal_decided","assistant_semantic_proposal_scope_changed",
    "assistant_model_call_in_progress","assistant_model_call_unknown","assistant_model_call_not_active",
    "assistant_conversation_not_found","assistant_conversation_request_conflict","assistant_conversation_busy",
    "assistant_turn_not_found","assistant_context_budget_insufficient",
    "assistant_model_result_too_large","assistant_task_context_invalid","assistant_task_turn_not_found",
    "assistant_creative_content_incomplete",
    "assistant_story_review_invalid","assistant_story_review_invalid_source",
    "assistant_story_review_turn_stale","assistant_story_review_not_revision",
    "assistant_story_review_source_pinned","assistant_story_review_source_missing",
    "assistant_story_review_revision_missing","assistant_story_review_model_unresolved",
    "assistant_story_review_snapshot_stale","assistant_story_review_event_unknown",
    "assistant_story_review_decision_conflict",
    "assistant_story_review_apply_invalid","assistant_story_review_no_candidates",
    "assistant_story_review_decisions_pending","assistant_story_review_revision_requested",
    "assistant_story_review_warnings_unresolved",
    "assistant_story_review_agent_source_missing","assistant_story_review_agent_source_mismatch",
    "assistant_story_review_apply_actions_invalid","assistant_story_review_binding_changed",
    "assistant_step_invalid","assistant_step_not_found","assistant_step_plan_conflict",
    "assistant_step_source_changed","assistant_step_not_preparable","assistant_step_dependency_invalid",
    "assistant_step_dependency_unverified","assistant_step_action_changed","assistant_step_approval_required",
    "assistant_step_ref_conflict","assistant_step_state_conflict","assistant_step_approval_conflict",
    "assistant_step_not_approvable","assistant_step_kind_not_ready","assistant_step_already_claimed",
    "assistant_step_lease_invalid",
    "assistant_canvas_plan_invalid","assistant_canvas_action_unsupported",
    "assistant_canvas_refs_invalid","assistant_canvas_ref_conflict",
    "assistant_canvas_connection_invalid","assistant_canvas_target_invalid",
    "assistant_step_already_planned",
    "assistant_external_invalid","assistant_external_evidence_missing",
    "assistant_task_run_invalid","assistant_task_run_target_invalid",
    "assistant_task_run_not_found","assistant_task_run_not_ready",
    "assistant_task_run_already_planned","assistant_task_run_sequence_active",
    "assistant_task_replan_invalid","assistant_task_replan_blocked",
    "assistant_task_run_input_invalid","assistant_task_run_input_port_invalid",
    "assistant_task_run_input_unavailable","assistant_task_run_input_occupied",
    "assistant_task_run_input_binding_unverified","assistant_task_run_input_not_bound",
    "assistant_task_run_input_selection_invalid","assistant_task_run_input_selection_not_ready",
    "assistant_task_run_input_selection_unverified","assistant_task_run_input_selection_conflict",
    "assistant_task_run_input_selection_required","assistant_task_run_input_selection_invalidated",
    "assistant_task_run_input_selection_overflow",
    "assistant_task_run_branch_invalid","assistant_task_run_branch_not_ready",
    "assistant_task_run_branch_evidence_unverified",
    "assistant_task_run_join_invalid","assistant_task_run_join_not_ready",
    "assistant_task_run_join_evidence_invalidated",
    "assistant_task_run_failure_invalid","assistant_task_run_failure_not_ready",
    "assistant_task_run_failure_evidence_invalidated",
    "assistant_node_parameter_invalid","assistant_node_parameter_not_applicable",
    "assistant_node_parameter_uses_workflow","assistant_node_model_unavailable",
    "assistant_comfy_target_invalid","assistant_comfy_template_unavailable",
    "assistant_comfy_port_invalid","assistant_comfy_param_value_invalid",
    "assistant_comfy_aspect_sync_unavailable",
    "assistant_skill_invalid","assistant_skill_evidence_missing","assistant_skill_outcome_unknown",
    "assistant_external_submission_unknown","assistant_external_artifacts_missing",
    "assistant_external_materialization_blocked","assistant_external_materialization_unknown",
   "chats_revision_conflict","viewport_revision_conflict",
   "text_node_not_found","text_version_not_found","text_version_limit","text_version_backup_required",
   "text_version_invalid_restore","text_version_save_not_allowed","text_version_operation_conflict",
   "invalid_text_versions","legacy_text_versions_reload_required","invalid_text_version_command","drama_draft_invalid",
   "archive_invalid_text_history","archive_text_history_integrity_error",
   "text_version_in_use","archive_invalid_drama_runs","drama_storyboard_not_found","drama_upstream_ambiguous_or_missing",
   "drama_asset_in_use",
   "drama_story_source_mismatch","drama_upstream_unconfirmed","drama_sequence_not_found","drama_shot_not_found",
   "drama_run_not_found","drama_run_id_conflict","drama_candidate_not_ready","drama_candidate_conflict",
   "stale_generation_source","cyclic_generation_source","generation_save_barrier_required","invalid_job_request","idempotency_key_conflict","backend_prior_job_not_terminal","job_not_found","invalid_project_job_history_request","invalid_project_job_history_cursor","project_job_not_found","project_job_not_terminal",
   "unknown_model_close_invalid","unknown_model_close_not_eligible","unknown_model_close_state_changed","reconciliation_invalid_input","reconciliation_not_eligible","reconciliation_provider_unsupported","reconciliation_adapter_unavailable","reconciliation_state_changed","reconciliation_upstream_unavailable","reconciliation_remote_already_linked",
   "script_asset_job_not_found","script_asset_job_not_eligible","script_asset_identity_mismatch",
   "script_asset_reconcile_invalid","script_asset_reconcile_not_eligible",
   "script_asset_reconcile_state_changed","script_asset_remote_id_conflict",
   "script_asset_resume_not_eligible","script_asset_uploads_incomplete",
   "script_asset_chunk_audit_unavailable","video_script_chunk_audit_not_eligible",
   "video_script_chunk_audit_invalid","video_script_chunk_audit_evidence_invalid",
   "video_script_chunk_audit_etag_conflict","video_script_chunk_audit_unsent_conflict",
   "video_script_chunk_audit_state_changed","video_script_chunk_audit_unsupported",
   "script_asset_credential_unavailable","script_asset_source_changed","script_asset_source_busy",
   "ui_setting_invalid","ui_setting_secret_forbidden","ui_setting_too_large","ui_setting_not_found",
   "ui_setting_revision_required","ui_setting_revision_conflict",
   "asset_catalog_invalid","asset_catalog_too_large","asset_catalog_media_not_portable",
   "asset_catalog_blob_missing","asset_catalog_media_mismatch","asset_catalog_revision_required","asset_catalog_revision_conflict",
   "invalid_event_cursor","event_cursor_expired","raw_credentials_forbidden",
   "invalid_bootstrap_token","unsupported_blob_mime","invalid_sha256","blob_quota_exceeded",
   "empty_blob","blob_mime_mismatch","blob_digest_mismatch","blob_identity_conflict",
   "blob_not_found","blob_missing_on_disk","blob_integrity_error","invalid_blob_range",
   "preview_unsupported_mime","preview_transcoder_unavailable","preview_timeout",
   "preview_render_failed","preview_invalid_output","preview_busy",
   "audio_extraction_cancelled","audio_extraction_source_invalid","audio_extraction_no_audio",
   "audio_extraction_tool_unavailable","audio_extraction_failed","audio_extraction_timeout",
   "audio_extraction_quota_exceeded","audio_extraction_busy",
   "gc_confirmation_required","invalid_gc_limit","gc_upload_in_progress",
   "gc_blob_integrity_error","gc_delete_race",
   "archive_nonportable_media_reference","archive_invalid_manifest",
   "archive_media_manifest_mismatch","archive_size_exceeded","archive_file_limit_exceeded",
   "archive_invalid_entry","archive_invalid_zip","archive_unexpected_files",
   "archive_media_integrity_error","archive_blob_integrity_error","archive_template_missing",
   "channel_not_found","channel_id_conflict","invalid_channel_config","invalid_credential_value",
   "model_catalog_key_missing","model_catalog_provider_invalid","model_catalog_origin_invalid",
   "model_catalog_upstream_unavailable","model_catalog_upstream_rejected",
   "model_catalog_unauthorized","model_catalog_timeout","model_catalog_dns_blocked",
   "media_capability_invalid","media_reference_duration_unverified","media_reference_mime_mismatch",
   "model_catalog_response_invalid",
   "ark_channel_provider_invalid","ark_channel_key_missing",
   "upstream_url_invalid","upstream_destination_forbidden","upstream_dns_unavailable",
   "upstream_dns_destination_forbidden","MEDIA_URL_EXPIRED","MEDIA_DOWNLOAD_FAILED",
   "MEDIA_NOT_MEDIA","media_download_too_large","media_download_mime_unsupported",
   "media_download_timeout","media_download_unavailable",
   "expected_credential_version_required","credential_version_conflict",
   "credential_reference_required","credential_missing","credential_revoked",
   "comfy_template_invalid","comfy_template_too_large","comfy_template_revision_mismatch",
   "comfy_template_immutable_conflict","comfy_template_not_found","comfy_template_in_use","comfy_template_restore_conflict",
   "comfy_preset_invalid","comfy_preset_not_found",
   "comfy_preset_parent_not_found","comfy_preset_parent_workflow_mismatch","comfy_preset_binding_mismatch","comfy_workflow_version_not_found","comfy_workflow_file_missing","comfy_workflow_file_corrupt",
   "invalid_comfy_instance","invalid_comfy_instance_url","comfy_instance_must_be_exact_loopback_origin",
   "comfy_instance_not_found","comfy_instance_conflict","comfy_instance_limit_reached",
   "comfy_instance_has_pending_jobs","invalid_comfy_instances",
   "comfy_object_info_invalid",
   "skill_freeze_unavailable","skill_freeze_integrity_failed","skill_grant_required","skill_grant_invalid",
   "skill_grant_gc_invalid","skill_replay_identity_mismatch",
   "skill_grant_already_used","skill_grant_expired","skill_grant_stale","skill_grant_not_applicable",
   "skill_authorization_invalid","skill_project_not_found",
   "skill_authorization_changed","skill_snapshot_limit_exceeded",
   "skill_revision_required","skill_revision_conflict","skill_scan_required","skill_scan_unavailable","skill_directory_name_mismatch","skill_directory_invalid","skill_path_unsafe","skill_missing_manifest","skill_directory_must_be_absolute","skill_registry_corrupt",
   "skill_package_integrity_failed",
   "skill_package_invalid","skill_package_too_large","skill_catalog_full","skill_version_conflict",
   "skill_versions_full","skill_update_invalid","skill_not_found","skill_version_not_found",
   "credential_protection_unavailable","credential_decryption_failed",
   "skill_job_invalid_request","skill_job_not_found","skill_job_not_supported",
   "skill_replay_source_not_succeeded","skill_replay_invalid_request","skill_replay_source_changed"]);
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
   ...(code==="comfy_template_in_use"&&error.references?{details:{templateId:error.templateId,revision:error.revision,references:error.references}}:{}),
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
 if(mediaDownloader)app.post("/api/v1/media/download",{
  bodyLimit:8192,
  schema:{body:{type:"object",required:["url"],
   properties:{url:{type:"string",minLength:1,maxLength:4096}},additionalProperties:false}}
 },async(req,reply)=>{
  const stored=await mediaDownloader.importUrl(req.body.url);
  reply.header("Cache-Control","no-store").code(stored.existing?200:201);
  return stored;
 });
 if(audioExtraction){
  app.addHook("preClose",async()=>audioExtraction.close());
  app.post("/api/v1/projects/:projectId/media/extract-audio",{
   bodyLimit:4096,
   schema:{params:{type:"object",required:["projectId"],properties:{projectId:idSchema},additionalProperties:false},
    body:{type:"object",required:["sourceNodeId","sourceBlobId"],additionalProperties:false,
     properties:{sourceNodeId:canvasNodeIdSchema,sourceBlobId:{type:"string",pattern:"^[a-f0-9]{64}$"}}}}
  },async(req,reply)=>{
   const {sourceNodeId,sourceBlobId}=req.body;
   const validate=()=>{
    const project=getProject(db,req.params.projectId);
    const node=project.document.nodes.find(node=>node.id===sourceNodeId);
    if(!node||node.type!=="video"||node.metadata?.storageKey!=="cas:"+sourceBlobId||
     node.metadata?.content!=="/api/v1/blobs/"+sourceBlobId)
     throw Object.assign(Error("audio_extraction_source_invalid"),{code:"audio_extraction_source_invalid",statusCode:409});
   };
   validate();
   // This request includes queue wait plus a bounded ten-minute conversion.
   req.raw.socket?.setTimeout?.(0);
   const controller=new AbortController();
   const abort=()=>{if(!reply.raw.writableFinished)controller.abort()};
   reply.raw.on("close",abort);
   req.raw.on("aborted",abort);
   try{
    const result=await audioExtraction.extract(sourceBlobId,{signal:controller.signal,validate});
    reply.header("Cache-Control","no-store");return result;
   }finally{reply.raw.off("close",abort);req.raw.off("aborted",abort)}
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
  if(modelCatalog)app.post("/api/v1/channels/:id/models",{
   schema:{params:channelRouteParams,body:{type:"object",required:["baseUrl"],
    properties:{baseUrl:{type:"string",minLength:8,maxLength:1024}},additionalProperties:false}}
  },async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return modelCatalog({channelId:req.params.id,endpointBaseUrl:req.body.baseUrl});
  });
  if(arkChannelHealth)app.get("/api/v1/channels/:id/health",{
   schema:{params:channelRouteParams}
  },async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return arkChannelHealth(req.params.id);
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

 const registry=createComfyRegistry(db,{workflowsDir:comfyWorkflowDir});
 const registryParams={type:"object",required:["id","revision"],
  properties:{id:{type:"string",minLength:1,maxLength:128},revision:{type:"string",pattern:"^[a-f0-9]{64}$"}},
  additionalProperties:false};
 const presetParams={type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"}},additionalProperties:false};
 app.get("/api/v1/comfy/templates",(req,reply)=>{
  reply.header("Cache-Control","no-store");return {templates:registry.listTemplates()};
 });
 app.get("/api/v1/comfy/workflows",(req,reply)=>{
  reply.header("Cache-Control","no-store");return {workflows:registry.listWorkflows()};
 });
 app.get("/api/v1/comfy/workflows/:id/versions",{schema:{params:{type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return {versions:registry.listTemplateVersions(req.params.id)};
 });
 app.post("/api/v1/comfy/workflows/:id/graphs",{bodyLimit:2*1024*1024+4096,
  schema:{params:{type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"}},additionalProperties:false},body:{type:"object",required:["graph"],properties:{graph:{type:"object"}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.publishWorkflowGraph(req.params.id,req.body.graph);
 });
 app.get("/api/v1/comfy/workflows/:id/graphs/:hash",{schema:{params:{type:"object",required:["id","hash"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"},hash:{type:"string",pattern:"^[a-f0-9]{64}$"}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return {available:registry.workflowGraphAvailable(req.params.id,req.params.hash)};
 });
 app.post("/api/v1/comfy/workflows/:id/versions",{bodyLimit:2*1024*1024+4096,
  schema:{params:{type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"}},additionalProperties:false},body:{type:"object",required:["template"],properties:{template:{type:"object"}},additionalProperties:false}}},(req,reply)=>{
  if(req.body.template.id!==req.params.id)throw Object.assign(Error("comfy_workflow_id_mismatch"),{code:"comfy_workflow_id_mismatch",statusCode:400});
  const result=registry.installMany([req.body.template])[0];reply.header("Cache-Control","no-store").code(result.status==="installed"?201:200);return result;
 });
 app.get("/api/v1/comfy/workflows/:id/versions/:revision",{schema:{params:registryParams}},(req,reply)=>{
  const template=registry.find(req.params.id,req.params.revision);
  if(!template){reply.code(404);return {code:"comfy_template_not_found"}}
  reply.header("Cache-Control","no-store");return {template};
 });
 app.get("/api/v1/comfy/templates/:id/:revision",{schema:{params:registryParams}},(req,reply)=>{
  const template=registry.find(req.params.id,req.params.revision);
  if(!template){reply.code(404);return {code:"comfy_template_not_found"}}
  reply.header("Cache-Control","no-store");return {template};
 });
 app.post("/api/v1/comfy/templates/batch",{bodyLimit:5*1024*1024,
  schema:{body:{type:"object",required:["templates"],
   properties:{templates:{type:"array",maxItems:128}},additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return {results:registry.installMany(req.body.templates)};
 });
 app.post("/api/v1/comfy/templates",{bodyLimit:2*1024*1024+4096,
  schema:{body:{type:"object",required:["template"],properties:{template:{type:"object"}},additionalProperties:false}}
 },(req,reply)=>{
  const result=registry.installMany([req.body.template])[0];
  reply.header("Cache-Control","no-store").code(result.status==="installed"?201:200);
  return result;
 });
 app.delete("/api/v1/comfy/templates/:id/:revision",{schema:{params:registryParams}},(req,reply)=>
  registry.deleteTemplate(req.params.id,req.params.revision));
 app.get("/api/v1/comfy/templates/:id/:revision/note",{schema:{params:registryParams}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.getVersionNote(req.params.id,req.params.revision);
 });
 app.put("/api/v1/comfy/templates/:id/:revision/note",{schema:{params:registryParams,body:{type:"object",required:["note"],properties:{note:{type:"string",maxLength:200}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.setVersionNote(req.params.id,req.params.revision,req.body.note);
 });
 app.get("/api/v1/comfy/templates/:id/:revision/references",{schema:{params:registryParams}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return {references:registry.templateReferences(req.params.id,req.params.revision)};
 });
 app.post("/api/v1/comfy/presets/:id/restore",{schema:{params:presetParams,body:{type:"object",required:["templateId","revision","expectedTemplateId","expectedRevision"],properties:{templateId:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"},revision:{type:"string",pattern:"^[a-f0-9]{64}$"},expectedTemplateId:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"},expectedRevision:{type:"string",pattern:"^[a-f0-9]{64}$"}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.restorePresetVersion(req.params.id,req.body);
 });
 app.post("/api/v1/comfy/templates/delete-batch",{schema:{body:{type:"object",required:["versions"],properties:{versions:{type:"array",minItems:1,maxItems:128,items:{type:"object",required:["templateId","revision"],properties:{templateId:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"},revision:{type:"string",pattern:"^[a-f0-9]{64}$"}},additionalProperties:false}}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.deleteTemplates(req.body.versions);
 });
 app.get("/api/v1/comfy/presets",(req,reply)=>{
  reply.header("Cache-Control","no-store");return {presets:registry.listPresets()};
 });
 app.put("/api/v1/comfy/templates/:id/name",{schema:{params:{type:"object",required:["id"],properties:{id:{type:"string",pattern:"^[A-Za-z0-9_:.-]{1,128}$"}},additionalProperties:false},body:{type:"object",required:["name"],properties:{name:{type:"string",minLength:1,maxLength:160}},additionalProperties:false}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return registry.renameTemplate(req.params.id,req.body.name);
 });
 app.put("/api/v1/comfy/presets/:id/bind",{bodyLimit:2*1024*1024+8192,
  schema:{params:presetParams,body:{type:"object",required:["preset","workflowHash","binding"],properties:{
   preset:{type:"object",required:["id","name","templateId","revision"],properties:{id:{type:"string"},name:{type:"string"},workflowId:{type:"string"},templateId:{type:"string"},revision:{type:"string"},source:{type:"string"},kind:{type:"string"},parentId:{type:"string"}},additionalProperties:false},
   workflowHash:{type:"string",pattern:"^[a-f0-9]{64}$"},binding:{type:"object"}},additionalProperties:false}}},(req,reply)=>{
  if(req.params.id!==req.body.preset.id)throw Object.assign(Error("comfy_preset_invalid"),{code:"comfy_preset_invalid",statusCode:400});
  reply.header("Cache-Control","no-store");return registry.savePresetBinding(req.body.preset,req.body.workflowHash,req.body.binding);
 });
 app.put("/api/v1/comfy/presets/:id",{schema:{params:presetParams,
  body:{type:"object",required:["id","name","templateId","revision"],
   properties:{id:{type:"string"},name:{type:"string"},workflowId:{type:"string"},templateId:{type:"string"},revision:{type:"string"},source:{type:"string"},kind:{type:"string"},parentId:{type:"string"}},
   additionalProperties:false}}},(req,reply)=>{
  if(req.params.id!==req.body.id)throw Object.assign(Error("comfy_preset_invalid"),{code:"comfy_preset_invalid",statusCode:400});
  reply.header("Cache-Control","no-store");return registry.savePreset(req.body);
 });
 app.delete("/api/v1/comfy/presets/:id",{schema:{params:presetParams}},(req,reply)=>
  registry.deletePreset(req.params.id));
 // P5.4b: Non-secret user preferences. Credential values are prohibited.
 const settingParams={type:"object",required:["name"],
  properties:{name:{type:"string",enum:["theme","model_config"]}},additionalProperties:false};
 app.get("/api/v1/ui-settings/:name",{schema:{params:settingParams}},(req,reply)=>{
  reply.header("Cache-Control","no-store");return getUiSetting(db,req.params.name);
 });
 app.put("/api/v1/ui-settings/:name",{bodyLimit:256*1024,
  schema:{params:settingParams,body:{type:"object",required:["expectedRevision","value"],
   additionalProperties:false,properties:{expectedRevision:{type:"integer",minimum:1},value:{}}}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return putUiSetting(db,req.params.name,req.body);
 });
  // Filesystem Skill registry in the production local backend.
  app.get("/api/v1/skills/config",(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return {storage:"filesystem",directory:skillRegistry?.root??null};
  });
  app.post("/api/v1/skills/scan",{bodyLimit:8192,
   schema:{body:{type:"object",required:["expectedRevision"],additionalProperties:false,
    properties:{expectedRevision:{type:"integer",minimum:1}}}}
  },(req,reply)=>{
   reply.header("Cache-Control","no-store");
   if(!skillRegistry)throw Object.assign(Error("skill_scan_unavailable"),{code:"skill_scan_unavailable",statusCode:503});
   return skillRegistry.scan(req.body.expectedRevision);
  });
 const skillId={type:"string",pattern:"^[a-z0-9]+(?:-[a-z0-9]+)*$",maxLength:80};
 const skillVersion={type:"string",pattern:"^[a-f0-9]{12}$"};
 const skillParams={type:"object",required:["id"],properties:{id:skillId},additionalProperties:false};
 app.get("/api/v1/skills",(req,reply)=>{
  reply.header("Cache-Control","no-store");return skillRegistry?skillRegistry.list():listSkillRegistry(db);
 });
 app.get("/api/v1/skills/:id/:version",{
  schema:{params:{type:"object",required:["id","version"],
   properties:{id:skillId,version:skillVersion},additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");return skillRegistry?skillRegistry.get(req.params.id,req.params.version):getSkillRegistryPackage(db,req.params.id,req.params.version);
 });
 app.post("/api/v1/skills/execute",{bodyLimit:1024*1024,schema:{body:{type:"object",required:["skill_id","version","project_id"],properties:{
  skill_id:skillId,version:skillVersion,project_id:idSchema,script_path:{type:"string",maxLength:240},entry_id:{type:"string",maxLength:64},
  runtime:{type:"string",maxLength:260},args:{type:"array",maxItems:64,items:{type:"string",maxLength:8192}},
  input_files:{type:"object",maxProperties:32,additionalProperties:{type:"string",maxLength:262144}},
  output_files:{type:"array",maxItems:32,items:{type:"string",maxLength:240}}
 },additionalProperties:false}}},async(req,reply)=>{
  reply.header("Cache-Control","no-store");
   const {skill_id,version,project_id}=req.body;
   const {scriptPath:selectedPath,source,packageFiles}=resolveAuthorizedSkillScript(
    db,skillRegistry,req.body);  const runId=randomUUID(),now=Date.now();
  db.prepare("INSERT INTO skill_script_runs(id,project_id,skill_id,version,status,result_json,blob_refs_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
   .run(runId,project_id,skill_id,version,"started","{}","[]",now,now);
  const controller=new AbortController(),onAbort=()=>controller.abort(),onClose=()=>{if(!reply.raw.writableEnded)controller.abort()};
  req.raw.once("aborted",onAbort);reply.raw.once("close",onClose);
  try{
   const result=await runSkillScript({skillId:skill_id,version,scriptPath:selectedPath,source,packageFiles,
    args:req.body.args??[],inputFiles:req.body.input_files??{},outputFiles:req.body.output_files??[],runtime:req.body.runtime,blobStore,signal:controller.signal});
   const refs=[...Object.values(result.log_blobs??{}),...(result.artifacts??[]).map(item=>item.blob_id)];
   db.prepare("UPDATE skill_script_runs SET status=?,result_json=?,blob_refs_json=?,updated_at=? WHERE id=?")
    .run(result.status,JSON.stringify({...result,run_id:runId}),JSON.stringify(refs),Date.now(),runId);
   return {...result,run_id:runId};
  }catch(error){
   db.prepare("UPDATE skill_script_runs SET status=?,result_json=?,updated_at=? WHERE id=?")
    .run(error.code??"failed",JSON.stringify({error:error.code??"skill_script_failed",message:error.message,run_id:runId}),Date.now(),runId);
   throw error;
  }
  finally{req.raw.removeListener("aborted",onAbort);reply.raw.removeListener("close",onClose);}
 });
 app.get("/api/v1/skills/runs/:id",{schema:{params:{type:"object",required:["id"],properties:{id:{type:"string",format:"uuid"}},additionalProperties:false}}},(req,reply)=>{
  const run=db.prepare("SELECT id,project_id,skill_id,version,status,result_json,created_at,updated_at FROM skill_script_runs WHERE id=?").get(req.params.id);
  if(!run)throw Object.assign(Error("skill_script_run_not_found"),{code:"skill_script_run_not_found",statusCode:404});
  reply.header("Cache-Control","no-store");return {...run,result:JSON.parse(run.result_json)};
 });
 app.post("/api/v1/skills/authorized-catalog",{bodyLimit:32*1024,
  schema:{body:{type:"object",required:["projectId","expectedRevision","skillIds","versionPins"],
   properties:{
    projectId:idSchema,expectedRevision:{type:"integer",minimum:1},
    skillIds:{type:"array",minItems:1,maxItems:100,items:skillId},
    versionPins:{type:"object",additionalProperties:skillVersion}
   },additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return skillRegistry?skillRegistry.authorized(db,req.body):getAuthorizedSkillCatalog(db,req.body);
 });
 app.post("/api/v1/skills/freeze",{bodyLimit:32*1024,
  schema:{body:{type:"object",required:["projectId","expectedRevision","skillIds","versionPins"],
   properties:{
    projectId:idSchema,expectedRevision:{type:"integer",minimum:1},
    skillIds:{type:"array",minItems:1,maxItems:100,items:skillId},
    versionPins:{type:"object",additionalProperties:skillVersion}
   },additionalProperties:false}}
 },async(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return freezeAuthorizedSkillGrant(db,blobStore,req.body);
 });
 app.patch("/api/v1/skills/:id",{
  schema:{params:skillParams,body:{type:"object",required:["action","expectedRevision"],properties:{
   expectedRevision:{type:"integer",minimum:1},
   action:{type:"string",enum:["enabled","scope","activate"]},enabled:{type:"boolean"},
   scope:{type:"object"},version:skillVersion},additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return {entry:skillRegistry?skillRegistry.update(req.params.id,req.body):updateSqliteSkill(db,req.params.id,req.body)};
 });
 // Non-Canvas Asset Library metadata is now backed by the same SQLite snapshot
 // and immutable BlobStore as the Canvas. All writes are revision fenced.
 const assetCatalogBody={type:"object",required:["expectedRevision","assets"],additionalProperties:false,
  properties:{expectedRevision:{type:"integer",minimum:1},assets:{type:"array",maxItems:5000}}};
 app.get("/api/v1/assets",(req,reply)=>{
  reply.header("Cache-Control","no-store");return getAssetCatalog(db);
 });
 app.put("/api/v1/assets",{bodyLimit:3*1024*1024,
  schema:{body:assetCatalogBody}},(req,reply)=>{
  const result=putAssetCatalog(db,req.body);
  reply.header("Cache-Control","no-store");return result;
 });
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
  const project=getProject(db,req.params.id,{compact:req.query.creative==="summary"});reply.header("ETag",'"'+project.revision+'"');return project;
 });
 app.patch("/api/v1/projects/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}},body:editBody}},async(req,reply)=>{
  const project=saveSingleUserCanvas(db,{id:req.params.id,...req.body});reply.header("ETag",'"'+project.revision+'"');
  return req.query.creative==="summary"?getProject(db,req.params.id,{compact:true}):project;
 });
 const versionPath="/api/v1/projects/:id/nodes/:nodeId/text-versions";
 app.get(versionPath,req=>readTextVersions(db,req.params.id,req.params.nodeId));
 app.get(versionPath+"/:versionId",req=>readTextVersions(db,req.params.id,req.params.nodeId,req.params.versionId));
 app.post(versionPath,{schema:{body:{type:"object",required:["operationId","action"],additionalProperties:false,properties:{
  operationId:idSchema,action:{enum:["save","delete","restore","confirm"]},
  expectedRevision:{type:"integer",minimum:1},versionId:{type:"string",minLength:1,maxLength:128},
  mode:{enum:["direct","backup","overwrite"]},note:{type:"string",maxLength:100}
 }}}},req=>{
  const {action,versionId,mode}=req.body;
  if((["delete","restore"].includes(action)&&!versionId)||(action==="restore"&&!mode))
   return Promise.reject(Object.assign(Error("invalid_text_version_command"),{code:"invalid_text_version_command",statusCode:400}));
  return mutateTextVersions(db,req.params.id,req.params.nodeId,req.body,validateProjectDocument,emitProjectEvent);
 });
 // Pure preflight for the drama pipeline. The canvas keeps the editable draft
 // in its document, while this endpoint gives every client the same reference
 // and render-readiness rules before submitting an image job.
 app.post("/api/v1/projects/:id/drama-pipeline/validate",{schema:{
  params:{type:"object",required:["id"],additionalProperties:false,properties:{id:idSchema}},
  body:{type:"object",required:["snapshot"],additionalProperties:false,
   properties:{snapshot:{type:"object",additionalProperties:true}}}
 }},async(req,reply)=>{
  getProject(db,req.params.id);
  try{return validateDramaPipelineSnapshot(req.body.snapshot)}
  catch(error){
   const status=Number(error?.statusCode)||400;
   return reply.code(status).send({valid:false,errors:[{code:error?.code||"drama_pipeline_snapshot_invalid"}]});
  }
 });
 initDramaRuns(db);
 const dramaRuns=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(config,input,baseline,signal,repair){
   if(!assistantChat)throw Object.assign(Error("assistant_unavailable"),{code:"assistant_unavailable"});
   const stage=input.stage==="episodes"?"episodes":"storyboard";
   const context=JSON.stringify({episode:input.episode,scope:input.scope,assets:input.assets,
    ...(stage==="episodes"?{existingEpisodes:baseline}:{existingShots:baseline}),
    sourceParagraphs:input.paragraphs,artDirection:input.artDirection,visualStyle:input.visualStyle});
   const prompt=buildDramaStagePrompt({stage,targetEpisodes:input.targetEpisodes,sourceText:input.story,sourceParagraphs:input.paragraphs,context})+
    (stage==="episodes"?"\n输出 episodes。scope.episodeId 非 * 时仅重写该集，保留该集 ID、场次 ID 和原文范围，不改写其他集。":
    "\n只输出 episode.id 指定集的镜头。scope.sequenceId 存在时只输出该场并为每镜复用该 ID。scope.shotId 存在时只输出该镜头。所有角色造型、场景和道具 ID 都必须来自已确认 assets；不得把原文出现但未登记的道具编造成 propIds/keyPropIds，若无合法道具则这两个数组均为 []。");
   const messages=[{role:"user",content:prompt}];
   if(repair){
    messages.push({role:"assistant",content:repair.response});
    messages.push({role:"user",content:`上一次输出未通过结构或引用校验。${repair.reason??""}\n只修复必要的字段和非法引用；保留合法 ID 与文本，不要加入新剧情或未确认资产。输出应符合先前给定的 ${stage==="episodes"?"episodes":"shots"} Schema。`});
   }
   const result=await assistantChat({...config,signal,messages,canvasActions:false,
    semanticCanvasIntent:false,skillContext:"",skillTools:[],selectedCanvasText:"",taskContext:"",plainCanvasChat:true});
   return result.answer;
  }});
 const dramaRunPath="/api/v1/projects/:id/drama-pipeline/runs";
 app.get("/api/v1/projects/:id/drama-pipeline/payload",{schema:{querystring:{type:"object",required:["nodeId"],
  properties:{nodeId:canvasNodeIdSchema}}}},req=>{
   const payload=readCreativePayload(db,req.params.id,req.query.nodeId);
   if(!payload)throw Object.assign(Error("text_node_not_found"),{code:"text_node_not_found",statusCode:404});
   return payload;
  });
 app.get("/api/v1/projects/:id/drama-pipeline/revision-scope",{schema:{querystring:{type:"object",additionalProperties:false,
  required:["nodeId"],properties:{nodeId:canvasNodeIdSchema,versionId:{type:"string",maxLength:128},
   episodeId:{type:"string",maxLength:128},sequenceId:{type:"string",maxLength:128},
   offset:{type:"integer",minimum:0,default:0},limit:{type:"integer",minimum:1,maximum:100,default:50},summaryOnly:{type:"boolean",default:false},draft:{type:"boolean",default:false}}}}},
  req=>readDramaRevisionScope(db,req.params.id,req.query.nodeId,req.query));
 app.patch("/api/v1/projects/:id/drama-pipeline/shot-draft",{schema:{body:{type:"object",additionalProperties:false,
  required:["nodeId","shotId","operationId","expectedDigest","changes"],properties:{nodeId:canvasNodeIdSchema,
   shotId:{type:"string",minLength:1,maxLength:128},operationId:idSchema,expectedDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
   changes:{type:"object",minProperties:1,additionalProperties:false,properties:{description:{type:"string",maxLength:20000},
    camera:{type:"string",maxLength:2000},shotSize:{type:"string",maxLength:256},action:{type:"string",maxLength:20000},
    dialogue:{type:"string",maxLength:20000},durationSec:{type:["number","null"],exclusiveMinimum:0},
    sceneId:{type:["string","null"],maxLength:128},sceneVariantId:{type:["string","null"],maxLength:128},
    sourceRefs:{type:"array",maxItems:64,items:{type:"string",maxLength:256}},
    characterVariantIds:{type:"array",uniqueItems:true,maxItems:64,items:{type:"string",maxLength:128}},
    propIds:{type:"array",uniqueItems:true,maxItems:64,items:{type:"string",maxLength:128}},
    keyPropIds:{type:"array",uniqueItems:true,maxItems:64,items:{type:"string",maxLength:128}}}}}}}},req=>{
   const {nodeId,...command}=req.body;
   patchDramaShotDraft(db,req.params.id,nodeId,command,validateProjectDocument,emitProjectEvent);
   return getProject(db,req.params.id,{compact:true});
  });
 app.get("/api/v1/projects/:id/drama-pipeline/dependencies",{schema:{querystring:{
  type:"object",required:["nodeId"],properties:{nodeId:canvasNodeIdSchema}}}},
  req=>inspectDramaDependencies(getProject(db,req.params.id).document,req.query.nodeId));
 app.post(dramaRunPath,{schema:{body:{type:"object",additionalProperties:false,
  required:["requestId","nodeId","episodeId","channelId","provider","model"],
  properties:{requestId:idSchema,nodeId:canvasNodeIdSchema,episodeId:{type:"string",minLength:1,maxLength:128},
   sequenceId:{type:"string",minLength:1,maxLength:128},shotId:{type:"string",minLength:1,maxLength:128},
   channelId:idSchema,provider:{enum:["openai","openai_compatible","google_gemini"]},
   baseUrl:{type:"string",maxLength:1024},model:{type:"string",minLength:1,maxLength:128}}}}},req=>dramaRuns.submit(req.params.id,req.body));
 app.get(dramaRunPath,{schema:{querystring:{type:"object",required:["nodeId"],properties:{nodeId:canvasNodeIdSchema}}}},
  req=>dramaRuns.list(req.params.id,req.query.nodeId));
 app.get(`${dramaRunPath}/:runId`,req=>dramaRuns.get(req.params.id,req.params.runId));
 app.post(`${dramaRunPath}/:runId/adopt`,{schema:{body:{type:"object",additionalProperties:false,
  properties:{shotIds:{type:"array",minItems:1,maxItems:500,uniqueItems:true,items:{type:"string",minLength:1,maxLength:128}}}}}},
  req=>dramaRuns.adopt(req.params.id,req.params.runId,req.body?.shotIds));
 app.post(`${dramaRunPath}/:runId/cancel`,req=>dramaRuns.cancel(req.params.id,req.params.runId));
 app.post(`${dramaRunPath}/:runId/retry`,req=>dramaRuns.retry(req.params.id,req.params.runId));

 app.post("/api/v1/projects/:id/drama-pipeline/generate",{schema:{
  params:{type:"object",required:["id"],additionalProperties:false,properties:{id:idSchema}},
  body:{type:"object",required:["stage","channelId","provider","model"],additionalProperties:false,
   properties:{stage:{type:"string",enum:["assets","episodes","storyboard"]},channelId:idSchema,
    provider:{type:"string",enum:["openai","openai_compatible","google_gemini"]},
    baseUrl:{type:"string",maxLength:1024},model:{type:"string",minLength:1,maxLength:128},
    sourceText:{type:"string",maxLength:98304},context:{type:"string",maxLength:48000},
    targetEpisodes:{type:"integer",minimum:1,maximum:100}}}
 }},async(req,reply)=>{
  getProject(db,req.params.id);
  if(!assistantChat)return reply.code(503).send({code:"assistant_unavailable"});
  try{
   const prompt=buildDramaStagePrompt(req.body);
   const result=await assistantChat({channelId:req.body.channelId,provider:req.body.provider,
    baseUrl:req.body.baseUrl,model:req.body.model,messages:[{role:"user",content:prompt}],
    canvasActions:false,semanticCanvasIntent:false,skillContext:"",skillTools:[],
    selectedCanvasText:"",taskContext:"",plainCanvasChat:true});
   reply.header("Cache-Control","no-store");
   return {stage:req.body.stage,answer:result.answer};
  }catch(error){
   const status=Number(error?.statusCode)||400;
   return reply.code(status).send({code:typeof error?.code==="string"?error.code:"drama_pipeline_generation_failed"});
  }
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
 const conversationParams={type:"object",required:["id","chatSessionId"],additionalProperties:false,
  properties:{id:idSchema,chatSessionId:idSchema}};
 const conversationMetrics={conflicts:0,needs_reconcile:0,budget_exceeded:0,checkpoint_invalid:0,checkpoint_write_failed:0};
 app.decorate("assistantConversationMetrics",conversationMetrics);
 const countConversationError=(code)=>{
  if(code==="assistant_conversation_request_conflict"||code==="assistant_conversation_busy")conversationMetrics.conflicts++;
  if(code==="assistant_context_budget_insufficient")conversationMetrics.budget_exceeded++;
 };
 const conversationRequestParams={type:"object",additionalProperties:false,required:["id","chatSessionId","turnId","requestId"],
  properties:{...conversationParams.properties,turnId:idSchema,requestId:idSchema}};
 app.delete("/api/v1/projects/:id/assistant/conversations/:chatSessionId",{schema:{params:conversationParams}},req=>
  removeConversation(db,req.params.id,req.params.chatSessionId));
 app.get("/api/v1/projects/:id/assistant/conversations/:chatSessionId/turns",{schema:{params:conversationParams,
  querystring:{type:"object",additionalProperties:false,properties:{before:{type:"integer",minimum:1},
   limit:{type:"integer",minimum:1,maximum:50}}}}},(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return listConversationTurns(db,{projectId:req.params.id,chatSessionId:req.params.chatSessionId,
   before:req.query.before,limit:req.query.limit});
 });
 app.get("/api/v1/projects/:id/assistant/conversations/:chatSessionId/turns/:turnId/:requestId",{schema:{
  params:conversationRequestParams}},(req,reply)=>{
  const state=findConversationRequest(db,{projectId:req.params.id,...req.params});
  if(!state)return reply.code(404).send({code:"assistant_turn_not_found"});
  reply.header("Cache-Control","no-store");return state;
 });
 app.post("/api/v1/projects/:id/assistant/conversations/:chatSessionId/turns/:turnId/:requestId/cancel",
  {schema:{params:conversationRequestParams}},(req,reply)=>{
   const state=findConversationRequest(db,{projectId:req.params.id,...req.params});
   if(!state)return reply.code(404).send({code:"assistant_turn_not_found"});
   const key=[req.params.id,req.params.chatSessionId,req.params.turnId,req.params.requestId].join("\0");
   const running=assistantStreamControllers.get(key);
   running?.abort();
   return {cancelled:Boolean(running)};
  });
 const assistantStreamParams={type:"object",required:["id","turnId"],additionalProperties:false,properties:{id:idSchema,turnId:idSchema}};
 app.get("/api/v1/projects/:id/assistant/chat/stream/:turnId",{schema:{params:assistantStreamParams,querystring:{type:"object",properties:{after:{type:"integer",minimum:0}},additionalProperties:false}}},async(req,reply)=>{
  getProject(db,req.params.id);const after=Number(req.query.after??0);const state=assistantChatStreamLedger.read(req.params.id,req.params.turnId,after);
  if(!state)return reply.code(404).send({code:"assistant_turn_not_found"});
  const first=state.events[0]?.seq; if(first!==undefined&&after<first-1)return reply.code(409).send({code:"assistant_stream_cursor_expired",oldestSeq:first});
  reply.header("Cache-Control","no-store");return state;
 });
 app.post("/api/v1/projects/:id/assistant/chat/stream/:turnId/cancel",{schema:{params:assistantStreamParams,body:{type:"object",additionalProperties:false}}},async(req,reply)=>{
  getProject(db,req.params.id);const state=assistantChatStreamLedger.cancel(req.params.id,req.params.turnId);if(!state)return reply.code(404).send({code:"assistant_turn_not_found"});
  if(state.cancelled)assistantStreamControllers.get(req.params.id+"\0"+req.params.turnId)?.abort();
  reply.header("Cache-Control","no-store");return {turnId:req.params.turnId,cancelled:state.cancelled};
 });
 registerAssistantTaskRoutes(app,db,{skillRegistry,blobStore,onTaskSkillSettled});
 registerShotGroupRoutes(app,{shotBatches});
   app.post("/api/v1/projects/:id/assistant/chat",{schema:{params:canvasParams,body:{type:"object",
     required:["channelId","provider","model","messages"],additionalProperties:false,properties:{
       channelId:idSchema,turnId:idSchema,chatSessionId:idSchema,conversationRequestId:idSchema,
       conversationContinuation:{type:"boolean"},
       conversationContext:{type:"object",additionalProperties:false,required:["includeContext","scope","includedIds"],
        properties:{includeContext:{type:"boolean"},scope:{type:"string",enum:["selection","overview"]},
         includedIds:{type:"array",maxItems:100,uniqueItems:true,items:canvasNodeIdSchema}}},
       provider:{type:"string",enum:["openai","openai_compatible","google_gemini"]},
        baseUrl:{type:"string",maxLength:1024},model:{type:"string",minLength:1,maxLength:128},
        canvasActions:{type:"boolean"},
        semanticCanvasIntent:{type:"boolean"},
        agentReadTools:{type:"boolean"},
        skillScriptProposalEnabled:{type:"boolean"},
        task:{type:"object",additionalProperties:false,required:["taskId","requestId","turnMessageId"],properties:{
         taskId:idSchema,requestId:idSchema,turnMessageId:idSchema,historyQuote:assistantHistoryQuoteSchema,
         callKind:{type:"string",enum:["initial","script_continuation","semantic_proposal"]}
        }},
        visualContext:{type:"object",required:["images"],additionalProperties:false,properties:{
         detail:{type:"string",enum:["auto","low","high"]},
         images:{type:"array",minItems:1,maxItems:4,items:{
          type:"object",required:["nodeId"],additionalProperties:false,
          properties:{nodeId:canvasNodeIdSchema,imageId:{type:"string",minLength:1,maxLength:160}}
         }}
        }},
        skills:{type:"object",required:["mode","projectId","expectedRevision","skillIds","versionPins"],additionalProperties:false,
         properties:{mode:{type:"string",enum:["manual","auto"]},projectId:idSchema,
          expectedRevision:{type:"integer",minimum:1},skillIds:{type:"array",minItems:1,maxItems:100,uniqueItems:true,items:skillId},
          versionPins:{type:"object",additionalProperties:skillVersion}}},
        messages:{type:"array",minItems:1,maxItems:20,items:{type:"object",required:["role","content"],
         additionalProperties:false,properties:{role:{type:"string",enum:["user","assistant"]},
           content:{type:"string",maxLength:98304}}}}
      }}}},async(req,reply)=>{
     const project=getProject(db,req.params.id); // Verify project before any paid provider call.
     if(!assistantChat)return reply.code(503).send({code:"assistant_unavailable"});
     const ref=req.body.task;
     const chatSessionId=req.body.chatSessionId;
     const managed=Boolean(chatSessionId&&!((ref?.callKind)==="semantic_proposal"));
     if(managed&&(!req.body.turnId||!req.body.conversationRequestId||req.body.messages.length!==1||
       req.body.messages[0].role!=="user"||ref&&(ref.turnMessageId!==req.body.turnId||
        ref.requestId!==req.body.conversationRequestId)))
      return reply.code(400).send({code:"assistant_turn_required"});
     const streamMode=req.headers.accept?.toLowerCase().includes("text/event-stream")&&
      req.body.provider!=="google_gemini"&&!ref&&!req.body.skills&&!req.body.visualContext&&req.body.agentReadTools!==true&&req.body.canvasActions===false;
     const streamTurnId=streamMode?req.body.turnId:null;
     if(streamMode&&!streamTurnId)return reply.code(400).send({code:"assistant_turn_required"});
     if(streamMode&&managed){
      let state;
      try{state=findConversationRequest(db,{projectId:req.params.id,chatSessionId,turnId:streamTurnId,
       requestId:req.body.conversationRequestId,requestPayload:req.body});}
      catch(error){countConversationError(error.code);throw error;}
      if(state){
       if(state.state!=="completed"){
        const code=state.state==="needs_reconcile"?"assistant_model_call_unknown":state.errorCode??"assistant_conversation_busy";
        countConversationError(code);
        return reply.code(409).send({code});
       }
       const event={seq:1,type:"done",result:state.response};
       reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store"});
       reply.raw.end("id: 1\nevent: done\ndata: "+JSON.stringify(event)+"\n\n");return reply;
      }
     }
     if(streamMode&&!managed&&assistantChatStreamLedger.isReplayExpired(req.params.id,streamTurnId))
      return reply.code(409).send({code:"assistant_stream_cursor_expired"});
     const existingStream=streamMode&&!managed&&assistantChatStreamLedger.has(req.params.id,streamTurnId)?
      assistantChatStreamLedger.read(req.params.id,streamTurnId,0):null;
     if(existingStream){
      if(!existingStream.terminal)return reply.code(409).send({code:"assistant_model_call_in_progress",turnId:streamTurnId});
      if(existingStream.oldestSeq>1)return reply.code(409).send({code:"assistant_stream_cursor_expired"});
      reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store","X-Assistant-Turn-Id":streamTurnId});
      for(const event of existingStream.events)reply.raw.write("id: "+event.seq+"\nevent: "+event.type+"\ndata: "+JSON.stringify(event)+"\n\n");reply.raw.end();return reply;
     }
     let streamStarted=false,streamSequence=0;
     const startStream=()=>{
      reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-store","Connection":"keep-alive","X-Assistant-Turn-Id":streamTurnId});
      reply.raw.flushHeaders();
      streamStarted=true;
     };
     const streamEvent=(type,payload)=>{
      const event=managed?{seq:++streamSequence,type,...payload}:
       assistantChatStreamLedger.append(req.params.id,streamTurnId,type,payload);
      if(event&&!reply.raw.destroyed)reply.raw.write("id: "+event.seq+"\nevent: "+event.type+"\ndata: "+JSON.stringify(event)+"\n\n");
      return event;
     };
     if(streamMode&&!managed){
      if(!assistantChatStreamLedger.ensure(req.params.id,streamTurnId))return reply.code(429).send({code:"assistant_stream_capacity"});
      startStream();
     }
     const controller=new AbortController();
     const controllerKey=managed?[req.params.id,chatSessionId,req.body.turnId,req.body.conversationRequestId].join("\0"):
      req.params.id+"\0"+streamTurnId;
     if(streamMode&&!managed)assistantStreamControllers.set(controllerKey,controller);
     const onClose=()=>controller.abort();
     if(!streamMode)reply.raw.on("close",onClose);
      const proposalMode=ref?.callKind==="semantic_proposal";
      const readMode=req.body.agentReadTools===true;
     let commandStarted=false,conversation=null,conversationPolicy=null,restrictConversation=false,conversationMemory="",usedRevisionHints=false;
     let promptTurnUsage=null;
     try{
       if(readMode&&(!ref||proposalMode||ref.callKind&&ref.callKind!=="initial"||
        req.body.skills||req.body.visualContext||req.body.provider==="google_gemini"))
        throw Object.assign(Error("assistant_agent_read_unsupported"),
         {code:"assistant_agent_read_unsupported",statusCode:400});
       if(ref&&!proposalMode&&req.body.skills&&currentAssistantTextDeliverable(db,ref.taskId))
        throw Object.assign(Error("assistant_deliverable_skill_not_supported"),
         {code:"assistant_deliverable_skill_not_supported",statusCode:403});
       if(proposalMode&&(!ref||req.body.canvasActions!==false||req.body.skills||
         req.body.visualContext||req.body.messages.length!==1))
         throw Object.assign(Error("assistant_semantic_proposal_invalid"),{code:"assistant_semantic_proposal_invalid",statusCode:400});
        let observer=null,taskContext="",messages=req.body.messages,frozenPolicy=null;
       if(ref&&!proposalMode&&ref.callKind==="script_continuation"&&
        currentAssistantTextDeliverable(db,ref.taskId))
        throw Object.assign(Error("assistant_deliverable_script_continuation_unsupported"),
         {code:"assistant_deliverable_script_continuation_unsupported",statusCode:403});
       // Legacy non-deliverable Skill continuations contain a server-produced
       // execution result rather than the original user text. P4.0 does not
       // upgrade their protocol; the direct text-card path disallows them.
       if(ref&&!proposalMode&&ref.callKind!=="script_continuation"){
        const current=req.body.messages.at(-1);
        const turn=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='user_turn' AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1")
         .get(ref.taskId,ref.turnMessageId);
        const recorded=turn?JSON.parse(turn.payload_json):null;
        const digest=typeof current?.content==="string"?
         createHash("sha256").update(stableJson(current.content)).digest("hex"):null;
        if(req.body.messages.length!==1||current?.role!=="user"||!recorded||
         digest!==recorded.requestDigest)
         throw Object.assign(Error("assistant_task_message_untrusted"),
          {code:"assistant_task_message_untrusted",statusCode:403});
       }
       if(managed){
        if(ref)assertConversationTaskTurn(db,{projectId:req.params.id,chatSessionId,taskId:ref.taskId,turnId:req.body.turnId});
        frozenPolicy=ref?getAssistantTaskTurnPolicy(db,{projectId:req.params.id,taskId:ref.taskId,messageId:ref.turnMessageId}):
         ordinaryConversationPolicy(req.body.conversationContext,req.body.visualContext,project);
        const reservation=beginConversationRequest(db,{projectId:req.params.id,chatSessionId,turnId:req.body.turnId,
         requestId:req.body.conversationRequestId,taskId:ref?.taskId??null,userText:messages[0].content,
         requestPayload:req.body,continuation:req.body.conversationContinuation===true,policy:frozenPolicy});
        if(reservation.cached){
         if(streamMode){
          startStream();
          streamEvent("done",{result:reservation.response});
          reply.raw.end();
          return reply;
         }
         reply.header("Cache-Control","no-store");return reservation.response;
        }
        conversation=reservation;
        if(streamMode){
         assistantStreamControllers.set(controllerKey,controller);
         startStream();
        }
       }
       let nodeReader=null,chosenMaterials=[],agentReadSession=null,structuredRequirement=null,usedHistoryQuote=null,quoteContext="";
       if(ref){
        const command=beginAssistantModelCommand(db,{projectId:req.params.id,taskId:ref.taskId,
         requestId:ref.requestId,requestPayload:req.body,beforeStart:()=>{
          if(ref.historyQuote&&(readMode||proposalMode))
           throw Object.assign(Error("assistant_history_quote_invalid"),{code:"assistant_history_quote_invalid",statusCode:409});
          if(ref.historyQuote&&(req.body.visualContext||req.body.skills)&&
           hasSelectedAssistantCreativeMaterials(db,ref.taskId,ref.turnMessageId))
           throw Object.assign(Error("assistant_history_quote_material_conflict"),
            {code:"assistant_history_quote_material_conflict",statusCode:409});
          if(!proposalMode)usedHistoryQuote=resolveAssistantHistoryQuote(db,{projectId:req.params.id,taskId:ref.taskId,
           turnMessageId:ref.turnMessageId,historyQuote:ref.historyQuote,request:req.body.messages[0]?.content,
           continuation:ref.callKind==="script_continuation"});
          if(usedHistoryQuote)quoteContext=formatAssistantHistoryQuote(usedHistoryQuote);
          if(readMode){
           if(hasSelectedAssistantCreativeMaterials(db,ref.taskId,ref.turnMessageId))
            throw Object.assign(Error("assistant_agent_read_source_conflict"),
             {code:"assistant_agent_read_source_conflict",statusCode:409});
           assertAssistantAgentReadClaim(db,{projectId:req.params.id,
            taskId:ref.taskId,turnMessageId:ref.turnMessageId});
          }
          if(!proposalMode&&hasSelectedAssistantCreativeMaterials(db,ref.taskId,ref.turnMessageId)&&
           (req.body.skills||ref.callKind==="script_continuation"))
           throw Object.assign(Error("assistant_creative_skill_not_supported"),
            {code:"assistant_creative_skill_not_supported",statusCode:403});
          if(!proposalMode&&ref.callKind!=="script_continuation")
           chosenMaterials=loadSelectedAssistantCreativeMaterials(db,{projectId:req.params.id,
            taskId:ref.taskId,turnMessageId:ref.turnMessageId});
         }});
        if(command.cached){
         if(conversation){
          startConversationSubmission(db,conversation,{...frozenPolicy,opaque:true});
          completeConversationRequest(db,conversation,command.response);
         }
         reply.header("Cache-Control","no-store");return command.response;
        }
        commandStarted=true;
        if(readMode)agentReadSession=createAssistantAgentReadSession(db,{
         projectId:req.params.id,taskId:ref.taskId,turnMessageId:ref.turnMessageId,
         requestId:ref.requestId,enforceOwner:true,loadTemplate:registry.find});
        const snapshot=getAssistantTask(db,{projectId:req.params.id,taskId:ref.taskId}).task;
         frozenPolicy={...getAssistantTaskTurnPolicy(db,{projectId:req.params.id,taskId:ref.taskId,
          messageId:ref.turnMessageId}),revision:project.revision};
        const requirement=proposalMode?null:currentAssistantTextDeliverable(db,ref.taskId);
        // Reject obsolete structured specs before the next billable POST.
        if(requirement?.deliverableType){
         structuredRequirement=requirement;
         assertAssistantStructuredSourceCurrent(db,ref.taskId,requirement,{turnMessageId:ref.turnMessageId});
        }
        // An explicitly approved source set supersedes unrelated model drafts.
        const pinned=requirement?.characters?.some(c=>c.sourceRef)===true||chosenMaterials.length>0;
        restrictConversation=pinned||Boolean(usedHistoryQuote)||readMode||Boolean(requirement);
        const creativeDrafts=managed||proposalMode||pinned||usedHistoryQuote?[]:loadAssistantTaskCreativeHistory(db,{
         taskId:ref.taskId,currentTurnMessageId:ref.turnMessageId,contextPolicy:frozenPolicy
        });
        // Pinned creative references narrow the prose context: old previews and
        // unrelated model drafts are not part of the user's selected material set.
         const scopedSummary=managed||chosenMaterials.length?{
         ...snapshot.summary,userTurns:{...(snapshot.summary?.userTurns??{}),recent:[]}
        }:snapshot.summary;
        // When the user pins concrete creative materials, limit the ordinary
        // canvas context to those selected text-node sources as well. Canvas
        // disclosure permission is a ceiling, not an instruction to send all
        // selected nodes despite a narrower material confirmation.
        const creativeNodeIds=new Set(chosenMaterials.map(item=>item.sourceNodeId).filter(Boolean));
        const scopedDocument=chosenMaterials.length?{
         ...project.document,
         // Only the frozen, budgeted excerpts below may supply source prose.
         // Generic node serialization also includes unconfirmed metadata fields.
         nodes:[],
         connections:[]}:project.document;
        if(!proposalMode&&!readMode&&!pinned)
         nodeReader=createCanvasNodeReader(frozenPolicy,scopedDocument);
        const modelSettings=req.body.canvasActions&&frozenPolicy.includeContext?
         db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get():null;
        taskContext=buildAssistantTaskProviderContext({task:{...snapshot,summary:scopedSummary,contextPolicy:frozenPolicy},document:scopedDocument,
         config:modelSettings?JSON.parse(modelSettings.value_json):undefined,loadTemplate:registry.find,
         currentTurnMessageId:ref.turnMessageId,creativeDrafts,
         trustedOutputs:trustedAssistantTaskOutputs(db,{projectId:project.id,taskId:snapshot.id,planVersion:snapshot.activePlanVersion})
          .filter(output=>!chosenMaterials.length||creativeNodeIds.has(output.nodeId))});
        if(chosenMaterials.length){
         const creativeText=formatSelectedAssistantCreativeMaterials(chosenMaterials);
         if(Buffer.byteLength(taskContext+"\n"+creativeText,"utf8")>16*1024)
          throw Object.assign(Error("assistant_context_budget_insufficient"),
           {code:"assistant_context_budget_insufficient",statusCode:413});
         taskContext+="\n"+creativeText;
        }
        if(!proposalMode){
         if(requirement?.kind==="text_nodes"){
          // Source references are server resolved again for THIS turn's permission.
          const sourced=(requirement.characters??[]).filter(c=>c.sourceRef);
          const candidates=sourced.length?resolveAuthorizedCreativeCharacters(db,{
           projectId:req.params.id,taskId:ref.taskId,turnMessageId:ref.turnMessageId,
           characters:sourced}):[];
          const sourceContext=formatAssistantCreativeSources(candidates);
          const structured=Boolean(requirement.deliverableType);
          const labels={story:"故事大纲",scene:"场景设定",storyboard:"分镜提示词"};
          const specContext="\n本轮已经过用户确认的文本交付规格："+JSON.stringify({
           type:structured?labels[requirement.deliverableType]:"角色卡",
           targets:structured?requirement.entries:requirement.characters,
           allowEmptyTemplate:requirement.allowEmptyTemplate,
           requiredFields:requirement.requiredFields,
           ...(structured?{minMeaningfulChars:requirement.minMeaningfulChars}:{})})+
           (requirement.allowEmptyTemplate?
            "\n必须使用 create_text 逐项精确匹配 ref/title；用户明确要求空白模板，允许空正文。":
            "\n必须使用 create_text 逐项精确匹配 ref/title；正文不得为空白模板。"+
            (structured?"每项应有完整具体内容，达到最低有效中文字量。":"应描写具体角色特征。"));
          if(Buffer.byteLength(taskContext+specContext+sourceContext,"utf8")>16*1024)
           throw Object.assign(Error("assistant_context_budget_insufficient"),
            {code:"assistant_context_budget_insufficient",statusCode:413});
          taskContext+=specContext+(sourceContext?"\n"+sourceContext:"");
         }
        }
        // P4.9h: only an explicit storyboard revision turn may reuse
        // previously completed, still-disclosable model storyboard events.
        // This is a bounded editorial hint, NOT a user-confirmed fact.
        // An explicitly pinned source, structured deliverable or restricted
        // read/Skill/media turn must never receive unsolicited model drafts.
        if(!proposalMode&&!pinned&&!usedHistoryQuote&&!readMode&&!requirement&&!req.body.skills&&
         !req.body.visualContext&&ref.callKind!=="script_continuation"){
         const hints=loadAuthorizedStoryEventRevisionHints(db,{
          taskId:ref.taskId,currentTurnMessageId:ref.turnMessageId,
          contextPolicy:frozenPolicy,userRequest:req.body.messages.at(-1)?.content
         });
         if(hints&&Buffer.byteLength(taskContext+"\n"+hints,"utf8")<=16*1024){
          taskContext+="\n"+hints;
          usedRevisionHints=true;
         }
        }
        if(Buffer.byteLength(taskContext+quoteContext,"utf8")>16*1024)
         throw Object.assign(Error("assistant_history_quote_budget"),{code:"assistant_history_quote_budget",statusCode:413});
        // P0b: client transcript may contain previously selected private nodes.
        // Only the current explicit user request enters the provider payload.
        messages=proposalMode?[{role:"user",content:"仅根据本轮已授权的任务事实和用户历史，提取长期目标、约束或决策候选。无证据时返回空数组。"}]:[req.body.messages.at(-1)];
        observer=createAssistantModelObserver(db,{projectId:req.params.id,taskId:ref.taskId,
         requestId:ref.requestId,provider:req.body.provider,model:req.body.model});
       }
       if(req.body.skills&&req.body.skills.projectId!==req.params.id)
        throw Object.assign(Error("assistant_skill_selection_invalid"),{code:"assistant_skill_selection_invalid",statusCode:400});
       const skill=resolveAssistantSkills(db,skillRegistry,req.body.skills,messages);
       if(!ref&&!streamMode)nodeReader=createCanvasNodeReader(frozenPolicy,project.document);
       const mode=proposalMode?"semantic_proposal":readMode?"agent_read":req.body.skills?"skill":
        ref?"task":req.body.canvasActions?"canvas":"chat";
       const rollout={channelId:req.body.channelId,provider:req.body.provider,model:req.body.model,mode};
       let stablePromptPrefix=Boolean(conversation&&assistantCacheRollout({...rollout,stage:"prefix"}));
       const batchHistory=Boolean(conversation&&assistantCacheRollout({...rollout,stage:"batch_history"}));
       let liveToolContext="";
       let plainCanvasChat=false,selectedCanvasText="";
       if(conversation){
        const autoSkills=req.body.skills?.mode==="auto";
        const restrict=restrictConversation||Boolean(req.body.conversationContinuation||req.body.visualContext||
         (req.body.skills&&!autoSkills));
        if(autoSkills&&!restrict){
         // Skill-assisted prose can enter later turns only under the same authorized catalog.
         const {expectedRevision,versionPins,skillIds}=req.body.skills;
         const catalog=[...skillIds].sort().map(id=>[id,versionPins[id]]);
         frozenPolicy={...frozenPolicy,skillHistoryKey:createHash("sha256")
          .update(stableJson({expectedRevision,catalog})).digest("hex")};
        }
        if(!restrict&&!req.body.skills)liveToolContext=resolveConversationToolReferences(db,conversation,{taskId:ref?.taskId,policy:frozenPolicy,project});
         plainCanvasChat=stablePromptPrefix&&!ref&&!frozenPolicy.includeContext&&!req.body.canvasActions&&
          !restrict&&!skill.context&&!skill.toolEntries?.length&&!liveToolContext&&!quoteContext&&
          assistantCacheRollout({...rollout,stage:"plain_chat"});
         if(!ref){
          const config=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
          taskContext=formatAssistantCanvasContext({policy:frozenPolicy,document:project.document,
           config:config?JSON.parse(config.value_json):{},loadTemplate:registry.find});
         }
        if(nodeReader)taskContext=nodeReader.withContext(taskContext);
        if(!nodeReader&&(!ref||!restrictConversation))
         selectedCanvasText=formatSelectedCanvasText({policy:frozenPolicy,document:project.document});
        let reservedBytes=stablePromptPrefix?Buffer.byteLength(assistantCurrentReferenceData({
         taskContext:plainCanvasChat?"":taskContext,liveToolContext,skillContext:skill.context,quoteContext,selectedCanvasText}).text):0;
        // Keep the legacy layout available when the user turn and independently
        // bounded system context fit separately but would not fit together.
        if(reservedBytes&&Buffer.byteLength(messages.at(-1).content)+reservedBytes>MAX_ASSISTANT_MESSAGE_BYTES){
         stablePromptPrefix=false;
         reservedBytes=0;
        }
        const built=buildConversationMessages(db,conversation,{current:messages.at(-1),policy:frozenPolicy,project,
         restrict,reservedBytes,retainedHistoryMode:batchHistory?{mode,taskId:ref?.taskId??null}:null,
         onDiagnostic:key=>conversationMetrics[key]++});
        messages=built.messages;
        conversationPolicy=usedRevisionHints?{...built.policy,opaque:true}:built.policy;
        conversationMemory=built.compactedHistory;
        if(!stablePromptPrefix&&liveToolContext&&Buffer.byteLength(conversationMemory+"\n"+liveToolContext)<8*1024)
         conversationMemory+="\n当前重新核验的历史工具节点：\n"+liveToolContext;
       }
       const promptCohort={...rollout,stablePromptPrefix,batchHistory,plainCanvasChat};
       if(onAssistantPromptTurnUsage)promptTurnUsage={...promptCohort,posts:0,inputReports:0,inputTokens:0};
       if(ref&&req.body.visualContext){
        // A confirmed text-material selection narrows this request to those
        // references; an older canvas selection cannot also authorize media.
        const allowed=new Set(!chosenMaterials.length&&frozenPolicy?.includeContext&&frozenPolicy.scope==="selection"?
         frozenPolicy.includedIds:[]);
        if(req.body.visualContext.images.some(image=>!allowed.has(image.nodeId)))
         throw Object.assign(Error("assistant_task_visual_not_authorized"),
          {code:"assistant_task_visual_not_authorized",statusCode:403});
       }
       if(nodeReader&&!conversation)taskContext=nodeReader.withContext(taskContext);
       const visual=await resolveAssistantVisualContext({
        document:project.document,visualContext:req.body.visualContext,blobStore,signal:controller.signal
       });
       const {skills:_selection,visualContext:_visual,task:_task,...chatInput}=req.body;
       const result=await assistantChat({...chatInput,messages,conversationMemory,skillContext:skill.context,selectedCanvasText,
        stablePromptPrefix,plainCanvasChat,liveToolContext:stablePromptPrefix?liveToolContext:"",
        compatibleStreamUsage:req.body.provider==="openai_compatible"&&
         process.env.ATELIER_ASSISTANT_CACHE_STREAM_USAGE_CHANNELS?.split(",").some(id=>id.trim()===req.body.channelId),
        onPromptUsage:onAssistantPromptUsage||promptTurnUsage?sample=>{
         if(promptTurnUsage){
          promptTurnUsage.posts++;
          if(sample.inputTokens!==null){
           promptTurnUsage.inputReports++;
           promptTurnUsage.inputTokens+=sample.inputTokens;
          }
         }
         onAssistantPromptUsage?.({...sample,...promptCohort});
        }:null,
        skillTools:skill.toolEntries??[],discoverSkills:skill.discover===true,nodeReader,visualImages:visual.images,
        visualDetail:req.body.visualContext?.detail??"high",signal:controller.signal,
        ...(streamMode?{stream:true,onDelta:delta=>streamEvent("delta",{text:delta})}:{}),
        ...((ref||conversation)?{providerPayloadGuard:(requestBody,{quote}={})=>{
         if(conversation&&Buffer.byteLength(requestBody)>34*1024*1024)
          throw Object.assign(Error("assistant_context_budget_insufficient"),{code:"assistant_context_budget_insufficient",statusCode:413});
         if((nodeReader||conversation&&(conversationPolicy.includeContext||req.body.visualContext))&&
          getProject(db,req.params.id).revision!==project.revision)
          throw Object.assign(Error("assistant_task_context_not_authorized"),{code:"assistant_task_context_not_authorized",statusCode:403});
         if(!ref){startConversationSubmission(db,conversation,conversationPolicy);return;}
         agentReadSession?.check(); // reauthorize immediately before each POST
         if(structuredRequirement){
          assertAssistantStructuredSourceCurrent(db,ref.taskId,structuredRequirement,{turnMessageId:ref.turnMessageId});
          if(currentAssistantTextDeliverable(db,ref.taskId)?.digest!==structuredRequirement.digest)
           throw Object.assign(Error("assistant_deliverable_spec_changed"),
            {code:"assistant_deliverable_spec_changed",statusCode:409});
         }
         // Another chat/turn or a graph edit may have happened while awaiting
         // media or a previous tool round. Recheck the exact frozen source
         // bindings immediately before EACH paid upstream POST.
         if(chosenMaterials.length)loadSelectedAssistantCreativeMaterials(db,{
          projectId:req.params.id,taskId:ref.taskId,turnMessageId:ref.turnMessageId});
         // Last-chance scan of the REAL serialized provider body, including
         // corrections/Skill tools. Authorized sources were assembled server-side.
         const visible=new Set(chosenMaterials.length?
          chosenMaterials.map(item=>item.sourceNodeId).filter(Boolean):
          frozenPolicy?.includeContext&&frozenPolicy.scope==="selection"?
           frozenPolicy.includedIds:[]);
         // Inspect decoded string values: JSON escaping must not hide source text.
         const body=JSON.parse(requestBody);
         if(usedHistoryQuote){
          const rechecked=resolveAssistantHistoryQuote(db,{projectId:req.params.id,taskId:ref.taskId,
           turnMessageId:ref.turnMessageId,historyQuote:ref.historyQuote,record:false,
           continuation:ref.callKind==="script_continuation"});
          const path=quote?.path??(req.body.provider==="google_gemini"?["systemInstruction","parts",0,"text"]:["messages",0,"content"]);
          const owner=path.slice(0,-1).reduce((value,key)=>value?.[key],body);
          const key=path.at(-1),value=owner?.[key];
          const start=quote?.offset??(typeof value==="string"?value.lastIndexOf(quoteContext):-1);
          if(typeof value!=="string"||start<0||!value.startsWith(quoteContext,start)||rechecked.text!==usedHistoryQuote.text||
           (stablePromptPrefix&&!quote))
            throw Object.assign(Error("assistant_history_quote_changed"),{code:"assistant_history_quote_changed",statusCode:409});
          owner[key]=value.slice(0,start)+value.slice(start+quoteContext.length);
         }
         const strings=[],pending=[body];
         while(pending.length){
          const value=pending.pop();
          if(typeof value==="string")strings.push(value);
          else if(value&&typeof value==="object")pending.push(...Object.values(value));
         }
         for(const node of project.document.nodes??[]){
          if(visible.has(node.id))continue;
          const text=typeof node.metadata?.content==="string"?node.metadata.content:"";
          if(text.length>=24&&(proposalMode||!req.body.messages.at(-1)?.content.includes(text))&&strings.some(value=>value.includes(text)))
           throw Object.assign(Error("assistant_task_context_not_authorized"),
            {code:"assistant_task_context_not_authorized",statusCode:403});
         }
         if(conversation)startConversationSubmission(db,conversation,conversationPolicy);
        }}:{}),
        ...(ref?{taskContext,quoteContext,callObserver:observer,modelCallKind:proposalMode?"initial":ref.callKind??"initial",
         semanticProposal:proposalMode,agentReadSession}:conversation?{taskContext,durableRequest:true}:{})});
       const proposed=proposalMode?prepareAssistantSemanticProposals({answer:result.answer,
         requestId:ref.requestId,turnMessageId:ref.turnMessageId,contextPolicy:frozenPolicy}):null;
       const completed={...(conversation?sanitizeConversationReply(result):result),appliedSkillIds:result.appliedSkillIds??skill.skillIds,usedVisualReferences:visual.references,
         ...(usedHistoryQuote?{usedHistoryQuote}:{}),
         ...(readMode?{agentRunId:agentReadRunId(req.params.id,ref.taskId,ref.requestId)}:{}),
         ...(proposed?{proposals:proposed.candidates}:{})};
       if(ref)completeAssistantModelCommand(db,{projectId:req.params.id,taskId:ref.taskId,
        requestId:ref.requestId,response:completed,semanticProposalBatch:proposed,
        onCompleted:conversation?()=>completeConversationRequestInTransaction(db,conversation,completed,(agentReadSession??nodeReader)?.references):null});
       else if(conversation)completeConversationRequest(db,conversation,completed);
       if(streamMode){const event=streamEvent("done",{result:completed});
        if(!reply.raw.destroyed){
         const terminal=!event&&!managed?assistantChatStreamLedger.read(req.params.id,streamTurnId,0)?.events.at(-1):null;
         if(terminal)reply.raw.write("id: "+terminal.seq+"\nevent: "+terminal.type+"\ndata: "+JSON.stringify(terminal)+"\n\n");
         reply.raw.end();
        }return reply;
       }
       reply.header("Cache-Control","no-store");return completed;
     }catch(error){
       if(ref&&commandStarted){
        try{failAssistantModelCommand(db,{projectId:req.params.id,taskId:ref.taskId,requestId:ref.requestId})}
        catch{ /* A durable submitting record will still prohibit replay on restart. */ }
       }
       const code=typeof error?.code==="string"&&error.code.startsWith("assistant_")?error.code:"assistant_failed";
       if(managed)countConversationError(code);
       if(conversation&&failConversationRequest(db,conversation,code,error?.failureDetail)==="needs_reconcile")
        conversationMetrics.needs_reconcile++;
       if(streamStarted){const event=streamEvent("error",{code});
        if(!reply.raw.destroyed){
         const terminal=!event&&!managed?assistantChatStreamLedger.read(req.params.id,streamTurnId,0)?.events.at(-1):null;
         if(terminal)reply.raw.write("id: "+terminal.seq+"\nevent: "+terminal.type+"\ndata: "+JSON.stringify(terminal)+"\n\n");
         reply.raw.end();
        }return reply;
       }
       return reply.code(error?.statusCode>=400&&error.statusCode<600?error.statusCode:502).send({code});
     }finally{
      reply.raw.off("close",onClose);
      if(streamStarted)assistantStreamControllers.delete(controllerKey);
      if(promptTurnUsage?.posts){
       try{onAssistantPromptTurnUsage(promptTurnUsage);}
       catch{/* Telemetry cannot change a paid request's outcome. */}
      }
     }
   });
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
  const snapshot=req.body.snapshot,task=snapshot?.task;
  const existing=db.prepare("SELECT idempotency_key FROM jobs WHERE idempotency_key=?").get(req.body.idempotencyKey);
  if(!existing&&snapshot?.adapterKind==="model"&&task&&["image","video","audio"].includes(task.kind)){
   const setting=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
   const config=setting?JSON.parse(setting.value_json):{};
   const channel=config.channels?.find(item=>item.id===snapshot.channelId);
   const model=channel?.models?.find(item=>item.name===task.model);
   if(model?.mediaCapabilities||snapshot.provider==="volcengine_ark"){
    const supportedModes=supportedMediaModes({provider:snapshot.provider,kind:task.kind,customScript:typeof task.script==="string"});
    const supportedParameters=supportedMediaParameters({provider:snapshot.provider,kind:task.kind,customScript:typeof task.script==="string"});
    const resolved=model?.mediaCapabilities?resolveMediaCapabilities(model,{kind:task.kind,supportedModes,supportedParameters}):null;
    const needsTrustedDuration=(ref)=>(ref.kind==="video"||ref.kind==="audio")&&
     (snapshot.provider==="volcengine_ark"||!!model?.mediaCapabilities?.modes.some(mode=>mode.enabled&&mode.inputs.some(rule=>rule.role===ref.role&&rule.maxDurationSeconds!==undefined)));
    const images=task.images??[];
    const imageRefs=async(role,items)=>Promise.all(items.map(async image=>{const stat=await blobStore?.stat(image.blobId);return {role,kind:"image",mimeType:stat?.mimeType,bytes:stat?.byteSize}}));
    const verifiedReferences=task.kind==="video"?await Promise.all((task.references??[]).map(async ref=>{
      let blobId=ref.blobId;
      if(!blobId&&snapshot.provider==="volcengine_ark"&&typeof ref.assetUrl==="string"){
       const assetId=/^asset:\/\/([A-Za-z0-9_-]{1,160})$/.exec(ref.assetUrl)?.[1];
       if(assetId)blobId=db.prepare("SELECT blob_id FROM ark_asset_uploads WHERE asset_id=? AND status='active'").get(assetId)?.blob_id;
      }
      const stat=blobId?await blobStore?.stat(blobId):undefined;
      const durationMs=needsTrustedDuration(ref)?stat?await readMediaDurationMs(stat.path,stat.mimeType):undefined:undefined;
      if(needsTrustedDuration(ref)&&(!durationMs||!stat))throw Object.assign(Error("media_reference_duration_unverified"),{code:"media_reference_duration_unverified",statusCode:422});
      const mimeType=stat?.mimeType;
      if(stat&&ref.mimeType&&ref.mimeType!==mimeType)throw Object.assign(Error("media_reference_mime_mismatch"),{code:"media_reference_mime_mismatch",statusCode:422});
      return {frozen:{...ref,...(stat?{mimeType}:{}),...(durationMs?{durationMs}:{})},validation:{role:ref.role,kind:ref.kind,mimeType,bytes:stat?.byteSize,durationMs}};
     })):
     task.kind==="image"?[
      ...(task.mask&&images.length?await imageRefs("source_image",[images[0]]):await imageRefs("reference_image",images)),
      ...(task.mask?[{role:"mask",kind:"mask",mimeType:(await blobStore?.stat(task.mask.blobId))?.mimeType,bytes:(await blobStore?.stat(task.mask.blobId))?.byteSize}]:[])
     ]:[];
    const refs=task.kind==="video"?verifiedReferences.map(item=>item.validation):verifiedReferences;
    if(task.kind==="video")task.references=verifiedReferences.map(item=>item.frozen);
    const inferredMode=task.kind==="video"?task.mode:task.kind==="image"?task.mask?"inpaint":images.length?"reference_edit":"text_to_image":"text_to_speech";
    const size=/^(\d{1,5})x(\d{1,5})$/.exec(String(task.size??""));
    const parameters=task.kind==="video"?{duration_seconds:task.duration,resolution:task.resolution,aspect_ratio:task.ratio,generate_audio:task.generateAudio,watermark:task.watermark}:
     task.kind==="image"?{count:task.count,size:task.size,width:size?Number(size[1]):undefined,height:size?Number(size[2]):undefined,output_format:task.outputFormat,negative_prompt:task.negativePrompt}: {voice:task.voice,speed:task.speed,output_format:task.format,instructions:task.instructions};
    if(resolved){const errors=validateMediaRequest({mode:inferredMode,references:refs,parameters},resolved);
     if(errors.length)throw Object.assign(Error("media_capability_invalid"),{code:"media_capability_invalid",statusCode:422,diagnostics:errors});}
   }
  }
  // Validation of secretVersionRef occurs inside repository's write transaction,
  // preserving idempotent replies even if a version is later revoked.
  const result=submitJob(db,{...req.body,requireSkillGrant:true}),row=db.prepare("SELECT * FROM jobs WHERE id=?").get(result.jobId);
  reply.code(result.existing?200:201);return {...jobView(row),existing:result.existing};
 });
 if(coordinator)app.post("/api/v1/jobs/:id/cancel",{
  schema:{params:{type:"object",required:["id"],properties:{id:idSchema},additionalProperties:false},
   body:{type:"object",additionalProperties:false}}
 },async(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return coordinator.cancel(req.params.id);
 });
 // P4.6e: the Canvas Task History can cancel only a Job belonging to
 // its current project. The coordinator verifies this in its lease transaction.
 if(coordinator)app.post("/api/v1/projects/:id/jobs/:jobId/cancel",{
  schema:{params:{type:"object",required:["id","jobId"],
   properties:{id:idSchema,jobId:idSchema},additionalProperties:false},
   body:{type:"object",additionalProperties:false}}
 },async(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return coordinator.cancel(req.params.jobId,req.params.id);
 });

 if(coordinator)app.post("/api/v1/projects/:id/jobs/:jobId/reconcile",{
  schema:{
   params:{type:"object",required:["id","jobId"],
    properties:{id:idSchema,jobId:idSchema},additionalProperties:false},
   body:{type:"object",
    properties:{remoteTaskId:idSchema},additionalProperties:false}
  }
 },async(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return coordinator.reconcileUnknown({projectId:req.params.id,
   jobId:req.params.jobId,remoteTaskId:req.body.remoteTaskId});
 });
 // Explicit human asset reconciliation is distinct from remote video-task
 // reconciliation. Never repeat an ambiguous asset POST automatically.
 if(coordinator){
  const assetJobParams={type:"object",required:["id","jobId"],
   properties:{id:idSchema,jobId:idSchema},additionalProperties:false};
  app.get("/api/v1/projects/:id/jobs/:jobId/assets",{
   schema:{params:assetJobParams}
  },(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return listScriptAssetReconciliation(db,{projectId:req.params.id,jobId:req.params.jobId});
  });
  app.post("/api/v1/projects/:id/jobs/:jobId/assets/:referenceIndex/reconcile",{
   schema:{
    params:{type:"object",required:["id","jobId","referenceIndex"],
     properties:{id:idSchema,jobId:idSchema,
      referenceIndex:{type:"integer",minimum:0,maximum:11}},additionalProperties:false},
    body:{type:"object",required:["action","expectedUpdatedAt","operatorConfirmed"],
     properties:{action:{type:"string",enum:["confirm","reject"]},
      remoteAssetId:idSchema,expectedUpdatedAt:{type:"integer",minimum:1},
      operatorConfirmed:{type:"boolean",const:true}},additionalProperties:false}
   }
  },(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return reconcileScriptAsset(db,{projectId:req.params.id,jobId:req.params.jobId,
    referenceIndex:req.params.referenceIndex,...req.body});
  });
  app.post("/api/v1/projects/:id/jobs/:jobId/assets/:referenceIndex/audit-chunks",{
   schema:{
    params:{type:"object",required:["id","jobId","referenceIndex"],
     properties:{id:idSchema,jobId:idSchema,
      referenceIndex:{type:"integer",minimum:0,maximum:11}},additionalProperties:false},
    body:{type:"object",required:["expectedUpdatedAt"],
     properties:{expectedUpdatedAt:{type:"integer",minimum:1}},additionalProperties:false}
   }
  },async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return coordinator.reconcileChunkUpload({projectId:req.params.id,
    jobId:req.params.jobId,index:req.params.referenceIndex,
    expectedUpdatedAt:req.body.expectedUpdatedAt});
  });
  app.post("/api/v1/projects/:id/jobs/:jobId/resume-assets",{
   schema:{params:assetJobParams,body:{type:"object",additionalProperties:false}}
  },(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return resumeReconciledVideoJob(db,{projectId:req.params.id,jobId:req.params.jobId});
  });
 }
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
 if(comfyRegistry){
  const routeParams={type:"object",required:["id"],properties:{id:idSchema},additionalProperties:false};
  const instanceBody={type:"object",required:["id","url"],properties:{
   id:idSchema,url:{type:"string",minLength:1,maxLength:256}},additionalProperties:false};
  app.get("/api/v1/comfy/instances",async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return {instances:await comfyRegistry.checkedList()};
  });
  app.get("/api/v1/comfy/instances/:id/object-info",{schema:{params:routeParams}},async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return comfyRegistry.objectInfo(req.params.id);
  });
  app.post("/api/v1/comfy/instances",{schema:{body:instanceBody}},(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return {instance:comfyRegistry.save(req.body)};
  });
  app.put("/api/v1/comfy/instances/:id",{schema:{params:routeParams,body:instanceBody}},(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return {instance:comfyRegistry.save(req.body,req.params.id)};
  });
  app.delete("/api/v1/comfy/instances/:id",{schema:{params:routeParams}},(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return comfyRegistry.remove(req.params.id);
  });
 }
 app.get("/api/v1/execution/capabilities",()=>({autoDispatch:Boolean(worker),comfyInstanceIds:typeof comfyInstanceIds==="function"?comfyInstanceIds():[...comfyInstanceIds],
  arkAssetUploadReady:Boolean(arkAssetUploadReady),
  ...(modelKinds.length?{modelKinds:[...modelKinds]}:{})}));
 if(materializer){
  app.get("/api/v1/jobs/:id/materializations",{schema:{params:{type:"object",required:["id"],
   properties:{id:idSchema},additionalProperties:false}}},async(req,reply)=>{
   if(!db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id)){
    reply.code(404);return {code:"job_not_found",message:"job_not_found",requestId:req.id}
   }
   return {materializations:materializer.status({jobId:req.params.id})};
  });
  app.post("/api/v1/projects/:id/materializations/:artifactId/recover",{
   schema:{params:{type:"object",required:["id","artifactId"],
    properties:{id:idSchema,artifactId:idSchema},additionalProperties:false},
    body:{type:"object",additionalProperties:false}}
  },async(req,reply)=>{
   // Direct Materializer replay only. No Coordinator tick / provider submit.
   const recovered=await materializer.recoverPending({
    projectId:req.params.id,artifactId:req.params.artifactId});
   if(!recovered){
    reply.code(409);
    return {code:"materialization_not_pending",message:"materialization_not_pending",requestId:req.id};
   }
   reply.header("Cache-Control","no-store");
   return {artifactId:recovered.artifactId,status:recovered.status,
    reason:recovered.reason??null};
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
 app.get("/api/v1/projects/:id/jobs",{
  schema:{
   params:{type:"object",required:["id"],properties:{id:idSchema},additionalProperties:false},
   querystring:{type:"object",properties:{
    limit:{type:"integer",minimum:1,maximum:50},
    before:idSchema
   },additionalProperties:false}
  }
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return listProjectJobs(db,{projectId:req.params.id,
   limit:req.query.limit??20,before:req.query.before});
 });
 // A human must explicitly acknowledge possible remote billing before an
 // unverified model submit can stop blocking future new source-node requests.
 // Never re-submit or infer remote rejection from a previous connection error.
 app.post("/api/v1/projects/:id/jobs/:jobId/close-unverified",{
  schema:{params:{type:"object",required:["id","jobId"],
   properties:{id:idSchema,jobId:idSchema},additionalProperties:false},
   body:{type:"object",required:["confirmationJobId","expectedUpdatedAt","acknowledgePossibleCharge"],
    properties:{confirmationJobId:idSchema,expectedUpdatedAt:{type:"integer",minimum:0},
     acknowledgePossibleCharge:{type:"boolean",const:true}},additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return closeUnverifiedModelJob(db,{projectId:req.params.id,jobId:req.params.jobId,...req.body});
 });
 app.delete("/api/v1/projects/:id/jobs/:jobId/history",{
  schema:{params:{type:"object",required:["id","jobId"],
   properties:{id:idSchema,jobId:idSchema},additionalProperties:false}}
 },(req,reply)=>{
  reply.header("Cache-Control","no-store");
  return hideProjectJobHistory(db,{projectId:req.params.id,jobId:req.params.jobId});
 });
 if(blobStore){
  const projectSkillParams={type:"object",required:["id","jobId"],properties:{
   id:idSchema,jobId:idSchema},additionalProperties:false};
  app.get("/api/v1/projects/:id/jobs/:jobId/skill-audit",{
   schema:{params:projectSkillParams}
  },async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return getProjectSkillAudit(db,blobStore,{projectId:req.params.id,jobId:req.params.jobId});
  });
  app.get("/api/v1/projects/:id/jobs/:jobId/replay-status",{
   schema:{params:projectSkillParams,querystring:{
    type:"object",required:["idempotencyKey"],properties:{idempotencyKey:idSchema},
    additionalProperties:false
   }}
  },(req,reply)=>{
   reply.header("Cache-Control","no-store");
   return lookupProjectSkillReplay(db,{
    projectId:req.params.id,jobId:req.params.jobId,
    idempotencyKey:req.query.idempotencyKey
   });
  });
  app.post("/api/v1/projects/:id/jobs/:jobId/replay-skills",{
   schema:{params:projectSkillParams,
    body:{type:"object",required:["expectedProjectRevision","idempotencyKey","requestFingerprint"],
     properties:{expectedProjectRevision:{type:"integer",minimum:1},
      idempotencyKey:idSchema,requestFingerprint:idSchema},additionalProperties:false}}
  },async(req,reply)=>{
   reply.header("Cache-Control","no-store");
   const result=replayProjectSkillJob(db,{projectId:req.params.id,jobId:req.params.jobId,...req.body});
   const row=db.prepare("SELECT * FROM jobs WHERE id=?").get(result.jobId);
   reply.code(result.existing?200:201);
   return {...jobView(row),existing:result.existing};
  });
 }
 app.get("/api/v1/jobs/snapshot",()=>{
  const {jobs,eventCursor}=readJobsSnapshot(db);return {jobs:jobs.map(jobView),eventCursor};
 });
 app.get("/api/v1/jobs/:id",{schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}},async(req,reply)=>{
  const row=db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
  if(!row){reply.code(404);return{code:"job_not_found",message:"job_not_found",requestId:req.id}}
  return jobView(row);
 });
  app.get("/api/v1/jobs/:id/comfy-diagnostic",{
   schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}
  },(req,reply)=>{
   const job=db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id);
   if(!job){reply.code(404);return {code:"job_not_found"}}
   const row=db.prepare("SELECT payload_json FROM job_events WHERE job_id=? AND kind='job_comfy_error' ORDER BY seq DESC LIMIT 1").get(req.params.id);
   reply.header("Cache-Control","no-store");
   return {error:row?JSON.parse(row.payload_json):null};
  });
  if(comfyLive)app.get("/api/v1/jobs/:id/preview",{
   schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}
  },(req,reply)=>{
   const job=db.prepare("SELECT id,status FROM jobs WHERE id=?").get(req.params.id);
   if(!job){reply.code(404);return {code:"job_not_found"}}
   if(["succeeded","failed","cancelled","submission_unknown","blocked_credential","blocked"].includes(job.status)){
    comfyLive.disconnect(req.params.id);reply.code(404);return {code:"preview_not_found"};
   }
   const preview=comfyLive.getPreview?.(req.params.id);
   reply.header("Cache-Control","no-store");
   if(!preview){reply.code(404);return {code:"preview_not_found"}}
   reply.type(preview.mime).header("X-Preview-Version",String(preview.version));
   return reply.send(preview.bytes);
  });
  // Ephemeral ComfyUI progress: sampler frames and previews never enter SQLite.
  if(comfyLive)app.get("/api/v1/jobs/:id/live",{
   schema:{params:{type:"object",required:["id"],properties:{id:idSchema}}}
  },(req,reply)=>{
   const job=db.prepare("SELECT id FROM jobs WHERE id=?").get(req.params.id);
   if(!job){reply.code(404);return {code:"job_not_found"}}
   const raw=reply.raw;reply.hijack();
   raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store, no-cache, no-transform",
    "Connection":"keep-alive","X-Accel-Buffering":"no"});
   let closed=false;
   const off=comfyLive.subscribe(req.params.id,item=>{
    if(!closed&&!raw.destroyed&&raw.writableLength<524288)
     raw.write("event: live\ndata: "+JSON.stringify(item)+"\n\n");
   });
   raw.write(": connected\n\n");
   const timer=setInterval(()=>{
     if(closed)return;
     if(sessionAuth&&!sessionAuth.authorize(req)){closed=true;raw.end();return}
     if(raw.writableLength<524288)raw.write(": heartbeat\n\n");
    },15000);
   timer.unref?.();
   raw.on("close",()=>{closed=true;clearInterval(timer);off()});
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
