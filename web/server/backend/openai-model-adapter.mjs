import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Blob} from "node:buffer";
import {Readable} from "node:stream";
import {appendArtifact} from "./repository.mjs";

const failure=(code,statusCode=400,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,statusCode,confirmedNotAccepted});
const MIME={mp3:"audio/mpeg",wav:"audio/wav",flac:"audio/flac"};
const supported=new Set(["image","audio","text"]);
const validModel=value=>typeof value==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const validPrompt=value=>typeof value==="string"&&value.trim().length>0&&
 Buffer.byteLength(value,"utf8")<=16000;

const imageMimes=new Set(["image/png","image/jpeg","image/webp"]);
const MAX_INPUT_IMAGE_BYTES=20*1024*1024,MAX_TOTAL_IMAGE_BYTES=64*1024*1024;
function validateImageInputs(task){
 const images=task.images??[];
 if(!Array.isArray(images)||images.length>8||
  images.some(ref=>!ref||typeof ref!=="object"||Array.isArray(ref)||
    Object.keys(ref).some(k=>!["blobId","mimeType"].includes(k))||
    typeof ref.blobId!=="string"||!/^[a-f0-9]{64}$/.test(ref.blobId)||
    !imageMimes.has(ref.mimeType)))throw failure("model_image_inputs_invalid");
 const mask=task.mask;
 if(mask!==undefined&&(!mask||typeof mask!=="object"||Array.isArray(mask)||
    Object.keys(mask).some(k=>!["blobId","mimeType"].includes(k))||
    typeof mask.blobId!=="string"||!/^[a-f0-9]{64}$/.test(mask.blobId)||
    mask.mimeType!=="image/png"))throw failure("model_image_mask_invalid");
 if(task.kind==="image"){
  if(task.operation!==undefined&&task.operation!=="edit")throw failure("model_task_invalid");
  if(task.operation==="edit"&&!images.length||images.length&&task.operation!=="edit"||
   mask!==undefined&&(task.operation!=="edit"||images.length!==1))
   throw failure("model_image_inputs_invalid");
 }else if(task.kind==="text"){
  if(task.operation!==undefined||mask!==undefined)throw failure("model_task_invalid");
 }else if(images.length||mask!==undefined||task.operation!==undefined)
  throw failure("model_task_invalid");
 return images;
}
export function validateModelSnapshot(snapshot){
 if(!snapshot||snapshot.adapterKind!=="model"||snapshot.provider!=="openai"||
  typeof snapshot.channelId!=="string"||!/^[-\w]{1,128}$/.test(snapshot.channelId)||
  typeof snapshot.secretVersionRef!=="string"||!/^[-\w]{1,128}$/.test(snapshot.secretVersionRef))
  throw failure("model_snapshot_invalid");
 const task=snapshot.task;
 if(!task||typeof task!=="object"||Array.isArray(task)||!supported.has(task.kind)||
  !validModel(task.model)||!validPrompt(task.prompt)||
  Object.keys(task).some(key=>!["kind","model","prompt","size","quality","voice","format","speed","operation","images","mask"].includes(key)))
  throw failure("model_task_invalid");
 const allowed=task.kind==="image"?["kind","model","prompt","size","quality","operation","images","mask"]:
  task.kind==="audio"?["kind","model","prompt","voice","format","speed"]:
  ["kind","model","prompt","images"];
 if(Object.keys(task).some(key=>!allowed.includes(key)))throw failure("model_task_invalid");
 validateImageInputs(task);
 if(task.kind==="image"&&
   (task.size!==undefined&&!["auto","1024x1024","1024x1536","1536x1024"].includes(task.size)||
    task.quality!==undefined&&!["auto","low","medium","high"].includes(task.quality)))
  throw failure("model_task_invalid");
 if(task.kind==="audio"&&(
   typeof task.voice!=="string"||!/^[a-zA-Z0-9_-]{1,48}$/.test(task.voice)||
   !Object.hasOwn(MIME,task.format)||
   task.speed!==undefined&&(!Number.isFinite(task.speed)||task.speed<0.25||task.speed>4)))
  throw failure("model_task_invalid");
 return task;
}
async function boundedJson(response,maxBytes=64*1024*1024){
 let size=0;const parts=[];
 if(!response.body)throw failure("model_response_missing",502);
 for await(const part of response.body){
  const chunk=Buffer.from(part);size+=chunk.length;
  if(size>maxBytes)throw failure("model_response_too_large",502);
  parts.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(parts).toString("utf8"))}
 catch{throw failure("model_response_invalid",502)}
}
function decodeImage(value){
 if(typeof value!=="string"||value.length>57_000_000||
  !/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw failure("model_image_invalid",502);
 const bytes=Buffer.from(value,"base64");
 if(bytes.length<8||bytes.length>40_000_000)throw failure("model_image_invalid",502);
 const header=bytes.subarray(0,12);
 const mime=header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":
  header.subarray(0,3).equals(Buffer.from([255,216,255]))?"image/jpeg":
  header.toString("ascii",0,4)==="RIFF"&&header.toString("ascii",8,12)==="WEBP"?"image/webp":null;
 if(!mime)throw failure("model_image_invalid",502);
 return {bytes,mime};
}
/** Trusted fixed OpenAI origin only. Model key is unsealed from DPAPI for the
 * network call, never stored in a JobSnapshot or returned via HTTP. Provider
 * errors are deliberately not recorded/logged to avoid leaking arbitrary data.
 * Only HTTP 4xx means confirmed nonacceptance; ambiguous network failures
 * stay submission_unknown and are never blindly retried.
 */
export function createOpenAiModelAdapter({db,blobStore,vault,upstreamCall=fetch}={}){
 if(!db||!blobStore||!vault||typeof upstreamCall!=="function")throw Error("model_adapter_dependencies_required");
 const check=job=>{
  const snapshot=job.snapshot??JSON.parse(job.snapshot_json);
  const task=validateModelSnapshot(snapshot);
  if(vault.get(snapshot.channelId).provider!=="openai")throw failure("model_provider_mismatch",409);
  vault.checkReference(snapshot.secretVersionRef,snapshot.channelId);
  return {snapshot,task};
 };
 async function readFrozenInputs(task){
  const refs=[...(task.images??[]),...(task.mask?[task.mask]:[])],inputs=[];
  let total=0;
  for(const ref of refs){
   const stat=await blobStore.stat(ref.blobId);
   if(stat.mimeType!==ref.mimeType||!imageMimes.has(stat.mimeType)||
    stat.byteSize<1||stat.byteSize>MAX_INPUT_IMAGE_BYTES||
    (total+=stat.byteSize)>MAX_TOTAL_IMAGE_BYTES)
    throw failure("model_image_input_invalid",422);
   inputs.push(stat);
  }
  return inputs;
 }
 async function prepare({job}){
  const {task}=check(job);
  await readFrozenInputs(task); // reject missing, oversized or wrong-MIME frozen CAS
 }
 async function submit({job}){
  const {snapshot,task}=check(job);
  const image=task.kind==="image",audio=task.kind==="audio";
  const edit=image&&task.operation==="edit";
  const path=image?(edit?"/images/edits":"/images/generations"):audio?"/audio/speech":"/chat/completions";
  const frozen=await readFrozenInputs(task);
  const data=[];
  for(const stat of frozen){
   const bytes=await readFile(stat.path);
   if(bytes.length!==stat.byteSize||createHash("sha256").update(bytes).digest("hex")!==stat.id)
    throw failure("model_image_input_integrity_failed",503);
   data.push(bytes);
  }
  let body,headers={"content-type":"application/json"};
  if(edit){
   const form=new FormData();
   form.set("model",task.model);form.set("prompt",task.prompt);form.set("n","1");
   if(task.size)form.set("size",task.size);
   if(task.quality)form.set("quality",task.quality);
   for(let i=0;i<task.images.length;i++){
    const ref=task.images[i];
    const ext=ref.mimeType==="image/png"?"png":ref.mimeType==="image/webp"?"webp":"jpg";
    form.append("image",new Blob([data[i]],{type:ref.mimeType}),"reference-"+i+"."+ext);
   }
   if(task.mask)form.set("mask",new Blob([data[data.length-1]],{type:"image/png"}),"mask.png");
   body=form;headers={};
  }else if(image){
   body=JSON.stringify({model:task.model,prompt:task.prompt,n:1,
    ...(task.size?{size:task.size}:{}),...(task.quality?{quality:task.quality}:{})});
  }else if(audio){
   body=JSON.stringify({model:task.model,input:task.prompt,voice:task.voice,
    response_format:task.format,...(task.speed?{speed:task.speed}:{})});
  }else{
   const content=task.images?.length?[
    {type:"text",text:task.prompt},
    ...task.images.map((ref,i)=>({type:"image_url",image_url:{
     url:"data:"+ref.mimeType+";base64,"+data[i].toString("base64")}}))
   ]:task.prompt;
   body=JSON.stringify({model:task.model,messages:[{role:"user",content}],stream:false});
  }
  // Copy an unprotected key into an HTTP header only within the consumer.
  // The vault zeros the temporary Buffer immediately after returning.
  const authorization=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  let response;
  try{
   response=await upstreamCall("https://api.openai.com/v1"+path,{
    method:"POST",redirect:"manual",headers:{"authorization":authorization,...headers},body,
    signal:AbortSignal.timeout(120000)
   });
  }catch{throw failure("model_submission_uncertain",502)}
  if(response.status>=300&&response.status<400)throw failure("model_redirect_rejected",502);
  if(!response.ok)throw failure("model_upstream_error",502,response.status>=400&&response.status<500);
  let record;
  if(audio){
   const mime=MIME[task.format];
   if(!response.body)throw failure("model_response_missing",502);
   const blob=await blobStore.put(Readable.fromWeb(response.body),{mime});
   record={...blob,kind:"audio"};
  }else{
   const json=await boundedJson(response);
   if(image){
    const data=decodeImage(json?.data?.[0]?.b64_json);
    const blob=await blobStore.put([data.bytes],{mime:data.mime});
    record={...blob,kind:"image"};
   }else{
    const content=json?.choices?.[0]?.message?.content;
    if(typeof content!=="string"||Buffer.byteLength(content,"utf8")>2_000_000)
     throw failure("model_text_invalid",502);
    const blob=await blobStore.put([Buffer.from(content,"utf8")],{mime:"text/plain"});
    record={...blob,kind:"text"};
   }
  }
  appendArtifact(db,{jobId:job.id,portId:record.kind,itemKey:"0",
   blobId:record.blobId,sha256:record.sha256,mime:record.mimeType,kind:record.kind,
   metadata:{modelGeneration:{kind:task.kind,model:task.model}}});
  // Captured bytes & SQLite artifact are durable BEFORE completed is reported.
  return {kind:"completed",receipt:{artifactReady:true}};
 }
 async function collect({job}){
  if(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(job.id).n<1)
   throw failure("model_artifact_missing",503);
 }
 return {prepare,submit,collect};
}
