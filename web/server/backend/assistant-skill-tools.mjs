/** Read-only tool dispatch for the ad-hoc canvas assistant. The catalog is built
 * from server-authorized, version-pinned Skill entries, never from the browser or model.
 * Script execution is deliberately excluded: it needs a job and an audit/artifact
 * boundary, which an ad-hoc chat does not have.
 */
const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const idPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const referencePath=/^references\/.+\.(?:md|txt|markdown)$/i;
const MAX_RESOURCE_BYTES=24*1024;
const MAX_RESULT_BYTES=26*1024;
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const exact=(data,keys)=>object(data)&&Object.keys(data).length===keys.length&&
 keys.every(key=>Object.hasOwn(data,key)&&typeof data[key]==="string"&&data[key].trim());
const safePath=path=>typeof path==="string"&&path.length<=240&&referencePath.test(path)&&
 !path.includes("\\")&&!/[\x00-\x1f\x7f]/.test(path)&&
 !path.split("/").some(part=>!part||part==="."||part==="..");

export const assistantSkillToolDefinitions=[
 {type:"function",function:{name:"search_skills",
  description:"Search the already-authorized Skill catalog by name or description. No network or filesystem access.",
  parameters:{type:"object",additionalProperties:false,required:["query"],
   properties:{query:{type:"string"}}}}},
 {type:"function",function:{name:"activate_skill",
  description:"Review the authorized Skill instructions and list of allowed reference text files. No scripts are run.",
  parameters:{type:"object",additionalProperties:false,required:["skill_id"],
   properties:{skill_id:{type:"string"}}}}},
 {type:"function",function:{name:"read_skill_resource",
  description:"Read one reference document listed in an authorized, activated Skill. Path must start with references/. This is read-only.",
  parameters:{type:"object",additionalProperties:false,required:["skill_id","path"],
   properties:{skill_id:{type:"string"},path:{type:"string"}}}}}
];
export const assistantGeminiSkillDeclarations=assistantSkillToolDefinitions.map(item=>({
 name:item.function.name,description:item.function.description,
 // Native Gemini function declarations use its Schema subset, not the full
 // OpenAI-compatible JSON Schema with additionalProperties.
 parameters:{type:"OBJECT",required:item.function.parameters.required,
  properties:Object.fromEntries(Object.keys(item.function.parameters.properties)
   .map(key=>[key,{type:"STRING"}]))}
}));

export function createAssistantSkillToolSession(authorizedEntries){
 if(!Array.isArray(authorizedEntries)||authorizedEntries.length>12)
  throw fail("assistant_skill_tool_unauthorized");
 const skills=new Map(),activated=new Set();
 for(const entry of authorizedEntries){
  if(!entry||!idPattern.test(entry.id)||skills.has(entry.id)||!object(entry.resources)||
   typeof entry.skillMd!=="string"||typeof entry.version!=="string")
   throw fail("assistant_skill_tool_unauthorized");
  skills.set(entry.id,entry);
  // These Skills' SKILL.md instructions are already present in the user-level
  // context. Their resources can be read without a redundant activate call.
  activated.add(entry.id);
 }
 const reads=[],calls=[];
 function invoke(name,args){
  if(typeof name!=="string"||!assistantSkillToolDefinitions.some(item=>item.function.name===name))
   throw fail("assistant_skill_tool_unauthorized");
  if(name==="search_skills"){
   if(!exact(args,["query"])||args.query.length>200)throw fail("assistant_skill_tool_arguments_invalid");
   const query=args.query.toLowerCase().trim();
   const matches=[...skills.values()].filter(entry=>
     (entry.id+" "+entry.name+" "+entry.description).toLowerCase().includes(query))
    .slice(0,8).map(entry=>({skill_id:entry.id,version:entry.version,description:entry.description.slice(0,230)}));
   calls.push({name,skillId:null});
   return JSON.stringify({matches,total:skills.size});
  }
  if(!exact(args,name==="activate_skill"?["skill_id"]:["skill_id","path"])||
   !idPattern.test(args.skill_id))throw fail("assistant_skill_tool_arguments_invalid");
  const skill=skills.get(args.skill_id);
  if(!skill)throw fail("assistant_skill_tool_unauthorized");
  if(name==="activate_skill"){
   activated.add(skill.id);
   calls.push({name,skillId:skill.id});
   const content=JSON.stringify({skill_id:skill.id,version:skill.version,
    content:skill.skillMd,references:Object.keys(skill.resources).filter(safePath)});
   if(Buffer.byteLength(content)>MAX_RESULT_BYTES)throw fail("assistant_skill_tool_output_too_large");
   return content;
  }
  if(!activated.has(skill.id)||!safePath(args.path)||!Object.hasOwn(skill.resources,args.path))
   throw fail("assistant_skill_tool_unauthorized");
  const body=skill.resources[args.path];
  if(typeof body!=="string"||Buffer.byteLength(body)>MAX_RESOURCE_BYTES)
   throw fail("assistant_skill_tool_output_too_large");
  const output=JSON.stringify({skill_id:skill.id,version:skill.version,path:args.path,content:body});
  if(Buffer.byteLength(output)>MAX_RESULT_BYTES)throw fail("assistant_skill_tool_output_too_large");
  calls.push({name,skillId:skill.id,path:args.path});
  reads.push({skillId:skill.id,path:args.path});
  return output;
 }
 return {invoke,reads,calls,authorizedSkillIds:[...skills.keys()]};
}

/** Model-provided JSON arguments must obey a narrow server-side schema. */
export function parseAssistantSkillToolArgs(input){
 if(typeof input!=="string"||Buffer.byteLength(input)>4096)
  throw fail("assistant_skill_tool_arguments_invalid");
 let parsed;
 try{parsed=JSON.parse(input)}catch{throw fail("assistant_skill_tool_arguments_invalid")}
 if(!object(parsed))throw fail("assistant_skill_tool_arguments_invalid");
 return parsed;
}
