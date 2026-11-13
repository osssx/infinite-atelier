import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createBlobGarbageCollector} from "./blob-gc.mjs";
import {createProject,patchProject} from "./projects.mjs";
import {blobReferenceLedgerStatus,rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";
import {createComfyRegistry} from "./comfy-registry.mjs";
import {createHash} from "node:crypto";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"atelier-ledger-"));
 const db=new DatabaseSync(join(root,"db.sqlite"));initializeSchema(db);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true})});
 return {db,root,blobStore:createBlobStore({db,dataDir:root})};
}
test("v10 ledger migration survives restart and source mutations mark dirty in same SQLite transaction",async t=>{
 const f=fixture(t);
 assert.equal(f.db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get().n,SCHEMA_VERSION);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 let row=rebuildBlobReferenceLedger(f.db);
 assert.equal(row.dirty,false);
 assert.equal(row.rebuild,true);
 const media=await f.blobStore.put([png],{mime:"image/png"});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 const doc={nodes:[{id:"a",type:"image",metadata:{content:"/api/v1/blobs/"+media.blobId}}],connections:[]};
 createProject(f.db,{id:"a",document:doc});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 const seq=blobReferenceLedgerStatus(f.db).changeSeq;
 f.db.exec("BEGIN IMMEDIATE");
 try{
  f.db.prepare("UPDATE projects SET document_json=? WHERE id='a'").run('{"nodes":[],"connections":[]}');
  assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 }finally{f.db.exec("ROLLBACK")}
 assert.equal(blobReferenceLedgerStatus(f.db).changeSeq,seq);
 const refreshed=rebuildBlobReferenceLedger(f.db);
 assert.equal(refreshed.dirty,false);
 assert.equal(refreshed.rebuiltSeq,seq);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),true);
 const reopened=new DatabaseSync(join(f.blobStore.pathFor(media.blobId),"..","..","..","db.sqlite"));
 try{assert.equal(persistedBlobReferences(reopened).has(media.blobId),true)}
 finally{reopened.close()}
 const current=f.db.prepare("SELECT revision FROM projects WHERE id='a'").get().revision;
 patchProject(f.db,{id:"a",expectedRevision:current,document:{nodes:[],connections:[]}});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 rebuildBlobReferenceLedger(f.db);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),false);
});
test("GC v10 must retain live references during dirty update, frozen job, template and Ark media",async t=>{
 const f=fixture(t);
 const image=await f.blobStore.put([png],{mime:"image/png"});
 const orphan=await f.blobStore.put([Buffer.concat([Buffer.alloc(4),Buffer.from("ftyp"),Buffer.alloc(10)])],{mime:"video/mp4"});
 createProject(f.db,{id:"a",document:{nodes:[{id:"x",type:"image",metadata:{id:image.blobId}}],connections:[]}});
 const gc=createBlobGarbageCollector({db:f.db,blobStore:f.blobStore}),future=Date.now()+8*86400000;
 const dry=gc.sweep({now:future});
 assert.deepEqual(dry.candidates.map(v=>v.id),[orphan.blobId]);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 assert.equal(persistedBlobReferences(f.db).has(image.blobId),true);
 const rev=f.db.prepare("SELECT revision FROM projects WHERE id='a'").get().revision;
 patchProject(f.db,{id:"a",expectedRevision:rev,document:{nodes:[],connections:[]}});
 f.db.prepare("INSERT INTO jobs(id,principal,project_scope,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at) VALUES('frozen','local','','k','f',?,'poll','succeeded',1,1)")
  .run(JSON.stringify({photo:image.blobId}));
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 assert.deepEqual(gc.sweep({now:future}).candidates.map(v=>v.id),[orphan.blobId]);
 f.db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at) VALUES(?,?,?,?)")
  .run("ref","sha",JSON.stringify({secret:image.blobId}),1);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 assert.equal(gc.sweep({now:future}).candidates.length,1);
 assert.equal(gc.sweep({now:future,dryRun:false,confirmation:"DELETE_UNREFERENCED"}).deletedCount,1);
 assert.equal(existsSync(f.blobStore.pathFor(image.blobId)),true);
});
test("references recorded by artifacts and Ark assets persist, malformed ledger fails closed rather than unlinking",async t=>{
 const f=fixture(t);
 const media=await f.blobStore.put([png],{mime:"image/png"});
 f.db.prepare("INSERT INTO ark_asset_uploads(blob_id,bucket,project_name,group_id,status,object_key,updated_at) VALUES(?,?,?,?,?,?,?)")
  .run(media.blobId,"bucket","project","group","active","remote",Date.now());
 const gc=createBlobGarbageCollector({db:f.db,blobStore:f.blobStore});
 const future=Date.now()+8*86400000;
 assert.equal(gc.sweep({now:future}).candidates.length,0);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),true);
 f.db.exec("DROP TABLE blob_ref_ledger");
 assert.throws(()=>gc.sweep({now:future}),/no such table/);
 assert.equal(existsSync(f.blobStore.pathFor(media.blobId)),true);
});

