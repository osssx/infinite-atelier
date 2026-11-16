import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn,changeAssistantTaskSemantic} from "./assistant-tasks.mjs";
import {buildApp} from "./app.mjs";
import {inspectAssistantStoryEventReview} from "./assistant-story-event-review.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const secret="PRIVATE_STORY_CANVAS_CONTENT_NOT_AUTHORIZED";
const empty={includeContext:false,scope:"selection",includedIds:[]};
const selected={includeContext:true,scope:"selection",includedIds:["private"]};
const response=actions=>new Response(JSON.stringify({choices:[{
 finish_reason:"stop",message:{content:JSON.stringify({answer:"已生成未确认草案",actions})}
}]}),{status:200});
const cards=(which)=>{
 const s=[
  {title:"分镜1·晨光森林",body:"小兔嘟嘟在晨光森林发现遗失星星，大家欢呼"},
  {title:"分镜2·暴雨石桥",body:"三人冒着雨帮助迷路的小动物安全过桥"},
  {title:"分镜3·雨后草地",body:"小兔嘟嘟把星星轻轻放回天空，大家团聚"}
 ];
 const r=[
  {title:"修订分镜1·晨光森林",body:"小兔嘟嘟在森林发现星星，大家挥手"},
  {title:"修订分镜2·暴雨石桥",body:"小龟慢慢帮助迷路的小动物安全过桥"},
  {title:"修订分镜3·雨后草地",body:"小兔嘟嘟把星星举起来，大家在夜空下团聚"}
 ];
 const good=[
  r[0],r[1],{title:r[2].title,body:"小兔嘟嘟将星星送回天上，大家团聚"}
 ];
 return (which==="original"?s:which==="complete"?good:r)
  .map((x,i)=>({type:"create_text",ref:which+i,title:x.title,
   content:"景别：中景。\n动作："+x.body+"。\n连续性：保持原剧情和角色关系。"}));
};
const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
 withSecretVersion:(_v,fn)=>fn(Buffer.from("placeholder-fixture-key"))};
async function setup(t,{sourcePolicy=empty,currentPolicy=empty,sourceActions=cards("original"),
 revisedActions=cards("omitted")}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const projectId="p49i";
 createProject(db,{id:projectId,document:{nodes:[
  {id:"private",type:"text",title:"隐藏设定",metadata:{content:secret}}
 ],connections:[]}});
 const task=createAssistantTask(db,{projectId,chatSessionId:"chat",rootMessageId:"root",
  originalRequest:"制作儿童动画三镜头分镜",requestId:"create-p49i",contextPolicy:sourcePolicy}).task;
 let count=0;
 const app=buildApp({db,authorize:()=>true,
  assistantChat:createAssistantChatService({vault,maxRetries:0,
   compatibleUpstreamCall:async()=>response(count++===0?sourceActions:revisedActions)})});
 t.after(async()=>{await app.close();db.close()});
 const uri="/api/v1/projects/"+projectId+"/assistant";
 const turn=async(messageId,text,policy,requestId)=>{
  appendAssistantTaskTurn(db,{projectId,taskId:task.id,requestId:"turn-"+messageId,
   messageId,text,contextPolicy:policy});
  const result=await app.inject({method:"POST",url:uri+"/chat",payload:{
   channelId:"c",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",
   model:"mock",canvasActions:true,messages:[{role:"user",content:text}],
   task:{taskId:task.id,turnMessageId:messageId,requestId}}});
  assert.equal(result.statusCode,200,result.body);
 };
 await turn("original-turn","创建三张分镜文本节点",sourcePolicy,"original-call");
 await turn("revision-turn","请修订分镜并创建3个新的修订分镜文本节点，强化暴雨协作",currentPolicy,"revision-call");
 const base=uri+"/tasks/"+task.id+"/story-events/review";
 const preview=async(turnMessageId="revision-turn")=>{
  const res=await app.inject({method:"GET",url:base+"?turnMessageId="+turnMessageId});
  return {status:res.statusCode,body:res.json(),headers:res.headers};
 };
 const decide=async(body)=>{const res=await app.inject({method:"POST",url:base,payload:body});
  return {status:res.statusCode,body:res.json()}};
 return {db,app,taskId:task.id,projectId,base,uri,turn,preview,decide,get posts(){return count}};
}
const decision=(preview,eventId="star_returns_to_sky",requestId="decide-1",choice="request_revision")=>({
 requestId,turnMessageId:"revision-turn",snapshotDigest:preview.snapshotDigest,
 eventId,decision:choice,confirmed:true
});

