import {readSkillStream} from "./skill-stream-parser.mjs";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {runSkillScript} from "./skill-script-runner.mjs";
import {appendArtifact} from "./repository.mjs";

const broken=(code,confirmedNotAccepted=false)=>Object.assign(Error(code),{
 code,statusCode:422,confirmedNotAccepted});
const namePattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pathPattern=/^references\/.+\.(?:md|txt|markdown)$/i;
const VALID_TOOLS=new Set(["search_skills","activate_skill","read_skill_resource","run_skill_script"]);
const MAX_BYTES=8*1024*1024,MAX_TOOL_CHARS=24000;
const allowedProperties={
 search_skills:["query"],activate_skill:["skill_id"],read_skill_resource:["skill_id","path"],
 run_skill_script:["skill_id","script_path","entry_id","runtime","args","input_files","output_files"]
};
const toolDefs=[
 {type:"function",function:{name:"search_skills",description:"Search authorized Skill metadata only. No external data access.",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}}},
 {type:"function",function:{name:"activate_skill",description:"Load authorized Skill instructions as untrusted text.",parameters:{type:"object",properties:{skill_id:{type:"string"}},required:["skill_id"],additionalProperties:false}}},
 {type:"function",function:{name:"read_skill_resource",description:"Read a text file in references/ or scripts/ from an activated Skill package. Provide skill_id and a relative path listed by activation.",parameters:{type:"object",properties:{skill_id:{type:"string"},path:{type:"string"}},required:["skill_id","path"],additionalProperties:false}}},
 {type:"function",function:{name:"run_skill_script",description:"Run a script bundled with an activated Skill using a local installed runtime.",parameters:{type:"object",properties:{skill_id:{type:"string"},script_path:{type:"string"},entry_id:{type:"string"},runtime:{type:"string"},args:{type:"array",items:{type:"string"},maxItems:64},input_files:{type:"object",additionalProperties:{type:"string"}},output_files:{type:"array",items:{type:"string"},maxItems:32}},required:["skill_id"],additionalProperties:false}}}
];
const obj=x=>x&&typeof x==="object"&&!Array.isArray(x);
const only=(x,keys)=>obj(x)&&Object.keys(x).every(k=>keys.includes(k));
export function validateSkillRef(ref){
 if(!only(ref,["blobId"])||!Object.keys(ref).length||
  typeof ref.blobId!=="string"||!/^[a-f0-9]{64}$/.test(ref.blobId))
  throw broken("model_skill_catalog_invalid",true);
 return ref;
}
function safePath(path){
 return typeof path==="string"&&path.length<=240&&pathPattern.test(path)&&
  !path.includes("\\")&&!/[\x00-\x1f\x7f]/.test(path)&&
  !path.startsWith("/")&&!path.split("/").some(part=>!part||part==="."||part==="..");
}
function safePackagePath(path){return typeof path==="string"&&path.length<=240&&!path.includes("\\")&&
 !path.startsWith("/")&&!/[\x00-\x1f\x7f<>:"|?*]/.test(path)&&
 !path.split("/").some(p=>!p||p==="."||p===".."||p===".atelier"||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p))}
