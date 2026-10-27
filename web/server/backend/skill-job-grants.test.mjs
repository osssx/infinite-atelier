import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openMainDatabase} from "./database.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {buildApp} from "./app.mjs";
import {createProject} from "./projects.mjs";
import {fingerprintSource} from "./repository.mjs";
import {listSkillRegistry,registerSqliteSkill} from "./sqlite-skill-registry.mjs";
import {calculateNormalizedSkillHash} from "./skill-package-integrity.mjs";
import {loadFrozenSkillCatalog} from "./sqlite-skill-agent.mjs";
import {createOpenAiModelAdapter} from "./openai-model-adapter.mjs";
import {createJobCoordinator} from "./job-coordinator.mjs";
import {createColdBackup,restoreColdBackup,verifyColdBackup} from "./cold-backup.mjs";
import {DatabaseSync} from "node:sqlite";
import {readFile} from "node:fs/promises";
import {createCredentialVault} from "./credential-vault.mjs";

const bad=(response,code)=>{assert.equal(response.json().code,code,response.body);assert.notEqual(response.statusCode,200)};
const md="---\nname: film-shot\ndescription: Lighting checklist\n---\nInstructions for filming";
const reference="Use the 35mm lens";
const digest=calculateNormalizedSkillHash(new Map([
 ["SKILL.md",Buffer.from(md)],["references/lighting.md",Buffer.from(reference)]
]));
const pkg={manifest:{id:"film-shot",name:"film-shot",description:"Lighting checklist",
 hash:digest,version:digest.slice(0,12),resources:["references/lighting.md"],warnings:[]},
 skillMd:md,resources:{"references/lighting.md":reference}};