test("P4.9i HTTP preview freezes source + revision and exposes omission without requiring another model POST",async t=>{
 const f=await setup(t);
 const direct=inspectAssistantStoryEventReview(f.db,{projectId:f.projectId,taskId:f.taskId,turnMessageId:"revision-turn"});
 assert.ok(direct.snapshotDigest);
 const r=await f.preview();
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.match(r.headers["cache-control"],/no-store/);
 const v=r.body;
 assert.equal(v.kind,"story_event_editorial_review");
 assert.equal(v.snapshotDigest.length,64);
 assert.notEqual(v.source.digest,v.revision.digest);
 assert.equal(v.reviewStatus,"pending");
 assert.deepEqual(v.sourceEvents.map(x=>x.id),[
  "star_found_in_forest","lost_animal_rescued_at_bridge","star_returns_to_sky"
 ]);
 assert.ok(v.comparison.some(x=>x.eventId==="star_returns_to_sky"&&
  x.revisionShotIndex===null&&x.warnings.includes("prior_story_action_not_observed")));
 assert.equal(v.canvasExecutionAuthorized,false);
 assert.equal(v.taskCompletionAuthorized,false);
 assert.equal(v.userConfirmed,false);
 assert.equal(v.semanticReview,"pending");
 assert.equal(f.posts,2);
 assert.doesNotMatch(JSON.stringify(v),/PRIVATE_STORY_CANVAS_CONTENT_NOT_AUTHORIZED/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
});
test("P4.9i explicit editorial review is event-level, persisted and idempotent but cannot change user facts or Canvas",async t=>{
 const f=await setup(t);
 const before=(await f.preview()).body;
 const d=decision(before);
 const first=await f.decide(d);
 assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal(first.body.decision,"request_revision");
 assert.equal(first.body.current,true);
 assert.equal(first.body.existing,false);
 assert.equal(first.body.canvasExecutionAuthorized,false);
 const duplicate=await f.decide(d);
 assert.equal(duplicate.status,200);
 assert.equal(duplicate.body.existing,true);
 const sameWithNewId=await f.decide({...d,requestId:"new-request-id"});
 assert.equal(sameWithNewId.status,409);
 assert.equal(sameWithNewId.body.code,"assistant_story_review_decision_conflict");
 const after=(await f.preview()).body;
 assert.equal(after.reviewed.length,1);
 assert.equal(after.reviewed[0].eventId,"star_returns_to_sky");
 assert.equal(after.reviewed[0].decision,"request_revision");
 assert.equal(after.comparison.find(x=>x.eventId==="star_returns_to_sky").decision,"request_revision");
 assert.equal(after.reviewStatus,"pending");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='story_event_review_decided'").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_commands WHERE command_kind='story_event_review_decision'").get().n,1);
 const taskRow=f.db.prepare("SELECT goal_json,constraints_json,read_only FROM assistant_tasks WHERE id=?").get(f.taskId);
 assert.equal(JSON.parse(taskRow.constraints_json).semantic?.revision??0,0);
 assert.equal(JSON.parse(taskRow.goal_json).current,undefined);
 assert.equal(f.posts,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_steps").get().n,0);
});
test("P4.9i forged event/snapshot, conflicting replay, omitted confirmation, and cross-project scope fail closed",async t=>{
 const f=await setup(t);
 const v=(await f.preview()).body;
 for(const body of [
  {...decision(v),eventId:"admin_override"},
  {...decision(v),snapshotDigest:"f".repeat(64)},
  {...decision(v),confirmed:false},
  {...decision(v),decision:"allow_canvas_execution"}
 ]){
  const r=await f.decide(body);
  assert.ok(r.status>=400,JSON.stringify(r));
 }
 const first=await f.decide(decision(v));
 assert.equal(first.status,200);
 const tampered=await f.decide({...decision(v),decision:"acknowledge_candidate"});
 assert.equal(tampered.status,409);
 const other=await f.app.inject({method:"GET",url:"/api/v1/projects/another/assistant/tasks/"+
  f.taskId+"/story-events/review?turnMessageId=revision-turn"});
 assert.equal(other.statusCode,404);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='story_event_review_decided'").get().n,1);
});
test("P4.9i a stale project revision invalidates review; prior idempotency only returns current=false",async t=>{
 const f=await setup(t),v=(await f.preview()).body;
 const d=decision(v);
 assert.equal((await f.decide(d)).status,200);
 f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(f.projectId);
 const stale=await f.decide({...d,requestId:"decision-stale"});
 assert.equal(stale.status,409);
 assert.equal(stale.body.code,"assistant_story_review_snapshot_stale");
 const old=await f.decide(d);
 assert.equal(old.status,200);
 assert.equal(old.body.existing,true);
 assert.equal(old.body.current,false);
 const newPreview=await f.preview();
 assert.equal(newPreview.status,200);
 assert.notEqual(newPreview.body.snapshotDigest,v.snapshotDigest);
 assert.equal(newPreview.body.reviewed.length,0);
 assert.equal(newPreview.body.reviewStatus,"pending");
});
test("P4.9i newer user turn and narrowed disclosure cannot reuse earlier revision reviews",async t=>{
 const f=await setup(t);
 const v=(await f.preview()).body;
 const r=await f.decide(decision(v));
 assert.equal(r.status,200);
 appendAssistantTaskTurn(f.db,{projectId:f.projectId,taskId:f.taskId,
  requestId:"third-turn",messageId:"third-turn",text:"继续其他工作",
  contextPolicy:empty});
 const stale=await f.preview();
 assert.equal(stale.status,409);
 assert.equal(stale.body.code,"assistant_story_review_turn_stale");
 const replay=await f.decide(decision(v));
 assert.equal(replay.status,200);
 assert.equal(replay.body.current,false);
 const other=await f.decide({...decision(v),requestId:"new-on-stale"});
 assert.equal(other.status,409);
});
test("P4.9i narrowing scope hides historical model source, and same-Task review never authorizes it",async t=>{
 const f=await setup(t,{sourcePolicy:selected,currentPolicy:empty});
 const r=await f.preview();
 assert.equal(r.status,409);
 assert.equal(r.body.code,"assistant_story_review_source_missing");
 assert.equal(f.posts,2);
});
test("P4.9i a complete revision may be acknowledged for editorial review but is NEVER a Task completion grant",async t=>{
 const f=await setup(t,{revisedActions:cards("complete")});
 const v=(await f.preview()).body;
 assert.equal(v.warnings.length,0);
 assert.ok(v.comparison.find(x=>x.eventId==="star_returns_to_sky").detected);
 const reply=await f.decide(decision(v,"star_returns_to_sky","decision-complete","acknowledge_candidate"));
 assert.equal(reply.status,200);
 assert.equal(reply.body.canvasExecutionAuthorized,false);
 assert.equal(reply.body.taskCompletionAuthorized,false);
 assert.equal((await f.preview()).body.semanticReview,"pending");
});

