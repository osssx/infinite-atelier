import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {zipSync} from "fflate";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {listSkillRegistry} from "./sqlite-skill-registry.mjs";
import {calculateNormalizedSkillHash} from "./skill-package-integrity.mjs";

const skill=(description="Storyboard",archived=false)=> {
 const md="---\nname: scene-frames\ndescription: "+description+"\n---\n# Steps";
 const resource="Use short shots";
 const files=new Map([["SKILL.md",Buffer.from(md)],
  ["references/shots.md",Buffer.from(resource)]]);
 if(archived)files.set("scripts/unsafe.py",Buffer.from("print('inert')"));
 const hash=calculateNormalizedSkillHash(files);
 const raw=archived?zipSync(Object.fromEntries([...files].map(([path,bytes])=>[
  "scene-frames/"+path,bytes])),{level:0}):null;
 return {manifest:{id:"scene-frames",name:"scene-frames",description,
   version:hash.slice(0,12),hash,
   resources:["references/shots.md"],warnings:archived?[
    "Script files are inert and cannot be executed in V1"]:[]},
  skillMd:md,resources:{"references/shots.md":resource},
  ...(raw?{sourceArchiveBase64:Buffer.from(raw).toString("base64")}:{})};
};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"sqlite-skill-registry-"));
 const db=new DatabaseSync(join(dir,"v13.sqlite"));initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 const headers={"x-test-owner":"owner"};
 const request=(method,url,payload,other=headers)=>app.inject({method,url,headers:other,
  ...(["POST","PATCH","DELETE"].includes(method)?{payload:{
   ...payload,expectedRevision:listSkillRegistry(db).revision}}:(payload?{payload}:{}))});
 t.after(async()=>{await app.close();db.close();rmSync(dir,{recursive:true,force:true})});
 return {db,dir,request,app};
}
test("P5.4i v13 hashes Skill.md and complete ZIP; persists immutable versions, scope and archive",async t=>{
 const {db,dir,request,app}=fixture(t);
 assert.equal(SCHEMA_VERSION,19);
 const initialPkg=skill(),nextPkg=skill("Updated",true);
 const oldVersion=initialPkg.manifest.version,nextVersion=nextPkg.manifest.version;
 const initial=await request("POST","/api/v1/skills",{package:initialPkg});
 assert.equal(initial.statusCode,201,initial.body);
 assert.equal(initial.json().entry.activeVersion,oldVersion);
 const next=await request("POST","/api/v1/skills",{package:nextPkg});
 assert.equal(next.statusCode,201,next.body);
 assert.deepEqual(next.json().entry.versions,[oldVersion,nextVersion]);
 const scope=await request("PATCH","/api/v1/skills/scene-frames",{
  action:"scope",scope:{type:"project",projectId:"project-a"}
 });
 assert.equal(scope.statusCode,200,scope.body);
 assert.deepEqual(scope.json().entry.scope,{type:"project",projectId:"project-a"});
 assert.equal((await request("PATCH","/api/v1/skills/scene-frames",{
  action:"enabled",enabled:false})).statusCode,200);
 assert.equal((await request("GET","/api/v1/skills/scene-frames/"+oldVersion))
  .json().package.skillMd,initialPkg.skillMd);
 assert.equal((await request("GET","/api/v1/skills/scene-frames/"+nextVersion))
  .json().package.sourceArchiveBase64,nextPkg.sourceArchiveBase64);
 const activated=await request("PATCH","/api/v1/skills/scene-frames",{
  action:"activate",version:oldVersion
 });
 assert.equal(activated.statusCode,200,activated.body);
 assert.equal(activated.json().entry.enabled,false);
 assert.deepEqual(activated.json().entry.scope,{type:"project",projectId:"project-a"});
 const state=(await request("GET","/api/v1/skills")).json();
 assert.equal(state.skills.length,1);
 assert.equal(state.skills[0].description,"Storyboard");
 assert.ok(state.revision>1);
 assert.ok(!JSON.stringify(state).includes("Use short shots"));
 const other=new DatabaseSync(join(dir,"v13.sqlite"));
 assert.deepEqual(listSkillRegistry(other),state);other.close();
 const stale=await app.inject({method:"PATCH",url:"/api/v1/skills/scene-frames",
  headers:{"x-test-owner":"owner"},
  payload:{expectedRevision:1,action:"enabled",enabled:true}});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(stale.json().code,"skill_revision_conflict");
 const removed=await request("DELETE","/api/v1/skills/scene-frames");
 assert.equal(removed.statusCode,200);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM skill_versions").get().n,0);
});
test("P5.4i rejects forged hashes, manifest metadata, tampered ZIP, unsanctioned paths and corrupt rows",async t=>{
 const {db,request}=fixture(t);
 const good=skill(),zip=skill("Zip version",true);
 const tamperedArchive=Buffer.from(zipSync({
  "scene-frames/SKILL.md":Buffer.from(zip.skillMd),
  "scene-frames/references/shots.md":Buffer.from("Use short shots"),
  "scene-frames/scripts/unsafe.py":Buffer.from("print(\'changed\')")},{level:0}));
 const blocked=[
  {...good,manifest:{...good.manifest,hash:"1".repeat(64)}},
  {...good,skillMd:good.skillMd+" edited"},
  {...good,manifest:{...good.manifest,description:"forged description"}},
  {...good,manifest:{...good.manifest,resources:[]}},
  {...good,resources:{"references/shots.md":"changed body"}},
  {...good,resources:{"scripts/unsafe.py":"code()"}},
  {...good,resources:{"references/../secret.md":"secret"}},
  {...good,sourceArchiveBase64:Buffer.from("not zip").toString("base64")},
  {...good,manifest:{...good.manifest,version:"notsha"}},
  {...good,resources:{"references/shots.md":"x".repeat(512*1024+1)}},
  {...zip,sourceArchiveBase64:tamperedArchive.toString("base64")},
  {...zip,manifest:{...zip.manifest,warnings:[]}}
 ];
 for(const pkg of blocked){
  const response=await request("POST","/api/v1/skills",{package:pkg});
  assert.ok([400,413,422].includes(response.statusCode),response.body);
 }
 assert.deepEqual((await request("GET","/api/v1/skills")).json().skills,[]);
 const created=await request("POST","/api/v1/skills",{package:good});
 assert.equal(created.statusCode,201,created.body);
 const badOps=[
  {action:"scope",scope:{type:"project",projectId:"../../wrong"}},
  {action:"enabled",enabled:"yes"},
  {action:"activate",version:"2".repeat(12)},
  {action:"enabled",enabled:"not-boolean",run:"script.js"}
 ];
 for(const body of badOps){
  const response=await request("PATCH","/api/v1/skills/scene-frames",body);
  assert.ok([400,404].includes(response.statusCode),response.body);
 }
 const duplicate=await request("POST","/api/v1/skills",{package:{
  ...good,skillMd:good.skillMd+"\nchanged"
 }});
 assert.equal(duplicate.statusCode,422);
 const key=good.manifest.version;
 assert.equal((await request("GET","/api/v1/skills/scene-frames/"+key))
  .json().package.skillMd,good.skillMd);
 db.prepare("UPDATE skill_versions SET skill_md='tampered' WHERE skill_id=? AND version=?")
  .run(good.manifest.id,key);
 const corrupt=await request("GET","/api/v1/skills/scene-frames/"+key);
 assert.equal(corrupt.statusCode,422,corrupt.body);
 assert.equal(corrupt.json().code,"skill_package_integrity_failed");
 assert.equal((await request("GET","/api/v1/skills",null,{})).statusCode,401);
});
test("P5.4h existing v12 SQLite settings survive v13 schema restart",async t=>{
 const {db}=fixture(t);
 const old=db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get();
 initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,SCHEMA_VERSION);
 assert.deepEqual(db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get(),old);
});
