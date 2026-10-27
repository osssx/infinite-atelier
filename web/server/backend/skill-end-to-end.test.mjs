import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {openMainDatabase} from "./database.mjs";
import {buildApp} from "./app.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource,submitJob} from "./repository.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {calculateNormalizedSkillHash} from "./skill-package-integrity.mjs";
import {listSkillRegistry,registerSqliteSkill} from "./sqlite-skill-registry.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createOpenAiModelAdapter} from "./openai-model-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {loadFrozenSkillCatalog} from "./sqlite-skill-agent.mjs";
import {createColdBackup,restoreColdBackup,verifyColdBackup} from "./cold-backup.mjs";
const protect={protect:bytes=>Buffer.from(bytes),unprotect:bytes=>Buffer.from(bytes)};
const text="---\nname: shot-workflow\ndescription: Cinematic shot sequence\n---\nUse camera references";
const reference="35mm wide lenses and soft light";
const hash=calculateNormalizedSkillHash(new Map([
 ["SKILL.md",Buffer.from(text)],["references/camera.md",Buffer.from(reference)]
]));
const skill={
 manifest:{id:"shot-workflow",name:"shot-workflow",
  description:"Cinematic shot sequence",hash,version:hash.slice(0,12),
  resources:["references/camera.md"],warnings:[]},
 skillMd:text,resources:{"references/camera.md":reference}
};
const request=(app,method,url,payload)=>app.inject({
 method,url,headers:{"x-test-owner":"owner"},...(payload?{payload}:{})
});
function setup(t,upstream){
 const root=mkdtempSync(join(tmpdir(),"p54j-skill-e2e-"));
 const dataDir=join(root,"data"),db=openMainDatabase(dataDir);
 const blobStore=createBlobStore({db,dataDir});
 const vault=createCredentialVault({db,protector:protect});
 const channel=vault.create({id:"openai-test",provider:"openai",
  displayName:"Test Channel",apiKey:"E2E_FAKE_TOKEN_DO_NOT_SEND"});
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,upstreamCall:upstream});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 const app=buildApp({db,authorize:r=>r.headers["x-test-owner"]==="owner",blobStore});
 const document={nodes:[{id:"skill-text",type:"text",title:"Prompt",position:{x:0,y:0},
  width:320,height:200,metadata:{prompt:"Show a camera angle"}}],connections:[]};
 createProject(db,{id:"film-project",document});
 createProject(db,{id:"other-project",document});
 const register=()=>registerSqliteSkill(db,skill,listSkillRegistry(db).revision);
 const authorize=(projectId="film-project",extra={})=>request(app,"POST",
  "/api/v1/skills/authorized-catalog",{projectId,
   expectedRevision:listSkillRegistry(db).revision,
   skillIds:["shot-workflow"],versionPins:{"shot-workflow":hash.slice(0,12)},...extra});
 async function freeze(bundle){
  const json=JSON.stringify({format:"atelier-skill-snapshot-v1",entries:bundle.entries});
  return blobStore.put([Buffer.from(json)],{mime:"text/plain"});
 }
 function submit(cas,name){
  return submitJob(db,{projectId:"film-project",targetNodeId:"skill-text",
   expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(document,"skill-text"),
   executionMode:"immediate",idempotencyKey:name,requestFingerprint:name,
   snapshot:{adapterKind:"model",provider:"openai",channelId:channel.id,
    secretVersionRef:channel.keyVersion,task:{
     kind:"text",model:"gpt-4o-mini",prompt:"Show a camera angle",stream:false,
     messages:[{role:"user",content:"Show a camera angle"}],
     skills:{blobId:cas.blobId}
    }}
  }).jobId;
 }
 let shutdown=false;
 const close=async()=>{
  if(shutdown)return;
  shutdown=true;await app.close();db.close();
 };
 t.after(async()=>{await close();rmSync(root,{recursive:true,force:true})});
 return {root,dataDir,db,app,blobStore,vault,coordinator,document,register,authorize,freeze,submit,close};
}
const call=(id,name,args)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const response=(tools,text="")=>new Response(JSON.stringify({choices:[{
 finish_reason:tools.length?"tool_calls":"stop",
 message:{role:"assistant",content:text,tool_calls:tools}
}]}),{status:200,headers:{"content-type":"application/json"}});
test("P5.4j end-to-end SQLite registration -> HTTP authorization -> CAS -> tools -> artifact -> cold restore",async t=>{
 let calls=0;
 const f=setup(t,async(url,options)=>{
  assert.equal(url,"https://api.openai.com/v1/chat/completions");
  const body=JSON.parse(options.body);
  calls++;
  assert.equal(body.model,"gpt-4o-mini");
  assert.equal(options.headers.authorization,"Bearer E2E_FAKE_TOKEN_DO_NOT_SEND");
  if(calls===1)return response([call("act","activate_skill",{skill_id:"shot-workflow"})]);
  if(calls===2){
   assert.match(body.messages.at(-1).content,/Use camera references/);
   return response([call("ref","read_skill_resource",{
    skill_id:"shot-workflow",path:"references/camera.md"})]);
  }
  assert.equal(calls,3);
  assert.match(body.messages.at(-1).content,/35mm wide lenses/);
  return response([],"Lighting and camera shot list complete.");
 });
 f.register();
 const authorized=await f.authorize();
 assert.equal(authorized.statusCode,200,authorized.body);
 assert.equal(authorized.json().entries.length,1);
 assert.equal(authorized.json().entries[0].hash,hash);
 assert.equal(authorized.json().entries[0].skillMd,text);
 assert.ok(!authorized.body.includes("E2E_FAKE_TOKEN"));
 const cas=await f.freeze(authorized.json());
 const skillData=await loadFrozenSkillCatalog(f.blobStore,{blobId:cas.blobId});
 assert.equal(skillData.get("shot-workflow").resources["references/camera.md"],reference);
 const jobId=f.submit(cas,"from-verified-registry");
 f.coordinator.recoverAtStartup();
 await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
 assert.equal(calls,3);
 const artifact=f.db.prepare("SELECT blob_id FROM artifacts WHERE job_id=?").get(jobId);
 assert.ok(artifact);
 const output=await f.blobStore.stat(artifact.blob_id);
 assert.equal(await readFile(output.path,"utf8"),"Lighting and camera shot list complete.");
 const snapshot=f.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(jobId).snapshot_json;
 assert.ok(snapshot.includes(cas.blobId));
 assert.ok(!snapshot.includes(reference));
 assert.ok(!snapshot.includes("E2E_FAKE_TOKEN"));
 const events=f.db.prepare("SELECT payload_json FROM job_events WHERE job_id=?").all(jobId);
 assert.ok(events.some(e=>e.payload_json.includes("read_skill_resource")));
 assert.ok(!events.some(e=>e.payload_json.includes(reference)));
 await f.coordinator.tick();
 assert.equal(calls,3);
 const archive=join(f.root,"backup"),restored=join(f.root,"restored");
 // Backup APIs require all SQLite connections to be quiesced.
 await f.close();
 await createColdBackup({dataDir:f.dataDir,backupDir:archive});
 assert.equal((await verifyColdBackup({backupDir:archive})).schemaVersion,14);
 await restoreColdBackup({backupDir:archive,dataDir:restored});
 const db=new DatabaseSync(join(restored,"db","atelier.sqlite"),{readOnly:true});
 try{
  assert.equal(listSkillRegistry(db).skills.length,1);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"succeeded");
  const restoredStore=createBlobStore({db,dataDir:restored});
  const recovered=await loadFrozenSkillCatalog(restoredStore,{blobId:cas.blobId});
  assert.equal(recovered.get("shot-workflow").skillMd,text);
  const blob=await restoredStore.stat(artifact.blob_id);
  assert.equal(await readFile(blob.path,"utf8"),"Lighting and camera shot list complete.");
 }finally{db.close()}
});
test("P5.4j one read fence prevents disabled/out-of-scope/stale Skills before CAS upload",async t=>{
 const f=setup(t,async()=>{throw Error("must never call paid model")});
 f.register();
 const baseRev=listSkillRegistry(f.db).revision;
 const good=await f.authorize();assert.equal(good.statusCode,200);
 const wrongScope=await request(f.app,"PATCH","/api/v1/skills/shot-workflow",{
  expectedRevision:baseRev,action:"scope",scope:{type:"project",projectId:"other-project"}});
 assert.equal(wrongScope.statusCode,200,wrongScope.body);
 const afterScope=await f.authorize("film-project");
 assert.equal(afterScope.statusCode,409,afterScope.body);
 assert.equal(afterScope.json().code,"skill_authorization_changed");
 const other=await f.authorize("other-project");
 assert.equal(other.statusCode,200,other.body);
 const stale=await f.authorize("other-project",{expectedRevision:baseRev});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(stale.json().code,"skill_revision_conflict");
 const invalid=await f.authorize("not-existing-project");
 assert.equal(invalid.statusCode,404,invalid.body);
 const current=listSkillRegistry(f.db).revision;
 const disabled=await request(f.app,"PATCH","/api/v1/skills/shot-workflow",{
  expectedRevision:current,action:"enabled",enabled:false});
 assert.equal(disabled.statusCode,200,disabled.body);
 assert.equal((await f.authorize("other-project")).statusCode,409);
 const badVersion=await f.authorize("other-project",{versionPins:{"shot-workflow":"f".repeat(12)}});
 assert.equal(badVersion.statusCode,409);
 assert.equal((await f.app.inject({method:"POST",url:"/api/v1/skills/authorized-catalog",
  payload:{projectId:"film-project",expectedRevision:1,
   skillIds:["shot-workflow"],versionPins:{"shot-workflow":hash.slice(0,12)}}
 })).statusCode,401);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM blobs").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
});
test("P5.4j already frozen CAS can finish after registry deletion, but uncertain POST is never replayed",async t=>{
 let calls=0;
 const f=setup(t,async()=>{
  calls++;
  if(calls===1)return response([call("act","activate_skill",{skill_id:"shot-workflow"})]);
  throw Error("upstream accepted round two, connection reset");
 });
 f.register();
 const granted=await f.authorize();
 assert.equal(granted.statusCode,200,granted.body);
 const cas=await f.freeze(granted.json());
 const jobId=f.submit(cas,"uncertain-after-skill-delete");
 const removed=await request(f.app,"DELETE","/api/v1/skills/shot-workflow",{
  expectedRevision:listSkillRegistry(f.db).revision});
 assert.equal(removed.statusCode,200,removed.body);
 assert.equal(listSkillRegistry(f.db).skills.length,0);
 const existing=await loadFrozenSkillCatalog(f.blobStore,{blobId:cas.blobId});
 assert.equal(existing.get("shot-workflow").skillMd,text);
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"submission_unknown");
 await f.coordinator.tick();
 const restart=createJobCoordinator({db:f.db,adapters:{model:createOpenAiModelAdapter({
  db:f.db,blobStore:f.blobStore,vault:f.vault,
  upstreamCall:async()=>{calls++;throw Error("SHOULD_NOT_RETRY")}
 })}});
 restart.recoverAtStartup();await restart.tick();
 assert.equal(calls,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE job_id=?").get(jobId).n,0);
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId).status,"submission_unknown");
});
