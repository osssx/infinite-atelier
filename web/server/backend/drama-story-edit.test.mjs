import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject} from "./projects.mjs";
import {buildApp} from "./app.mjs";
import {buildDramaStoryEditPrompt} from "./drama-story-edit.mjs";

test("story AI prompts separate selection, preceding context and requested rewrite scope",()=>{
 const prompt=buildDramaStoryEditPrompt({mode:"selection",selectedText:"她推开门。",beforeText:"午夜的雨一直在下。",
  afterText:"门外没有人。",instruction:"加深悬疑"});
 assert.match(prompt,/只改写选中的原文片段/);
 assert.match(prompt,/<选中原文>\n她推开门。/);
 assert.match(prompt,/<前文参考>\n午夜的雨一直在下。/);
 assert.match(prompt,/<后文参考>\n门外没有人。/);
 assert.match(prompt,/加深悬疑/);
 assert.doesNotMatch(prompt,/待处理故事全文/);
 const continuing=buildDramaStoryEditPrompt({mode:"continue",beforeText:"她走进树林。"});
 assert.match(continuing,/只输出新增文字/);
 assert.match(continuing,/她走进树林/);
 const polishing=buildDramaStoryEditPrompt({mode:"polish",sourceText:"这天，他又走了过去。"});
 assert.match(polishing,/不擅自更改情节设定/);
});
test("story AI prompts reject empty selections, missing source and oversized text",()=>{
 assert.throws(()=>buildDramaStoryEditPrompt({mode:"selection",selectedText:"  "}),/drama_story_edit_source_required|drama_story_edit_selection_required/);
 assert.throws(()=>buildDramaStoryEditPrompt({mode:"rewrite",sourceText:" "}),/drama_story_edit_source_required/);
 assert.throws(()=>buildDramaStoryEditPrompt({mode:"invalid",sourceText:"test"}),/drama_story_edit_mode_invalid/);
 assert.throws(()=>buildDramaStoryEditPrompt({mode:"rewrite",sourceText:"字".repeat(7000)}),/drama_story_edit_context_too_large/);
});
test("story-edit HTTP checks project, source node and authorization, returns candidate without saving",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"story-ai",document:{title:"Story AI",nodes:[
  {id:"story",type:"drama:source",title:"故事",metadata:{content:"旧文字",dramaDraft:"旧文字"}},
  {id:"text",type:"text",title:"文本",metadata:{content:"不用编辑"}}],connections:[]}});
 const calls=[];
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes",
  assistantChat:async args=>{calls.push(args);return {answer:"她慢慢回头。"};}});
 t.after(async()=>app.close());
 const path="/api/v1/projects/story-ai/drama-pipeline/story-edit";
 const body={nodeId:"story",mode:"selection",channelId:"test-channel",provider:"openai_compatible",
  baseUrl:"http://localhost:8188/v1",model:"test-model",selectedText:"旧文字",beforeText:"前一段"};
 assert.equal((await app.inject({method:"POST",url:path,payload:body})).statusCode,401);
 assert.equal((await app.inject({method:"POST",url:path,payload:{...body,nodeId:"text"},
  headers:{"x-test-owner":"yes"}})).statusCode,404);
 const original=getProject(db,"story-ai").document.nodes[0].metadata.dramaDraft;
 const result=await app.inject({method:"POST",url:path,payload:body,headers:{"x-test-owner":"yes"}});
 assert.equal(result.statusCode,200,result.body);
 assert.deepEqual(result.json(),{mode:"selection",candidate:"她慢慢回头。"});
 assert.equal(calls.length,1);
 assert.equal(calls[0].canvasActions,false);
 assert.equal(calls[0].plainCanvasChat,true);
 assert.equal(getProject(db,"story-ai").document.nodes[0].metadata.dramaDraft,original);
});