function parseCatalog(bytes){
 let data;
 try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
 catch{throw broken("model_skill_catalog_invalid",true)}
 if(!only(data,["format","entries"])||data.format!=="atelier-skill-snapshot-v1"||
    !Array.isArray(data.entries)||!data.entries.length||data.entries.length>100)
  throw broken("model_skill_catalog_invalid",true);
 const skills=new Map();
 for(const entry of data.entries){
  if(!only(entry,["id","version","hash","name","description","skillMd","resources","scripts","files"])||
    typeof entry.id!=="string"||!namePattern.test(entry.id)||entry.id.length>80||
    typeof entry.hash!=="string"||!/^[a-f0-9]{64}$/.test(entry.hash)||
    typeof entry.version!=="string"||!entry.hash.startsWith(entry.version)||
    entry.version.length<8||entry.version.length>64||
    typeof entry.name!=="string"||entry.name.length>200||
    typeof entry.description!=="string"||entry.description.length>2000||
    typeof entry.skillMd!=="string"||entry.skillMd.length>MAX_TOOL_CHARS||
    !obj(entry.resources)||Object.keys(entry.resources).length>99||
    (entry.scripts!==undefined&&(!obj(entry.scripts)||Object.keys(entry.scripts).length>99))||
    (entry.files!==undefined&&(!obj(entry.files)||Object.keys(entry.files).length>100))||
    skills.has(entry.id))throw broken("model_skill_catalog_invalid",true);
  for(const [path,value] of Object.entries(entry.resources)){
   if(!safePath(path)||typeof value!=="string"||value.length>MAX_TOOL_CHARS)
    throw broken("model_skill_catalog_invalid",true);
  }
  for(const [path,value] of Object.entries(entry.scripts??{})){
   if(!safePackagePath(path)||!path.startsWith("scripts/")||typeof value!=="string"||value.length>512*1024)
    throw broken("model_skill_catalog_invalid",true);
  }
  for(const [path,value] of Object.entries(entry.files??{})){
   if(!safePackagePath(path)||typeof value!=="string"||value.length>8*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw broken("model_skill_catalog_invalid",true);
  }
  entry.scripts??={};entry.files??={};
  skills.set(entry.id,entry);
 }
 return skills;
}
export async function loadFrozenSkillCatalog(blobStore,ref){
 validateSkillRef(ref);
 const stat=await blobStore.stat(ref.blobId);
 if(stat.mimeType!=="text/plain"||stat.byteSize<30||stat.byteSize>MAX_BYTES)
  throw broken("model_skill_catalog_invalid",true);
 const bytes=await readFile(stat.path);
 if(bytes.byteLength!==stat.byteSize||
    createHash("sha256").update(bytes).digest("hex")!==ref.blobId)
  throw broken("model_skill_catalog_integrity_failed",true);
 return parseCatalog(bytes);
}
function paramsFor(call){
 if(!obj(call)||call.type!=="function"||!obj(call.function)||
  typeof call.id!=="string"||!/^[-\w]{1,128}$/.test(call.id)||
  !VALID_TOOLS.has(call.function.name)||typeof call.function.arguments!=="string"||
  call.function.arguments.length>(call.function.name==="run_skill_script"?1024*1024:8192))throw broken("model_skill_tool_unauthorized");
 let args;
 try{args=JSON.parse(call.function.arguments)}
 catch{throw broken("model_skill_tool_arguments_invalid")}
 const keys=allowedProperties[call.function.name];
 if(!only(args,keys))throw broken("model_skill_tool_arguments_invalid");
 if(call.function.name!=="run_skill_script"){
  if(Object.keys(args).length!==keys.length||keys.some(key=>typeof args[key]!=="string"||!args[key].trim()))
   throw broken("model_skill_tool_arguments_invalid");
 }else if(typeof args.skill_id!=="string"||!args.skill_id||
   (args.script_path!==undefined&&typeof args.script_path!=="string")||
   (args.entry_id!==undefined&&typeof args.entry_id!=="string")||
   (args.script_path===undefined)===(args.entry_id===undefined)||
   (args.runtime!==undefined&&typeof args.runtime!=="string")||
   (args.args!==undefined&&(!Array.isArray(args.args)||args.args.length>64||args.args.some(x=>typeof x!=="string")))||
   (args.input_files!==undefined&&(!obj(args.input_files)||Object.values(args.input_files).some(x=>typeof x!=="string")))||
   (args.output_files!==undefined&&(!Array.isArray(args.output_files)||args.output_files.length>32||args.output_files.some(x=>typeof x!=="string"))))
   throw broken("model_skill_tool_arguments_invalid");
 return {name:call.function.name,id:call.id,args};
}
function textResult(body){
 if(body.length>MAX_TOOL_CHARS)throw broken("model_skill_tool_output_too_large");
 return body;
}
function entryPoints(skill){
 const encoded=skill.files?.["execution.json"];if(!encoded)return {};
 let data;try{data=JSON.parse(Buffer.from(encoded,"base64").toString("utf8"))}catch{throw broken("model_skill_execution_manifest_invalid")}
 if(!obj(data)||!obj(data.entries)||Object.keys(data).some(k=>!(["entries"].includes(k))))
  throw broken("model_skill_execution_manifest_invalid");
 const result={};for(const [id,path] of Object.entries(data.entries)){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)||typeof path!=="string"||!Object.hasOwn(skill.scripts,path))
   throw broken("model_skill_execution_manifest_invalid");result[id]=path;
 }return result;
}
async function toolResult(call,skills,activated,blobStore,db,jobId,signal){
 const {name,args}=call;
 if(name==="search_skills"){
  if(args.query.length>200)throw broken("model_skill_search_invalid");
  const term=args.query.toLowerCase().trim();
  const matches=[...skills.values()].filter(s=>(s.name+" "+s.description+" "+s.id)
    .toLowerCase().includes(term)).slice(0,8).map(s=>({
      skill_id:s.id,version:s.version,description:s.description.slice(0,230)
    }));
  return JSON.stringify({matches,total:skills.size});
 }
 const skill=skills.get(args.skill_id);
 if(!skill)throw broken("model_skill_not_authorized");
 if(name==="activate_skill"){
  activated.add(skill.id);
  return JSON.stringify({skill_id:skill.id,version:skill.version,
   content:textResult(skill.skillMd),references:Object.keys(skill.resources),scripts:Object.keys(skill.scripts),entry_points:entryPoints(skill)});
 }
 if(name==="run_skill_script"){
  if(!activated.has(skill.id))throw broken("model_skill_script_not_authorized");
  const path=args.script_path??entryPoints(skill)[args.entry_id];
  if(typeof path!=="string"||!Object.hasOwn(skill.files,path)||!Object.hasOwn(skill.scripts,path))throw broken("model_skill_script_not_authorized");
  try{
   const result=await runSkillScript({skillId:skill.id,version:skill.version,scriptPath:path,
    source:skill.scripts[path],packageFiles:skill.files,args:args.args??[],inputFiles:args.input_files??{},outputFiles:args.output_files??[],runtime:args.runtime,blobStore,signal});
   const savedItems=[...(result.artifacts??[]).map(item=>{item.kind=item.mime?.startsWith("image/")?"image":item.mime?.startsWith("audio/")?"audio":item.mime?.startsWith("video/")?"video":"text";return item}),
    ...Object.entries(result.log_blobs??{}).map(([log,blobId])=>({path:".logs/"+log,blob_id:blobId,kind:"text",mime:"text/plain",byte_length:0}))];
   for(const item of savedItems){
    const stat=await blobStore.stat(item.blob_id);
    const saved=appendArtifact(db,{jobId,portId:"skill-script",itemKey:call.id+":"+skill.id+":"+item.path,
     blobId:item.blob_id,sha256:stat.sha256,kind:item.kind,mime:item.mime,
     metadata:{skillId:skill.id,version:skill.version,scriptPath:result.script_path,path:item.path}});
    item.artifact_id=saved.artifactId;
   }
   let output=JSON.stringify(result);
   if(Buffer.byteLength(output,"utf8")>32768){
    const inline=[];for(const artifact of result.artifacts??[])if(typeof artifact.content==="string"){
     inline.push({text:artifact.content,set:value=>{artifact.content=value}});delete artifact.content;
    }
    inline.push({text:result.stdout??"",set:value=>{result.stdout=value}});
    inline.push({text:result.stderr??"",set:value=>{result.stderr=value}});
    result.stdout="";result.stderr="";const cap=32768-512;
    for(const field of inline){const chars=[...field.text];let low=0,high=chars.length;
     while(low<high){const mid=Math.ceil((low+high)/2);field.set(chars.slice(0,mid).join(""));
      if(Buffer.byteLength(JSON.stringify(result),"utf8")<=cap)low=mid;else high=mid-1;}
     field.set(chars.slice(0,low).join(""));
    }
    output=JSON.stringify(result);
   }
   return output;
  }
  catch(error){return JSON.stringify({error:error.code??"skill_script_failed",message:error.message})}
 }
 if(!activated.has(skill.id)||!safePackagePath(args.path))
  throw broken("model_skill_reference_not_authorized");
 let content=skill.resources[args.path]??skill.scripts[args.path];
 if(content===undefined){
  if(!Object.hasOwn(skill.files,args.path))throw broken("model_skill_reference_not_authorized");
  const bytes=Buffer.from(skill.files[args.path],"base64");if(bytes.includes(0))throw broken("model_skill_reference_not_authorized");try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes)}catch{throw broken("model_skill_reference_not_authorized")}
 }
 return JSON.stringify({skill_id:skill.id,version:skill.version,path:args.path,
  content:textResult(content)});
}
function audit(db,jobId,kind,payload){
 db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
  .run(jobId,kind,JSON.stringify(payload),Date.now());
}
async function readJson(response){
 if(!response.body)throw broken("model_skill_response_invalid");
 let size=0;const chunks=[];
 for await(const value of response.body){
  const bytes=Buffer.from(value);size+=bytes.byteLength;
  if(size>2*1024*1024)throw broken("model_skill_response_too_large");
  chunks.push(bytes);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString("utf8"))}
 catch{throw broken("model_skill_response_invalid")}
}
/** Every upstream round is a distinct billable POST inside ONE coordinator submit
 * barrier. Crashes/timeout after any round are unknown and NEVER re-enter submit.
 */
