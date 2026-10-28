import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,readFileSync,unlinkSync,writeFileSync,mkdirSync,cpSync,renameSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {openMainDatabase} from "./database.mjs";
import {SCHEMA_VERSION} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createColdBackup,verifyColdBackup,restoreColdBackup} from "./cold-backup.mjs";
import {acquireDatasetGuard,activateRestoredDataset,readDatasetIdentity,adoptMovedDataset} from "./dataset-activation.mjs";
import {createLocalBackend} from "./runtime.mjs";

async function fixture(t){
 const parent=mkdtempSync(join(tmpdir(),"atelier-p52-active-"));
 t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const source=join(parent,"data"),backupDir=join(parent,"backup"),
  clone=join(parent,"clone"),activationRoot=join(parent,"activation");
 const db=openMainDatabase(source);
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)")
  .run("project-1",'{"nodes":[],"connections":[]}',1);
 const blob=await createBlobStore({dataDir:source,db}).put([Buffer.from("reference-for-P52")],{mime:"text/plain"});
 db.close();
 await createColdBackup({dataDir:source,backupDir,activationRoot});
 await restoreColdBackup({backupDir,dataDir:clone});
 return {parent,source,backupDir,clone,activationRoot,blob};
}
test("stop, cut whole data folder, update path, restart: original project and assets remain",async t=>{
 const f=await fixture(t),dest=join(f.parent,"moved");
 renameSync(f.source,dest);
 assert.throws(()=>readDatasetIdentity(dest),/dataset_identity_location_mismatch/);
 const activated=adoptMovedDataset(dest,{activationRoot:f.activationRoot});
 assert.deepEqual(activated,{migrated:true,from:f.source,to:dest});
 assert.equal(readDatasetIdentity(dest).currentRoot,dest);
 const active=acquireDatasetGuard(dest,{activationRoot:f.activationRoot});
 try{
  const db=openMainDatabase(dest);
  try {
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,1);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,1);
  }finally{db.close()}
 }finally{active.release()}
 assert.equal(adoptMovedDataset(dest,{activationRoot:f.activationRoot}).migrated,false);
 // Moving a second time uses the latest active path rather than the origin.
 const second=join(f.parent,"moved-again");
 renameSync(dest,second);
 assert.equal(adoptMovedDataset(second,{activationRoot:f.activationRoot}).from,dest);
 const guard=acquireDatasetGuard(second,{activationRoot:f.activationRoot});guard.release();
});
test("cut folder with a verified-dead backend PID lock automatically recovers it",async t=>{
 const f=await fixture(t),dest=join(f.parent,"moved-with-stale-lock");
 // An actually exited child PID is better evidence than a guessed high PID.
 const child=spawnSync(process.execPath,["-e","console.log(process.pid)"],{encoding:"utf8"});
 assert.equal(child.status,0);
 const deadPid=Number(child.stdout.trim());
 assert.ok(Number.isSafeInteger(deadPid)&&deadPid>0);
 assert.throws(()=>process.kill(deadPid,0),{code:"ESRCH"});
 const identity=readDatasetIdentity(f.source);
 const stale={pid:deadPid,token:"dead-lock-token",createdAt:Date.now()-10000};
 writeFileSync(join(f.source,"atelier-instance.lock"),JSON.stringify(stale));
 const registryDir=join(f.activationRoot,identity.lineageId);
 writeFileSync(join(registryDir,"atelier-instance.lock"),JSON.stringify(stale));
 renameSync(f.source,dest);
 assert.equal(adoptMovedDataset(dest,{activationRoot:f.activationRoot}).migrated,true);
 assert.equal(existsSync(join(dest,"atelier-instance.lock")),false);
 assert.equal(existsSync(join(registryDir,"atelier-instance.lock")),false);
 const guard=acquireDatasetGuard(dest,{activationRoot:f.activationRoot});guard.release();
});
test("active or malformed lock in moved folder never gets stolen or deleted",async t=>{
 for(const [label,payload] of [
  ["active",{pid:process.pid,token:"live-owner",createdAt:Date.now()}],
  ["malformed",{pid:"not-a-pid",token:"unknown",createdAt:Date.now()}]
 ]){
  const f=await fixture(t),dest=join(f.parent,"blocked-"+label);
  writeFileSync(join(f.source,"atelier-instance.lock"),JSON.stringify(payload));
  renameSync(f.source,dest);
  assert.throws(()=>adoptMovedDataset(dest,{activationRoot:f.activationRoot}),
   /instance_already_running/);
  assert.equal(existsSync(join(dest,"atelier-instance.lock")),true);
  const stored=JSON.parse(readFileSync(join(dest,"atelier-instance.lock"),"utf8"));
  assert.deepEqual(stored,payload);
  assert.throws(()=>readDatasetIdentity(dest),/dataset_identity_location_mismatch/);
 }
});
test("cutting folder CONTENTS into a new root leaves the old empty directory",async t=>{
 const f=await fixture(t),dest=join(f.parent,"moved-contents");
 mkdirSync(dest);
 for(const name of readdirSync(f.source))renameSync(join(f.source,name),join(dest,name));
 assert.deepEqual(readdirSync(f.source),[]);
 assert.equal(adoptMovedDataset(dest,{activationRoot:f.activationRoot}).migrated,true);
 const guard=acquireDatasetGuard(dest,{activationRoot:f.activationRoot});guard.release();
});
test("a copied directory or unfinished cut never changes the active data location",async t=>{
 const f=await fixture(t),dest=join(f.parent,"copy");
 cpSync(f.source,dest,{recursive:true});
 assert.throws(()=>adoptMovedDataset(dest,{activationRoot:f.activationRoot}),/dataset_move_source_not_empty/);
 const owner=acquireDatasetGuard(f.source,{activationRoot:f.activationRoot});owner.release();
 // Even when identity and database are moved, leftover media blocks activation.
 const partial=join(f.parent,"partial");mkdirSync(partial);
 renameSync(join(f.source,"atelier-dataset-identity.json"),join(partial,"atelier-dataset-identity.json"));
 renameSync(join(f.source,"db"),join(partial,"db"));
 assert.throws(()=>adoptMovedDataset(partial,{activationRoot:f.activationRoot}),/dataset_move_source_not_empty/);
 for(const name of readdirSync(f.source))renameSync(join(f.source,name),join(partial,name));
 assert.equal(adoptMovedDataset(partial,{activationRoot:f.activationRoot}).migrated,true);
});
test("active backend lock prevents even a completed cut from being adopted",async t=>{
 const f=await fixture(t),dest=join(f.parent,"moved-during-running");
 const owner=acquireDatasetGuard(f.source,{activationRoot:f.activationRoot});
 try{
  renameSync(f.source,dest);
  assert.throws(()=>adoptMovedDataset(dest,{activationRoot:f.activationRoot}),/instance_already_running/);
 }finally{owner.release()}
 assert.equal(adoptMovedDataset(dest,{activationRoot:f.activationRoot}).migrated,true);
});
test("interrupted registry-first migration retries successfully on restart",async t=>{
 const f=await fixture(t),dest=join(f.parent,"moved-crash");
 renameSync(f.source,dest);
 const moved=JSON.parse(readFileSync(join(dest,"atelier-dataset-identity.json"),"utf8"));
 const reg=join(f.activationRoot,moved.lineageId,"active.json");
 const active=JSON.parse(readFileSync(reg,"utf8"));
 writeFileSync(reg,JSON.stringify({...active,activeRoot:dest,updatedAt:Date.now()}));
 assert.throws(()=>readDatasetIdentity(dest),/dataset_identity_location_mismatch/);
 assert.equal(adoptMovedDataset(dest,{activationRoot:f.activationRoot}).migrated,true);
 const guard=acquireDatasetGuard(dest,{activationRoot:f.activationRoot});guard.release();
});
test("P5.2 restored copy is standby; original and restored can never both acquire the lineage guard",async t=>{
 const f=await fixture(t);
 const original=readDatasetIdentity(f.source),clone=readDatasetIdentity(f.clone);
 assert.equal(original.status,"active");assert.equal(clone.status,"standby");
 assert.equal(clone.lineageId,original.lineageId);
 assert.notEqual(clone.replicaId,original.replicaId);
 assert.equal((await verifyColdBackup({backupDir:f.backupDir})).schemaVersion,SCHEMA_VERSION);
 assert.throws(()=>acquireDatasetGuard(f.clone,{activationRoot:f.activationRoot}),/instance_already_running|dataset_not_active/);
 const guard=acquireDatasetGuard(f.source,{activationRoot:f.activationRoot});
 try{
  assert.throws(()=>activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
   confirmation:"ACTIVATE_RESTORED_DATASET"}),/instance_already_running/);
 }finally{guard.release()}
 assert.throws(()=>activateRestoredDataset(f.clone,{activationRoot:f.activationRoot}),
  /dataset_confirmation_required/);
 const promotion=activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"});
 assert.equal(promotion.lineageId,original.lineageId);
 assert.equal(readDatasetIdentity(f.clone).status,"active");
 assert.throws(()=>acquireDatasetGuard(f.source,{activationRoot:f.activationRoot}),/dataset_not_active/);
 const active=acquireDatasetGuard(f.clone,{activationRoot:f.activationRoot});
 try{
  assert.throws(()=>acquireDatasetGuard(f.source,{activationRoot:f.activationRoot}),/instance_already_running/);
 }finally{active.release()}
 assert.throws(()=>acquireDatasetGuard(f.source,{activationRoot:f.activationRoot}),/dataset_not_active/);
 assert.throws(()=>activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"}),/dataset_not_standby/);
 await assert.rejects(createColdBackup({dataDir:f.source,
  backupDir:join(f.parent,"stale-backup"),activationRoot:f.activationRoot}),/dataset_not_active/);
 assert.equal(existsSync(join(f.parent,"stale-backup")),false);
});
test("P5.2 startup gate runs before JobCoordinator dispatch, even if two datasets share a paid task",async t=>{
 if(process.platform!=="win32")return;
 const f=await fixture(t);
 assert.throws(()=>createLocalBackend({dataDir:f.clone,activationRoot:f.activationRoot}),
  /dataset_not_active/);
 const first=createLocalBackend({dataDir:f.source,activationRoot:f.activationRoot});
 try{
  assert.throws(()=>createLocalBackend({dataDir:f.clone,activationRoot:f.activationRoot}),
   /instance_already_running|dataset_not_active/);
 }finally{await first.close()}
 activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"});
 assert.throws(()=>createLocalBackend({dataDir:f.source,activationRoot:f.activationRoot}),
  /dataset_not_active/);
 const clone=createLocalBackend({dataDir:f.clone,activationRoot:f.activationRoot});
 await clone.close();
});
test("P5.2 modified restored CAS bytes fail activation audit without changing active owner",async t=>{
 const f=await fixture(t);
 const file=join(f.clone,"blobs",f.blob.blobId.slice(0,2),f.blob.blobId);
 const original=readFileSync(file);
 const corrupt=Buffer.from(original);corrupt[0]^=1;
 writeFileSync(file,corrupt);
 assert.throws(()=>activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"}),/dataset_restore_integrity_failed/);
 assert.equal(readDatasetIdentity(f.clone).status,"standby");
 const existing=acquireDatasetGuard(f.source,{activationRoot:f.activationRoot});
 existing.release();
 writeFileSync(file,original);
 const activated=activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"});
 assert.equal(activated.activeRoot,f.clone);
});
test("P5.2 deleted active registry fails closed instead of silently reactivating the old root",async t=>{
 const f=await fixture(t);
 activateRestoredDataset(f.clone,{activationRoot:f.activationRoot,
  confirmation:"ACTIVATE_RESTORED_DATASET"});
 const identity=readDatasetIdentity(f.source);
 const registry=join(f.activationRoot,identity.lineageId,"active.json");
 unlinkSync(registry);
 assert.throws(()=>acquireDatasetGuard(f.source,{activationRoot:f.activationRoot}),/dataset_registry_missing/);
 assert.throws(()=>acquireDatasetGuard(f.clone,{activationRoot:f.activationRoot}),/dataset_registry_missing/);
});
test("P5.2 corrupt dataset identity, copied source ID and malformed registry all fail closed",async t=>{
 const f=await fixture(t);
 const copy=join(f.parent,"copied-old");
 mkdirSync(copy);
 writeFileSync(join(copy,"atelier-dataset-identity.json"),
  readFileSync(join(f.source,"atelier-dataset-identity.json")));
 assert.throws(()=>acquireDatasetGuard(copy,{activationRoot:f.activationRoot}),/dataset_identity_location_mismatch/);
 const identity=readDatasetIdentity(f.source);
 const file=join(f.activationRoot,identity.lineageId,"active.json");
 writeFileSync(file,"{bad json");
 assert.throws(()=>acquireDatasetGuard(f.source,{activationRoot:f.activationRoot}),/dataset_registry_invalid/);
});
test("P5.2 pre-activation legacy v1 backups may be verified but cannot be restored unsafely",async t=>{
 const f=await fixture(t);
 const manifestFile=join(f.backupDir,"manifest.json");
 const manifest=JSON.parse(readFileSync(manifestFile,"utf8"));
 manifest.version=1;delete manifest.lineageId;delete manifest.originRoot;
 writeFileSync(manifestFile,JSON.stringify(manifest));
 await verifyColdBackup({backupDir:f.backupDir});
 await assert.rejects(restoreColdBackup({backupDir:f.backupDir,
  dataDir:join(f.parent,"legacy-restore")}),/backup_activation_identity_required/);
 assert.equal(existsSync(join(f.parent,"legacy-restore")),false);
});
