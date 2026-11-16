import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {resolveP49CConfiguredChannel} from "../../scripts/p49c-configured-channel-live.mjs";

const dbTest=(config,channels)=>{
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE ui_settings(name TEXT PRIMARY KEY,value_json TEXT);");
 db.exec("CREATE TABLE channels(id TEXT PRIMARY KEY,provider TEXT,display_name TEXT,current_version_id TEXT);");
 db.prepare("INSERT INTO ui_settings(name,value_json) VALUES('model_config',?)").run(JSON.stringify(config));
 for(const item of channels)db.prepare("INSERT INTO channels VALUES(?,?,?,?)")
  .run(item.id,item.provider,item.name,item.keyVersion);
 return db;
};
const online={id:"online-1",name:"Cline",baseUrl:"https://api.cline.bot/api/v1",
 apiFormat:"openai",models:["cline-pass/deepseek-v4.1-flash-1017"]};
const saved={id:"online-1",provider:"openai_compatible",name:"Cline",keyVersion:"encrypted-v1"};
const setting={textModel:"online-1::cline-pass/deepseek-v4.1-flash-1017",
 channels:[online]};
test("P4.9c selects exactly current online text model bound to encrypted DB channel metadata",()=>{
 const db=dbTest(setting,[saved]);
 try{
  const result=resolveP49CConfiguredChannel(db);
  assert.deepEqual(result,{
   channelId:"online-1",displayName:"Cline",provider:"openai_compatible",
   model:"cline-pass/deepseek-v4.1-flash-1017",
   baseUrl:"https://api.cline.bot/api/v1",keyVersionPresent:true
  });
  assert.doesNotMatch(JSON.stringify(result),/encrypted-v1/);
 }finally{db.close()}
});
test("P4.9c refuses selected offline HTTP URL and rejects an unencrypted channel",()=>{
 for(const config of [
  {...setting,channels:[{...online,baseUrl:"http://127.0.0.1:8189/v1"}]},
  {...setting,channels:[{...online,baseUrl:"http://metadata.google.internal"}]}
 ]){
  const db=dbTest(config,[saved]);
  try{assert.throws(()=>resolveP49CConfiguredChannel(db))}
  finally{db.close()}
 }
 const db=dbTest(setting,[{...saved,keyVersion:null}]);
 try{assert.throws(()=>resolveP49CConfiguredChannel(db),/p49c_channel_not_available/)}
 finally{db.close()}
});
test("P4.9c rejects UI->vault ID, provider, display-name and model-selection mismatches",()=>{
 const combos=[
  [{...setting,textModel:"other::a"},[saved]],
  [{...setting,textModel:"online-1::"},[saved]],
  [setting,[{...saved,provider:"google_gemini"}]],
  [setting,[{...saved,name:"unexpected channel"}]],
  [{...setting,channels:[online,online]},[saved]]
 ];
 for(const [cfg,list] of combos){
  const db=dbTest(cfg,list);
  try{assert.throws(()=>resolveP49CConfiguredChannel(db))}
  finally{db.close()}
 }
});
