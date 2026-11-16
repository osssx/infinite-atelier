import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,statSync,openSync,closeSync,unlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initP49E,inspectP49E,executeP49EStage,approveP49EStage,recoverP49E,
 exportP49EReviewSource} from "../../scripts/p49e-creative-stage.mjs";
import {initP49CReview,verifyP49CReview} from "../../scripts/p49c-human-review.mjs";
import {P49B_CASE} from "./assistant-creative-consistency.mjs";

const mock={mode:"mock",provider:"openai_compatible",model:"p49e-mock",
 baseUrl:"http://127.0.0.1:8188/v1"};
const live={mode:"live",provider:"openai_compatible",model:"test-model",
 channelId:"remote-1",baseUrl:"https://example.org/v1"};
const tests=[
 ["characters",3],["scenes",3],["storyboard",6],["revision",6]
];
const cleanup=t=>{const x=initP49E(mock);t.after(()=>rmSync(x.directory,{recursive:true,force:true}));return x.directory};
const mockResponse=actions=>new Response(JSON.stringify({choices:[{finish_reason:"stop",
 message:{content:JSON.stringify({answer:"待审核的草案",actions})}}]}),{status:200});

test("P4.9e four separate persistent Task rounds retain model drafts across process reopen and require explicit digest approval",async t=>{
 const directory=cleanup(t);
 const initial=inspectP49E(directory);
 assert.equal(initial.stages.length,0);
 assert.equal(initial.graphUnchanged,true);
 assert.throws(()=>exportP49EReviewSource(directory),/p49e_complete_review_evidence_required/);
 const before=statSync(join(directory,"summary.json")).mtimeMs;
 await new Promise(r=>setTimeout(r,5));
 inspectP49E(directory);
 assert.equal(statSync(join(directory,"summary.json")).mtimeMs,before,"read-only inspection must not rewrite a summary");
 for(let index=0;index<tests.length;index++){
  const [id,count]=tests[index];
  const last=await executeP49EStage(directory,mock,id);
  assert.equal(last.providerPosts,1);
  assert.equal(last.status.stages[index].status,"review_pending");
  assert.equal(last.status.stages[index].review.actualCount,count);
  assert.equal(last.status.stages[index].review.conclusion,"human_review_required");
  assert.equal(last.status.stages[index].modelCalls[0].status,"succeeded");
  assert.equal(last.status.graphUnchanged,true);
  assert.equal(last.status.jobs,0);
  await assert.rejects(executeP49EStage(directory,mock,id),/p49e_stage_already_reserved_no_replay/);
  assert.throws(()=>approveP49EStage(directory,id,"0".repeat(64)),/p49e_approval_requires_matching_evidence/);
  if(index+1<tests.length){
   await assert.rejects(executeP49EStage(directory,mock,tests[index+1][0]),/p49e_prior_human_approval_required/);
  }
  const approved=approveP49EStage(directory,id,last.status.stages[index].digest);
  assert.equal(approved.stages[index].status,"approved_for_continuation");
  assert.equal(approved.semanticVerdict,"human_review_required");
 }
 const final=inspectP49E(directory);
 assert.deepEqual(final.stages.map(s=>s.review.actualCount),[3,3,6,6]);
 assert.equal(final.stages.length,4);
 assert.equal(final.jobs,0);
 assert.equal(final.graphUnchanged,true);
 const reviewExport=exportP49EReviewSource(directory);
 assert.equal(reviewExport.stages,4);
 assert.equal(reviewExport.mode,"mock");
 const human=initP49CReview(reviewExport.reportPath);
 const check=verifyP49CReview(reviewExport.reportPath,human.reviewPath);
 assert.equal(check.qualityStatus,"draft");
 assert.equal(check.sourceMode,"mock");
 assert.equal(check.taskCompletionAuthorized,false);
 assert.throws(()=>exportP49EReviewSource(directory),error=>error.code==="EEXIST");
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"),{readOnly:true});
 try{
  const calls=db.prepare("SELECT call_kind,status FROM assistant_model_calls ORDER BY started_at").all();
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.status==="succeeded"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_task_chat_links").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='user_turn'").get().n,4);
 }finally{db.close()}
});
test("P4.9e ambiguous remote error is persisted across reopen, never retried, never advances later stage",async t=>{
 const directory=cleanup(t);
 let posts=0;
 const response=await executeP49EStage(directory,mock,"characters",{
  mockUpstreamCall:async()=>{posts++;throw Object.assign(new Error("private-token"),{code:"ECONNRESET"})}
 });
 assert.equal(posts,1);
 assert.equal(response.providerPosts,1);
 assert.equal(response.status.stages[0].status,"needs_reconcile");
 assert.equal(response.status.stages[0].modelCalls[0].status,"needs_reconcile");
 assert.equal(response.status.stages[0].modelCalls[0].diagnostic.category,"transport_disconnected");
 assert.equal(inspectP49E(directory).stages[0].status,"needs_reconcile");
 const recovered=recoverP49E(directory);
 assert.equal(recovered.stages[0].status,"needs_reconcile");
 await assert.rejects(executeP49EStage(directory,mock,"characters"),/p49e_stage_already_reserved_no_replay/);
 await assert.rejects(executeP49EStage(directory,mock,"scenes"),/p49e_prior_human_approval_required/);
 assert.equal(posts,1);
 assert.equal(recovered.graphUnchanged,true);
});
test("P4.9e remote 503 is unknown with durable HTTP provenance; no automatic retry",async t=>{
 const directory=cleanup(t);let calls=0;
 const result=await executeP49EStage(directory,mock,"characters",{
  mockUpstreamCall:async()=>{calls++;return new Response("upstream 503 private",{status:503})}
 });
 assert.equal(calls,1);
 assert.equal(result.status.stages[0].status,"needs_reconcile");
 assert.equal(result.status.stages[0].modelCalls[0].diagnostic.category,"http_server_error");
 assert.equal(result.status.stages[0].modelCalls[0].diagnostic.httpStatus,503);
 assert.doesNotMatch(JSON.stringify(result.status),/upstream 503 private/);
});
test("P4.9e persistent empty creative output allows one repair then fails closed",async t=>{
 const directory=cleanup(t);let posts=0;
 const result=await executeP49EStage(directory,mock,"characters",{
  mockUpstreamCall:async()=>{
   posts++;
   return mockResponse([{type:"create_text",ref:"empty",title:"小兔嘟嘟",
    content:"姓名：\n外貌：\n性格："}]);
  }
 });
 assert.equal(posts,2);
 assert.equal(result.status.stages[0].status,"rejected");
 assert.equal(result.status.stages[0].modelCalls.length,2);
 assert.equal(result.status.stages[0].failureCode,"assistant_creative_content_incomplete");
 assert.equal(result.status.graphUnchanged,true);
 await assert.rejects(executeP49EStage(directory,mock,"scenes"),/p49e_prior_human_approval_required/);
});
test("P4.9e manual recovery reconstructs a completed response from durable Task cache without new Provider POST",async t=>{
 const directory=cleanup(t),stage=await executeP49EStage(directory,mock,"characters");
 const db=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{db.prepare("UPDATE p49e_stages SET status='submitted',result_digest=NULL,review_json=NULL WHERE stage_index=0").run()}
 finally{db.close()}
 const repaired=recoverP49E(directory);
 assert.equal(repaired.stages[0].status,"review_pending");
 assert.equal(repaired.stages[0].digest,stage.status.stages[0].digest);
 assert.equal(repaired.stages[0].modelCalls.length,1);
 assert.equal(repaired.stages[0].modelCalls[0].status,"succeeded");
});
test("P4.9e pre-submit crash reservations stop, recover conservatively and never start a remote call",async t=>{
 const directory=cleanup(t),db=new DatabaseSync(join(directory,"acceptance.sqlite"));
 try{
  db.prepare("INSERT INTO p49e_stages(stage_index,stage_id,status,request_id,message_id) VALUES(0,'characters','reserved','provider-characters','user-characters')").run();
 }finally{db.close()}
 const restored=recoverP49E(directory);
 assert.equal(restored.stages[0].status,"held_for_manual_inspection");
 await assert.rejects(executeP49EStage(directory,mock,"characters"),/p49e_stage_already_reserved_no_replay/);
});
test("P4.9e frozen online configuration, writer lock, invalid directory, and live cost ack are enforced without outbound POST",async t=>{
 const directory=cleanup(t);
 await assert.rejects(executeP49EStage(directory,{...mock,model:"changed"},"characters"),/p49e_frozen_model_changed/);
 await assert.rejects(executeP49EStage(directory,{...live,ackCost:false},"characters"),/p49e_paid_stage_requires_explicit_ack/);
 const lock=join(directory,".single-writer.lock"),fd=openSync(lock,"wx");
 try{await assert.rejects(executeP49EStage(directory,mock,"characters"),/p49e_run_locked/)}
 finally{closeSync(fd);unlinkSync(lock)}
 const randomFolder=mkdtempSync(join(tmpdir(),"ordinary-file-"));
 t.after(()=>rmSync(randomFolder,{recursive:true,force:true}));
 await assert.rejects(executeP49EStage(randomFolder,mock,"characters"));
 assert.equal(inspectP49E(directory).stages.length,0);
});
test("P4.9e encrypted online credential rotation invalidates frozen stage even with cost ack",async t=>{
 const fixed={...live,credentialVersion:"encrypted-v1"};
 const initial=initP49E(fixed);
 t.after(()=>rmSync(initial.directory,{recursive:true,force:true}));
 await assert.rejects(executeP49EStage(initial.directory,{
  ...fixed,credentialVersion:"encrypted-v2",ackCost:true,secret:"test-only"
 },"characters"),/p49e_frozen_model_changed/);
 assert.equal(inspectP49E(initial.directory).stages.length,0);
});
test("P4.9e isolated live init never submits a POST or requires consent, but each new paid stage must",async t=>{
 const result=initP49E(live);t.after(()=>rmSync(result.directory,{recursive:true,force:true}));
 assert.equal(inspectP49E(result.directory).mode,"live");
 await assert.rejects(executeP49EStage(result.directory,live,"characters"),
  /p49e_paid_stage_requires_explicit_ack/);
 assert.equal(inspectP49E(result.directory).stages.length,0);
});
