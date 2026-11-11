import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema} from "./schema.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

test("assistant HTTP resolves current project image and sends actual pixels through OpenAI/Gemini channels",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"atelier-assistant-image-"));
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const blobStore=createBlobStore({db,dataDir:dir});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true})});
 const original=Buffer.from([137,80,78,71,13,10,26,10,11,22,33,44]);
 const file=await blobStore.put([original],{mime:"image/png"});
 const vault={get:channelId=>({provider:channelId==="gemini"?"google_gemini":"openai_compatible",
  hasKey:true,keyVersion:"v1"}),withSecretVersion:(_version,cb)=>cb(Buffer.from("never-leak-key"))};
 const upstream=[];
 const send=async(url,opts)=>{
  const body=JSON.parse(opts.body);upstream.push({url,body});
  const result=JSON.stringify({answer:"图片中有一座灯塔。",actions:[]});
  return new Response(JSON.stringify(url.includes("generateContent")?
   {candidates:[{content:{role:"model",parts:[{text:result}]},finishReason:"STOP"}]}:
   {choices:[{message:{role:"assistant",content:result},finish_reason:"stop"}]}),{status:200});
 };
 const assistantChat=createAssistantChatService({vault,compatibleUpstreamCall:send});
 const app=buildApp({db,blobStore,assistantChat,authorize:()=>true});
 t.after(async()=>app.close());
 const node={id:"img-1",type:"image",title:"原始图片",position:{x:0,y:0},width:100,height:100,
  metadata:{storageKey:"cas:"+file.blobId,mimeType:"image/png",content:"/api/v1/blobs/"+file.blobId}};
 for(const [id,nodes] of [["p1",[node]],["p2",[]]]){
  const create=await app.inject({method:"POST",url:"/api/v1/projects",
   payload:{id,document:{nodes,connections:[]}}});
  assert.equal(create.statusCode,201,create.body);
 }
 const question={model:"demo",canvasActions:true,messages:[{role:"user",content:"请描述该图像"}],
  visualContext:{images:[{nodeId:"img-1"}],detail:"high"}};
 for(const [channelId,provider] of [["compat","openai_compatible"],["gemini","google_gemini"]]){
  const response=await app.inject({method:"POST",url:"/api/v1/projects/p1/assistant/chat",
   payload:{...question,channelId,provider,baseUrl:"http://localhost:8188/v1"}});
  assert.equal(response.statusCode,200,response.body);
  const reply=response.json();
  assert.match(reply.answer,/灯塔/);
  assert.deepEqual(reply.usedVisualReferences,[{nodeId:"img-1",blobId:file.blobId}]);
  assert.equal(reply.actions.length,0);
  assert.doesNotMatch(response.body,/never-leak-key|base64|137,80,78/);
 }
 assert.equal(upstream.length,2);
 const openai=upstream[0].body.messages.at(-1).content;
 assert.equal(openai[0].type,"text");
 assert.equal(openai[1].type,"image_url");
 assert.equal(openai[1].image_url.detail,"high");
 assert.deepEqual(Buffer.from(openai[1].image_url.url.split(",")[1],"base64"),original);
 const gemini=upstream[1].body.contents.at(-1).parts;
 assert.equal(gemini[1].inlineData.mimeType,"image/png");
 assert.deepEqual(Buffer.from(gemini[1].inlineData.data,"base64"),original);
 const unavailable=await app.inject({method:"POST",url:"/api/v1/projects/p2/assistant/chat",
  payload:{...question,provider:"openai_compatible",channelId:"compat"}});
 assert.equal(unavailable.statusCode,422);
 assert.equal(unavailable.json().code,"assistant_visual_node_unavailable");
 assert.equal(upstream.length,2,"cross-project access must not invoke paid provider");
 const missing=await app.inject({method:"POST",url:"/api/v1/projects/p1/assistant/chat",
  payload:{...question,provider:"openai_compatible",channelId:"compat",
   visualContext:{images:[{nodeId:"img-1",imageId:"forged"}]}}});
 assert.equal(missing.statusCode,422);
 assert.equal(upstream.length,2);
});
