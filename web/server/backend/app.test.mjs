import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {openMainDatabase} from "./database.mjs";
import {buildApp,startServer} from "./app.mjs";
import {createLocalSessionAuth} from "./session.mjs";
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

test("SQLite job snapshot exposes workflow source for duplicate GPU protection",async t=>{
 const{call}=await fixture(t);
 assert.equal((await call("POST","/api/v1/projects",{id:"p4-source",document:doc()})).statusCode,201);
 const payload={idempotencyKey:"same-job",requestFingerprint:"same-job",executionMode:"poll",
  projectId:"p4-source",targetNodeId:"text",expectedProjectRevision:1,
  sourceNodeFingerprint:fingerprintSource(doc(),"text"),
  snapshot:{adapterKind:"comfy",instanceId:"comfy-local"}
 };
 const submitted=await call("POST","/api/v1/jobs",payload);
 assert.equal(submitted.statusCode,201,submitted.body);
 assert.equal(submitted.json().targetNodeId,"text");
 const snapshot=await call("GET","/api/v1/jobs/snapshot");
 assert.equal(snapshot.statusCode,200,snapshot.body);
 const queued=snapshot.json().jobs.find(job=>job.id===submitted.json().id);
 assert.equal(queued.projectId,"p4-source");
 assert.equal(queued.targetNodeId,"text");
 assert.equal(queued.status,"queued");
 const again=await call("POST","/api/v1/jobs",payload);
 assert.equal(again.statusCode,200,again.body);
 assert.equal(again.json().id,submitted.json().id);
});
test("Canvas save validation pinpoints lane and schema field without echoing content",async t=>{
 const {call}=await fixture(t);
 const created=await call("POST","/api/v1/projects",{id:"validation-lanes",document:doc()});
 assert.equal(created.statusCode,201,created.body);
 const cases=[
  {url:"/api/v1/projects/validation-lanes",method:"PATCH",
   payload:{expectedRevision:1,document:{nodes:{"private":"not disclosed"},connections:[]}},
   lane:"graph",field:"/document/nodes",keyword:"type"},
  {url:"/api/v1/projects/validation-lanes/viewport",method:"PUT",
   payload:{expectedRevision:1,viewport:{x:0,y:0,k:null}},
   lane:"viewport",field:"/viewport/k",keyword:"exclusiveMinimum"},
  {url:"/api/v1/projects/validation-lanes/chats",method:"PUT",
   payload:{expectedRevision:1,sessions:[]},
   lane:"chats",field:"/activeChatId",keyword:"required"}
 ];
 for(const item of cases){
  const response=await call(item.method,item.url,item.payload);
  assert.equal(response.statusCode,400,response.body);
  const body=response.json();
  assert.equal(body.code,"invalid_request");
  assert.equal(body.details.lane,item.lane);
  assert.equal(body.details.field,item.field);
  assert.equal(body.details.keyword,item.keyword);
  assert.doesNotMatch(response.body,/not disclosed|private/);
 }
 assert.equal((await call("GET","/api/v1/projects/validation-lanes")).json().revision,1);
});
test("an empty Canvas chat selection preserves null and saves without invalid_request",async t=>{
 const {call}=await fixture(t);
 assert.equal((await call("POST","/api/v1/projects",{
  id:"empty-chat",document:doc()
 })).statusCode,201);
 // The Canvas page has no assistant conversation until the user creates one.
 // Fastify/Ajv must not coerce null to the empty string in this JSON schema.
 const initial=await call("PUT","/api/v1/projects/empty-chat/chats",{
  expectedRevision:1,sessions:[],activeChatId:null
 });
 assert.equal(initial.statusCode,200,initial.body);
 assert.equal(initial.json().activeChatId,null);
 assert.equal(initial.json().revision,2);
 const fresh=(await call("GET","/api/v1/projects/empty-chat/chats")).json();
 assert.equal(fresh.activeChatId,null);
 assert.deepEqual(fresh.sessions,[]);
 const withChat=await call("PUT","/api/v1/projects/empty-chat/chats",{
  expectedRevision:2,
  sessions:[{id:"chat1",title:"Conversation",messages:[]}],
  activeChatId:"chat1"
 });
 assert.equal(withChat.statusCode,200,withChat.body);
 const unselect=await call("PUT","/api/v1/projects/empty-chat/chats",{
  expectedRevision:3,
  sessions:[{id:"chat1",title:"Conversation",messages:[]}],
  activeChatId:null
 });
 assert.equal(unselect.statusCode,200,unselect.body);
 assert.equal(unselect.json().activeChatId,null);
 const invalid=await call("PUT","/api/v1/projects/empty-chat/chats",{
  expectedRevision:4,sessions:[],activeChatId:""
 });
 assert.equal(invalid.statusCode,400,invalid.body);
 assert.equal(invalid.json().code,"invalid_canvas_chats");
 // Failed request never advances the stored revision or overwrites messages.
 assert.equal((await call("GET","/api/v1/projects/empty-chat/chats")).json().revision,4);
});
test("SQLite-only local sessions auto-issue on same-origin GET and protect CRUD",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const sessionAuth=createLocalSessionAuth();
 const app=buildApp({db,sessionAuth,autoLocalSession:true});
 t.after(async()=>{await app.close();db.close()});
 const unauth=await app.inject({method:"GET",url:"/api/v1/projects"});
 assert.equal(unauth.statusCode,401);
 const cross=await app.inject({method:"GET",url:"/api/v1/session",headers:{"sec-fetch-site":"cross-site"}});
 assert.equal(cross.statusCode,403);
 const initial=await app.inject({method:"GET",url:"/api/v1/session",headers:{host:"localhost:3000","sec-fetch-site":"same-origin"}});
 assert.equal(initial.statusCode,200,initial.body);
 const first=initial.json();
 assert.equal(typeof first.csrfToken,"string");
 const cookie=initial.headers["set-cookie"].split(";")[0];
 const owner={host:"localhost:3000",cookie,origin:"http://localhost:3000","x-atelier-csrf":first.csrfToken};
 const same=await app.inject({method:"GET",url:"/api/v1/session",headers:owner});
 assert.equal(same.statusCode,200);
 assert.equal(same.json().csrfToken,first.csrfToken);
 const noCsrf=await app.inject({method:"POST",url:"/api/v1/projects",headers:{cookie,host:"localhost:3000",origin:"http://localhost:3000"},payload:{document:doc()}});
 assert.equal(noCsrf.statusCode,401);
 const created=await app.inject({method:"POST",url:"/api/v1/projects",headers:owner,payload:{id:"sqlite-only",document:doc()}});
 assert.equal(created.statusCode,201,created.body);
 const deleted=await app.inject({method:"DELETE",url:"/api/v1/projects/sqlite-only",headers:owner});
 assert.equal(deleted.statusCode,200,deleted.body);
 assert.equal(deleted.json().deleted,true);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/projects/sqlite-only",headers:owner})).statusCode,404);
 assert.deepEqual((await app.inject({method:"GET",url:"/api/v1/projects",headers:owner})).json().projects,[]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NOT NULL").get().n,1);
});