test("P2b GC retains CAS referenced solely by a frozen, unexecuted Task Step",async t=>{
 const f=fixture(t),media=await f.blobStore.put([png],{mime:"image/png"});
 createProject(f.db,{id:"task-resource",document:{nodes:[],connections:[]}});
 const {createAssistantTask,addAssistantTaskStep}=await import("./assistant-tasks.mjs");
 const task=createAssistantTask(f.db,{projectId:"task-resource",requestId:"create-resource-task",
  chatSessionId:"chat",rootMessageId:"root",originalRequest:"处理冻结图像"}).task;
 rebuildBlobReferenceLedger(f.db,{force:true});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 addAssistantTaskStep(f.db,{projectId:"task-resource",taskId:task.id,
  expectedPlanVersion:1,kind:"skill_script",ordinal:0,
  action:{reference:"/api/v1/blobs/"+media.blobId}});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 const gc=createBlobGarbageCollector({db:f.db,blobStore:f.blobStore}),future=Date.now()+9*86400000;
 assert.equal(gc.sweep({now:future}).candidates.some(item=>item.id===media.blobId),false);
 assert.equal(persistedBlobReferences(f.db).has(media.blobId),true);
 assert.equal(gc.sweep({now:future,dryRun:false,confirmation:"DELETE_UNREFERENCED"}).deletedCount,0);
 assert.equal(existsSync(f.blobStore.pathFor(media.blobId)),true);
 f.db.exec("BEGIN IMMEDIATE");
 try{f.db.prepare("UPDATE assistant_task_steps SET action_json='{}' WHERE task_id=?").run(task.id)}
 finally{f.db.exec("ROLLBACK")}
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 assert.ok(persistedBlobReferences(f.db).has(media.blobId));
});

test("P2b v25 to v26 upgrades Task-owned blob reference triggers without losing frozen Steps",t=>{
 const f=fixture(t),blobId="c".repeat(64);
 createProject(f.db,{id:"migration-task",document:{nodes:[],connections:[]}});
 const taskId="migration-task-id",stepId="migration-step-id",at=Date.now();
 f.db.prepare("INSERT INTO assistant_tasks(id,project_id,chat_session_id,root_message_id,original_request,goal_json,constraints_json,summary_json,context_policy_json,created_at,updated_at) VALUES(?,?,?,?,?,'{}','{}','{}','{}',?,?)")
  .run(taskId,"migration-task","chat","root","冻结素材",at,at);
 f.db.prepare("INSERT INTO assistant_task_steps(id,task_id,plan_version,ordinal,kind,action_json,action_digest,depends_on_json,created_at,updated_at) VALUES(?,?,1,0,'model_job',?,?, '[]',?,?)")
  .run(stepId,taskId,JSON.stringify({assetId:blobId}),"x".repeat(64),at,at);
 const triggers=f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'blob_ref_dirty_assistant_%'").all().map(row=>row.name);
 for(const name of triggers)f.db.exec("DROP TRIGGER "+name);
 f.db.prepare("DELETE FROM schema_migrations WHERE version>25").run();
 f.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(25,?)").run(Date.now());
 rebuildBlobReferenceLedger(f.db,{force:true});
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,false);
 initializeSchema(f.db);
 assert.equal(f.db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get().n,SCHEMA_VERSION);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);
 rebuildBlobReferenceLedger(f.db);
 assert.equal(persistedBlobReferences(f.db).has(blobId),true);
 f.db.prepare("UPDATE assistant_task_steps SET action_json='{}' WHERE id=?").run(stepId);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);

});
test("content-addressed workflow graph references enter the ledger and dirty it transactionally",t=>{
 const f=fixture(t),blobId="b".repeat(64),graph={"1":{class_type:"Image",inputs:{seed:1,asset:"cas:"+blobId}}};
 const ports=[{id:"out",label:"Output",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}];
 const payload={name:"Ledger graph",apiGraph:graph,ports,requirements:{classTypes:["Image"]}};
 const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;
 const template={id:"ledger-graph",revision:createHash("sha256").update(JSON.stringify(sort(payload))).digest("hex"),...payload};
 createComfyRegistry(f.db,{workflowsDir:join(f.root,"workflows")}).installMany([template]);
 assert.equal(blobReferenceLedgerStatus(f.db).dirty,true);rebuildBlobReferenceLedger(f.db);
 assert.equal(persistedBlobReferences(f.db).has(blobId),true);
});
