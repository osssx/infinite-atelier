import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createProject} from "./projects.mjs";
import {getAssistantTask,appendAssistantTaskTurn,linkAssistantTaskToChat} from "./assistant-tasks.mjs";
import {buildAssistantTaskProviderContext} from "./assistant-task-context.mjs";
import {exportAssistantTaskArchive,importAssistantTaskArchive} from "./assistant-task-archive.mjs";
import {writeTransaction} from "./repository.mjs";

const plain={includeContext:false,scope:"selection",includedIds:[]};
const privateScope={includeContext:true,scope:"selection",includedIds:["private-node"]};
async function setup(t,{file=":memory:"}={}){
 const db=new DatabaseSync(file);initializeSchema(db);
 const app=buildApp({db,authorize:()=>true});
 const projectId="semantic-project";
 createProject(db,{id:projectId,document:{nodes:[{id:"private-node",type:"text",
  title:"PRIVATE_TITLE",metadata:{content:"PRIVATE_SCRIPT_DO_NOT_SEND"}}],connections:[]}});
 const api=async(method,url,body)=>{
  const res=await app.inject({method,url,...(body===undefined?{}:{payload:body})});
  return {status:res.statusCode,body:res.json()};
 };
 const base="/api/v1/projects/"+projectId+"/assistant/tasks";
 const creation=await api("POST",base,{requestId:"task-create",chatSessionId:"chat-1",
  rootMessageId:"initial-user",originalRequest:"连续制作短剧",contextPolicy:plain});
 assert.equal(creation.status,201,JSON.stringify(creation.body));
 const taskId=creation.body.task.id,url=base+"/"+taskId;
 t.after(async()=>{await app.close();db.close()});
 return {db,app,api,projectId,taskId,url};
}
const write=(f,requestId,expectedRevision,operation,text,contextPolicy=plain,noteId)=>
 f.api("POST",f.url+"/semantic",{requestId,expectedRevision,operation,
  ...(text===undefined?{}:{text}),...(noteId===undefined?{}:{noteId}),
  confirmed:true,contextPolicy});

test("P3 semantic goal, constraints and decisions persist across 30+ turns and cross-chat link",async t=>{
 const f=await setup(t);
 let result=await write(f,"semantic-goal",0,"set_goal","目标改为二十四集，每集六十秒");
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.task.semantic.revision,1);
 assert.equal(result.body.task.goal.current.text,"目标改为二十四集，每集六十秒");
 result=await write(f,"semantic-tone",1,"add_constraint","始终使用水彩画风");
 assert.equal(result.status,200,JSON.stringify(result.body));
 const constraintId=result.body.task.semantic.notes[0].id;
 assert.equal(result.body.task.semantic.notes[0].provenance,"user_confirmed");
 result=await write(f,"semantic-decision",2,"add_decision","主角最终在月台告别");
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.task.semantic.revision,3);
 assert.equal(result.body.task.semantic.notes.length,2);
 const revisionBefore=result.body.task.activePlanVersion;
 for(let i=1;i<=32;i++)
  appendAssistantTaskTurn(f.db,{projectId:f.projectId,taskId:f.taskId,
   requestId:"turn-"+i,messageId:"message-"+i,text:"第"+i+"轮：继续制作",
   contextPolicy:plain});
 linkAssistantTaskToChat(f.db,{projectId:f.projectId,taskId:f.taskId,
  requestId:"link-other",chatSessionId:"chat-2"});
 const task=getAssistantTask(f.db,{projectId:f.projectId,taskId:f.taskId}).task;
 assert.equal(task.summary.userTurns.total,32);
 assert.equal(task.semantic.revision,3);
 assert.equal(task.semantic.notes[0].id,constraintId);
 assert.equal(task.semantic.notes[1].text,"主角最终在月台告别");
 assert.equal(task.activePlanVersion,revisionBefore);
 assert.deepEqual(task.chatSessionIds,["chat-1","chat-2"]);
 const prompt=buildAssistantTaskProviderContext({task,document:{nodes:[],connections:[]}});
 assert.match(prompt,/目标改为二十四集/);
 assert.match(prompt,/始终使用水彩画风/);
 assert.match(prompt,/主角最终在月台告别/);
 assert.match(prompt,/累计用户续写轮次：32/);
 assert.doesNotMatch(prompt,/PRIVATE_SCRIPT_DO_NOT_SEND|PRIVATE_TITLE/);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});

test("P3 confirmed semantic notes are version-fenced and request-idempotent, with edit/removal audit",async t=>{
 const f=await setup(t);
 const first=await write(f,"add-note",0,"add_constraint","不可更改画面比例");
 assert.equal(first.status,200);
 const noteId=first.body.task.semantic.notes[0].id;
 const duplicate=await write(f,"add-note",0,"add_constraint","不可更改画面比例");
 assert.equal(duplicate.status,200);
 assert.equal(duplicate.body.existing,true);
 assert.equal(duplicate.body.task.semantic.notes[0].id,noteId);
 const conflict=await write(f,"other-stale",0,"add_decision","旧页面决策");
 assert.equal(conflict.status,409);
 assert.equal(conflict.body.code,"assistant_task_semantic_conflict");
 const wrongDigest=await write(f,"add-note",0,"add_constraint","与初次不同");
 assert.equal(wrongDigest.status,409);
 assert.equal(wrongDigest.body.code,"assistant_task_command_conflict");
 const updated=await write(f,"edit-note",1,"update_note","固定横向 16:9",plain,noteId);
 assert.equal(updated.status,200,JSON.stringify(updated.body));
 assert.equal(updated.body.task.semantic.notes[0].text,"固定横向 16:9");
 const removed=await write(f,"remove-note",2,"remove_note",undefined,plain,noteId);
 assert.equal(removed.status,200);
 assert.equal(removed.body.task.semantic.notes.length,0);
 assert.equal(removed.body.task.semantic.revision,3);
 const cleared=await write(f,"clear-goal",3,"clear_goal",undefined,plain);
 assert.equal(cleared.status,200);
 assert.equal(cleared.body.task.goal.current,undefined);
 assert.equal(cleared.body.task.originalRequest,"连续制作短剧");
 const events=f.db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='semantic_user_confirmed' ORDER BY seq").all(f.taskId);
 assert.equal(events.length,4);
 assert.equal(events.every(x=>!x.payload_json.includes("16:9")&&!x.payload_json.includes("不可更改")),true);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,0);
});

