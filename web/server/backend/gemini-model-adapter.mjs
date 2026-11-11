import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {compatEndpointFingerprint,createPinnedOpenAiCompatCall,normalizeOpenAiCompatBaseUrl} from "./openai-compat-endpoints.mjs";
import {appendArtifact} from "./repository.mjs";
import {geminiVisionParts} from "./model-vision-parts.mjs";

const failure=(code,statusCode=400,confirmedNotAccepted=false)=>
 Object.assign(Error(code),{code,statusCode,confirmedNotAccepted});
const imageMimes=new Set(["image/png","image/jpeg","image/webp"]);
const MAX_INPUT_IMAGE_BYTES=20*1024*1024,MAX_TOTAL_IMAGE_BYTES=64*1024*1024;
const validModel=value=>typeof value==="string"&&value.length<=128&&
 /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(value);
const validPrompt=value=>typeof value==="string"&&value.trim().length>0&&
 Buffer.byteLength(value,"utf8")<=512*1024;
const validRef=ref=>ref&&typeof ref==="object"&&!Array.isArray(ref)&&
 Object.keys(ref).every(k=>["blobId","mimeType"].includes(k))&&
 typeof ref.blobId==="string"&&/^[a-f0-9]{64}$/.test(ref.blobId)&&imageMimes.has(ref.mimeType);
const geminiEndpoint=base=>/\/v1(?:beta)?$/i.test(base)?base:`${base}/v1beta`;
const GEMINI_IMAGE_RATIOS=["1:1","1:4","1:8","2:3","3:2","3:4","4:1","4:3","4:5","5:4","8:1","9:16","16:9","21:9"];
function geminiImageConfig(task){
 const config={responseModalities:["TEXT","IMAGE"],candidateCount:task.count??1},image={};
 const dimensions=typeof task.size==="string"?task.size.match(/^(\d{2,5})x(\d{2,5})$/):null;
 if(dimensions){
  const width=Number(dimensions[1]),height=Number(dimensions[2]);
  if(width<1||height<1||width>8192||height>8192)throw failure("gemini_model_task_invalid");
  const target=width/height;
  const ratios=GEMINI_IMAGE_RATIOS.map(value=>({value,parts:value.split(":").map(Number)}));
  image.aspectRatio=ratios.reduce((best,item)=>
   Math.abs(item.parts[0]/item.parts[1]-target)<Math.abs(best.parts[0]/best.parts[1]-target)?item:best).value;
 }else if(task.size!==undefined&&task.size!=="auto")throw failure("gemini_model_task_invalid");
 const quality=String(task.quality??"auto").trim().toLowerCase();
 const imageSize={low:"1K",standard:"1K",medium:"2K",hd:"2K",high:"4K"}[quality];
 if(imageSize&&/(?:gemini-3|3\.1|3-pro)/i.test(task.model))image.imageSize=imageSize;
 else if(!["auto","low","standard","medium","hd","high"].includes(quality))
  throw failure("gemini_model_task_invalid");
 if(Object.keys(image).length)config.responseFormat={image};
 return config;
}

/** Gemini requests are intentionally separate from the OpenAI adapter. Each
 * job freezes a validated endpoint URL and fingerprint, model IDs are
 * path-segment validated, and the key travels in x-goog-api-key rather than
 * a query string. The default caller pins DNS and keeps TLS verification on.
 */
export function validateGeminiModelSnapshot(snapshot){
 if(!snapshot||snapshot.adapterKind!=="model"||snapshot.provider!=="google_gemini"||
  typeof snapshot.channelId!=="string"||!/^[-\w]{1,128}$/.test(snapshot.channelId)||
  typeof snapshot.secretVersionRef!=="string"||!/^[-\w]{1,128}$/.test(snapshot.secretVersionRef)||
  typeof snapshot.endpointBaseUrl!=="string"||typeof snapshot.endpointFingerprint!=="string")
  throw failure("gemini_model_snapshot_invalid");
 let endpoint;
 try{endpoint=normalizeOpenAiCompatBaseUrl(snapshot.endpointBaseUrl)}
 catch{throw failure("gemini_model_endpoint_invalid")}
 if(endpoint!==snapshot.endpointBaseUrl||snapshot.endpointFingerprint!==compatEndpointFingerprint(endpoint))
  throw failure("gemini_model_endpoint_invalid");
 const task=snapshot.task;
 if(!task||typeof task!=="object"||Array.isArray(task)||
  !["image","text"].includes(task.kind)||!validModel(task.model)||!validPrompt(task.prompt))
  throw failure("gemini_model_task_invalid");
 const allowed=task.kind==="image"?
  ["kind","model","prompt","count","size","quality","images","operation","writeBack"]:
  ["kind","model","prompt","messages","images","stream"];
 if(Object.keys(task).some(k=>!allowed.includes(k)))throw failure("gemini_model_task_invalid");
 const images=task.images??[];
 if(!Array.isArray(images)||images.length>8||images.some(ref=>!validRef(ref)))
  throw failure("gemini_model_image_inputs_invalid");
 if(task.kind==="image"){
  if(task.operation!==undefined&&task.operation!=="edit"||
    (images.length>0)!==(task.operation==="edit")||
    task.count!==undefined&&(!Number.isSafeInteger(task.count)||task.count<1||task.count>10)||
    task.writeBack!==undefined&&typeof task.writeBack!=="boolean"||
    task.size!==undefined&&typeof task.size!=="string"||
    task.quality!==undefined&&typeof task.quality!=="string")
   throw failure("gemini_model_task_invalid");
 }else{
  if(task.stream!==undefined&&task.stream!==false||task.count!==undefined||task.operation!==undefined||
    !Array.isArray(task.messages)||task.messages.length<1||task.messages.length>32||
    task.messages.some(item=>!item||typeof item!=="object"||Array.isArray(item)||
      Object.keys(item).some(k=>!(["role","content"].includes(k)))||
      !["system","user","assistant"].includes(item.role)||typeof item.content!=="string"||
      Buffer.byteLength(item.content,"utf8")>512*1024)||
    task.messages.at(-1)?.role!=="user"||task.messages.at(-1)?.content!==task.prompt)
   throw failure("gemini_model_task_invalid");
 }
 return task;
}

