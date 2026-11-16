import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {getUiSetting,putUiSetting} from "./ui-settings.mjs";

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),"atelier-setting-"));
 const db=new DatabaseSync(join(root,"settings.sqlite"));
 initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true,maxRetries:3})});
 const call=(method,url,payload,headers={})=>app.inject({method,url,
  headers:{"x-test-owner":"owner",...headers},
  ...(payload===undefined?{}:{payload})});
 return {db,call};
}
const publicConfig={
 channelMode:"local",model:"one::gpt",textModel:"one::gpt",
 imageModel:"",videoModel:"",audioModel:"",
 comfyWorkflowDefaults:{image:{templateId:"image-flow",templateRevision:"a".repeat(64)}},
 audioVoice:"alloy",videoSeconds:"6",comfyAutoDetect:true,
 channels:[{id:"one",name:"API",baseUrl:"https://api.example.test",apiFormat:"openai",
  models:[{name:"gpt",capability:"text"}]}]
};
test("P5.4b schema v12 migrates, preserves existing v11 table, persists nonsecret preferences with revisions",async t=>{
 const x=fixture(t);
 assert.equal(x.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,SCHEMA_VERSION);
 assert.deepEqual(getUiSetting(x.db,"model_config"),{revision:1,value:{}});
 assert.deepEqual(getUiSetting(x.db,"theme"),{revision:1,value:"dark"});
 assert.equal((await x.call("PUT","/api/v1/ui-settings/model_config",
  {expectedRevision:1,value:publicConfig})).statusCode,200);
 assert.deepEqual(getUiSetting(x.db,"model_config"),{revision:2,value:publicConfig});
 assert.equal((await x.call("PUT","/api/v1/ui-settings/theme",
  {expectedRevision:1,value:"light"})).statusCode,200);
 assert.deepEqual(getUiSetting(x.db,"theme"),{revision:2,value:"light"});
 assert.equal(getUiSetting(x.db,"model_config").revision,2); // independent revisions
 assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM asset_catalog").get().n,1);
});
test("P5.4b rejects API keys, scripts, tokens and unknown fields anywhere in settings",async t=>{
 const x=fixture(t),put=(value)=>x.call("PUT","/api/v1/ui-settings/model_config",
  {expectedRevision:1,value});
 for(const payload of [
  {...publicConfig,apiKey:"SHOULD_NEVER_PERSIST"},
  {...publicConfig,baseUrl:"https://api.example.test/?api_key=SECRET"},
  {...publicConfig,channels:[{...publicConfig.channels[0],baseUrl:"https://username:password@api.example.test"}]},
  {...publicConfig,channels:[{...publicConfig.channels[0],apiKey:"SECRET"}]},
  {...publicConfig,channels:[{...publicConfig.channels[0],
   models:[{name:"gpt",capability:"text",script:"const key = 'SECRET'"}]}]},
  {...publicConfig,metadata:{some:"value"}},
  {...publicConfig,comfyWorkflowDefaults:{text:{templateId:"text-flow",templateRevision:"a".repeat(64)}}},
  {...publicConfig,comfyWorkflowDefaults:{image:{templateId:"image-flow",templateRevision:"bad"}}},
  {...publicConfig,channels:[{...publicConfig.channels[0],models:[{
   name:"gpt",capability:"text",videoCapabilities:{accessToken:"secret"}
  }]}]}
 ]){
  const reply=await put(payload);
  assert.ok([400,422].includes(reply.statusCode),reply.body);
  assert.equal(getUiSetting(x.db,"model_config").revision,1);
  assert.ok(!reply.body.includes("SHOULD_NEVER_PERSIST"));
  assert.ok(!reply.body.includes("SECRET"));
 }
 assert.equal((await x.call("PUT","/api/v1/ui-settings/theme",
  {expectedRevision:1,value:"auto"})).statusCode,400);
});
test("mediaCapabilities uses its bounded shared schema without the generic tree depth limit",async t=>{
 const x=fixture(t),put=(value,revision=1)=>x.call("PUT","/api/v1/ui-settings/model_config",{expectedRevision:revision,value});
 const cap={schemaVersion:1,kind:"image",defaultMode:"text_to_image",modes:[{id:"text_to_image",enabled:true,inputs:[],parameters:[{id:"width",mode:"adjustable",type:"number",min:256,max:2048,step:64,defaultValue:1024}]}]};
 const good={...publicConfig,channels:[{...publicConfig.channels[0],models:[{name:"image-model",capability:"image",mediaCapabilities:cap}]}]};
 assert.equal((await put(good)).statusCode,200);
 for(const invalid of [
  {...cap,modes:[{...cap.modes[0],parameters:[{...cap.modes[0].parameters[0],defaultValue:{nested:{script:"bad"}}}]}]},
  {...cap,modes:[{...cap.modes[0],parameters:[{...cap.modes[0].parameters[0],unsupported:"extra"}]}]},
  {...cap,modes:[{...cap.modes[0],inputs:[{role:"mask",kind:"image",minItems:1,maxItems:1}]}]},
  {...cap,defaultMode:"reference_edit"},
  {...cap,modes:[{...cap.modes[0],allowedReferenceCombinations:[["image"],["image","image"]]}]},
 ]){
  const reply=await put({...publicConfig,channels:[{...publicConfig.channels[0],models:[{name:"image-model",capability:"image",mediaCapabilities:invalid}]}]},2);
  assert.equal(reply.statusCode,400,reply.body);
 }
});
test("P5.4b model/theme settings enforce auth, origin, independent revision fencing",async t=>{
 const x=fixture(t);
 assert.equal((await x.call("GET","/api/v1/ui-settings/model_config")).statusCode,200);
 assert.equal((await x.call("GET","/api/v1/ui-settings/secret")).statusCode,400);
 assert.equal((await x.call("PUT","/api/v1/ui-settings/model_config",
  {expectedRevision:1,value:publicConfig},{origin:"https://attacker.example",host:"localhost"})).statusCode,403);
 const update=await x.call("PUT","/api/v1/ui-settings/model_config",
  {expectedRevision:1,value:publicConfig});
 assert.equal(update.statusCode,200);
 const stale=await x.call("PUT","/api/v1/ui-settings/model_config",
  {expectedRevision:1,value:{}});
 assert.equal(stale.statusCode,409);
 assert.equal(stale.json().code,"ui_setting_revision_conflict");
 assert.equal(getUiSetting(x.db,"model_config").revision,2);
 const unauthorized=await x.call("GET","/api/v1/ui-settings/theme",undefined,{"x-test-owner":"invalid"});
 assert.equal(unauthorized.statusCode,401);
});