export async function runSqliteSkillAgent({
 task,jobId,db,skills,authorization,upstreamCall,endpointUrl="https://api.openai.com/v1/chat/completions",messages,blobStore,signal
}){
 const history=[...messages],activated=new Set(),seen=new Set();
 let rounds=0,calls=0;
 for(;;){
  signal?.throwIfAborted();
  if(rounds>6)throw broken("model_skill_round_limit");
  let response;
  try{
   response=await upstreamCall(endpointUrl,{
    method:"POST",redirect:"manual",
    headers:{authorization,"content-type":"application/json"},
    body:JSON.stringify({model:task.model,messages:history,stream:task.stream===true,tools:toolDefs,
     tool_choice:"auto"}),
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)
   });
  }catch{throw broken("model_skill_submission_uncertain")}
  if(response.status>=300&&response.status<400)throw broken("model_skill_redirect_rejected");
  if(!response.ok)throw broken("model_skill_upstream_error",rounds===0&&
    response.status>=400&&response.status<500);
  const json=task.stream===true?await readSkillStream(response,{db,jobId,round:rounds}):await readJson(response);
  const choice=json?.choices?.[0];
  const msg=choice?.message;
  if(!obj(msg)||msg.role!=="assistant")throw broken("model_skill_response_invalid");
  const text=msg.content??"";
  if(typeof text!=="string"||Buffer.byteLength(text,"utf8")>2000000)
   throw broken("model_skill_response_invalid");
  const tools=msg.tool_calls??[];
  if(!Array.isArray(tools)||tools.length>12)throw broken("model_skill_response_invalid");
  if(!tools.length){
   if(!text.trim()||choice.finish_reason!=="stop")
    throw broken("model_skill_response_invalid");
   audit(db,jobId,"skill_run_completed",{rounds,calls});
   return text;
  }
  if(choice.finish_reason!=="tool_calls"||rounds>=6||calls+tools.length>12)
   throw broken("model_skill_round_limit");
  const parsed=tools.map(paramsFor);
  for(const call of parsed){
   if(seen.has(call.id))throw broken("model_skill_call_duplicate");
   seen.add(call.id);
  }
  history.push({role:"assistant",content:text||null,
   tool_calls:tools.map(raw=>({id:raw.id,type:"function",function:{
    name:raw.function.name,arguments:raw.function.arguments
   }}))});
  rounds++;
  for(const call of parsed){
   calls++;
   const skillId=call.args.skill_id??null;
   audit(db,jobId,"skill_tool",{status:"started",round:rounds,callId:call.id,
    name:call.name,skillId});
   let output;
   try{output=await toolResult(call,skills,activated,blobStore,db,jobId,signal);signal?.throwIfAborted()}catch(error){
    audit(db,jobId,"skill_tool",{status:"failed",round:rounds,callId:call.id,name:call.name,
     skillId:skillId??null,error:error.code??"skill_tool_failed"});throw error;
   }
  if(Buffer.byteLength(output,"utf8")>32768)throw broken("model_skill_tool_output_too_large");
   history.push({role:"tool",tool_call_id:call.id,content:output});
   const parsedOutput=JSON.parse(output);
   audit(db,jobId,"skill_tool",{status:call.name==="run_skill_script"&&parsedOutput.status!=="completed"?"failed":"completed",round:rounds,callId:call.id,
    name:call.name,skillId, ...(call.name==="run_skill_script"?{result:JSON.parse(output)}:{})});
  }
 }
}
