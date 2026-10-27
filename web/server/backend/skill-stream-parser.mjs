const error=code=>Object.assign(Error(code),{code,statusCode:502});
/** Parses fragmented OpenAI Chat Completions SSE without dispatching partial tools.
 * Output is authoritative ONLY after both finish_reason and [DONE] arrive.
 */
export async function readSkillStream(response,{db,jobId,round}){
 if(!response.body)throw error("model_skill_stream_missing");
 const reader=response.body.getReader();
 const decoder=new TextDecoder("utf-8",{fatal:true});
 let buffer="",text="",done=false,finish=null,count=0;
 const tools=new Map(),seenIndexes=new Set();
 let sent=0,events=0;
 const publish=()=>{
  if(events>=96||text.length<=sent)return;
  const delta=text.slice(sent,sent+4096);
  db.prepare("INSERT INTO job_events(job_id,kind,payload_json,created_at) VALUES(?,?,?,?)")
   .run(jobId,"skill_text_delta",JSON.stringify({round,delta}),Date.now());
  sent+=delta.length;events++;
 };
 function frame(body){
  const lines=body.split(/\r?\n/).filter(line=>line.startsWith("data:"));
  if(!lines.length)return;
  const raw=lines.map(line=>line.slice(5).trimStart()).join("\n").trim();
  if(raw==="[DONE]"){done=true;return}
  if(done)throw error("model_skill_stream_invalid");
  let packet;
  try{packet=JSON.parse(raw)}catch{throw error("model_skill_stream_invalid")}
  if(packet?.error)throw error("model_skill_stream_upstream_error");
  if(!Array.isArray(packet?.choices)||packet.choices.length!==1||
    packet.choices[0]?.index!==0)
   throw error("model_skill_stream_invalid");
  const choice=packet.choices[0];
  if(choice.finish_reason!==null&&choice.finish_reason!==undefined){
   if(finish!==null||!["stop","tool_calls"].includes(choice.finish_reason))
    throw error("model_skill_stream_incomplete");
   finish=choice.finish_reason;
  }
  const delta=choice.delta;
  if(!delta||typeof delta!=="object"||Array.isArray(delta))
   throw error("model_skill_stream_invalid");
  if(delta.content!==null&&delta.content!==undefined){
   if(typeof delta.content!=="string")throw error("model_skill_stream_invalid");
   text+=delta.content;
   if(Buffer.byteLength(text,"utf8")>2*1024*1024)
    throw error("model_skill_stream_too_large");
   if(text.length-sent>=512)publish();
  }
  for(const item of delta.tool_calls??[]){
   if(!item||!Number.isInteger(item.index)||item.index<0||item.index>=12)
    throw error("model_skill_stream_invalid");
   const previous=tools.get(item.index)??{id:"",type:"function",function:{name:"",arguments:""}};
   if(item.type!==undefined&&item.type!=="function")
    throw error("model_skill_stream_invalid");
   if(item.id!==undefined){
    if(typeof item.id!=="string"||previous.id&&item.id!==previous.id)
     throw error("model_skill_stream_invalid");
    previous.id=item.id;
   }
   if(item.function!==undefined){
    if(!item.function||typeof item.function!=="object")
     throw error("model_skill_stream_invalid");
    for(const key of ["name","arguments"]){
     const value=item.function[key];
     if(value!==undefined){
      if(typeof value!=="string")throw error("model_skill_stream_invalid");
      previous.function[key]+=value;
     }
    }
   }
   if(previous.function.arguments.length>8192||previous.function.name.length>128)
    throw error("model_skill_stream_too_large");
   tools.set(item.index,previous);seenIndexes.add(item.index);
  }
  count++;if(count>12000)throw error("model_skill_stream_too_many_events");
 }
 try{
  for(;;){
   const {done:ended,value}=await reader.read();
   if(ended)break;
   buffer+=decoder.decode(value,{stream:true});
   if(Buffer.byteLength(buffer,"utf8")>65536)throw error("model_skill_stream_too_large");
   for(;;){
    const match=/\r?\n\r?\n/.exec(buffer);
    if(!match)break;
    frame(buffer.slice(0,match.index));
    buffer=buffer.slice(match.index+match[0].length);
   }
  }
  buffer+=decoder.decode();
  if(buffer.trim())frame(buffer);
 }finally{reader.releaseLock()}
 if(!done||!finish)throw error("model_skill_stream_incomplete");
 if(finish==="stop"&&tools.size||finish==="tool_calls"&&!tools.size)
  throw error("model_skill_stream_incomplete");
 const toolCalls=[...tools].sort(([a],[b])=>a-b).map(([,v])=>v);
 if(toolCalls.some(tool=>!tool.id||!tool.function.name||!tool.function.arguments))
  throw error("model_skill_stream_incomplete");
 publish();
 return {choices:[{finish_reason:finish,message:{role:"assistant",content:text,tool_calls:toolCalls}}]};
}