test("SQLite schema v6 upgrades old backend viewport/chat JSON without losing graph revision",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());
 initializeSchema(db);
 db.exec("DROP TABLE project_chats");
 db.exec("DELETE FROM schema_migrations WHERE version>=7");
 db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(6,0)").run();
 const legacy={...doc("legacy"),title:"Keep",viewport:{x:50,y:-70,k:1.3},
  chatSessions:[{id:"legacy-chat",title:"Old",messages:[]}],activeChatId:"legacy-chat"};
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)")
  .run("old-backend",JSON.stringify(legacy),18);
 initializeSchema(db);initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,16);
 assert.equal(db.prepare("SELECT revision FROM projects WHERE id='old-backend'").get().revision,18);
 assert.deepEqual(JSON.parse(db.prepare("SELECT viewport_json AS v FROM project_viewports WHERE project_id='old-backend'").get().v),
  legacy.viewport);
 assert.equal(db.prepare("SELECT active_chat_id AS id FROM project_chats WHERE project_id='old-backend'").get().id,"legacy-chat");
});
test("viewport and chats have independent SQLite revisions and do not modify the graph",async t=>{
 const{call,db}=await fixture(t);
 const original={...doc(),title:"P2",viewport:{x:3,y:5,k:0.5},
  chatSessions:[{id:"a",title:"A",messages:[],createdAt:"today",updatedAt:"today"}],activeChatId:"a"};
 const created=await call("POST","/api/v1/projects",{id:"p2",document:original});
 assert.equal(created.statusCode,201,created.body);
 assert.equal("chatSessions" in created.json().document,false);
 assert.equal("viewport" in created.json().document,false);
 assert.deepEqual((await call("GET","/api/v1/projects/p2/viewport")).json(),
  {revision:1,viewport:original.viewport});
 assert.deepEqual((await call("GET","/api/v1/projects/p2/chats")).json(),
  {revision:1,sessions:original.chatSessions,activeChatId:"a"});
 const view=await call("PUT","/api/v1/projects/p2/viewport",
  {expectedRevision:1,viewport:{x:100,y:-20,k:1.25}});
 assert.equal(view.statusCode,200,view.body);
 assert.equal(view.json().revision,2);
 const changedChats=await call("PUT","/api/v1/projects/p2/chats",
  {expectedRevision:1,sessions:[{...original.chatSessions[0],messages:[{role:"user",content:"changed"}]}],activeChatId:"a"});
 assert.equal(changedChats.statusCode,200,changedChats.body);
 assert.equal((await call("GET","/api/v1/projects/p2")).json().revision,1);
 const sameGraph=await call("PATCH","/api/v1/projects/p2",{expectedRevision:1,document:doc("modified")});
 assert.equal(sameGraph.statusCode,200,sameGraph.body);
 assert.equal((await call("GET","/api/v1/projects/p2")).json().revision,2);
 assert.equal((await call("GET","/api/v1/projects/p2/viewport")).json().revision,2);
 assert.equal((await call("GET","/api/v1/projects/p2/chats")).json().revision,2);
 const stale=await call("PUT","/api/v1/projects/p2/viewport",{expectedRevision:1,viewport:{x:0,y:0,k:1}});
 assert.equal(stale.statusCode,409);
 const bad=await call("PUT","/api/v1/projects/p2/chats",{expectedRevision:2,sessions:[],activeChatId:"unknown"});
 assert.equal(bad.statusCode,400);
 assert.equal((await call("GET","/api/v1/projects/p2/chats")).json().sessions[0].messages.length,1);
 const injection=await call("PUT","/api/v1/projects/p2/chats",{
  expectedRevision:2,sessions:[{id:"evil",title:"x",messages:[],apiKey:"secret"}],activeChatId:"evil"});
 assert.equal(injection.statusCode,400);
 const gone=await call("DELETE","/api/v1/projects/p2");
 assert.equal(gone.statusCode,200);
 assert.equal((await call("GET","/api/v1/projects/p2/chats")).statusCode,404);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_chats WHERE project_id='p2'").get().n,1);
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


test("two browser origins share project summaries and revision events but never overwrite on stale PATCH",async t=>{
 const {call,db}=await fixture(t);
 const hostA={host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000"};
 const hostB={host:"localhost:3000",origin:"http://localhost:3000"};
 const created=await call("POST","/api/v1/projects",{id:"shared-1",document:{...doc("A"),title:"共享画布"}},hostA);
 assert.equal(created.statusCode,201,created.body);
 const listingA=await call("GET","/api/v1/projects",undefined,hostA);
 const listingB=await call("GET","/api/v1/projects",undefined,hostB);
 assert.equal(listingA.statusCode,200);
 assert.deepEqual(listingA.json(),listingB.json());
 assert.deepEqual(listingA.json().projects,[{id:"shared-1",revision:1,title:"共享画布",nodeCount:1,connectionCount:0}]);
 assert.equal(listingA.json().eventCursor,1);
 const afterSnapshot=listingB.json().eventCursor;
 const edited=await call("PATCH","/api/v1/projects/shared-1",{
  expectedRevision:1,document:{...doc("B"),title:"共享画布"}
 },{"if-match":'"1"',...hostA});
 assert.equal(edited.statusCode,200);
 const stale=await call("PATCH","/api/v1/projects/shared-1",{expectedRevision:1,document:doc("lost")},
  {"if-match":'"1"',...hostB});
 assert.equal(stale.statusCode,409);
 assert.equal((await call("GET","/api/v1/projects/shared-1",undefined,hostB)).json().document.nodes[0].metadata.prompt,"B");
 const stream=await call("GET","/api/v1/projects/events?after="+afterSnapshot+"&once=1",undefined,hostB);
 assert.equal(stream.statusCode,200,stream.body);
 assert.match(stream.body,/event: project/);
 const values=stream.body.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6)));
 assert.deepEqual(values.map(item=>[item.kind,item.projectId,item.revision]),[["updated","shared-1",2]]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE project_id=?").get("shared-1").n,2);
 assert.equal((await call("GET","/api/v1/projects",undefined,hostB)).json().projects[0].revision,2);
 const replay=await call("GET","/api/v1/projects/events?after=0&once=1",undefined,hostA);
 assert.equal(replay.statusCode,200);assert.match(replay.body,/"kind":"created"/);
 const future=await call("GET","/api/v1/projects/events?after=99&once=1",undefined,hostB);
 assert.equal(future.statusCode,400);
});
test("real canvas Comfy/plugin IDs preserve graph and allow guarded job enqueue",async t=>{
 const {call,db}=await fixture(t);
 const comfyId="comfy:workflow-1792758417919-co36n",pluginId="@plugin/image-177:abc";
 const graph={nodes:[
  {id:comfyId,type:"comfy:workflow",title:"W",position:{x:300,y:0},width:420,height:320,
   metadata:{comfyPorts:[{id:"image",label:"Image",direction:"source",valueKind:"IMAGE"}]}},
  {id:pluginId,type:"@plugin/image",title:"Source",position:{x:0,y:0},width:200,height:200,
   metadata:{storageKey:"image:local-abc",content:"blob:example"}}
 ],connections:[{id:"c-1",fromNodeId:pluginId,fromPortId:"image",toNodeId:comfyId,toPortId:"first_frame"}]};
 const created=await call("POST","/api/v1/projects",{id:"p-canvas",document:graph});
 assert.equal(created.statusCode,201,created.body);
 assert.deepEqual(created.json().document,graph);
 const job=await call("POST","/api/v1/jobs",{projectId:"p-canvas",targetNodeId:comfyId,
  expectedProjectRevision:1,sourceNodeFingerprint:fingerprintSource(graph,comfyId),
  executionMode:"poll",idempotencyKey:"canvas-id-1",requestFingerprint:"canvas-id-1",snapshot:{model:"dummy"}});
 assert.equal(job.statusCode,201,job.body);
 const edited={...graph,nodes:graph.nodes.map(n=>n.id===comfyId?{...n,title:"W edited"}:n)};
 const patch=await call("PATCH","/api/v1/projects/p-canvas",{expectedRevision:1,document:edited},{"if-match":'"1"'});
 assert.equal(patch.statusCode,200,patch.body);
 assert.deepEqual(patch.json().document,edited);
 const invalid=await call("POST","/api/v1/projects",{id:"bad-html",document:{
  nodes:[{id:"<img src=x>",type:"image"}],connections:[]}});
 assert.equal(invalid.statusCode,400);
 assert.equal(invalid.json().code,"invalid_project_document");
 assert.deepEqual(invalid.json().details,{reason:"node_id",nodeIndex:0});
 const missing=await call("POST","/api/v1/projects",{id:"bad-link",document:{
  nodes:[{id:"safe",type:"image"}],connections:[{fromNodeId:"safe",toNodeId:"deleted"}]}});
 assert.equal(missing.statusCode,400);
 assert.deepEqual(missing.json().details,{reason:"dangling_connection",connectionIndex:0});
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n,1);
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
 const db=openMainDatabase(dir);assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,16);
 db.close();const reopened=openMainDatabase(dir);
 assert.equal(reopened.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,16);reopened.close();
});
test("startServer rejects wide-area binding",async t=>{
 const{app}=await fixture(t);
 await assert.rejects(startServer(app,{host:"0.0.0.0",port:0}),/loopback_only/);
});
