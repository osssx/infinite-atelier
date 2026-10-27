import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,readFileSync,unlinkSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openMainDatabase} from "./database.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createColdBackup,verifyColdBackup,restoreColdBackup} from "./cold-backup.mjs";
import {acquireDatasetGuard,activateRestoredDataset,readDatasetIdentity} from "./dataset-activation.mjs";
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
test("P5.2 restored copy is standby; original and restored can never both acquire the lineage guard",async t=>{
 const f=await fixture(t);
 const original=readDatasetIdentity(f.source),clone=readDatasetIdentity(f.clone);
 assert.equal(original.status,"active");assert.equal(clone.status,"standby");
 assert.equal(clone.lineageId,original.lineageId);
 assert.notEqual(clone.replicaId,original.replicaId);
 assert.equal((await verifyColdBackup({backupDir:f.backupDir})).schemaVersion,11);
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
