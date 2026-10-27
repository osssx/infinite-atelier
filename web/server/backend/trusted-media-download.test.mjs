import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createTrustedMediaDownloader} from "./trusted-media-download.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
const allowedUrl="https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/clip.mp4?exp=123&sig=private";
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82,0,0,0,0]);
function fakeRequest({statusCode=200,contentType="image/png",parts=[png],contentLength}={}){
 let called=0;
 function requester(_url,opts,callback){
  called++;
  assert.equal(opts.method,"GET");
  const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{
   const res=Readable.from(parts);
   res.statusCode=statusCode;
   res.headers={"content-type":contentType,...(contentLength?{"content-length":String(contentLength)}:{})};
   callback(res);
  });
  req.destroy=error=>req.emit("error",error);
  return req;
 }
 return {requester,get calls(){return called}};
}
const resolver=async()=>[{address:"8.8.8.8",family:4}];
test("HTTPS signed media is streamed to CAS with verified media type",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-ark-media-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 const blobStore=createBlobStore({db,dataDir:dir});
 const fetcher=fakeRequest({contentType:"application/octet-stream",parts:[png]});
 const service=createTrustedMediaDownloader({blobStore,requester:fetcher.requester,resolver});
 const stored=await service.importUrl(allowedUrl);
 assert.equal(stored.mimeType,"image/png");
 assert.equal((await blobStore.stat(stored.blobId)).byteSize,png.length);
 assert.equal((await service.importUrl(allowedUrl)).existing,true);
 assert.equal(fetcher.calls,2);
 assert.equal(db.prepare("SELECT COUNT(*) count FROM blobs").get().count,1);
});
test("trusted media refuses private addresses, redirects, HTML, oversized and non-allowlisted URLs",async()=>{
 const cases=[
  {opts:{statusCode:302},code:"MEDIA_DOWNLOAD_FAILED"},
  {opts:{contentType:"text/html"},code:"MEDIA_NOT_MEDIA"},
  {opts:{contentLength:500},code:"media_download_too_large"},
  {opts:{parts:[png,Buffer.alloc(100)]},code:"media_download_too_large"},
 ];
 for(const scenario of cases){
  const fetcher=fakeRequest(scenario.opts);
  const service=createTrustedMediaDownloader({blobStore:{put:async source=>{
   for await(const _chunk of source){}return {};
  }},requester:fetcher.requester,
   resolver,maxBytes:50});
  await assert.rejects(service.importUrl(allowedUrl),{code:scenario.code});
 }
 const fetcher=fakeRequest();
 const service=createTrustedMediaDownloader({blobStore:{put:async()=>({})},requester:fetcher.requester,
  resolver:async()=>[{address:"127.0.0.1",family:4}]});
 await assert.rejects(service.importUrl(allowedUrl),{code:"upstream_dns_destination_forbidden"});
 for(const url of ["http://127.0.0.1:8888/a","https://evil.example/image.png",
  "https://127.0.0.1/foo","file:///etc/passwd"])
  await assert.rejects(service.importUrl(url));
 assert.equal(fetcher.calls,0);
});
test("Fastify media import requires same-origin authorized POST; it never creates jobs",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let calls=0;
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",
  mediaDownloader:{importUrl:async()=>{calls++;return {blobId:"a".repeat(64),sha256:"a".repeat(64),byteSize:10,mimeType:"image/png",existing:false}}}});
 t.after(async()=>{await app.close();db.close()});
 const url="/api/v1/media/download",body={url:allowedUrl};
 assert.equal((await app.inject({method:"POST",url,payload:body})).statusCode,401);
 assert.equal((await app.inject({method:"POST",url,payload:body,
  headers:{"x-test-owner":"owner",origin:"https://attacker.example"}})).statusCode,403);
 assert.equal((await app.inject({method:"POST",url,payload:{unexpected:"test"},
  headers:{"x-test-owner":"owner"}})).statusCode,400);
 assert.equal(calls,0);
 const response=await app.inject({method:"POST",url,payload:body,headers:{"x-test-owner":"owner"}});
 assert.equal(response.statusCode,201,response.body);
 assert.equal(response.json().blobId,"a".repeat(64));
 assert.equal(calls,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});
