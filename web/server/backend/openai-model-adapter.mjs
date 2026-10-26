import {Readable} from "node:stream";
import {appendArtifact} from "./repository.mjs";

const failure=(code,statusCode=400,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,statusCode,confirmedNotAccepted});
const MIME={mp3:"audio/mpeg",wav:"audio/wav",flac:"audio/flac"};
const supported=new Set(["image","audio","text"]);
const validModel=value=>typeof value==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const validPrompt=value=>typeof value==="string"&&value.trim().length>0&&
 Buffer.byteLength(value,"utf8")<=16000;

export function validateModelSnapshot(snapshot){
 if(!snapshot||snapshot.adapterKind!=="model"||snapshot.provider!=="openai"||
  typeof snapshot.channelId!=="string"||!/^[-\w]{1,128}$/.test(snapshot.channelId)||
  typeof snapshot.secretVersionRef!=="string"||!/^[-\w]{1,128}$/.test(snapshot.secretVersionRef))
  throw failure("model_snapshot_invalid");
 const task=snapshot.task;
 if(!task||typeof task!=="object"||!supported.has(task.kind)||
  !validModel(task.model)||!validPrompt(task.prompt)||
  Object.keys(task).some(key=>!["kind","model","prompt","size","quality","voice","format","speed"].includes(key)))
  throw failure("model_task_invalid");
 const allowed=task.kind==="image"?["kind","model","prompt","size","quality"]:
  task.kind==="audio"?["kind","model","prompt","voice","format","speed"]:
  ["kind","model","prompt"];
 if(Object.keys(task).some(key=>!allowed.includes(key)))throw failure("model_task_invalid");
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
 async function prepare({job}){check(job)}
 async function submit({job}){
  const {snapshot,task}=check(job);
  const image=task.kind==="image",audio=task.kind==="audio";
  const path=image?"/images/generations":audio?"/audio/speech":"/chat/completions";
  const body=image?{model:task.model,prompt:task.prompt,n:1,
   ...(task.size?{size:task.size}:{}),...(task.quality?{quality:task.quality}:{})}:
   audio?{model:task.model,input:task.prompt,voice:task.voice,
    response_format:task.format,...(task.speed?{speed:task.speed}:{})}:
    {model:task.model,messages:[{role:"user",content:task.prompt}],stream:false};
  // Copy an unprotected key into an HTTP header only within the consumer.
  // The vault zeros the temporary Buffer immediately after returning.
  const authorization=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  let response;
  try{
   response=await upstreamCall("https://api.openai.com/v1"+path,{
    method:"POST",redirect:"manual",headers:{"authorization":authorization,
     "content-type":"application/json"},body:JSON.stringify(body),
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
