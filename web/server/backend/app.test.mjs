import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {openMainDatabase} from "./database.mjs";
import {buildApp,startServer} from "./app.mjs";
import {fingerprintSource,transitionJob} from "./repository.mjs";
const doc=(prompt="hello")=>({nodes:[{id:"text",type:"text",metadata:{prompt}}],connections:[]});
async function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",streamPollMs:20});
 t.after(async()=>{await app.close();db.close()});
 const call=(method,url,payload,headers={})=>app.inject({method,url,headers:{"x-test-owner":"owner",...headers},...(payload===undefined?{}:{payload})});
 return{db,app,call};
}
test("application fail-closed auth and localhost origin rules",async t=>{
 assert.throws(()=>buildApp({db:new DatabaseSync(":memory:")}),/backend_authorizer_required/);
 const{call,app}=await fixture(t);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/jobs/snapshot"})).statusCode,401);
 assert.equal((await call("GET","/health")).statusCode,200);
 assert.equal((await call("GET","/api/v1/jobs/snapshot",undefined,{"host":"attacker.example"})).statusCode,403);
 assert.equal((await call("POST","/api/v1/projects",{document:doc()},{"origin":"https://evil.example"})).statusCode,403);
});
test("project endpoints preserve CAS and reject invalid references",async t=>{
 const{call}=await fixture(t);
 let r=await call("POST","/api/v1/projects",{id:"p",document:doc()});
 assert.equal(r.statusCode,201);assert.equal(r.json().revision,1);
 assert.equal((await call("GET","/api/v1/projects/p")).headers.etag,'"1"');
 r=await call("PATCH","/api/v1/projects/p",{expectedRevision:1,document:doc("revised")},{"if-match":'"1"'});
 assert.equal(r.statusCode,200);assert.equal(r.json().revision,2);
 r=await call("PATCH","/api/v1/projects/p",{expectedRevision:1,document:doc("stale")});
 assert.equal(r.statusCode,409);assert.equal(r.json().code,"project_revision_conflict");assert.equal(r.json().details.currentRevision,2);
 r=await call("PATCH","/api/v1/projects/p",{expectedRevision:2,document:doc("other")},{"if-match":'"1"'});
 assert.equal(r.statusCode,400);
 r=await call("POST","/api/v1/projects",{id:"wrong",document:{nodes:[],connections:[{fromNodeId:"none",toNodeId:"none"}]}});
 assert.equal(r.statusCode,400);
 const unsafe=await call("POST","/api/v1/projects",{id:"leak",document:{
  nodes:[{id:"n",type:"config",metadata:{apiKey:"secret"}}],connections:[]
 }});
 assert.equal(unsafe.statusCode,400);
 assert.equal(unsafe.json().code,"raw_credentials_forbidden");
});
test("project save barrier before job enqueue and persistent idempotency",async t=>{
 const{call,db}=await fixture(t);
 await call("POST","/api/v1/projects",{id:"p",document:doc()});
 const body={projectId:"p",targetNodeId:"text",expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(doc(),"text"),
  executionMode:"poll",idempotencyKey:"idem",requestFingerprint:"fingerprint",snapshot:{model:"test"}};
 let r=await call("POST","/api/v1/jobs",{...body,expectedProjectRevision:2});
 assert.equal(r.statusCode,409);assert.equal(r.json().code,"stale_generation_source");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 r=await call("POST","/api/v1/jobs",body);assert.equal(r.statusCode,201);
 const id=r.json().id;assert.equal((await call("POST","/api/v1/jobs",body)).statusCode,200);
 assert.equal((await call("POST","/api/v1/jobs",{...body,snapshot:{model:"changed"}})).statusCode,409);
 assert.equal((await call("GET","/api/v1/jobs/"+id)).json().status,"queued");
 assert.equal((await call("GET","/api/v1/jobs/snapshot")).json().jobs.length,1);
 assert.equal((await call("POST","/api/v1/jobs",{idempotencyKey:"secret",requestFingerprint:"fp",executionMode:"immediate",
  snapshot:{model:"test",config:{apiKey:"must-not-store"}}})).json().code,"raw_credentials_forbidden");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,1);
 const incomplete=await call("POST","/api/v1/jobs",{projectId:"p",idempotencyKey:"incomplete",requestFingerprint:"incomplete",
  executionMode:"poll",snapshot:{model:"test"}});
 assert.equal(incomplete.statusCode,400);
 assert.equal(incomplete.json().code,"generation_save_barrier_required");
});
test("multi-hop generation fingerprint includes all transitive upstream nodes",()=>{
 const chain={nodes:[
  {id:"first",type:"text",metadata:{prompt:"one"}},
  {id:"middle",type:"text",metadata:{}},
  {id:"last",type:"text",metadata:{}}
 ],connections:[
  {id:"e1",fromNodeId:"first",toNodeId:"middle"},
  {id:"e2",fromNodeId:"middle",toNodeId:"last"}
 ]};
 const initial=fingerprintSource(chain,"last");
 assert.equal(initial,fingerprintSource({...chain,nodes:[...chain.nodes].reverse(),connections:[...chain.connections].reverse()},"last"));
 const edited={...chain,nodes:chain.nodes.map(n=>n.id==="first"?{...n,metadata:{prompt:"two"}}:n)};
 assert.notEqual(initial,fingerprintSource(edited,"last"));
 assert.throws(()=>fingerprintSource({...chain,connections:[...chain.connections,{id:"cycle",fromNodeId:"last",toNodeId:"first"}]},"last"),/cyclic_generation_source/);
});
test("SSE one-shot catch-up from snapshot includes intervening events",async t=>{
 const{call,db}=await fixture(t);
 const r=await call("POST","/api/v1/jobs",{idempotencyKey:"idem",requestFingerprint:"fingerprint",executionMode:"immediate",snapshot:{text:"hello"}});
 assert.equal(r.statusCode,201);const id=r.json().id;
 const snap=(await call("GET","/api/v1/jobs/snapshot")).json();
 assert.equal(snap.eventCursor,1);
 transitionJob(db,id,"preparing");transitionJob(db,id,"submitting");transitionJob(db,id,"collecting");
 const events=await call("GET","/api/v1/events?after="+snap.eventCursor+"&once=1");
 assert.equal(events.statusCode,200);assert.match(events.headers["content-type"],/text\/event-stream/);
 assert.match(events.body,/id: 2\nevent: job/);assert.match(events.body,/id: 4\nevent: job/);
 const replay=await call("GET","/api/v1/events?after=4&once=1");assert.doesNotMatch(replay.body,/id: 4/);
 assert.equal((await call("GET","/api/v1/events?after=999&once=1")).statusCode,400);
});
test("live SSE stream delivers events committed after subscription, without reloading snapshot",async t=>{
 const {call,app,db}=await fixture(t);
 const created=await call("POST","/api/v1/jobs",{idempotencyKey:"live",requestFingerprint:"live",
  executionMode:"poll",snapshot:{model:"test"}});
 const id=created.json().id;
 const snap=(await call("GET","/api/v1/jobs/snapshot")).json();
 const origin=await startServer(app,{port:0});
 const ac=new AbortController();
 const deadline=setTimeout(()=>ac.abort(),3000);deadline.unref?.();
 try{
  const response=await fetch(origin+"/api/v1/events?after="+snap.eventCursor,{
   headers:{"x-test-owner":"owner"},signal:ac.signal
  });
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  transitionJob(db,id,"preparing");
  let text="";
  while(!text.includes("id: "+(snap.eventCursor+1))){
   const {value,done}=await reader.read();
   if(done)break;
   text+=new TextDecoder().decode(value);
  }
  assert.match(text,new RegExp("id: "+(snap.eventCursor+1)));
 }finally{clearTimeout(deadline);ac.abort()}
});
test("SSE reports expired event cursor after retained history is pruned",async t=>{
 const {call,db}=await fixture(t);
 const body={executionMode:"immediate",snapshot:{},idempotencyKey:"old",requestFingerprint:"old"};
 const created=(await call("POST","/api/v1/jobs",body)).json();
 transitionJob(db,created.id,"preparing");
 db.prepare("DELETE FROM job_events WHERE seq=1").run();
 const expired=await call("GET","/api/v1/events?after=0&once=1");
 assert.equal(expired.statusCode,409);
 assert.equal(expired.json().code,"event_cursor_expired");
});
test("disk main db creates schema and remains reusable after close",t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-main-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const db=openMainDatabase(dir);assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,1);
 db.close();const reopened=openMainDatabase(dir);
 assert.equal(reopened.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,1);reopened.close();
});
test("startServer rejects wide-area binding",async t=>{
 const{app}=await fixture(t);
 await assert.rejects(startServer(app,{host:"0.0.0.0",port:0}),/loopback_only/);
});