test("P4.9i undecided or unknown current Provider model call blocks snapshot generation without any replay",async t=>{
 const f=await setup(t),before=f.posts;
 f.db.prepare("UPDATE assistant_task_commands SET status='needs_reconcile' WHERE request_id='revision-call'").run();
 const r=await f.preview();
 assert.equal(r.status,409);
 assert.equal(r.body.code,"assistant_story_review_model_unresolved");
 assert.equal(f.posts,before);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='story_event_review_decided'").get().n,0);
});
test("P4.9i an old model response created after a new user turn is not usable as frozen prior evidence",async t=>{
 const f=await setup(t);
 const command=f.db.prepare("SELECT payload_digest FROM assistant_task_commands WHERE request_id='original-call'").get();
 // An inconsistent late command binding cannot make a future response look
 // like a prior Task turn; latest server audit seq supersedes its old binding.
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'model_command_started',?,?)")
  .run(f.taskId,JSON.stringify({requestId:"original-call",requestDigest:command.payload_digest,
   turnMessageId:"original-turn"}),Date.now());
 const r=await f.preview();
 assert.equal(r.status,409);
 assert.equal(r.body.code,"assistant_story_review_source_missing");
});
test("P4.9i a prior pinned private creative source cannot leak into current unpinned review",async t=>{
 const f=await setup(t);
 f.db.prepare("INSERT INTO assistant_task_events(task_id,kind,payload_json,created_at) VALUES(?,'creative_sources_selected',?,?)")
  .run(f.taskId,JSON.stringify({turnMessageId:"original-turn",references:[{kind:"story",
   sourceRef:"private",sourceDigest:"f".repeat(64)}]}),Date.now());
 const r=await f.preview();
 assert.equal(r.status,409);
 assert.equal(r.body.code,"assistant_story_review_source_missing");
 assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_STORY_CANVAS_CONTENT_NOT_AUTHORIZED/);
});
test("P4.9i server does not trust preview after candidate model response bytes change",async t=>{
 const f=await setup(t),before=(await f.preview()).body;
 f.db.prepare("UPDATE assistant_task_commands SET response_json=? WHERE request_id='revision-call'").run(
  JSON.stringify({answer:"new response",actions:cards("complete")}));
 const next=(await f.preview()).body;
 assert.notEqual(next.snapshotDigest,before.snapshotDigest);
 assert.equal(next.warnings.length,0);
 const reject=await f.decide(decision(before));
 assert.equal(reject.status,409);
 assert.equal(reject.body.code,"assistant_story_review_snapshot_stale");
});