function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),"p54k-grants-"));
 const db=openMainDatabase(join(parent,"data"));
 const blobStore=createBlobStore({dataDir:join(parent,"data"),db});
 const vault=createCredentialVault({db,protector:{
  protect:b=>Buffer.from(b),unprotect:b=>Buffer.from(b)
 }});
 const channel=vault.create({id:"official",provider:"openai",displayName:"Official",
  apiKey:"fixture-only"});
 const doc={nodes:[{id:"skill-src",type:"text",title:"Skill",
  position:{x:0,y:0},width:300,height:200,metadata:{prompt:"Camera shots"}}],connections:[]};
 for(const id of ["project-a","project-b"])createProject(db,{id,document:doc});
 registerSqliteSkill(db,pkg,listSkillRegistry(db).revision);
 let upstreamCalls=0;
 const adapter=createOpenAiModelAdapter({db,blobStore,vault,upstreamCall:async()=>{
  upstreamCalls++;
  const tc=[{id:"s1",type:"function",function:{name:"activate_skill",
   arguments:JSON.stringify({skill_id:"film-shot"})}}];
  const message=upstreamCalls===1?{role:"assistant",content:"",tool_calls:tc}:
   {role:"assistant",content:"Final authorized shots.",tool_calls:[]};
  return new Response(JSON.stringify({choices:[{
   finish_reason:upstreamCalls===1?"tool_calls":"stop",message
  }]}),{status:200});
 }});
 const coordinator=createJobCoordinator({db,adapters:{model:adapter}});
 const app=buildApp({db,blobStore,authorize:req=>req.headers["x-test-owner"]==="owner"});
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;await app.close();db.close()};
 t.after(async()=>{await close();rmSync(parent,{recursive:true,force:true})});
 const call=(method,url,payload)=>app.inject({method,url,headers:{"x-test-owner":"owner"},...(payload?{payload}:{})});
 const revision=()=>listSkillRegistry(db).revision;
 const selection=(projectId="project-a")=>({projectId,
  expectedRevision:revision(),skillIds:["film-shot"],versionPins:{"film-shot":digest.slice(0,12)}});
 const freeze=async()=>call("POST","/api/v1/skills/freeze",selection());
 const job=(authorization,scope="project-a",key="test-job")=>({
  projectId:scope,targetNodeId:"skill-src",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc,"skill-src"),
  idempotencyKey:key,requestFingerprint:key,executionMode:"immediate",
  ...(authorization?{skillAuthorizationId:authorization.authorizationId}:{}),
  snapshot:{adapterKind:"model",provider:"openai",channelId:channel.id,
   secretVersionRef:channel.keyVersion,
   task:{kind:"text",model:"gpt-4o-mini",prompt:"Camera shots",stream:false,
    messages:[{role:"user",content:"Camera shots"}],
    skills:{blobId:authorization?.blobId??"a".repeat(64)}}}
 });
 return {db,blobStore,call,selection,freeze,job,revision,coordinator,close,
  root:parent,getUpstreamCalls:()=>upstreamCalls};
}
test("P5.4k server freeze writes verifiable CAS and one-use project grant",async t=>{
 const f=fixture(t);
 const freeze=await f.freeze();assert.equal(freeze.statusCode,200,freeze.body);
 const ticket=freeze.json();
 assert.match(ticket.blobId,/^[a-f0-9]{64}$/);
 assert.match(ticket.authorizationId,/^[0-9a-f-]{36}$/);
 assert.ok(!freeze.body.includes(reference));
 const catalog=await loadFrozenSkillCatalog(f.blobStore,{blobId:ticket.blobId});
 assert.equal(catalog.get("film-shot").resources["references/lighting.md"],reference);
 const absent=await f.call("POST","/api/v1/jobs",f.job(null));
 bad(absent,"skill_grant_required");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 const altered=await f.call("POST","/api/v1/jobs",{
  ...f.job(ticket),snapshot:{...f.job(ticket).snapshot,task:{
   ...f.job(ticket).snapshot.task,skills:{blobId:"a".repeat(64)}}}
 });
 bad(altered,"skill_grant_invalid");
 const wrongProject=await f.call("POST","/api/v1/jobs",f.job(ticket,"project-b"));
 bad(wrongProject,"skill_grant_invalid");
 const accepted=await f.call("POST","/api/v1/jobs",f.job(ticket));
 assert.equal(accepted.statusCode,201,accepted.body);
 assert.equal(f.db.prepare("SELECT job_id FROM skill_job_grants WHERE id=?").get(ticket.authorizationId).job_id,
  accepted.json().id);
 const same=await f.call("POST","/api/v1/jobs",f.job(ticket));
 assert.equal(same.statusCode,200,same.body);
 assert.equal(same.json().id,accepted.json().id);
 // The accepted Job enters the actual Coordinator and produces one CAS artifact.
 f.coordinator.recoverAtStartup();await f.coordinator.tick();
 assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(accepted.json().id).status,"succeeded");
 assert.equal(f.getUpstreamCalls(),2);
 const artifact=f.db.prepare("SELECT blob_id FROM artifacts WHERE job_id=?").get(accepted.json().id);
 assert.equal(await readFile((await f.blobStore.stat(artifact.blob_id)).path,"utf8"),
  "Final authorized shots.");
 // New key may not reuse a claimed grant even after the first task completes.
 const duplicate=await f.call("POST","/api/v1/jobs",f.job(ticket,"project-a","second-run"));
 bad(duplicate,"skill_grant_already_used");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,1);
 const savedId=accepted.json().id,savedBlob=ticket.blobId;
 await f.close();
 const archive=join(f.root,"archive"),restored=join(f.root,"restore");
 await createColdBackup({dataDir:join(f.root,"data"),backupDir:archive});
 assert.equal((await verifyColdBackup({backupDir:archive})).schemaVersion,14);
 await restoreColdBackup({backupDir:archive,dataDir:restored});
 const recovered=new DatabaseSync(join(restored,"db","atelier.sqlite"),{readOnly:true});
 try{
  const grant=recovered.prepare("SELECT blob_id,job_id FROM skill_job_grants WHERE id=?")
   .get(ticket.authorizationId);
  assert.equal(grant.job_id,savedId);assert.equal(grant.blob_id,savedBlob);
  assert.equal(recovered.prepare("SELECT status FROM jobs WHERE id=?").get(savedId).status,
   "succeeded");
 }finally{recovered.close()}
});
test("P5.4k revised/expired grants and forged browser CAS fail before new Job",async t=>{
 const f=fixture(t);
 const first=(await f.freeze()).json();
 f.db.prepare("UPDATE skill_job_grants SET expires_at=? WHERE id=?").run(Date.now()-1,first.authorizationId);
 bad(await f.call("POST","/api/v1/jobs",f.job(first)),"skill_grant_expired");
 const second=(await f.freeze()).json();
 const scope=await f.call("PATCH","/api/v1/skills/film-shot",{
  expectedRevision:f.revision(),action:"scope",
  scope:{type:"project",projectId:"project-b"}});
 assert.equal(scope.statusCode,200,scope.body);
 bad(await f.call("POST","/api/v1/jobs",f.job(second)),"skill_grant_stale");
 const stale=await f.call("POST","/api/v1/skills/freeze",{
  ...f.selection(),expectedRevision:1});
 bad(stale,"skill_revision_conflict");
 const denied=await f.call("POST","/api/v1/skills/freeze",f.selection());
 bad(denied,"skill_authorization_changed");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
 // Unauthenticated requests cannot mint a server grant.
 const unauthorized=await f.call("GET","/api/v1/skills/authorized-catalog");
 assert.notEqual(unauthorized.statusCode,200);
 const plain=await f.call("POST","/api/v1/jobs",{
  ...f.job(null),skillAuthorizationId:"00000000-0000-4000-8000-000000000000"});
 bad(plain,"skill_grant_invalid");
});
test("P5.4k project grant remains unclaimed after stale source failure",async t=>{
 const f=fixture(t);
 const ticket=(await f.freeze()).json();
 const stale=f.job(ticket);
 stale.sourceNodeFingerprint="b".repeat(64);
 bad(await f.call("POST","/api/v1/jobs",stale),"stale_generation_source");
 assert.equal(f.db.prepare("SELECT job_id FROM skill_job_grants WHERE id=?")
  .get(ticket.authorizationId).job_id,null);
 assert.equal((await f.call("POST","/api/v1/jobs",f.job(ticket))).statusCode,201);
});
