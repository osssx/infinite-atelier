import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openMainDatabase} from "./database.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {acquireInstanceLock} from "./instance-lock.mjs";
import {auditColdBlobStore} from "./blob-recovery-audit.mjs";

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"atelier-p53-crash-"));
 t.after(()=>rmSync(root,{force:true,recursive:true,maxRetries:3}));
 const db=openMainDatabase(root);
 const text=await createBlobStore({dataDir:root,db}).put([Buffer.from("durable")],{mime:"text/plain"});
 db.close();
 return {root,text};
}
test("P5.3 disk audit finds interrupted temp and publish-before-SQLite orphan, never deletes either",async t=>{
 const f=await fixture(t);
 const ghost=Buffer.from("published-but-no-SQLite-row");
 const id=createHash("sha256").update(ghost).digest("hex");
 mkdirSync(join(f.root,"blobs",id.slice(0,2)),{recursive:true});
 const orphan=join(f.root,"blobs",id.slice(0,2),id);
 writeFileSync(orphan,ghost);
 mkdirSync(join(f.root,"tmp"),{recursive:true});
 const partial=join(f.root,"tmp","interrupted.part");writeFileSync(partial,"unfinished bytes");
 const report=await auditColdBlobStore({dataDir:f.root});
 assert.equal(report.ok,false);
 assert.equal(report.needsReview,true);
 assert.equal(report.registered,1);
 assert.equal(report.verified,1);
 assert.equal(report.orphanFiles,1);
 assert.equal(report.staleTemps,1);
 assert.deepEqual(report.issues.map(x=>x.type).sort(),["orphanFiles","staleTemps"]);
 assert.equal(existsSync(orphan),true);
 assert.equal(readFileSync(partial,"utf8"),"unfinished bytes");
 let cli;
 try{execFileSync(process.execPath,["scripts/canvas-data-backup.mjs","audit",f.root],
  {cwd:process.cwd(),encoding:"utf8",timeout:25000})}
 catch(e){assert.equal(e.status,2);cli=JSON.parse(e.stdout)}
 assert.equal(cli.operation,"audit");
 assert.equal(cli.orphanFiles,1);
 assert.equal(cli.readOnly,true);
});
test("P5.3 registered but missing or hash-corrupt CAS blocks clean result; restored bytes pass",async t=>{
 const f=await fixture(t);
 const path=join(f.root,"blobs",f.text.blobId.slice(0,2),f.text.blobId);
 writeFileSync(path,"defiled"); // same size, different digest
 const corrupt=await auditColdBlobStore({dataDir:f.root});
 assert.equal(corrupt.ok,false);assert.equal(corrupt.corrupt,1);
 writeFileSync(path,"durable");
 assert.equal((await auditColdBlobStore({dataDir:f.root})).ok,true);
 rmSync(path);
 const missing=await auditColdBlobStore({dataDir:f.root});
 assert.equal(missing.ok,false);assert.equal(missing.missing,1);
 assert.equal(existsSync(path),false);
});
test("P5.3 refuses to audit a live-locked store even if only reading",async t=>{
 const f=await fixture(t);
 const live=acquireInstanceLock(f.root);
 try{
  await assert.rejects(auditColdBlobStore({dataDir:f.root}),/instance_already_running/);
 }finally{live.release()}
 const ok=await auditColdBlobStore({dataDir:f.root});
 assert.equal(ok.ok,true);
 assert.equal(existsSync(join(f.root,"atelier-instance.lock")),false);
});