function addFrozenAgentStep(db,taskId,projectId,{corrupt=false,stepId="review-step"}={}){
 const row=db.prepare("SELECT response_json FROM assistant_task_commands WHERE task_id=? AND request_id='revision-call'").get(taskId);
 const response=JSON.parse(row.response_json);
 const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
 const binding={
  runId:"storyboard-agent-run",requestId:"revision-call",planVersion:1,
  responseDigest:digest(response),actionsDigest:digest(response.actions)
 };
 const action={actions:response.actions,center:{x:0,y:0},
  agentRunId:binding.runId,agentOutputDigest:binding.responseDigest,
  agentActionsDigest:binding.actionsDigest};
 const revision=db.prepare("SELECT revision FROM projects WHERE id=?").get(projectId).revision;
 const pre={projectRevision:revision,agentRunBinding:binding};
 if(corrupt)pre.agentRunBinding.actionsDigest="f".repeat(64);
 db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,status,required,depends_on_json,action_json,action_digest,preconditions_json,approval_json,receipt_json,receipt_trust,result_json,created_at,updated_at) VALUES(?,?,1,0,'canvas_mutation','waiting_approval',1,'[]',?,?,?,'{}','{}','none','{}',?,?)")
  .run(stepId,taskId,stableJson(action),digest(action),stableJson(pre),Date.now(),Date.now());
 return {stepId,actionDigest:digest(action)};
}
test("P4.9j read-only preflight verifies a frozen step bound to the exact revision output but grants no execution",async t=>{
 const f=await setup(t,{revisedActions:cards("complete")});
 let review=(await f.preview()).body;
 const frozen=addFrozenAgentStep(f.db,f.taskId,f.projectId);
 const url=f.base+"/preflight?turnMessageId=revision-turn&snapshotDigest="+review.snapshotDigest+"&stepId="+frozen.stepId;
 let before=await f.app.inject({method:"GET",url});
 assert.equal(before.statusCode,200,before.body);
 assert.equal(before.json().verified,false);
 assert.equal(before.json().reason,"editorial_decisions_pending");
 for(const event of review.comparison){
  const v=await f.decide(decision(review,event.eventId,"review-"+event.eventId,"acknowledge_candidate"));
  assert.equal(v.status,200,v.body);
 }
 review=(await f.preview()).body;
 assert.equal(review.reviewStatus,"recorded_only");
 const passed=await f.app.inject({method:"GET",url});
 assert.equal(passed.statusCode,200,passed.body);
 assert.equal(passed.json().verified,true);
 assert.equal(passed.json().stepActionDigest,frozen.actionDigest);
 assert.equal(passed.json().canvasExecutionAuthorized,false);
 assert.equal(passed.json().taskCompletionAuthorized,false);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_attempts").get().n,0);
 assert.equal(f.posts,2);
});
test("P4.9j preflight rejects unresolved original story warnings, altered frozen binding, and stale snapshot",async t=>{
 const f=await setup(t);
 let review=(await f.preview()).body;
 const frozen=addFrozenAgentStep(f.db,f.taskId,f.projectId,{corrupt:true});
 const target=f.base+"/preflight?turnMessageId=revision-turn&snapshotDigest="+review.snapshotDigest+"&stepId="+frozen.stepId;
 let missing=await f.app.inject({method:"GET",url:target});
 assert.equal(missing.statusCode,200,missing.body);
 assert.equal(missing.json().reason,"editorial_decisions_pending");
 for(const event of review.comparison){
  const v=await f.decide(decision(review,event.eventId,"review-"+event.eventId,"acknowledge_candidate"));
  assert.equal(v.status,200,v.body);
 }
 missing=await f.app.inject({method:"GET",url:target});
 assert.equal(missing.json().verified,false);
 assert.equal(missing.json().reason,"story_event_warnings_unresolved");
 f.db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(f.projectId);
 const stale=await f.app.inject({method:"GET",url:target});
 assert.equal(stale.statusCode,409);
 assert.equal(stale.json().code,"assistant_story_review_snapshot_stale");
});
test("P4.9j preflight never treats a mismatched agent output as the user-approved revision",async t=>{
 const f=await setup(t,{revisedActions:cards("complete")});
 const review=(await f.preview()).body;
 const frozen=addFrozenAgentStep(f.db,f.taskId,f.projectId,{corrupt:true});
 for(const event of review.comparison){
  assert.equal((await f.decide(decision(review,event.eventId,"review-"+event.eventId,"acknowledge_candidate"))).status,200);
 }
 const res=await f.app.inject({method:"GET",url:f.base+"/preflight?turnMessageId=revision-turn&snapshotDigest="+review.snapshotDigest+"&stepId="+frozen.stepId});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(res.json().verified,false);
 assert.equal(res.json().reason,"step_source_not_bound");
});
test("P4.9i stale semantic revision invalidates snapshot even if model drafts and graph remain unchanged",async t=>{
 const f=await setup(t),v=(await f.preview()).body;
 changeAssistantTaskSemantic(f.db,{projectId:f.projectId,taskId:f.taskId,
  requestId:"semantic-change",expectedRevision:0,operation:"add_decision",
  text:"以新版本的故事结尾为准",confirmed:true,contextPolicy:empty});
 const bad=await f.decide(decision(v));
 assert.equal(bad.status,409);
 assert.equal(bad.body.code,"assistant_story_review_snapshot_stale");
});
