import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {patchProject} from "./projects.mjs";

const a={id:"original",type:"text",title:"原节点",metadata:{content:"A"}};
const b={id:"task-added",type:"text",title:"任务创建的节点",metadata:{content:"B"}};
const graph=nodes=>({title:"测试画布",nodes,connections:[]});
async function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 t.after(async()=>{await app.close();db.close()});
 const call=async(method,path,payload)=>{
  const result=await app.inject({method,url:path,...(payload?{payload}:{})});
  return {status:result.statusCode,data:result.json()};
 };
 assert.equal((await call("POST","/api/v1/projects",{id:"p",document:graph([a])})).status,201);
 return {db,call,path:"/api/v1/projects/p"};
}
test("P1a Task-associated graph PATCH rejects late ordinary-node snapshots and preserves backend commit",async t=>{
 const {db,call,path}=await setup(t);
 // Ordinary projects preserve the intentionally-compatible single-user behavior.
 const legacy=await call("PATCH",path,{expectedRevision:1,document:graph([a])});
 assert.equal(legacy.status,200);
 assert.equal(legacy.data.revision,2);
 const created=await call("POST",path+"/assistant/tasks",{
  requestId:"create-p1a",chatSessionId:"chat",rootMessageId:"root",originalRequest:"创建节点"});
 assert.equal(created.status,201);
 const taskId=created.data.task.id;
 // Simulate a backend graph commit. P1b will implement the atomic Step+graph commit.
 const authoritative=patchProject(db,{id:"p",expectedRevision:2,document:graph([a,b])});
 assert.equal(authoritative.revision,3);
 const stale=await call("PATCH",path,{expectedRevision:2,document:graph([a])});
 assert.equal(stale.status,409,JSON.stringify(stale.data));
 assert.equal(stale.data.code,"project_revision_conflict");
 assert.equal(stale.data.details.currentRevision,3);
 const still=await call("GET",path);
 assert.equal(still.data.revision,3);
 assert.deepEqual(still.data.document.nodes.map(n=>n.id),["original","task-added"]);
 const fresh=await call("PATCH",path,{expectedRevision:3,document:graph([a,b])});
 assert.equal(fresh.status,200);
 assert.equal(fresh.data.revision,4);
 const cancelled=await call("POST",path+"/assistant/tasks/"+taskId+"/cancel",{requestId:"end"});
 assert.equal(cancelled.status,200);
 const late=await call("PATCH",path,{expectedRevision:2,document:graph([])});
 assert.equal(late.status,409);
 assert.equal((await call("GET",path)).data.document.nodes.length,2);
});
test("P1a Task-managed PATCH requires current revision and never treats omitted or future revisions as valid",async t=>{
 const {call,path}=await setup(t);
 assert.equal((await call("POST",path+"/assistant/tasks",{
  requestId:"task-1",chatSessionId:"chat",rootMessageId:"root",originalRequest:"创建节点"})).status,201);
 for(const rev of [undefined,3]){
  const response=await call("PATCH",path,{
   ...(rev===undefined?{}:{expectedRevision:rev}),document:graph([])});
  assert.equal(response.status,409);
  assert.equal(response.data.code,"project_revision_conflict");
 }
 assert.equal((await call("GET",path)).data.revision,1);
 assert.equal((await call("GET",path)).data.document.nodes.length,1);
});
test("P1a non-Task single-user late autosaves keep compatible behavior",async t=>{
 const {call,path}=await setup(t);
 const first=await call("PATCH",path,{expectedRevision:1,document:graph([a,b])});
 assert.equal(first.status,200);
 const old=await call("PATCH",path,{expectedRevision:1,document:graph([a])});
 assert.equal(old.status,200);
 assert.equal(old.data.document.nodes.length,1);
});