async function boundedJson(response,maxBytes=64*1024*1024){
 let size=0;const parts=[];
 if(!response.body)throw failure("gemini_model_response_missing",502);
 for await(const part of response.body){
  const chunk=Buffer.from(part);size+=chunk.length;
  if(size>maxBytes)throw failure("gemini_model_response_too_large",502);
  parts.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(parts).toString("utf8"))}
 catch{throw failure("gemini_model_response_invalid",502)}
}
function decodeImage(value,mimeHint){
 if(typeof value!=="string"||value.length>57_000_000||!(/^[A-Za-z0-9+/]+={0,2}$/.test(value)))
  throw failure("gemini_model_image_invalid",502);
 const bytes=Buffer.from(value,"base64");
 if(bytes.length<8||bytes.length>40_000_000)throw failure("gemini_model_image_invalid",502);
 const head=bytes.subarray(0,12);
 const mime=head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":
  head.subarray(0,3).equals(Buffer.from([255,216,255]))?"image/jpeg":
  head.toString("ascii",0,4)==="RIFF"&&head.toString("ascii",8,12)==="WEBP"?"image/webp":null;
 if(!mime||mimeHint&&mimeHint!==mime)throw failure("gemini_model_image_invalid",502);
 return {bytes,mime};
}
function modelPath(model){return model.split("/").map(encodeURIComponent).join("/")}
function normalizeGeminiHistory(task){
 const turns=task.messages.map(item=>({role:item.role==="assistant"?"model":"user",
  parts:[{text:item.content}]}));
 const system=task.messages.filter(item=>item.role==="system").map(item=>item.content).join("\n\n");
 const contents=turns.filter((_,i)=>task.messages[i].role!=="system");
 // Gemini requires alternating user/model turns; preserve history only when
 // it is valid. The UI history may include repeated same-role items, so merge.
 const merged=[];
 for(const turn of contents){
  const last=merged.at(-1);
  if(last?.role===turn.role)last.parts.push(...turn.parts);else merged.push(turn);
 }
 if(!merged.length||merged.at(-1).role!=="user")throw failure("gemini_model_text_history_invalid");
 return {contents:merged,...(system?{systemInstruction:{parts:[{text:system}]}}:{})};
}

