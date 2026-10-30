import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createFileSkillRegistry} from "./file-skill-registry.mjs";
import {readSkillArchive} from "./skill-package-integrity.mjs";
import {openMainDatabase} from "./database.mjs";
import {createProject} from "./projects.mjs";
import {buildApp} from "./app.mjs";
import {bindFileSkillRegistry,freezeAuthorizedSkillGrant,claimSkillJobGrant} from "./skill-job-grants.mjs";
import {createBlobStore} from "./blob-store.mjs";

const md=(body="Use a 35mm camera.")=>"---\nname: camera-guide\ndescription: Camera workflow\n---\n"+body;
function fixture(t){
 const base=mkdtempSync(join(tmpdir(),"atelier-file-skills-"));
 const root=join(base,"skills"),data=join(base,"data");
 mkdirSync(join(root,"camera-guide","references"),{recursive:true});
 writeFileSync(join(root,"camera-guide","SKILL.md"),md());
 writeFileSync(join(root,"camera-guide","references","lighting.md"),"Diffuse soft light");
 const db=openMainDatabase(data);createProject(db,{id:"project-a",document:{nodes:[],connections:[]}});
 t.after(()=>{db.close();rmSync(base,{recursive:true,force:true})});
 const skillRegistry=createFileSkillRegistry({skillsDir:root});
 const blobStore=createBlobStore({db,dataDir:data});
 bindFileSkillRegistry(db,skillRegistry);
 return {base,root,db,skillRegistry,blobStore};
}
test("filesystem registry scans folders, persists metadata, adds immutable versions and detects edits",t=>{
 const f=fixture(t),r=f.skillRegistry;
 let c=r.list();assert.equal(c.skills.length,1);assert.equal(c.skills[0].name,"camera-guide");
 const a=c.skills[0],initial=a.activeVersion;
 assert.equal(r.scan(c.revision).unchanged,1);
 r.update("camera-guide",{action:"enabled",enabled:false,expectedRevision:r.revision()});
 r.update("camera-guide",{action:"scope",scope:{type:"project",projectId:"project-a"},expectedRevision:r.revision()});
 writeFileSync(join(f.root,"camera-guide","SKILL.md"),md("Use a 50mm lens."));
 assert.throws(()=>r.authorized(f.db,{projectId:"project-a",expectedRevision:r.revision(),
  skillIds:["camera-guide"],versionPins:{"camera-guide":initial}}),/skill_authorization_changed/);
 const scan=r.scan();assert.equal(scan.updated,1);
 c=r.list();assert.equal(c.skills[0].enabled,false);
 assert.equal(c.skills[0].versions.length,2);
 assert.match(r.get("camera-guide",initial).package.skillMd,/35mm/);
 r.update("camera-guide",{action:"enabled",enabled:true,expectedRevision:r.revision()});
 r.update("camera-guide",{action:"activate",version:initial,expectedRevision:r.revision()});
 const authorized=r.authorized(f.db,{projectId:"project-a",expectedRevision:r.revision(),
  skillIds:["camera-guide"],versionPins:{"camera-guide":initial}});
 assert.match(authorized.entries[0].skillMd,/35mm/);
 assert.throws(()=>r.authorized(f.db,{projectId:"project-b",expectedRevision:r.revision(),
  skillIds:["camera-guide"],versionPins:{"camera-guide":initial}}),/skill_project_not_found/);
 const reopened=createFileSkillRegistry({skillsDir:f.root});
 assert.equal(reopened.list().skills[0].scope.projectId,"project-a");
 assert.equal(reopened.list().skills[0].activeVersion,initial);
});
test("unscanned disk edit fails freeze; missing and invalid folders cannot be authorized",t=>{
 const {root,db,skillRegistry:r}=fixture(t);
 const v=r.list().skills[0].activeVersion;
 const selection=()=>({projectId:"project-a",expectedRevision:r.revision(),
  skillIds:["camera-guide"],versionPins:{"camera-guide":v}});
 writeFileSync(join(root,"camera-guide","SKILL.md"),md("Changed without scanning"));
 assert.throws(()=>r.authorized(db,selection()),/skill_scan_required/);
 writeFileSync(join(root,"camera-guide","SKILL.md"),"broken");
 assert.equal(r.scan().invalid,1);
 assert.equal(r.list().skills[0].status,"invalid");
 assert.throws(()=>r.authorized(db,selection()),/skill_authorization_changed/);
 rmSync(join(root,"camera-guide"),{recursive:true});
 assert.equal(r.scan().missing,1);
 assert.deepEqual(r.list().skills,[]);
 assert.throws(()=>r.get("camera-guide",v),/skill_not_found/);
});
test("HTTP scan, freeze grant and metadata remain outside SQLite Skill tables",async t=>{
 const f=fixture(t),r=f.skillRegistry;
 const app=buildApp({db:f.db,blobStore:f.blobStore,skillRegistry:r,authorize:()=>true});
 t.after(()=>app.close());
 const read=await app.inject({url:"/api/v1/skills"});
 assert.equal(read.statusCode,200);
 assert.equal(read.json().skills.length,1);
 const config=await app.inject({url:"/api/v1/skills/config"});
  assert.equal((await app.inject({method:"POST",url:"/api/v1/skills",payload:{package:{}}})).statusCode,404);
  assert.equal((await app.inject({method:"DELETE",url:"/api/v1/skills/camera-guide"})).statusCode,404);

 assert.equal(config.json().directory,f.root);
 const scan=await app.inject({method:"POST",url:"/api/v1/skills/scan",payload:{expectedRevision:r.revision()}});
 assert.equal(scan.statusCode,200);assert.equal(scan.json().unchanged,1);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM skill_entries").get().n,0);
 const version=r.list().skills[0].activeVersion;
 const selection={projectId:"project-a",expectedRevision:r.revision(),
  skillIds:["camera-guide"],versionPins:{"camera-guide":version}};
 const frozen=await freezeAuthorizedSkillGrant(f.db,f.blobStore,selection);
 assert.ok(frozen.authorizationId);
 const persisted=JSON.parse(readFileSync(join(f.root,".atelier","registry.json"),"utf8"));
 assert.ok(persisted.entries["camera-guide"]);
 writeFileSync(join(f.root,"camera-guide","SKILL.md"),md("Edited after freezing"));
 assert.throws(()=>claimSkillJobGrant(f.db,{projectId:"project-a",
  snapshot:{adapterKind:"model",provider:"openai",task:{kind:"text",skills:{blobId:frozen.blobId}}},
  skillAuthorizationId:frozen.authorizationId,jobId:"00000000-0000-4000-8000-000000000001"}),/skill_scan_required/);
});
test("filesystem archive export retains binary assets and inert scripts",t=>{
 const f=fixture(t);
 mkdirSync(join(f.root,"camera-guide","assets"));
 mkdirSync(join(f.root,"camera-guide","scripts"));
 const image=Buffer.from([0,127,255,3,42]);
 writeFileSync(join(f.root,"camera-guide","assets","reference.bin"),image);
 writeFileSync(join(f.root,"camera-guide","scripts","helper.py"),"print('safe inert script')\n");
 const scan=f.skillRegistry.scan();assert.equal(scan.updated,1);
 const skill=f.skillRegistry.list().skills[0];
 const pkg=f.skillRegistry.get("camera-guide",skill.activeVersion).package;
 assert.ok(pkg.manifest.warnings.some(x=>x.includes("inert")));
 const archive=readSkillArchive(Buffer.from(pkg.sourceArchiveBase64,"base64"));
 assert.deepEqual(archive.get("assets/reference.bin"),image);
 assert.match(archive.get("scripts/helper.py").toString(),/safe inert script/);

});
test("Windows junction / directory symlink Skills and out-of-root linked references",t=>{
 const f=fixture(t),r=f.skillRegistry;
 const target=join(f.base,"external-skill"),outside=join(f.base,"shared-references");
 mkdirSync(target,{recursive:true});mkdirSync(outside,{recursive:true});
 const source="---\nname: linked-skill\ndescription: Linked skill used on one PC\n---\nUse the linked reference";
 writeFileSync(join(target,"SKILL.md"),source);
 writeFileSync(join(outside,"guide.md"),"External reference content");
 const linkType=process.platform==="win32"?"junction":"dir";
 symlinkSync(outside,join(target,"references"),linkType);
 const alias=join(f.root,"linked-skill");
 symlinkSync(target,alias,linkType);
 const outcome=r.scan();
 assert.equal(outcome.added,1,JSON.stringify(outcome));
 assert.equal(outcome.invalid,0);
 const entry=r.list().skills.find(x=>x.id==="linked-skill");
 assert.equal(entry?.enabled,true);
 const pkg=r.get("linked-skill",entry.activeVersion).package;
 assert.equal(pkg.resources["references/guide.md"],"External reference content");
 const selection=r.authorized(f.db,{projectId:"project-a",expectedRevision:r.revision(),
  skillIds:["linked-skill"],versionPins:{"linked-skill":entry.activeVersion}});
 assert.equal(selection.entries[0].resources["references/guide.md"],"External reference content");
 assert.equal(existsSync(alias),true);
 assert.equal(r.scan().unchanged,2);
 assert.equal(readFileSync(join(target,"SKILL.md"),"utf8"),source);
 assert.equal(readFileSync(join(outside,"guide.md"),"utf8"),"External reference content");
});
test("linked Skill root works and cyclic directory symlinks are skipped",t=>{
 const f=fixture(t),kind=process.platform==="win32"?"junction":"dir";
 const alias=join(f.base,"skills-alias");
 symlinkSync(f.root,alias,kind);
 const registry=createFileSkillRegistry({skillsDir:alias});
 assert.equal(registry.list().skills[0].name,"camera-guide");
 symlinkSync(join(f.root,"camera-guide"),join(f.root,"camera-guide","references","cycle"),kind);
 const scan=registry.scan();
 assert.equal(scan.invalid,1,JSON.stringify(scan));
 assert.equal(scan.errors[0].code,"skill_directory_cycle");
});
