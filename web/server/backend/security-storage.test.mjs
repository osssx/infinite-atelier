import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createLocalSessionAuth} from "./session.mjs";
import {acquireInstanceLock,hasInstanceLock} from "./instance-lock.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createLocalBackend,resolveLocalDataDir} from "./runtime.mjs";
import {fileURLToPath} from "node:url";

const temp=t=>{const path=mkdtempSync(join(tmpdir(),"atelier-backend-sec-"));t.after(()=>rmSync(path,{recursive:true,force:true}));return path};
const sha=b=>createHash("sha256").update(b).digest("hex");
test("one-time bootstrap exchange, cookie credentials, CSRF, expiry and revocation",()=>{
 let now=1000;
 const session=createLocalSessionAuth({clock:()=>now,bootstrapLifetimeMs:200,sessionLifetimeMs:1000});
 const initial=session.bootstrapToken;
 const info=session.exchange(initial);
 assert.equal(session.bootstrapToken,null);
 assert.throws(()=>session.exchange(initial),/invalid_bootstrap_token/);
 assert.match(session.cookie(info.id),/HttpOnly; SameSite=Strict; Path=\//);
 assert.doesNotMatch(session.cookie(info.id),/Secure/);
 const req={headers:{cookie:"atelier_session="+info.id,"x-atelier-csrf":info.csrf},method:"POST"};
 assert.equal(session.authorize(req),true);
 assert.equal(session.authorize({...req,headers:{cookie:req.headers.cookie}}),false);
 assert.equal(session.authorize({...req,headers:{cookie:"atelier_session=bad","x-atelier-csrf":info.csrf}}),false);
 session.revoke(req);assert.equal(session.authorize(req),false);
 const renewed=session.issueBootstrapToken();
 now+=201;assert.throws(()=>session.exchange(renewed),/invalid_bootstrap_token/);
 now+=1;const next=session.exchange(session.issueBootstrapToken());now+=1001;
 assert.equal(session.authorize({headers:{cookie:"atelier_session="+next.id},method:"GET"}),false);
});
test("live instance lock blocks second owner; releases correctly; proven-dead PID can recover",t=>{
 const dir=temp(t);
 const first=acquireInstanceLock(dir);
 assert.equal(hasInstanceLock(dir),true);
 assert.throws(()=>acquireInstanceLock(dir),/instance_already_running/);
 first.release();first.release();
 assert.equal(hasInstanceLock(dir),false);
 const stale=join(dir,"atelier-instance.lock");
 writeFileSync(stale,JSON.stringify({pid:99999999,token:"orphan",createdAt:1}));
 const next=acquireInstanceLock(dir);
 assert.equal(hasInstanceLock(dir),true);
 next.release();assert.equal(hasInstanceLock(dir),false);
 writeFileSync(stale,"{malformed");
 assert.throws(()=>acquireInstanceLock(dir),/instance_lock_recovery_required/);
});
test("BlobStore validates signatures, SHA-256, deduplicates, caps bytes, guards Range",async t=>{
 const dir=temp(t),db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const store=createBlobStore({dataDir:dir,db,maxBlobBytes:100});
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]);
 const digest=sha(png);
 const first=await store.put([png],{mime:"image/png",expectedSha256:digest});
 assert.equal(first.blobId,digest);assert.equal(first.existing,false);
 const second=await store.put([png],{mime:"image/png"});
 assert.equal(second.existing,true);
 const storedPath=join(dir,"blobs",digest.slice(0,2),digest);
 writeFileSync(storedPath,Buffer.alloc(png.length,0x30));
 await assert.rejects(store.put([png],{mime:"image/png"}),/blob_integrity_error/);
 writeFileSync(storedPath,png);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blobs").get().n,1);
 assert.equal((await store.stat(digest)).byteSize,png.length);
 assert.deepEqual(store.parseRange("bytes=3-7",png.length),{start:3,end:7});
 assert.deepEqual(store.parseRange("bytes=-4",png.length),{start:12,end:15});
 assert.throws(()=>store.parseRange("bytes=99-100",png.length),/invalid_blob_range/);
 await assert.rejects(store.stat("../etc/passwd"),/blob_not_found/);
 await assert.rejects(store.put([Buffer.from("fake")],{mime:"image/png"}),/blob_mime_mismatch/);
 await assert.rejects(store.put([png],{mime:"image/png",expectedSha256:"0".repeat(64)}),/blob_digest_mismatch/);
 await assert.rejects(store.put([Buffer.alloc(101)],{mime:"text/plain"}),/blob_quota_exceeded/);
 await assert.rejects(store.put([Buffer.from([0x61,0xc3,0x28])],{mime:"text/plain"}),/blob_mime_mismatch/);
 const utf8=Buffer.from("你好","utf8");
 const textResult=await store.put([utf8.subarray(0,1),utf8.subarray(1,3),utf8.subarray(3)],{mime:"text/plain"});
 assert.equal(textResult.byteSize,utf8.length);
 assert.deepEqual(readdirSync(join(dir,"tmp")),[]);
});
test("runtime rejects source worktree data roots before creating a lock",()=>{
 const actual=fileURLToPath(new URL(".",import.meta.url));
 assert.throws(()=>resolveLocalDataDir(actual),/data_dir_inside_repo/);
 assert.throws(()=>resolveLocalDataDir(join(actual,"private-db")) ,/data_dir_inside_repo/);
 assert.throws(()=>resolveLocalDataDir("./relative"),/absolute_data_dir_required/);
});
test("isolated local backend enforces cookie/CSRF and streams uploaded bytes with Range",async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),"atelier-backend-sec-"));
 const runtime=createLocalBackend({dataDir,streamPollMs:20});
 t.after(async()=>{await runtime.close();rmSync(dataDir,{recursive:true,force:true})});
 assert.throws(()=>createLocalBackend({dataDir}),/instance_already_running/);
 const app=runtime.app;
 const bootstrap=runtime.sessionAuth.bootstrapToken;
 const bootstrapResponse=await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{
  Authorization:"Bearer "+bootstrap,origin:"http://localhost",host:"localhost"
 }});
 assert.equal(bootstrapResponse.statusCode,201);
 const csrf=bootstrapResponse.json().csrfToken,cookie=bootstrapResponse.headers["set-cookie"].split(";")[0];
 assert.match(bootstrapResponse.headers["set-cookie"],/HttpOnly/);
 assert.equal((await app.inject({method:"POST",url:"/api/v1/session",payload:{},headers:{Authorization:"Bearer "+bootstrap}})).statusCode,401);
 const headers={host:"localhost",cookie};
 assert.equal((await app.inject({method:"GET",url:"/api/v1/projects/no",headers})).statusCode,404);
 const body={id:"p",document:{nodes:[],connections:[]}};
 assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",payload:body,headers})).statusCode,403);
 assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",payload:body,
  headers:{...headers,origin:"http://localhost"}})).statusCode,401);
 const authenticated={...headers,origin:"http://localhost","x-atelier-csrf":csrf};
 assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",payload:body,headers:authenticated})).statusCode,201);
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]);
 const upload=await app.inject({method:"POST",url:"/api/v1/blobs",payload:png,headers:{
  ...authenticated,"content-type":"application/octet-stream","x-atelier-mime":"image/png","x-content-sha256":sha(png)
 }});
 assert.equal(upload.statusCode,201,upload.body);
 const blobId=upload.json().blobId;
 const repeat=await app.inject({method:"POST",url:"/api/v1/blobs",payload:png,headers:{
  ...authenticated,"content-type":"application/octet-stream","x-atelier-mime":"image/png"
 }});
 assert.equal(repeat.statusCode,200,repeat.body);
 const result=await app.inject({method:"GET",url:"/api/v1/blobs/"+blobId,headers:{...headers,range:"bytes=2-5"}});
 assert.equal(result.statusCode,206,result.body);
 assert.deepEqual(result.rawPayload,png.subarray(2,6));
 assert.equal(result.headers["content-range"],"bytes 2-5/16");
 assert.equal(result.headers["x-content-type-options"],"nosniff");
 const head=await app.inject({method:"HEAD",url:"/api/v1/blobs/"+blobId,headers});
 assert.equal(head.statusCode,200);
 assert.equal(head.body,"");
 assert.equal(head.headers["content-length"],"16");
 const bad=await app.inject({method:"GET",url:"/api/v1/blobs/"+blobId,headers:{...headers,range:"bytes=999-"}});
 assert.equal(bad.statusCode,416,bad.body);
 assert.equal(bad.headers["content-range"],"bytes */16");
 const logout=await app.inject({method:"DELETE",url:"/api/v1/session",headers:authenticated});
 assert.equal(logout.statusCode,204);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/projects/p",headers})).statusCode,401);
});
