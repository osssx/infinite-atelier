import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {zipSync} from "fflate";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {listSkillRegistry,registerSqliteSkill,getSkillRegistryPackage,updateSqliteSkill} from "./sqlite-skill-registry.mjs";
import {calculateNormalizedSkillHash} from "./skill-package-integrity.mjs";

const skill=(description="Storyboard",archived=false)=>{
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
 const dir=mkdtempSync(join(tmpdir(),"legacy-skill-registry-"));
 const db=new DatabaseSync(join(dir,"v13.sqlite"));initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 const request=(method,url,payload)=>app.inject({method,url,headers:{"x-test-owner":"owner"},
  ...(payload?{payload}:{})});
 t.after(async()=>{await app.close();db.close();rmSync(dir,{recursive:true,force:true})});
 return {db,dir,request};
}
test("historical SQLite Skill content stays readable, but import and delete APIs are gone",async t=>{
 const {db,dir,request}=fixture(t);
 assert.equal(SCHEMA_VERSION,19);
 const first=skill(),second=skill("Updated",true);
 const initial=registerSqliteSkill(db,first,listSkillRegistry(db).revision);
 assert.equal(initial.activeVersion,first.manifest.version);
 const next=registerSqliteSkill(db,second,listSkillRegistry(db).revision);
 assert.deepEqual(next.versions,[first.manifest.version,second.manifest.version]);
 const changed=updateSqliteSkill(db,"scene-frames",{action:"scope",scope:{type:"project",projectId:"project-a"},
  expectedRevision:listSkillRegistry(db).revision});
 assert.deepEqual(changed.scope,{type:"project",projectId:"project-a"});
 updateSqliteSkill(db,"scene-frames",{action:"enabled",enabled:false,
  expectedRevision:listSkillRegistry(db).revision});
 assert.equal(getSkillRegistryPackage(db,"scene-frames",first.manifest.version).package.skillMd,first.skillMd);
 assert.equal(getSkillRegistryPackage(db,"scene-frames",second.manifest.version).package.sourceArchiveBase64,second.sourceArchiveBase64);
 updateSqliteSkill(db,"scene-frames",{action:"activate",version:first.manifest.version,
  expectedRevision:listSkillRegistry(db).revision});
 const current=listSkillRegistry(db);
 assert.equal(current.skills.length,1);
 assert.equal(current.skills[0].enabled,false);
 assert.deepEqual(current.skills[0].scope,{type:"project",projectId:"project-a"});
 const other=new DatabaseSync(join(dir,"v13.sqlite"));
 assert.deepEqual(listSkillRegistry(other),current);other.close();
 assert.equal((await request("GET","/api/v1/skills")).json().skills.length,1);
 assert.equal((await request("POST","/api/v1/skills",{package:first})).statusCode,404);
 assert.equal((await request("DELETE","/api/v1/skills/scene-frames")).statusCode,404);
 assert.equal(getSkillRegistryPackage(db,"scene-frames",first.manifest.version).package.skillMd,first.skillMd);
});
test("historical SQLite registry rejects forged package contents and protects old snapshots",async t=>{
 const {db,request}=fixture(t);
 const good=skill(),zip=skill("Zip version",true);
 const tamperedArchive=Buffer.from(zipSync({
  "scene-frames/SKILL.md":Buffer.from(zip.skillMd),
  "scene-frames/references/shots.md":Buffer.from("Use short shots"),
  "scene-frames/scripts/unsafe.py":Buffer.from("print('changed')")},{level:0}));
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
 for(const pkg of blocked)assert.throws(
  ()=>registerSqliteSkill(db,pkg,listSkillRegistry(db).revision),
  /skill_package_/);
 assert.deepEqual(listSkillRegistry(db).skills,[]);
 registerSqliteSkill(db,good,listSkillRegistry(db).revision);
 const key=good.manifest.version;
 db.prepare("UPDATE skill_versions SET skill_md='tampered' WHERE skill_id=? AND version=?")
  .run(good.manifest.id,key);
 const corrupt=await request("GET","/api/v1/skills/scene-frames/"+key);
 assert.equal(corrupt.statusCode,422,corrupt.body);
 assert.equal(corrupt.json().code,"skill_package_integrity_failed");
 assert.equal((await request("POST","/api/v1/skills",{package:good})).statusCode,404);
});
test("historical v12 SQLite settings survive schema restart",t=>{
 const {db}=fixture(t);
 const old=db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get();
 initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,SCHEMA_VERSION);
 assert.deepEqual(db.prepare("SELECT * FROM ui_settings WHERE name='theme'").get(),old);
});