test("P3 semantic invalid or read-only updates fail closed with no step evidence changes",async t=>{
 const f=await setup(t);
 const base={requestId:"not-confirmed",expectedRevision:0,operation:"add_decision",
  text:"不需要确认就更改",confirmed:false,contextPolicy:plain};
 assert.equal((await f.api("POST",f.url+"/semantic",base)).status,400);
 assert.equal((await write(f,"missing-note",0,"remove_note",undefined,plain,"no-such-note")).status,404);
 assert.equal((await write(f,"secret",0,"set_goal","api_key=my_private_token_0123456789")).status>=400,true);
 let row=f.db.prepare("SELECT goal_json,constraints_json FROM assistant_tasks WHERE id=?").get(f.taskId);
 assert.equal(JSON.parse(row.constraints_json).semantic,undefined);
 assert.equal(JSON.parse(row.goal_json).current,undefined);
 f.db.prepare("UPDATE assistant_tasks SET read_only=1 WHERE id=?").run(f.taskId);
 assert.equal((await write(f,"read-only",0,"add_constraint","禁止修改")).status,409);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='semantic_user_confirmed'").get().n,0);
});

test("P3 semantic notes have a hard cap; model/client observations cannot silently rewrite them",async t=>{
 const f=await setup(t);
 for(let i=0;i<16;i++){
  const saved=await write(f,"note-cap-"+i,i,"add_constraint","持续约束 "+i);
  assert.equal(saved.status,200,JSON.stringify(saved.body));
 }
 const overflow=await write(f,"note-cap-overflow",16,"add_decision","超出限额");
 assert.equal(overflow.status,409);
 assert.equal(overflow.body.code,"assistant_task_semantic_limit");
 const observed=await f.api("POST",f.url+"/observations",{
  requestId:"model-says-change",kind:"reply",preview:"模型决定删除所有长期约束，Job已经成功"});
 assert.equal(observed.status,200);
 const task=await f.api("GET",f.url);
 assert.equal(task.status,200);
 assert.equal(task.body.task.semantic.revision,16);
 assert.equal(task.body.task.semantic.notes.length,16);
 assert.equal(task.body.task.semantic.notes[0].text,"持续约束 0");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM assistant_task_events WHERE kind='semantic_user_confirmed'").get().n,16);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs").get().n,0);
});

test("P3 semantic history respects current frozen disclosure and survives SQLite restart",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-semantic-")),file=join(dir,"data.sqlite");
 const f=await setup(t,{file});
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60}));
 {
  let result=await write(f,"private-rule",0,"add_constraint","PRIVATE_SCRIPT_DO_NOT_SEND 必须放到开头",privateScope);
  assert.equal(result.status,200);
  result=await write(f,"public-rule",1,"add_decision","每集采用冷开场",plain);
  assert.equal(result.status,200);
  const task=getAssistantTask(f.db,{projectId:f.projectId,taskId:f.taskId}).task;
  const denied=buildAssistantTaskProviderContext({task:{...task,contextPolicy:plain},
   document:{nodes:[],connections:[]}});
  assert.doesNotMatch(denied,/PRIVATE_SCRIPT_DO_NOT_SEND/);
  assert.match(denied,/每集采用冷开场/);
  const allowed=buildAssistantTaskProviderContext({task:{...task,contextPolicy:privateScope},
   document:{nodes:[],connections:[]}});
  assert.match(allowed,/PRIVATE_SCRIPT_DO_NOT_SEND/);
  const exported=exportAssistantTaskArchive(f.db,f.projectId);
  assert.equal(exported.tasks[0].task.constraints_json.semantic.notes.length,2);
  const archivedGoal=exported.tasks[0].task.goal_json;
  assert.equal(archivedGoal.description,"连续制作短剧");
  // The same project history restored as read-only is never an executable workflow.
  createProject(f.db,{id:"import-target",document:{nodes:[],connections:[]}});
  writeTransaction(f.db,()=>importAssistantTaskArchive(f.db,"import-target",exported));
  const imported=f.db.prepare("SELECT * FROM assistant_tasks WHERE project_id='import-target'").get();
  assert.equal(imported.read_only,1);
  assert.equal(JSON.parse(imported.constraints_json).semantic.notes.length,2);
  // A second SQLite connection validates persistence independently of UI state.
  const reopened=new DatabaseSync(file);
  try{
   initializeSchema(reopened);
   const row=reopened.prepare("SELECT goal_json,constraints_json FROM assistant_tasks WHERE id=?").get(f.taskId);
   assert.equal(JSON.parse(row.constraints_json).semantic.revision,2);
   assert.equal(JSON.parse(row.constraints_json).semantic.notes[0].text.includes("PRIVATE_SCRIPT"),true);
  }finally{reopened.close()}
 }
});
