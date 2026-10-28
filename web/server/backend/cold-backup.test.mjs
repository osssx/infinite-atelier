import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from "node:fs";
import {readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {openMainDatabase} from "./database.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {createColdBackup,verifyColdBackup,restoreColdBackup} from "./cold-backup.mjs";
import {getAssetCatalog,putAssetCatalog} from "./asset-catalog.mjs";
import {calculateNormalizedSkillHash} from "./skill-package-integrity.mjs";
import {getSkillRegistryPackage,listSkillRegistry,registerSqliteSkill} from "./sqlite-skill-registry.mjs";
import {getUiSetting,putUiSetting} from "./ui-settings.mjs";

const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082","hex");
async function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),"atelier-p5-cold-"));
 t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const source=join(parent,"data"),destination=join(parent,"backup"),restore=join(parent,"restored");
 const db=openMainDatabase(source);
 const store=createBlobStore({dataDir:source,db});
 const blob=await store.put([png],{mime:"image/png"});
 const text=await store.put([Buffer.from("hello from the Canvas\n")],{mime:"text/plain"});
 const document={nodes:[{id:"image",type:"image",title:"source",position:{x:0,y:0},
  width:320,height:200,metadata:{content:"/api/v1/blobs/"+blob.blobId}}],connections:[]};
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)")
  .run("p5-test",JSON.stringify(document),13);
 db.prepare("INSERT INTO channels(id,provider,display_name,created_at,updated_at) VALUES(?,?,?,?,?)")
  .run("stored","openai","Protected provider",1,1);
 db.prepare("INSERT INTO credential_versions(id,channel_id,version_num,ciphertext,created_at) VALUES(?,?,?,?,?)")
  .run("ver", "stored",1, Buffer.from("encrypted-current-user"),1);
 putAssetCatalog(db,{expectedRevision:1,assets:[{id:"asset-from-backup",kind:"image",title:"CAS image",coverUrl:"/api/v1/blobs/"+blob.blobId,tags:[],createdAt:"2026-10-27",updatedAt:"2026-10-27",data:{storageKey:"cas:"+blob.blobId,dataUrl:"/api/v1/blobs/"+blob.blobId,width:1,height:1,bytes:blob.byteSize,mimeType:blob.mimeType}}]});
 putUiSetting(db,"theme",{expectedRevision:1,value:"light"});
 putUiSetting(db,"model_config",{expectedRevision:1,value:{textModel:"one::gpt",channels:[{id:"one",name:"Provider",baseUrl:"https://api.example.test",apiFormat:"openai",models:[{name:"gpt",capability:"text"}]}]}});
 const md="---\nname: backup-skill\ndescription: Protected Skill in SQLite\n---\nUse guide";
 const guide="Frozen guide data";
 const hash=calculateNormalizedSkillHash(new Map([["SKILL.md",Buffer.from(md)],
  ["references/guide.md",Buffer.from(guide)]]));
 registerSqliteSkill(db,{manifest:{id:"backup-skill",name:"backup-skill",
  description:"Protected Skill in SQLite",hash,version:hash.slice(0,12),
  resources:["references/guide.md"],warnings:[]},skillMd:md,
  resources:{"references/guide.md":guide}},listSkillRegistry(db).revision);
 db.close();
 return {parent,source,destination,restore,blob,text};
}
test("P5.1 cold backup copies SQLite plus all ready BlobStore bytes, verifies, and restores to new data root",async t=>{
 const f=await fixture(t);
 const result=await createColdBackup({dataDir:f.source,backupDir:f.destination});
 assert.equal(result.blobCount,2);
 assert.equal(result.blobBytes,png.length+Buffer.byteLength("hello from the Canvas\n"));
 assert.equal(result.schemaVersion,19);
 assert.equal(existsSync(join(f.destination,"db","atelier.sqlite")),true);
 assert.equal(existsSync(join(f.destination,"manifest.json")),true);
 const check=await verifyColdBackup({backupDir:f.destination});
 assert.equal(check.blobCount,2);
 const restored=await restoreColdBackup({backupDir:f.destination,dataDir:f.restore});
 assert.equal(restored.blobCount,2);
 assert.equal(existsSync(join(f.restore,"manifest.json")),false);
 assert.equal(existsSync(join(f.restore,"atelier-instance.lock")),false);
 const db=new DatabaseSync(join(f.restore,"db","atelier.sqlite"));
 try{
  assert.equal(db.prepare("SELECT revision FROM projects WHERE id='p5-test'").get().revision,13);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,2);
  assert.equal(getAssetCatalog(db).assets[0].id,"asset-from-backup");
  assert.equal(getAssetCatalog(db).revision,2);
  assert.deepEqual(getUiSetting(db,"theme"),{revision:2,value:"light"});
  assert.equal(getUiSetting(db,"model_config").value.channels[0].models[0].name,"gpt");
  assert.equal(JSON.stringify(getUiSetting(db,"model_config")).includes("apiKey"),false);
  assert.deepEqual(Buffer.from(db.prepare("SELECT ciphertext FROM credential_versions WHERE id='ver'").get().ciphertext),
   Buffer.from("encrypted-current-user"));
  const skills=listSkillRegistry(db);
  assert.equal(skills.skills.length,1);
  assert.equal(skills.skills[0].id,"backup-skill");
  assert.equal(getSkillRegistryPackage(db,"backup-skill",db.prepare("SELECT active_version FROM skill_entries WHERE id=\'backup-skill\'").get().active_version).package.resources["references/guide.md"],
   "Frozen guide data");
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
 }finally{db.close()}
 assert.deepEqual(await readFile(join(f.restore,"blobs",f.blob.blobId.slice(0,2),f.blob.blobId)),png);
 const src=readFileSync(join(f.source,"db","atelier.sqlite"));
 assert.ok(src.byteLength>0);
});
test("P5.1 offline CLI verify command inspects a completed backup",async t=>{
 const f=await fixture(t);
 await createColdBackup({dataDir:f.source,backupDir:f.destination});
 const output=execFileSync(process.execPath,
  ["scripts/canvas-data-backup.mjs","verify",f.destination],{
   cwd:process.cwd(),encoding:"utf8",timeout:30000
  });
 const result=JSON.parse(output);
 assert.equal(result.ok,true);
 assert.equal(result.operation,"verify");
 assert.equal(result.blobCount,2);
});
test("P5.2 CLI activate requires explicit confirmation and promotes only restored standby",async t=>{
 const f=await fixture(t);
 await createColdBackup({dataDir:f.source,backupDir:f.destination});
 await restoreColdBackup({backupDir:f.destination,dataDir:f.restore});
 assert.throws(()=>execFileSync(process.execPath,
  ["scripts/canvas-data-backup.mjs","activate",f.restore,"INCORRECT"],{
   cwd:process.cwd(),encoding:"utf8",timeout:30000}),/dataset_confirmation_required/);
 const output=execFileSync(process.execPath,
  ["scripts/canvas-data-backup.mjs","activate",f.restore,"ACTIVATE_RESTORED_DATASET"],{
   cwd:process.cwd(),encoding:"utf8",timeout:30000});
 const promoted=JSON.parse(output);
 assert.equal(promoted.ok,true);
 assert.equal(promoted.operation,"activate");
 assert.equal(promoted.activeRoot,f.restore);
});
test("P5.1 SQLite backup API includes committed WAL sidecar transactions in quiescent database",async t=>{
 const f=await fixture(t);
 // Keep an idle SQLite connection open so this committed transaction remains
 // in WAL. There is no running application or concurrent writer in this test.
 const writer=new DatabaseSync(join(f.source,"db","atelier.sqlite"));
 try{
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)")
   .run("wal-project",'{"nodes":[],"connections":[]}',99);
  assert.equal(existsSync(join(f.source,"db","atelier.sqlite-wal")),true);
  const result=await createColdBackup({dataDir:f.source,backupDir:f.destination});
  assert.equal(result.blobCount,2);
  await restoreColdBackup({backupDir:f.destination,dataDir:f.restore});
  const restored=new DatabaseSync(join(f.restore,"db","atelier.sqlite"),{readOnly:true});
  try{assert.equal(restored.prepare("SELECT revision FROM projects WHERE id='wal-project'").get().revision,99)}
  finally{restored.close()}
 }finally{writer.close()}
});
test("P5.1 cold backup cannot race active backend or replace existing backup/restore paths",async t=>{
 const f=await fixture(t);
 const lock=acquireInstanceLock(f.source);
 try{
  await assert.rejects(createColdBackup({dataDir:f.source,backupDir:f.destination}),/instance_already_running/);
  assert.equal(existsSync(f.destination),false);
 }finally{lock.release()}
 await createColdBackup({dataDir:f.source,backupDir:f.destination});
 await assert.rejects(createColdBackup({dataDir:f.source,backupDir:f.destination}),/backup_destination_exists/);
 mkdirSync(f.restore);writeFileSync(join(f.restore,"user.txt"),"do not overwrite me");
 await assert.rejects(restoreColdBackup({backupDir:f.destination,dataDir:f.restore}),/backup_destination_exists/);
 assert.equal(readFileSync(join(f.restore,"user.txt"),"utf8"),"do not overwrite me");
 await assert.rejects(restoreColdBackup({backupDir:f.destination,dataDir:f.source}),/backup_destination_exists|backup_paths_overlap/);
 await assert.rejects(createColdBackup({dataDir:f.source,backupDir:join(f.source,"subdir")}),/backup_paths_overlap/);
});
test("P5.1 same-size media corruption and tampered manifest refuse restore without partial user target",async t=>{
 const f=await fixture(t);
 await createColdBackup({dataDir:f.source,backupDir:f.destination});
 const file=join(f.destination,"blobs",f.blob.blobId.slice(0,2),f.blob.blobId);
 const bytes=Buffer.from(await readFile(file));bytes[12]^=1;
 await writeFile(file,bytes);
 await assert.rejects(verifyColdBackup({backupDir:f.destination}),/backup_blob_digest_mismatch/);
 await assert.rejects(restoreColdBackup({backupDir:f.destination,dataDir:f.restore}),/backup_blob_digest_mismatch/);
 assert.equal(existsSync(f.restore),false);
 const manifestPath=join(f.destination,"manifest.json");
 const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
 manifest.blobs[0].id="../payload";
 await writeFile(manifestPath,JSON.stringify(manifest));
 await assert.rejects(verifyColdBackup({backupDir:f.destination}),/backup_manifest_invalid/);
 await assert.rejects(restoreColdBackup({backupDir:f.destination,dataDir:f.restore}),/backup_manifest_invalid/);
 assert.equal(existsSync(f.restore),false);
});
test("P5.1 missing source Blob aborts backup, rolls back staging and releases lock",async t=>{
 const f=await fixture(t);
 await rm(join(f.source,"blobs",f.blob.blobId.slice(0,2),f.blob.blobId));
 await assert.rejects(createColdBackup({dataDir:f.source,backupDir:f.destination}),/ENOENT/);
 assert.equal(existsSync(f.destination),false);
 assert.equal(existsSync(join(f.source,"atelier-instance.lock")),false);
 assert.equal(readdirSync(f.parent).filter(name=>name.includes(".backup.partial-")).length,0);
});
test("P5.1 invalid SQLite snapshot / manifest mismatch never publishes restored data",async t=>{
 const f=await fixture(t);
 await createColdBackup({dataDir:f.source,backupDir:f.destination});
 const db=join(f.destination,"db","atelier.sqlite");
 const original=Buffer.from(await readFile(db));
 const tampered=Buffer.from(original);
 tampered[20]^=0x10;
 await writeFile(db,tampered);
 await assert.rejects(verifyColdBackup({backupDir:f.destination}),/backup_database_digest_mismatch/);
 await assert.rejects(restoreColdBackup({backupDir:f.destination,dataDir:f.restore}),/backup_database_digest_mismatch/);
 assert.equal(existsSync(f.restore),false);
 await writeFile(db,original);
 const manifestPath=join(f.destination,"manifest.json");
 const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
 manifest.blobs[0].byteSize+=1;
 await writeFile(manifestPath,JSON.stringify(manifest));
 await assert.rejects(verifyColdBackup({backupDir:f.destination}),/backup_manifest_database_mismatch/);
 assert.equal(existsSync(f.restore),false);
});