export function createGeminiModelAdapter({db,blobStore,vault,
 upstreamCall=createPinnedOpenAiCompatCall({allowGetModels:true})}={}){
 if(!db||!blobStore||!vault||typeof upstreamCall!=="function")
  throw Error("gemini_model_adapter_dependencies_required");
 const check=job=>{
  const snapshot=job.snapshot??JSON.parse(job.snapshot_json);
  const task=validateGeminiModelSnapshot(snapshot);
  if(vault.get(snapshot.channelId).provider!=="google_gemini")throw failure("gemini_model_provider_mismatch",409);
  vault.checkReference(snapshot.secretVersionRef,snapshot.channelId);
  return {snapshot,task};
 };
 async function readImages(task){
  const refs=task.images??[],out=[];let total=0;
  for(const ref of refs){
   const stat=await blobStore.stat(ref.blobId);
   if(stat.mimeType!==ref.mimeType||!imageMimes.has(stat.mimeType)||stat.byteSize<1||
    stat.byteSize>MAX_INPUT_IMAGE_BYTES||(total+=stat.byteSize)>MAX_TOTAL_IMAGE_BYTES)
    throw failure("gemini_model_image_input_invalid",422);
   const bytes=await readFile(stat.path);
   if(bytes.length!==stat.byteSize||createHash("sha256").update(bytes).digest("hex")!==stat.id)
    throw failure("gemini_model_image_integrity_failed",503);
   out.push({mimeType:stat.mimeType,data:bytes.toString("base64")});
  }
  return out;
 }
 async function prepare({job}){
  const {task}=check(job);await readImages(task);
 }
 async function send({snapshot,task,contents,systemInstruction,jobId}){
  const key=vault.withSecretVersion(snapshot.secretVersionRef,b=>b.toString("utf8"),{channelId:snapshot.channelId});
  const url=snapshot.endpointBaseUrl+"/models/"+modelPath(task.model)+":generateContent";
  let response;
  try{response=await upstreamCall(url,{method:"POST",redirect:"manual",
   headers:{"content-type":"application/json","x-goog-api-key":key},
   body:JSON.stringify({contents,...(systemInstruction?{systemInstruction}:{}),
    generationConfig:task.kind==="image"?geminiImageConfig(task):undefined}),
   signal:AbortSignal.timeout(120000)});
  }catch{throw failure("gemini_model_submission_uncertain",502)}
  if(response.status>=300&&response.status<400)throw failure("gemini_model_redirect_rejected",502);
  if(!response.ok)throw failure("gemini_model_upstream_error",502,response.status>=400&&response.status<500);
  const json=await boundedJson(response);
  if(jobId){
   if(task.kind==="image"){
    const parts=(json?.candidates??[]).flatMap(c=>c?.content?.parts??[]).filter(p=>p?.inlineData?.data||p?.inline_data?.data);
    const count=task.count??1;
    if(parts.length<count)throw failure("gemini_model_image_count_mismatch",502);
    for(let i=0;i<count;i++){
     const part=parts[i],input=part.inlineData??part.inline_data;
     const decoded=decodeImage(input.data,input.mimeType??input.mime_type);
     const blob=await blobStore.put([decoded.bytes],{mime:decoded.mime});
     appendArtifact(db,{jobId,portId:"image",itemKey:String(i),blobId:blob.blobId,
      sha256:blob.sha256,mime:blob.mimeType,kind:"image",
      metadata:{modelGeneration:{kind:"image",model:task.model,index:i}}});
    }
   }else{
    const parts=json?.candidates?.[0]?.content?.parts;
    const content=Array.isArray(parts)?parts.filter(p=>typeof p?.text==="string").map(p=>p.text).join(""):"";
    if(!content.trim()||Buffer.byteLength(content,"utf8")>2_000_000)
     throw failure("gemini_model_text_invalid",502);
    const blob=await blobStore.put([Buffer.from(content,"utf8")],{mime:"text/plain"});
    appendArtifact(db,{jobId,portId:"text",itemKey:"0",blobId:blob.blobId,
     sha256:blob.sha256,mime:blob.mimeType,kind:"text",
     metadata:{modelGeneration:{kind:"text",model:task.model}}});
   }
  }
  return json;
 }
 async function submit({job}){
  const {snapshot,task}=check(job),images=await readImages(task);
  if(task.kind==="image"){
   const parts=geminiVisionParts(task.prompt,images);
   await send({snapshot,task,contents:[{role:"user",parts}],jobId:job.id});
  }else{
   const history=normalizeGeminiHistory(task);
   if(images.length){
    const user=history.contents.at(-1);
    user.parts=geminiVisionParts(task.prompt,images);
   }
   await send({snapshot,task,contents:history.contents,systemInstruction:history.systemInstruction,jobId:job.id});
  }
  return {kind:"completed",receipt:{artifactReady:true}};
 }
 async function collect({job}){
  if(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=?").get(job.id).n<1)
   throw failure("gemini_model_artifact_missing",503);
 }
 async function listModels({channelId,endpointBaseUrl}={}){
  const channel=vault.get(channelId);
  if(channel.provider!=="google_gemini")throw failure("gemini_model_provider_mismatch",409);
  if(!channel.hasKey||!channel.keyVersion)throw failure("gemini_model_key_missing",409);
  let endpoint;
  try{endpoint=geminiEndpoint(normalizeOpenAiCompatBaseUrl(endpointBaseUrl))}
  catch{throw failure("gemini_model_endpoint_invalid")}
  const key=vault.withSecretVersion(channel.keyVersion,b=>b.toString("utf8"),{channelId});
  let response;
  try{response=await upstreamCall(endpoint+"/models",{method:"GET",redirect:"manual",
   headers:{"x-goog-api-key":key},signal:AbortSignal.timeout(15000)});
  }catch{throw failure("gemini_model_catalog_unavailable",502)}
  if(response.status>=300&&response.status<400)throw failure("gemini_model_redirect_rejected",502);
  if(!response.ok)throw failure("gemini_model_catalog_rejected",502,response.status>=400&&response.status<500);
  const json=await boundedJson(response,2*1024*1024);
  if(!Array.isArray(json?.models)||json.models.length>5000)throw failure("gemini_model_catalog_invalid",502);
  const models=json.models.filter(m=>typeof m?.name==="string"&&m.supportedGenerationMethods?.includes("generateContent"))
   .map(m=>m.name.replace(/^models\//,""));
  return {models:[...new Set(models)].sort((a,b)=>a.localeCompare(b))};
 }
 return {prepare,submit,collect,listModels,
  // Gemini generateContent is a single request/response call. There is no
  // remote task ID to poll or cancel, so coordinator cancellation only applies
  // before the atomic submit barrier; in-flight cancellation is deliberately
  // not claimed as success.
  poll:async()=>({kind:"pending",retryAfterMs:1000}),
  cancel:async()=>({kind:"unsupported"})};
}
