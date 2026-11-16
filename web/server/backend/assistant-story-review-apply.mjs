/** Explicit "apply this reviewed storyboard" request.
 * Read-only source selection + frozen Step planning. NO approval or Canvas
 * application occurs in this endpoint. Step execution has its own server gate.
 */
import {inspectAssistantStoryEventReview} from "./assistant-story-event-review.mjs";
import {planAssistantCanvasStep} from "./assistant-task-canvas-executor.mjs";
const fail=(code,statusCode=409)=>{throw Object.assign(Error(code),{code,statusCode})};
const id=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const hex=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
export function prepareReviewedStoryboardCanvasStep(db,{projectId,taskId,
 requestId,turnMessageId,snapshotDigest,center,confirmed}){
 if(!id(requestId)||!id(turnMessageId)||!hex(snapshotDigest)||confirmed!==true||
  !center||!Number.isFinite(center.x)||!Number.isFinite(center.y))
  fail("assistant_story_review_apply_invalid",400);
 const review=inspectAssistantStoryEventReview(db,{projectId,taskId,turnMessageId});
 if(review.snapshotDigest!==snapshotDigest)fail("assistant_story_review_snapshot_stale");
 if(!review.comparison.length)fail("assistant_story_review_no_candidates");
 if(review.comparison.some(item=>item.decision==="pending"))
  fail("assistant_story_review_decisions_pending");
 if(review.comparison.some(item=>item.decision==="request_revision"))
  fail("assistant_story_review_revision_requested");
 if(review.warnings.length)fail("assistant_story_review_warnings_unresolved");
 const command=db.prepare("SELECT status,response_json FROM assistant_task_commands WHERE project_id=? AND task_id=? AND request_id=? AND command_kind='model_infer'")
  .get(projectId,taskId,review.revision.requestId);
 let response;
 try{response=JSON.parse(command?.response_json)}catch{}
 if(command?.status!=="completed"||!id(response?.agentRunId)||
  !Array.isArray(response.actions)||response.actions.length>16)
  fail("assistant_story_review_agent_source_missing");
 const actions=response.actions.filter(a=>a?.type!=="run_node"&&a?.type!=="run_workflow");
 if(!actions.length||actions.some(a=>a?.type!=="create_text"&&
  !(a?.type==="create_node"&&a.nodeType==="text")))
  fail("assistant_story_review_apply_actions_invalid");
 // planAssistantCanvasStep performs the same review, source and action digest
 // validation INSIDE its own SQLite write transaction. A stale preflight
 // cannot race a new model/Graph/user-turn write into an accepted frozen Step.
 return planAssistantCanvasStep(db,{projectId,taskId,requestId,
  expectedPlanVersion:review.activePlanVersion,
  expectedProjectRevision:review.projectRevision,
  actions,center,agentRunId:response.agentRunId,
  storyReview:{turnMessageId,snapshotDigest,confirmed:true}});
}
