import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createRestrictedAssetMultipart} from "./restricted-video-multipart.mjs";
import {parseRestrictedModelScript,runRestrictedModelScript} from "./restricted-model-script.mjs";

const png=Buffer.from("524946460800000057415645666d7420","hex");
const sha=createHash("sha256").update(png).digest("hex");
const asset={kind:"audio",role:"reference_audio",mimeType:"audio/wav",
 sha256:sha,dataUrl:"data:audio/wav;base64,"+png.toString("base64")};
test("trusted FormData constructs real multipart file and bounded metadata from frozen CAS bytes",async()=>{
 const form=createRestrictedAssetMultipart({asset,options:{
  fileField:"media",fields:{role:"reference_audio",model:"test-model",seconds:6}
 }});
 assert.ok(form instanceof FormData);
 assert.equal(form.get("role"),"reference_audio");
 assert.equal(form.get("seconds"),"6");
 const file=form.get("media");
 assert.equal(file.type,"audio/wav");
 assert.equal(file.name,"reference_"+sha.slice(0,16)+".wav");
 assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
 assert.equal([...form.keys()].length,4);
});
test("multipart options reject path traversal, media forged by script, metadata injection and quota abuse",()=>{
 const attempt=(options,ref=asset)=>createRestrictedAssetMultipart({asset:ref,options});
 for(const options of [
  {fileField:"../file"},{fileField:"file",fields:{file:"override"}},
  {fileField:"file",fields:Object.fromEntries([["__proto__","bad"]])},
  {fields:{auth:"data:audio/wav;base64,c2VjcmV0"}},
  {fields:{large:"x".repeat(1100)}},
  {fields:{metadata:{"nested":"evil"}}},
  {fields:{broken:"line\nbreak"}},{fields:[]},
  {fields:Object.fromEntries(Array.from({length:25},(_,i)=>["key"+i,"v"]))}
 ]){
  if(Object.keys(options.fields??{}).length===0&&options.fileField===undefined)continue;
  assert.throws(()=>attempt(options),/model_asset_multipart_/);
 }
 assert.throws(()=>attempt({}, {...asset,dataUrl:"data:audio/wav;base64,QUJD"}),/integrity_invalid/);
 assert.throws(()=>attempt({}, {...asset,mimeType:"image/png"}),/source_invalid/);
 assert.throws(()=>attempt({}, {...asset,sha256:"INVALID"}),/source_invalid/);
 assert.throws(()=>attempt({}, {...asset,kind:"image"}),/source_invalid/);
});
test("the constrained script interpreter permits exactly one multipart call, never arbitrary globals",async()=>{
 const script='const result=await http.multipart("/assets",{fileField:"upload",fields:{role:params.asset.role,model}});return result.id;';
 parseRestrictedModelScript(script);
 let calls=0;
 const result=await runRestrictedModelScript({script,model:"model-1",prompt:"test",
  messages:[],params:{asset},http:async(method,path,opts)=>{
   calls++;
   assert.equal(method,"multipart");assert.equal(path,"/assets");
   assert.equal(opts.fields.role,"reference_audio");
   return {id:"remote_id"};
  }});
 assert.equal(result,"remote_id");assert.equal(calls,1);
 assert.throws(()=>parseRestrictedModelScript('const a=await http.multipart("/assets",{fileField:"file"});const b=await http.multipart("/assets",{fileField:"file"});return b;'),
  /model_script_multiple_requests_forbidden/);
});
