import {assistantSkillToolDefinitions,assistantGeminiSkillDeclarations,
 createAssistantSkillToolSession,parseAssistantSkillToolArgs} from "./assistant-skill-tools.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const MAX_TOOL_ROUNDS=4,MAX_TOOL_CALLS=8,MAX_TOOL_TRANSCRIPT=64*1024;
const obj=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const utf8=value=>Buffer.byteLength(value,"utf8");

/** Use a separate, read-only Skill tool transcript: no external scripts or
 * canvas writes. All model tool calls are validated against the one request's
 * server-authorized, version-pinned catalog before execution.
 */
export async function runAssistantSkillRounds({provider,initialBody,infer,readAnswer,authorizedEntries,signal}){
 const toolSession=createAssistantSkillToolSession(authorizedEntries);
 const payload=JSON.parse(initialBody);
 const gemini=provider==="google_gemini";
 if(gemini){
  payload.tools=[{functionDeclarations:assistantGeminiSkillDeclarations}];
  if(!Array.isArray(payload.contents))throw fail("assistant_skill_tool_response_invalid");
 }else{
  payload.tools=assistantSkillToolDefinitions;
  payload.tool_choice="auto";
  if(!Array.isArray(payload.messages))throw fail("assistant_skill_tool_response_invalid");
 }
 const seen=new Set();
 let rounds=0,totalCalls=0,transcriptBytes=0,retryCount=0;
 for(;;){
  if(signal?.aborted)throw fail("assistant_cancelled",499);
  let result;
  try{result=await infer(JSON.stringify(payload),true)}
  catch(error){
   if(rounds>0&&error?.code==="assistant_skill_tools_unsupported")
    throw fail("assistant_skill_tool_response_invalid");
   throw error;
  }
  retryCount+=result.retryCount;
  const data=result.answer?.data??result.answer;
  if(!obj(data))throw fail("assistant_skill_tool_response_invalid");
  let calls=[],reply;
  if(gemini){
   const candidate=data.candidates?.[0];
   const parts=candidate?.content?.parts;
   if(!Array.isArray(parts))throw fail("assistant_skill_tool_response_invalid");
   calls=parts.filter(item=>obj(item?.functionCall)).map((item,index)=>{
    const call=item.functionCall;
    if(typeof call.name!=="string"||!obj(call.args))
     throw fail("assistant_skill_tool_response_invalid");
    return {id:"gemini-"+rounds+"-"+index,name:call.name,args:call.args};
   });
   reply=parts;
  }else{
   const choice=data.choices?.[0];
   if(!obj(choice?.message))throw fail("assistant_skill_tool_response_invalid");
   const raw=choice.message.tool_calls??[];
   if(!Array.isArray(raw))throw fail("assistant_skill_tool_response_invalid");
   if(raw.length&&choice.finish_reason!=="tool_calls")throw fail("assistant_skill_tool_response_invalid");
   calls=raw.map(item=>{
    if(item?.type!=="function"||typeof item.id!=="string"||!/^[-\w]{1,128}$/.test(item.id)||
     typeof item.function?.name!=="string")throw fail("assistant_skill_tool_response_invalid");
    return {id:item.id,name:item.function.name,args:parseAssistantSkillToolArgs(item.function.arguments)};
   });
   reply=choice.message;
  }
  if(!calls.length){
   return {answer:readAnswer(data,provider),retryCount,
    skillToolCalls:toolSession.calls,skillResourceReads:toolSession.reads};
  }
  if(rounds>=MAX_TOOL_ROUNDS||totalCalls+calls.length>MAX_TOOL_CALLS)
   throw fail("assistant_skill_tool_round_limit");
  const replies=[];
  for(const call of calls){
   if(seen.has(call.id))throw fail("assistant_skill_tool_response_invalid");
   seen.add(call.id);
   const output=toolSession.invoke(call.name,call.args);
   transcriptBytes+=utf8(output);
   if(transcriptBytes>MAX_TOOL_TRANSCRIPT)
    throw fail("assistant_skill_tool_output_too_large");
   replies.push({call,output});
  }
  if(gemini){
   // Only the relevant function calls are fed back; ignore undocumented fields.
   payload.contents.push({role:"model",parts:calls.map(item=>({
    functionCall:{name:item.name,args:item.args}
   }))});
   payload.contents.push({role:"user",parts:replies.map(item=>({
    functionResponse:{name:item.call.name,response:JSON.parse(item.output)}
   }))});
  }else{
   payload.messages.push({role:"assistant",content:typeof reply.content==="string"?reply.content:null,
    tool_calls:calls.map(item=>({
     id:item.id,type:"function",function:{name:item.name,arguments:JSON.stringify(item.args)}
    }))});
   for(const item of replies)payload.messages.push({
    role:"tool",tool_call_id:item.call.id,content:item.output
   });
  }
  rounds++;
  totalCalls+=calls.length;
 }
}
