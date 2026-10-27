import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {listSkillRegistry} from "./sqlite-skill-registry.mjs";
const skill=(version="1".repeat(12),description="Storyboard")=>({
 manifest:{id:"scene-frames",name:"scene-frames",description,
   version,hash:version+"0".repeat(52),
   resources:["references/shots.md","scripts/unsafe.py"],warnings:["script inert"]},
 skillMd:"---\nname: scene-frames\ndescription: "+description+"\n---\n# Steps",
 resources:{"references/shots.md":"Use short shots"}
});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"sqlite-skill-registry-"));
 const db=new DatabaseSync(join(dir,"v13.sqlite"));initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 const headers={"x-test-owner":"owner"};
 const request=(method,url,payload,other=headers)=>app.inject({method,url,headers:other,
  ...(["POST","PATCH","DELETE"].includes(method)?{payload:{...payload,expectedRevision:listSkillRegistry(db).revision}}:(payload?{payload}:{}))});
 t.after(async()=>{await app.close();db.close();rmSync(dir,{recursive:true,force:true})});
 return {db,dir,request,app};
}
test("P5.4h v13 Skill library atomically stores versions, scope, enabled and archive bytes",async t=>{
 const {db,dir,request,app}=fixture(t);
 assert.equal(SCHEMA_VERSION,13);
 const oldVersion="1".repeat(12),nextVersion="2".repeat(12);
 const initial=await request("POST","/api/v1/skills",{package:skill()});
 assert.equal(initial.statusCode,201,initial.body);
 assert.equal(initial.json().entry.activeVersion,oldVersion);
 const archive=Buffer.from("504b030400000000000000000000", "hex").toString("base64");
 const next=await request("POST","/api/v1/skills",{
   package:{...skill(nextVersion,"Updated"),sourceArchiveBase64:archive}
 });
 assert.equal(next.statusCode,201,next.body);
 assert.deepEqual(next.json().entry.versions,[oldVersion,nextVersion]);
 const scope=await request("PATCH","/api/v1/skills/scene-frames",{
  action:"scope",scope:{type:"project",projectId:"project-a"}
 });
 assert.equal(scope.statusCode,200,scope.body);
 assert.deepEqual(scope.json().entry.scope,{type:"project",projectId:"project-a"});
 const disabled=await request("PATCH","/api/v1/skills/scene-frames",{action:"enabled",enabled:false});
 assert.equal(disabled.statusCode,200);
 const pinned=await request("GET","/api/v1/skills/scene-frames/"+oldVersion);
 assert.equal(pinned.statusCode,200,pinned.body);
 assert.equal(pinned.json().package.skillMd,skill().skillMd);
 const original=await request("GET","/api/v1/skills/scene-frames/"+nextVersion);
 assert.equal(original.json().package.sourceArchiveBase64,archive);
 const restored=await request("PATCH","/api/v1/skills/scene-frames",{
  action:"activate",version:oldVersion
 });
 assert.equal(restored.statusCode,200,restored.body);
 assert.equal(restored.json().entry.enabled,false);
 assert.equal(restored.json().entry.activeVersion,oldVersion);
 assert.deepEqual(restored.json().entry.scope,{type:"project",projectId:"project-a"});
 const state=(await request("GET","/api/v1/skills")).json();
 assert.equal(state.skills.length,1);
 assert.equal(state.skills[0].name,"scene-frames");
 assert.equal(state.skills[0].description,"Storyboard");
 assert.ok(state.revision>1);
 assert.ok(!JSON.stringify(state).includes("Use short shots"));
 const other=new DatabaseSync(join(dir,"v13.sqlite"));
 assert.deepEqual(listSkillRegistry(other),state);
 other.close();
 const stale=await app.inject({method:"PATCH",url:"/api/v1/skills/scene-frames",
  headers:{"x-test-owner":"owner"},
  payload:{expectedRevision:1,action:"enabled",enabled:true}});
 assert.equal(stale.statusCode,409,stale.body);
 assert.equal(stale.json().code,"skill_revision_conflict");
 const remove=await request("DELETE","/api/v1/skills/scene-frames");
 assert.equal(remove.statusCode,200);
 assert.deepEqual((await request("GET","/api/v1/skills")).json().skills,[]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM skill_versions").get().n,0);
});
test("P5.4h Skill security rejects arbitrary execution, mutations and forged archives",async t=>{
 const {request}=fixture(t);
 const blocked=[
  {...skill(),manifest:{...skill().manifest,hash:"invalid"}},
  {...skill(),resources:{"scripts/unsafe.py":"subprocess.run()"}},
  {...skill(),resources:{"references/../secret.md":"password"}},
  {...skill(),sourceArchiveBase64:Buffer.from("not zip").toString("base64")},
  {...skill(),manifest:{...skill().manifest,version:"notsha"}},
  {...skill(),resources:{"references/shots.md":"x".repeat(512*1024+1)}}
 ];
 for(const pkg of blocked){
  const response=await request("POST","/api/v1/skills",{package:pkg});
  assert.ok([400,413].includes(response.statusCode),response.body);
 }
 assert.deepEqual((await request("GET","/api/v1/skills")).json().skills,[]);
 const created=await request("POST","/api/v1/skills",{package:skill()});
 assert.equal(created.statusCode,201,created.body);
 const attempts=[
  ["scope",{action:"scope",scope:{type:"project",projectId:"../../wrong"}}],
  ["enabled",{action:"enabled",enabled:"yes"}],
  ["activate",{action:"activate",version:"2".repeat(12)}],
  ["extra-invalid",{action:"enabled",enabled:"not-boolean",run:"node script.js"}]
 ];
 for(const [kind,body] of attempts){
  const response=await request("PATCH","/api/v1/skills/scene-frames",body);
  assert.ok([400,404].includes(response.statusCode),kind+" "+response.body);
 }
 const duplicate=await request("POST","/api/v1/skills",{package:{
  ...skill(),skillMd:skill().skillMd+"\nUnexpected changed body"
 }});
 assert.equal(duplicate.statusCode,409);
 assert.equal((await request("GET","/api/v1/skills/scene-frames/"+("1".repeat(12)))).json().package.skillMd,skill().skillMd);
 const unauth=await request("GET","/api/v1/skills",undefined,{});
 assert.equal(unauth.statusCode,401);
});
test("P5.4h existing v12 database upgrades without changing v12 records",async t=>{
 const {db}=fixture(t);
 const old=db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get();
 initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,13);
 assert.deepEqual(db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get(),old);
});
