import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {resolveAssistantSkills} from "./assistant-skills.mjs";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createFileSkillRegistry} from "./file-skill-registry.mjs";

const version="a".repeat(12);
const mk=(id,name,description,skillMd)=>({id,name,description,skillMd,version,resources:{"references/extra.md":"not automatically loaded"},scripts:{"scripts/side-effect.py":"do not run"}});
const catalog=[
 mk("story","短剧编剧","剧本 分镜 故事角色 节奏","按三幕结构梳理冲突，并保持分镜连续。"),
 mk("color","调色指南","电影色彩 调色 光影","建议对比色调与主次光源。"),
 mk("coding","工程调试","程序报错 测试","定位错误和补测试。")
];
const selection=(mode,ids=catalog.map(entry=>entry.id),projectId="p1")=>({
 mode,projectId,expectedRevision:4,skillIds:ids,
 versionPins:Object.fromEntries(ids.map(id=>[id,version]))
});
const messages=[{role:"user",content:"为故事创建三个分镜"}];
const registry={authorized(_db,query){
 if(query.expectedRevision!==4)throw Object.assign(Error("skill_revision_conflict"),{code:"skill_revision_conflict"});
 if(query.skillIds.includes("disabled"))throw Object.assign(Error("skill_authorization_changed"),{code:"skill_authorization_changed"});
 return {revision:4,entries:query.skillIds.map(id=>catalog.find(entry=>entry.id===id))};
}};
test("assistant Skill resolver reuses authorized versions; manual order and auto matching",()=>{
 const manual=resolveAssistantSkills(null,registry,selection("manual",["color","story"]),messages);
 assert.deepEqual(manual.skillIds,["color","story"]);
 assert.ok(manual.context.indexOf("调色指南")<manual.context.indexOf("短剧编剧"));
 assert.match(manual.context,/按三幕结构/);
 assert.doesNotMatch(manual.context,/references\/extra\.md|side-effect\.py/);
 const auto=resolveAssistantSkills(null,registry,selection("auto"),messages);
 assert.deepEqual(auto.skillIds,["story"]);
 assert.deepEqual(resolveAssistantSkills(null,registry,selection("auto"),[{role:"user",content:"随便聊聊"}]).skillIds,[]);
 assert.deepEqual(resolveAssistantSkills(null,registry,undefined,messages),{context:"",skillIds:[]});
 assert.throws(()=>resolveAssistantSkills(null,registry,selection("manual",Array(13).fill("story")),messages),
  {code:"assistant_skill_selection_invalid"});
 assert.throws(()=>resolveAssistantSkills(null,registry,selection("manual",["disabled"]),messages),
  {code:"assistant_skill_catalog_changed"});
 assert.throws(()=>resolveAssistantSkills(null,registry,{...selection("manual",["story"]),expectedRevision:5},messages),
  {code:"assistant_skill_catalog_changed"});
});
test("assistant Skill context never accepts oversize documents and never runs scripts",()=>{
 const oversized={authorized:()=>({entries:[mk("large","超长","large","x".repeat(50*1024))]})};
 assert.throws(()=>resolveAssistantSkills(null,oversized,selection("manual",["large"]),messages),
  {code:"assistant_skill_context_too_large"});
});
test("assistant HTTP injects authorized Skill into user turn only, preserves action plan and project",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const captured=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,cb)=>cb(Buffer.from("private-key"))};
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);captured.push(body);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:"已规划",actions:[
   {type:"create_node",ref:"board-1",nodeType:"text",title:"分镜",content:"场景"}
  ]})}}]}),{status:200});
 }});
 const app=buildApp({db,skillRegistry:registry,assistantChat:service,
  authorize:req=>req.headers["x-test-owner"]==="yes"});
 t.after(async()=>{await app.close();db.close()});
 const headers={"x-test-owner":"yes"};
 assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",headers,
  payload:{id:"p1",document:{nodes:[],connections:[]}}})).statusCode,201);
 const base={channelId:"c1",provider:"openai_compatible",model:"demo",baseUrl:"http://localhost:8080/v1",
  canvasActions:true,messages};
 const send=skills=>app.inject({method:"POST",url:"/api/v1/projects/p1/assistant/chat",headers,
  payload:{...base,...(skills?{skills}:{})}});
 const manual=await send(selection("manual",["story"]));
 assert.equal(manual.statusCode,200,manual.body);
 assert.deepEqual(manual.json().appliedSkillIds,["story"]);
 assert.equal(manual.json().actions[0].type,"create_node");
 assert.match(captured[0].messages[1].content,/selected-skill id="story"/);
 assert.match(captured[0].messages[1].content,/user-request/);
 assert.doesNotMatch(captured[0].messages[0].content,/按三幕结构/);
 assert.doesNotMatch(JSON.stringify(manual.json()),/selected-skill|private-key/);
 const noSkill=await send();
 assert.equal(noSkill.statusCode,200,noSkill.body);
 assert.deepEqual(noSkill.json().appliedSkillIds,[]);
 assert.doesNotMatch(captured[1].messages[1].content,/selected-skill/);
 const auto=await send(selection("auto"));
 assert.equal(auto.statusCode,200,auto.body);
 assert.deepEqual(auto.json().appliedSkillIds,["story"]);
 const mismatch=await send(selection("manual",["story"],"other-project"));
 assert.equal(mismatch.statusCode,400);
 assert.equal(mismatch.json().code,"assistant_skill_selection_invalid");
 const changed=await send({...selection("manual",["story"]),expectedRevision:7});
 assert.equal(changed.statusCode,409);
 assert.equal(changed.json().code,"assistant_skill_catalog_changed");
 assert.equal(captured.length,3);
 const unchanged=await app.inject({method:"GET",url:"/api/v1/projects/p1",headers});
 assert.equal(unchanged.json().revision,1);
 assert.deepEqual(unchanged.json().document.nodes,[]);
});
test("production filesystem Skill registry enforces enablement and project scope at assistant request",async t=>{
 const root=mkdtempSync(join(tmpdir(),"assistant-skills-"));
 const skillDir=join(root,"skills","scene-guide");
 mkdirSync(skillDir,{recursive:true});
 writeFileSync(join(skillDir,"SKILL.md"),"---\nname: scene-guide\ndescription: Scene dialogue and storyboard\n---\nUse three cinematic shots.");
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const skills=createFileSkillRegistry({skillsDir:join(root,"skills")});
 let captured=null;
 const app=buildApp({db,skillRegistry:skills,authorize:req=>req.headers["x-test-owner"]==="owner",
  assistantChat:async input=>{captured=input;return {answer:"okay",model:"demo",actions:[]};}});
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true})});
 const headers={"x-test-owner":"owner"};
 for(const id of ["p1","p2"])assert.equal((await app.inject({method:"POST",url:"/api/v1/projects",
  headers,payload:{id,document:{nodes:[],connections:[]}}})).statusCode,201);
 const entry=skills.list().skills[0];
 const request=(projectId="p1",rev=skills.revision())=>app.inject({method:"POST",headers,
  url:"/api/v1/projects/"+projectId+"/assistant/chat",
  payload:{channelId:"c1",provider:"openai_compatible",model:"demo",messages,
   skills:{mode:"manual",projectId,expectedRevision:rev,skillIds:["scene-guide"],
    versionPins:{"scene-guide":entry.activeVersion}}}});
 const accepted=await request();
 assert.equal(accepted.statusCode,200,accepted.body);
 assert.match(captured.skillContext,/Use three cinematic shots/);
 skills.update("scene-guide",{action:"scope",scope:{type:"project",projectId:"p1"},expectedRevision:skills.revision()});
 const outOfScope=await request("p2");
 assert.equal(outOfScope.statusCode,409,outOfScope.body);
 assert.equal(outOfScope.json().code,"assistant_skill_catalog_changed");
 skills.update("scene-guide",{action:"enabled",enabled:false,expectedRevision:skills.revision()});
 const disabled=await request();
 assert.equal(disabled.statusCode,409,disabled.body);
 assert.equal(disabled.json().code,"assistant_skill_catalog_changed");
 const stale=await request("p1",1);
 assert.equal(stale.statusCode,409,stale.body);
});
test("assistant corrective JSON inference retains selected Skill instructions",async()=>{
 const captured=[];
 const vault={get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_v,cb)=>cb(Buffer.from("private-key"))};
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);captured.push(body);
  const result=captured.length===1?"我会创建节点":
   JSON.stringify({answer:"建议新建",actions:[{type:"create_node",ref:"x",nodeType:"text",title:"节点",content:"剧情"}]});
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:result}]},finishReason:"STOP"}]}),{status:200});
 }});
 const result=await service({channelId:"c1",provider:"google_gemini",model:"gemini-2",
  baseUrl:"http://localhost:8080/v1beta",messages,canvasActions:true,
  skillContext:"<selected-skill>分镜指导</selected-skill>"});
 assert.equal(result.actions.length,1);
 assert.equal(captured.length,2);
 for(const item of captured){
  assert.match(item.contents.at(-1).parts[0].text,/分镜指导/);
  assert.doesNotMatch(item.systemInstruction.parts[0].text,/分镜指导/);
 }
});
