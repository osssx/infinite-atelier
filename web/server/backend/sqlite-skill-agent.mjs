import {readSkillStream} from "./skill-stream-parser.mjs";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

const broken=(code,confirmedNotAccepted=false)=>Object.assign(Error(code),{
 code,statusCode:422,confirmedNotAccepted});
const namePattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pathPattern=/^references\/.+\.(?:md|txt|markdown)$/i;
const VALID_TOOLS=new Set(["search_skills","activate_skill","read_skill_resource"]);
const MAX_BYTES=1024*1024,MAX_TOOL_CHARS=24000;
const allowedProperties={
 search_skills:["query"],activate_skill:["skill_id"],read_skill_resource:["skill_id","path"]
};
const toolDefs=[
 {type:"function",function:{name:"search_skills",description:"Search authorized Skill metadata only. No external data access.",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}}},
 {type:"function",function:{name:"activate_skill",description:"Load authorized Skill instructions as untrusted text.",parameters:{type:"object",properties:{skill_id:{type:"string"}},required:["skill_id"],additionalProperties:false}}},
 {type:"function",function:{name:"read_skill_resource",description:"Read a declared text reference of an already activated Skill.",parameters:{type:"object",properties:{skill_id:{type:"string"},path:{type:"string"}},required:["skill_id","path"],additionalProperties:false}}}
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
function parseCatalog(bytes){
 let data;
 try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
 catch{throw broken("model_skill_catalog_invalid",true)}
 if(!only(data,["format","entries"])||data.format!=="atelier-skill-snapshot-v1"||
    !Array.isArray(data.entries)||!data.entries.length||data.entries.length>100)
  throw broken("model_skill_catalog_invalid",true);
 const skills=new Map();
 for(const entry of data.entries){
  if(!only(entry,["id","version","hash","name","description","skillMd","resources"])||
    typeof entry.id!=="string"||!namePattern.test(entry.id)||entry.id.length>80||
    typeof entry.hash!=="string"||!/^[a-f0-9]{64}$/.test(entry.hash)||
    typeof entry.version!=="string"||!entry.hash.startsWith(entry.version)||
    entry.version.length<8||entry.version.length>64||
    typeof entry.name!=="string"||entry.name.length>200||
    typeof entry.description!=="string"||entry.description.length>2000||
    typeof entry.skillMd!=="string"||entry.skillMd.length>MAX_TOOL_CHARS||
    !obj(entry.resources)||Object.keys(entry.resources).length>99||
    skills.has(entry.id))throw broken("model_skill_catalog_invalid",true);
  for(const [path,value] of Object.entries(entry.resources)){
   if(!safePath(path)||typeof value!=="string"||value.length>MAX_TOOL_CHARS)
    throw broken("model_skill_catalog_invalid",true);
  }
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
  call.function.arguments.length>8192)throw broken("model_skill_tool_unauthorized");
 let args;
 try{args=JSON.parse(call.function.arguments)}
 catch{throw broken("model_skill_tool_arguments_invalid")}
 const keys=allowedProperties[call.function.name];
 if(!only(args,keys)||Object.keys(args).length!==keys.length||
  keys.some(key=>typeof args[key]!=="string"||!args[key].trim()))
  throw broken("model_skill_tool_arguments_invalid");
 return {name:call.function.name,id:call.id,args};
}
function textResult(body){
 if(body.length>MAX_TOOL_CHARS)throw broken("model_skill_tool_output_too_large");
 return body;
}
function toolResult(call,skills,activated){
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
   content:textResult(skill.skillMd),references:Object.keys(skill.resources)});
 }
 if(!activated.has(skill.id)||!safePath(args.path)||
    !Object.hasOwn(skill.resources,args.path))
  throw broken("model_skill_reference_not_authorized");
 return JSON.stringify({skill_id:skill.id,version:skill.version,path:args.path,
  content:textResult(skill.resources[args.path])});
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
 task,jobId,db,skills,authorization,upstreamCall,messages
}){
 const history=[...messages],activated=new Set(),seen=new Set();
 let rounds=0,calls=0;
 for(;;){
  if(rounds>6)throw broken("model_skill_round_limit");
  let response;
  try{
   response=await upstreamCall("https://api.openai.com/v1/chat/completions",{
    method:"POST",redirect:"manual",
    headers:{authorization,"content-type":"application/json"},
    body:JSON.stringify({model:task.model,messages:history,stream:task.stream===true,tools:toolDefs,
     tool_choice:"auto"}),
    signal:AbortSignal.timeout(120000)
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
   const output=toolResult(call,skills,activated);
   if(output.length>32768)throw broken("model_skill_tool_output_too_large");
   history.push({role:"tool",tool_call_id:call.id,content:output});
   audit(db,jobId,"skill_tool",{status:"completed",round:rounds,callId:call.id,
    name:call.name,skillId});
  }
 }
}
