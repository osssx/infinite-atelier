import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Blob} from "node:buffer";
import {Readable} from "node:stream";
import {validateSkillRef,loadFrozenSkillCatalog,runSqliteSkillAgent} from "./sqlite-skill-agent.mjs";
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
const MAX_HISTORY=32,MAX_HISTORY_BYTES=128*1024,MAX_TOOL_OUTPUT=32768;
const textRoles=new Set(["system","user","assistant","tool"]);
function validateTextHistory(task){
 if(task.messages===undefined)return null;
 if(!Array.isArray(task.messages)||task.messages.length<1||task.messages.length>MAX_HISTORY)
  throw failure("model_text_history_invalid");
 let total=0,last="",pending=new Map();
 const normalized=[];
 for(const item of task.messages){
  if(!item||typeof item!=="object"||Array.isArray(item)||!textRoles.has(item.role))
   throw failure("model_text_history_invalid");
  const keys=item.role==="assistant"?["role","content","toolCalls"]:
   item.role==="tool"?["role","content","callId","name"]:["role","content"];
  if(Object.keys(item).some(key=>!keys.includes(key))||
   typeof item.content!=="string"||item.content.length>MAX_TOOL_OUTPUT||
   (total+=Buffer.byteLength(item.content,"utf8"))>MAX_HISTORY_BYTES)
   throw failure("model_text_history_invalid");
  if(item.role==="assistant"&&item.toolCalls!==undefined){
   if(!Array.isArray(item.toolCalls)||item.toolCalls.length<1||item.toolCalls.length>12||
    item.toolCalls.some(call=>!call||typeof call!=="object"||Array.isArray(call)||
     Object.keys(call).some(k=>!["id","name","argumentsJson"].includes(k))||
     typeof call.id!=="string"||!/^[-\w]{1,128}$/.test(call.id)||
     typeof call.name!=="string"||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(call.name)||
     typeof call.argumentsJson!=="string"||call.argumentsJson.length>8192))
     throw failure("model_text_history_invalid");
   for(const call of item.toolCalls){
    if(pending.has(call.id))throw failure("model_text_history_invalid");
    let args;
    try{args=JSON.parse(call.argumentsJson)}catch{throw failure("model_text_history_invalid")}
    if(!args||typeof args!=="object"||Array.isArray(args))throw failure("model_text_history_invalid");
    total+=Buffer.byteLength(call.argumentsJson,"utf8");
    if(total>MAX_HISTORY_BYTES)throw failure("model_text_history_invalid");
    pending.set(call.id,call.name);
   }
  }
  if(item.role==="tool"){
   if(typeof item.callId!=="string"||typeof item.name!=="string"||
    pending.get(item.callId)!==item.name)throw failure("model_text_history_invalid");
   pending.delete(item.callId);
  }
  if(item.role==="user")last=item.content;
  normalized.push(item);
 }
 if(pending.size||task.messages.at(-1).role!=="user"||
  !last.trim()||last!==task.prompt)throw failure("model_text_history_invalid");
 return normalized;
}
function chatHistory(messages){
 return messages.map(item=>item.role==="tool"?
  {role:"tool",tool_call_id:item.callId,content:item.content}:
  item.role==="assistant"&&item.toolCalls?.length?
   {role:"assistant",content:item.content||null,tool_calls:item.toolCalls.map(call=>({
     id:call.id,type:"function",function:{name:call.name,arguments:call.argumentsJson}
   }))}:
   {role:item.role,content:item.content});
}
async function streamOpenAiText(response,db,jobId){
 if(!response.body)throw failure("model_text_stream_missing",502);
 const decoder=new TextDecoder("utf-8",{fatal:true}),reader=response.body.getReader();
 let buffer="",text="",seenDone=false,finished=false,events=0,lastPublished=0,chars=0;
 const publish=()=>{
  if(events>=96||text.length===lastPublished)return;
  const delta=text.slice(lastPublished);
  const sample=delta.slice(0,4096);
  if(!sample)return;
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,"model_text_delta",JSON.stringify({delta:sample}),Date.now());
  events++;lastPublished+=sample.length;
 };
 function frame(block){
  const json=block.split(/\r?\n/).filter(line=>line.startsWith("data:"))
   .map(line=>line.slice(5).trimStart()).join("\n").trim();
  if(!json)return;
  if(json==="[DONE]"){seenDone=true;return}
  let value;
  try{value=JSON.parse(json)}catch{throw failure("model_text_stream_invalid",502)}
  if(value?.error)throw failure("model_text_stream_error",502);
  const choice=value?.choices?.[0];
  if(choice?.delta?.tool_calls?.length||choice?.message?.tool_calls?.length)
   throw failure("model_text_tools_not_supported",502);
  if(choice?.finish_reason!==undefined&&choice.finish_reason!==null){
   if(choice.finish_reason!=="stop")throw failure("model_text_incomplete",502);
   finished=true;
  }
  const next=choice?.delta?.content??choice?.message?.content??"";
  if(typeof next!=="string")throw failure("model_text_stream_invalid",502);
  text+=next;
  chars+=next.length;
  if(Buffer.byteLength(text,"utf8")>2_000_000||chars>2_000_000)
   throw failure("model_text_invalid",502);
  if(text.length-lastPublished>=1024)publish();
 }
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   buffer+=decoder.decode(value,{stream:true});
   if(buffer.length>65536)throw failure("model_text_stream_invalid",502);
   for(;;){
    const split=/\r?\n\r?\n/.exec(buffer);
    if(!split)break;
    const block=buffer.slice(0,split.index);
    buffer=buffer.slice(split.index+split[0].length);
    frame(block);
   }
  }
  buffer+=decoder.decode();
  if(buffer.trim())frame(buffer);
 }finally{reader.releaseLock()}
 if(!seenDone||!finished||!text)throw failure("model_text_stream_incomplete",502);
 publish();
 return text;
}
export function validateModelSnapshot(snapshot){
 if(!snapshot||snapshot.adapterKind!=="model"||snapshot.provider!=="openai"||
  typeof snapshot.channelId!=="string"||!/^[-\w]{1,128}$/.test(snapshot.channelId)||
  typeof snapshot.secretVersionRef!=="string"||!/^[-\w]{1,128}$/.test(snapshot.secretVersionRef))
  throw failure("model_snapshot_invalid");
 const task=snapshot.task;
 if(!task||typeof task!=="object"||Array.isArray(task)||!supported.has(task.kind)||
  !validModel(task.model)||!validPrompt(task.prompt)||
  Object.keys(task).some(key=>!["kind","model","prompt","size","quality","voice","format","speed","operation","images","mask","messages","stream","skills"].includes(key)))
  throw failure("model_task_invalid");
 const allowed=task.kind==="image"?["kind","model","prompt","size","quality","operation","images","mask"]:
  task.kind==="audio"?["kind","model","prompt","voice","format","speed"]:
  ["kind","model","prompt","images","messages","stream","skills"];
 if(Object.keys(task).some(key=>!allowed.includes(key)))throw failure("model_task_invalid");
 if(task.kind==="text"){
  if(task.stream!==undefined&&typeof task.stream!=="boolean")throw failure("model_task_invalid");
  if(task.skills){
   validateSkillRef(task.skills);
   if(!task.messages||task.stream!==false||task.images?.length)
    throw failure("model_skill_task_invalid");
  }
  validateTextHistory(task);
 }
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
  if(task.skills)await loadFrozenSkillCatalog(blobStore,task.skills);
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
   const messages=task.messages?chatHistory(task.messages):[{role:"user",content}];
   if(task.messages&&task.images?.length){
    messages[messages.length-1]={role:"user",content};
   }
   body=JSON.stringify({model:task.model,messages,stream:task.stream===true});
  }
  // Copy an unprotected key into an HTTP header only within the consumer.
  // The vault zeros the temporary Buffer immediately after returning.
  const authorization=vault.withSecretVersion(snapshot.secretVersionRef,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId:snapshot.channelId});
  if(task.skills){
   const skills=await loadFrozenSkillCatalog(blobStore,task.skills);
   const content=await runSqliteSkillAgent({task,jobId:job.id,db,skills,
    authorization,upstreamCall,messages:chatHistory(task.messages)});
   const blob=await blobStore.put([Buffer.from(content,"utf8")],{mime:"text/plain"});
   appendArtifact(db,{jobId:job.id,portId:"text",itemKey:"0",
    blobId:blob.blobId,sha256:blob.sha256,mime:blob.mimeType,kind:"text",
    metadata:{modelGeneration:{kind:"text",model:task.model}}});
   return {kind:"completed",receipt:{artifactReady:true}};
  }
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
   const json=task.kind==="text"&&task.stream===true?null:await boundedJson(response);
   if(image){
    const data=decodeImage(json?.data?.[0]?.b64_json);
    const blob=await blobStore.put([data.bytes],{mime:data.mime});
    record={...blob,kind:"image"};
   }else{
    const content=task.stream===true?await streamOpenAiText(response,db,job.id):json?.choices?.[0]?.message?.content;
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
