import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createRestrictedSignedPut,validateSignedPutUrl,validateSignedPutAsset} from "./restricted-video-signed-put.mjs";

const bytes=Buffer.from("000000186674797069736f6d0000020069736f6d69736f32","hex");
const sha=createHash("sha256").update(bytes).digest("hex");
const asset={kind:"video",mimeType:"video/mp4",sha256:sha,
 dataUrl:"data:video/mp4;base64,"+bytes.toString("base64")};
const signed="https://storage.example.com/objects/path.mp4?X-Amz-Signature=secret&X-Amz-Expires=600";

test("accepts a signed public HTTPS URL and PUTs exactly the CAS bytes, never a Vault bearer",async()=>{
 const calls=[];
 const put=createRestrictedSignedPut({fetcher:async(url,options)=>{
  calls.push({url,options});
  return new Response(null,{status:200});
 }});
 await put({uploadUrl:signed,asset});
 assert.equal(calls.length,1);
 const {url,options}=calls[0];
 assert.equal(url,signed);
 assert.equal(options.method,"PUT");
 assert.equal(options.redirect,"manual");
 assert.equal(options.headers["content-type"],"video/mp4");
 assert.ok(!JSON.stringify(options.headers).toLowerCase().includes("authorization"));
 assert.deepEqual(Buffer.from(options.body),bytes);
 assert.ok(options.dispatcher);
 assert.ok(!Object.keys(options).includes("credentials"));
 assert.equal(validateSignedPutUrl(signed).hostname,"storage.example.com");
 assert.deepEqual(validateSignedPutAsset(asset),bytes);
});
test("captures only a returned ETag from a confirmed signed PUT for chunk upload",async()=>{
 const put=createRestrictedSignedPut({fetcher:async()=>new Response(null,{
  status:204,headers:{"ETag":'"abc-1"'}
 })});
 assert.deepEqual(await put({uploadUrl:signed,asset}),{uploaded:true,etag:'"abc-1"'});
});
test("rejects metadata, private IP, localhost, redirects, credentials and non-HTTPS before any network",async()=>{
 const put=createRestrictedSignedPut({fetcher:async()=>{throw Error("should_not_fetch")}});
 for(const url of [
  "http://storage.example.com/object?signature=1",
  "https://169.254.169.254/latest/meta-data",
  "https://127.0.0.1/private",
  "https://[::1]/private",
  "https://localhost/file",
  "https://storage.example.com:8080/a",
  "https://user:pass@storage.example.com/a",
  "https://storage.example.com/a#fragment",
  "file:///etc/passwd",
  "https://storage.example.com/",
  "https://example.internal/object"
 ]){
  await assert.rejects(put({uploadUrl:url,asset}),
   /model_signed_put_(url_invalid|destination_forbidden)/,url);
 }
 for(const modified of [
  {...asset,sha256:"0".repeat(64)},
  {...asset,dataUrl:"data:video/mp4;base64,QUJD"},
  {...asset,kind:"image"},
  {...asset,mimeType:"video/avi"},
  {...asset,dataUrl:"file:///private"}
 ]){
  assert.throws(()=>validateSignedPutAsset(modified),/model_signed_put_/);
 }
});
test("signed PUT network uncertainty and non-2xx response are never treated as upload success",async()=>{
 const errors=[];
 for(const fetcher of [
  async()=>{throw Error("secret full signed URL https://storage.example.com/objects?Signature=secret")},
  async()=>new Response(null,{status:403}),
  async()=>new Response(null,{status:302,headers:{location:"https://attacker.example/evil"}})
 ]){
  const put=createRestrictedSignedPut({fetcher});
  try{await put({uploadUrl:signed,asset});assert.fail("must reject")}
  catch(error){errors.push(error.message)}
 }
 assert.deepEqual(errors,Array(3).fill("model_signed_put_outcome_unknown"));
 assert.ok(!errors.join(" ").includes("Signature"));
 assert.ok(!errors.join(" ").includes("secret"));
});
