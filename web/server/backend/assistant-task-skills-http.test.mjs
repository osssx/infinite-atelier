import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {zipSync,strToU8} from "fflate";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema} from "./schema.mjs";
import {createProject} from "./projects.mjs";
import {buildApp} from "./app.mjs";
import {createBlobStore} from "./blob-store.mjs";

function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 createProject(db,{id:"p",document:{nodes:[],connections:[]}});
 const path="scripts/generate.js",version="abc123def456",id="fixture-skill";
 const archive=Buffer.from(zipSync({
  "SKILL.md":strToU8("---\nname: Fixture\ndescription: fixed script\n---\n"),
  [path]:strToU8('const fs=require("node:fs");fs.writeFileSync("output.txt","actual-script-result");console.log("done");')
 })).toString("base64");
 const registry={
  list:()=>({skills:[{id,enabled:true,versions:[version]}]}),
  get:()=>({package:{manifest:{hash:version+"1".repeat(52)},sourceArchiveBase64:archive}})
 };
 const root=mkdtempSync(join(tmpdir(),"atelier-task-skill-http-"));
 const app=buildApp({db,skillRegistry:registry,blobStore:createBlobStore({db,dataDir:root}),authorize:()=>true});
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true})});
 const call=async(method,url,payload)=>{
  const response=await app.inject({method,url,...(payload!==undefined?{payload}:{})});
  return {status:response.statusCode,body:response.json()};
 };
 return {db,call,scriptPath:path,skillId:id,version,base:"/api/v1/projects/p/assistant/tasks"};
}
test("P2b Skill HTTP plan/approval/process/run-record/replay without a second spawn",async t=>{
 const f=fixture(t);
 const created=await f.call("POST",f.base,{
  requestId:"create",chatSessionId:"c",rootMessageId:"r",originalRequest:"生成一个文字产物"});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const taskUrl=f.base+"/"+created.body.task.id;
 const proposal={skill_id:f.skillId,version:f.version,script_path:f.scriptPath,
  output_files:["output.txt"]};
 const planned=await f.call("POST",taskUrl+"/skill-steps",{
  requestId:"plan",expectedPlanVersion:1,expectedProjectRevision:1,
  proposal,finalizeTask:true});
 assert.equal(planned.status,200,JSON.stringify(planned.body));
 assert.equal(planned.body.status,"waiting_approval");
 const stepUrl=taskUrl+"/steps/"+planned.body.stepId;
 const input={requestId:"run",expectedPlanVersion:1,actionDigest:planned.body.actionDigest};
 assert.equal((await f.call("POST",stepUrl+"/run-skill",input)).status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,0);
 const approval=await f.call("POST",stepUrl+"/approval",{
  requestId:"approval",expectedPlanVersion:1,actionDigest:planned.body.actionDigest,decision:"approve"});
 assert.equal(approval.status,200,JSON.stringify(approval.body));
 const completed=await f.call("POST",stepUrl+"/run-skill",input);
 assert.equal(completed.status,200,JSON.stringify(completed.body));
 assert.equal(completed.body.status,"completed");
 assert.equal(completed.body.exit_code,0);
 assert.equal(completed.body.artifacts[0].content,"actual-script-result");
 const runId=completed.body.run_id;
 const history=await f.call("GET","/api/v1/skills/runs/"+runId);
 assert.equal(history.status,200,JSON.stringify(history.body));
 assert.equal(history.body.status,"completed");
 const replay=await f.call("POST",stepUrl+"/run-skill",input);
 assert.equal(replay.status,200,JSON.stringify(replay.body));
 assert.equal(replay.body.runId,runId);
 assert.equal(replay.body.shouldLaunch,false);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,1);
 assert.equal((await f.call("GET",taskUrl)).body.task.status,"completed");
 assert.equal((await f.call("GET",taskUrl)).body.task.steps[0].receiptTrust,"server_committed");
 const clash=await f.call("POST",stepUrl+"/run-skill",{
  ...input,actionDigest:"f".repeat(64)});
 assert.equal(clash.status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,1);
});
test("P2b frozen Skill rejected by HTTP when version does not exist",async t=>{
 const f=fixture(t);
 const created=await f.call("POST",f.base,{
  requestId:"create",chatSessionId:"c",rootMessageId:"r",originalRequest:"生成"});
 const taskUrl=f.base+"/"+created.body.task.id;
 const invalid=await f.call("POST",taskUrl+"/skill-steps",{
  requestId:"invalid",expectedPlanVersion:1,expectedProjectRevision:1,
  proposal:{skill_id:f.skillId,version:"fff111eee222",script_path:f.scriptPath}});
 assert.equal(invalid.status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,0);
});
