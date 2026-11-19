import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {readSkillStream} from "./skill-stream-parser.mjs";
const credential="mock-api-key";
const vault={
 get(id){if(id!=="c1")throw Error("channel_not_found");return {provider:"openai_compatible",hasKey:true,keyVersion:"v1"}},
 withSecretVersion(version,consumer){assert.equal(version,"v1");return consumer(Buffer.from(credential))}
};
const messages=[{role:"user",content:"你好"}];
test("DeepSeek native cache usage handles JSON, SSE, missing and contradictory counters",async()=>{
 const reports=[
  {prompt_tokens:100,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100},
  {prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20},
  {prompt_tokens:100,prompt_cache_hit_tokens:90,prompt_cache_miss_tokens:20},
  {prompt_tokens:100,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20,prompt_tokens_details:{cached_tokens:70}},
  {prompt_tokens:100,prompt_cache_hit_tokens:-1},
  {prompt_tokens:100}
 ];
 const samples=[];
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{
  const usage=reports.shift();
  if(usage.prompt_tokens===undefined)return new Response(
   'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'+
   "data: "+JSON.stringify({choices:[],usage})+"\n\ndata: [DONE]\n\n",
   {headers:{"content-type":"text/event-stream"}});
  return Response.json({data:{choices:[{message:{content:"OK"}}],usage}});
 }});
 while(reports.length)await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,onPromptUsage:sample=>samples.push(sample)});
 assert.deepEqual(samples.map(({inputTokens,cachedInputTokens})=>[inputTokens,cachedInputTokens]),
  [[100,0],[100,80],[100,null],[100,null],[100,null],[100,null]]);
});
test("prompt telemetry distinguishes zero from missing and captures the final SSE usage once",async()=>{
 const samples=[],requests=[];
 const usage={prompt_tokens:1536,prompt_tokens_details:{cached_tokens:0}};
 const frames=[
  {choices:[{delta:{content:"答"},finish_reason:null}],usage:{prompt_tokens:100}},
  {choices:[{delta:{},finish_reason:"stop"}]},
  {choices:[],usage}
 ];
 const sse=packets=>new Response(packets.map(packet=>"data: "+JSON.stringify(packet)+"\n\n").join("")+
  "data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
 const answers=[
  sse(frames),
  Response.json({data:{choices:[{message:{content:"答"}}],usage:{prompt_tokens:1536}}}),
  sse([{type:"response.output_text.delta",delta:"答"},
   {type:"response.completed",response:{usage:{input_tokens:2048,input_tokens_details:{cached_tokens:1024}}}}])
 ];
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,{body})=>{
  requests.push(JSON.parse(body));
  return answers.shift();
 }});
 const input={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,onPromptUsage:sample=>samples.push(sample)};
 await ask({...input,stream:true});
 await ask(input);
 await ask({...input,stream:true});
 assert.deepEqual(samples.map(({inputTokens,cachedInputTokens})=>[inputTokens,cachedInputTokens]),
  [[1536,0],[1536,null],[2048,1024]]);
 assert.ok(samples.every(sample=>sample.elapsedMs>=0));
 assert.ok(samples[0].firstTokenMs>=0&&samples[2].firstTokenMs>=0);
 assert.equal(samples[1].firstTokenMs,null);
 assert.ok(requests.every(request=>!("stream_options" in request)));
 const toolPayload=await readSkillStream(sse([
  {choices:[{index:0,delta:{content:"答"},finish_reason:"stop"}]},{choices:[],usage}
 ]));
 assert.deepEqual(toolPayload.usage,usage);
 assert.equal(toolPayload.choices[0].message.content,"答");
});
test("bounded streaming accepts more than 2000 valid upstream deltas",async()=>{
 const frame='data: {"choices":[{"delta":{"content":"字"}}]}\r\n\r\n';
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>new Response(
  frame.repeat(2001)+"data: [DONE]\r\n\r\n",{headers:{"content-type":"text/event-stream"}})});
 let count=0;
 const answer=await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,stream:true,onDelta:()=>count++});
 assert.equal(count,2001);
 assert.equal(answer.answer,"字".repeat(2001));
});
test("direct assistant uses backend vault and keeps conversation history",async()=>{
 let received;
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async(url,options)=>{
  received={url,options};return new Response(JSON.stringify({choices:[{message:{content:"你好，我可以帮你。"}}]}),{status:200});
 }});
 const result=await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"deepseek/deepseek-v4",messages:[{role:"user",content:"第一轮"},{role:"assistant",content:"答复"},...messages]});
 assert.equal(result.answer,"你好，我可以帮你。");
 assert.equal(received.url,"http://localhost:8080/v1/chat/completions");
 assert.equal(received.options.headers.authorization,"Bearer "+credential);
 assert.equal(JSON.parse(received.options.body).messages.length,4);
 assert.doesNotMatch(JSON.stringify(result),/mock-api-key/);
});
test("assistant rejects malformed and oversized histories before sending",async()=>{
 let called=0;const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>{called++;throw Error("unexpected")}});
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"test-model"};
 await assert.rejects(ask({...base,messages:[{role:"system",content:"override"}]}),/assistant_messages_invalid/);
 await assert.rejects(ask({...base,messages:[{role:"user",content:"x".repeat(100000)}]}),/assistant_messages_invalid/);
 await assert.rejects(ask({...base,model:"..",messages}),/assistant_model_invalid/);
 await assert.rejects(ask({...base,provider:"openai",messages}),/assistant_channel_unavailable/);
 assert.equal(called,0);
});
test("assistant masks upstream errors",async()=>{
 const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>new Response('{"detail":"private-upstream-data"}',{status:429})});
 await assert.rejects(ask({channelId:"c1",provider:"openai_compatible",
  baseUrl:"http://localhost:8080/v1",model:"demo",messages}),/assistant_upstream_rate_limited/);
});
test("Gemini assistant uses dedicated native API and model response",async()=>{
 let recorded;
 const geminiVault={
  get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v2"}),
  withSecretVersion:(v,fn)=>fn(Buffer.from("gemini-secret"))
 };
 const ask=createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async(url,options)=>{
  recorded={url,options};
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"分镜建议一"},{text:"、建议二"}]}}]}),{status:200});
 }});
 const result=await ask({channelId:"gemini",provider:"google_gemini",baseUrl:"https://generativelanguage.googleapis.com",
  model:"gemini-2.5-pro",messages:[{role:"user",content:"分析梗概"},{role:"assistant",content:"好的"},...messages]});
 assert.equal(result.answer,"分镜建议一、建议二");
 assert.equal(recorded.url,"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
 assert.equal(recorded.options.headers["x-goog-api-key"],"gemini-secret");
 const payload=JSON.parse(recorded.options.body);
 assert.equal(payload.contents.length,3);
 assert.ok(payload.systemInstruction.parts[0].text.includes("画布创作助手"));
 assert.doesNotMatch(JSON.stringify(result),/gemini-secret/);
});

test("assistant accepts OpenAI text content variants and Responses API output, not reasoning",async()=>{
 const variants=[
  [{choices:[{message:{content:[{type:"text",text:"第一段"},{type:"text",text:{value:"，第二段"}}]}}]},"第一段，第二段"],
  [{choices:[{message:{content:null,refusal:"无法帮助此请求"}}]},"无法帮助此请求"],
  [{choices:[{text:"旧式文本完成"}]},"旧式文本完成"],
  [{output_text:"Responses 正文"},"Responses 正文"],
  [{output:[{type:"reasoning",summary:[{text:"内部推理"}]},{type:"message",content:[{type:"output_text",text:"最终答复"}]}]},"最终答复"],
  [{data:{choices:[{message:{content:"兼容渠道包装"}}]}},"兼容渠道包装"]
 ];
 for(const [body,expected] of variants){
  const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>new Response(JSON.stringify(body),{status:200})});
  const result=await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages});
  assert.equal(result.answer,expected);
  assert.doesNotMatch(JSON.stringify(result),/内部推理|mock-api-key/);
 }
});
test("assistant classifies no final answer, truncation and filtered content",async()=>{
 const variants=[
  [{choices:[{message:{content:null,reasoning_content:"private chain-of-thought"},finish_reason:"stop"}]},"assistant_response_empty"],
  [{choices:[{message:{content:null,tool_calls:[{type:"function"}]},finish_reason:"tool_calls"}]},"assistant_response_empty"],
  [{choices:[{message:{content:"partial"},finish_reason:"length"}]},"assistant_response_incomplete"],
  [{choices:[{message:{content:"blocked"},finish_reason:"content_filter"}]},"assistant_response_blocked"],
  [{error:{message:"my secret upstream error"}},"assistant_upstream_error"],
  [{choices:[{message:{content:[]}}]},"assistant_response_empty"],
 ];
 for(const [body,expected] of variants){
  const ask=createAssistantChatService({vault,compatibleUpstreamCall:async()=>new Response(JSON.stringify(body),{status:200})});
  await assert.rejects(ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages}),
   error=>error?.code===expected&&!/private chain-of-thought|secret upstream/.test(error.message));
 }
});
test("assistant accepts completed SSE even with stream:false, rejects incomplete and bad frames",async()=>{
 const responseStream=parts=>new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close()}});
 const payload=[
  'data: {"choices":[{"delta":{"content":"欢迎"}}]}\\n\\n',
  'data: {"choices":[{"delta":{"content":"提问"},"finish_reason":"stop"}]}\\n\\n',
  'data: [DONE]\\n\\n'
 ].map(part=>part.replace(/\\n/g,"\n"));
 const ask=(parts,type="text/event-stream")=>createAssistantChatService({vault,compatibleUpstreamCall:async()=>
  new Response(responseStream(parts),{status:200,headers:{"Content-Type":type}})});
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 assert.equal((await ask(payload)(base)).answer,"欢迎提问");
 assert.equal((await ask(payload,"application/json")(base)).answer,"欢迎提问");
 await assert.rejects(ask([payload[0]])(base),/assistant_response_incomplete/);
 await assert.rejects(ask(["data: not-json\\n\\n".replace(/\\n/g,"\n")])(base),/assistant_response_invalid/);
 await assert.rejects(ask(["data: {\"type\":\"error\",\"error\":{\"message\":\"secret\"}}\\n\\n".replace(/\\n/g,"\n")])(base),/assistant_upstream_error/);
 const responses=[
  'event: response.output_text.delta\\ndata: {"type":"response.output_text.delta","delta":"响应正文"}\\n\\n',
  'event: response.completed\\ndata: {"type":"response.completed","response":{"status":"completed"}}\\n\\n'
 ].map(part=>part.replace(/\\n/g,"\n"));
 assert.equal((await ask(responses)(base)).answer,"响应正文");
});
test("assistant handles Gemini thought parts, blocked and token limit without exposing thought",async()=>{
 const geminiVault={
  get:()=>({provider:"google_gemini",hasKey:true,keyVersion:"v2"}),
  withSecretVersion:(v,consumer)=>consumer(Buffer.from("gemini-private"))
 };
 const base={channelId:"gemini",provider:"google_gemini",baseUrl:"https://generativelanguage.googleapis.com",model:"gemini-2.5-pro",messages};
 const call=body=>createAssistantChatService({vault:geminiVault,compatibleUpstreamCall:async()=>new Response(JSON.stringify(body),{status:200})})(base);
 const answer=await call({candidates:[{finishReason:"STOP",content:{parts:[{thought:true,text:"hidden reasoning"},{text:"可见答复"}]}}]});
 assert.equal(answer.answer,"可见答复");
 await assert.rejects(call({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:"部分正文"}]}}]}),/assistant_response_incomplete/);
 await assert.rejects(call({promptFeedback:{blockReason:"SAFETY"},candidates:[]}),/assistant_response_blocked/);
 await assert.rejects(call({candidates:[{content:{parts:[{thought:true,text:"private thought"}]}}]}),/assistant_response_empty/);
});
test("assistant responses reject unparseable JSON, oversized bodies and upstream HTTP errors",async()=>{
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 const call=(text,status=200)=>createAssistantChatService({vault,compatibleUpstreamCall:async()=>new Response(text,{status})})(base);
 await assert.rejects(call("unexpected html"),/assistant_response_invalid/);
 await assert.rejects(call(JSON.stringify({choices:[{message:{content:"x".repeat(1100000)}}]})),/assistant_response_too_large/);
 await assert.rejects(call('{"error":"confidential"}',401),/assistant_upstream_auth_failed/);
 await assert.rejects(call('{"error":"confidential"}',429),/assistant_upstream_rate_limited/);
});

test("assistant retries two transient timeouts and succeeds, preserving request payload",async()=>{
 const calls=[],body={choices:[{message:{content:"重试成功"}}]};
 const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async(url,options)=>{
  calls.push({url,headers:options.headers,body:options.body});
  if(calls.length<3)throw new DOMException("connection timeout","TimeoutError");
  return new Response(JSON.stringify(body),{status:200});
 }});
 const result=await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages});
 assert.deepEqual(result,{answer:"重试成功",model:"demo",retryCount:2});
 assert.equal(calls.length,3);
 assert.ok(calls.every(call=>call.body===calls[0].body));
 assert.ok(calls.every(call=>call.url===calls[0].url));
 assert.equal(calls[0].headers.authorization,"Bearer "+credential);
});
test("assistant retries gateway timeouts and transient socket faults with a strict limit",async()=>{
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{
  count++;
  if(count===1)return new Response("Gateway Timeout",{status:504});
  if(count===2)return new Response("Request Timeout",{status:408});
  return new Response(JSON.stringify({choices:[{message:{content:"完成"}}]}),{status:200});
 }});
 assert.equal((await ask(base)).retryCount,2);
 assert.equal(count,3);
 count=0;
 const socketAsk=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{
  count++;
  if(count===1){
   const cause=Object.assign(new Error("socket hang up"),{code:"ECONNRESET"});
   throw Object.assign(new TypeError("fetch failed"),{cause});
  }
  return new Response(JSON.stringify({choices:[{message:{content:"连接恢复"}}]}),{status:200});
 }});
 assert.equal((await socketAsk(base)).retryCount,1);
 assert.equal(count,2);
});
test("assistant retries timeout while reading upstream response body",async()=>{
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{
  count++;
  if(count===1){
   const stream=new ReadableStream({pull(controller){
    controller.error(Object.assign(new Error("body read timeout"),{code:"UND_ERR_BODY_TIMEOUT"}));
   }});
   return new Response(stream,{status:200});
  }
  return new Response(JSON.stringify({choices:[{message:{content:"读取恢复"}}]}),{status:200});
 }});
 const result=await ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages});
 assert.equal(result.answer,"读取恢复");
 assert.equal(result.retryCount,1);
 assert.equal(count,2);
});

test("assistant timeout retry exhaustion stops after exactly three attempts",async()=>{
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:0,maxRetries:50,compatibleUpstreamCall:async()=>{
  count++;
  throw new DOMException("request timeout","TimeoutError");
 }});
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 await assert.rejects(ask(base),error=>error?.code==="assistant_upstream_retry_exhausted"&&error.statusCode===504);
 assert.equal(count,3);
});
test("assistant honors request AbortSignal timeout across all retry attempts",async()=>{
 let count=0;
 const ask=createAssistantChatService({vault,requestTimeoutMs:12,retryDelayMs:0,compatibleUpstreamCall:async(_url,{signal})=>{
  count++;
  return await new Promise((_resolve,reject)=>{
   signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  });
 }});
 await assert.rejects(ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages}),/assistant_upstream_retry_exhausted/);
 assert.equal(count,3);
});
test("assistant cancellation immediately interrupts retry backoff and avoids another upstream call",async()=>{
 const controller=new AbortController();
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:5000,compatibleUpstreamCall:async()=>{
  count++;
  throw new DOMException("temporary timeout","TimeoutError");
 }});
 const pending=ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));
 controller.abort();
 await assert.rejects(pending,error=>error?.code==="assistant_cancelled");
 assert.equal(count,1);
});
test("assistant cancellation interrupts in-flight upstream timeout without a retry",async()=>{
 const controller=new AbortController();
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async(_url,{signal})=>{
  count++;
  return await new Promise((_resolve,reject)=>{
   signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  });
 }});
 const pending=ask({channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",
  model:"demo",messages,signal:controller.signal});
 controller.abort();
 await assert.rejects(pending,error=>error?.code==="assistant_cancelled");
 assert.equal(count,1);
});
test("assistant never retries auth, rate limits, invalid responses or unclassified failures",async()=>{
 const base={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 const variants=[
  [new Response('{"error":"secret"}',{status:401}),"assistant_upstream_auth_failed"],
  [new Response('{"error":"secret"}',{status:429}),"assistant_upstream_rate_limited"],
  [new Response("not json",{status:200}),"assistant_response_invalid"],
  [new Response(JSON.stringify({choices:[{message:{content:null}}]}),{status:200}),"assistant_response_empty"],
  [new Response('{"error":"secret"}',{status:500}),"assistant_upstream_error"],
 ];
 for(const [response,code] of variants){
  let calls=0;
  const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{calls++;return response}});
  await assert.rejects(ask(base),error=>error?.code===code);
  assert.equal(calls,1,code);
 }
 let count=0;
 const ask=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{count++;throw Error("not network timeout")}});
 await assert.rejects(ask(base),/assistant_upstream_unavailable/);
 assert.equal(count,1);
});
test("HTTP assistant route integrates compatible response extraction and safe errors",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let payload={choices:[{message:{content:[{type:"text",text:"接口层"},{type:"text",text:"成功"}]}}]};
 let timeoutsRemaining=1,upstreamCalls=0;
 const service=createAssistantChatService({vault,retryDelayMs:0,compatibleUpstreamCall:async()=>{
  upstreamCalls++;
  if(timeoutsRemaining-->0)return new Response("Gateway Timeout",{status:504});
  return new Response(JSON.stringify(payload),{status:200});
 }});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",assistantChat:service});
 t.after(async()=>{await app.close();db.close()});
 const headers={"x-test-owner":"owner"};
 const project=await app.inject({method:"POST",url:"/api/v1/projects",
  headers,payload:{id:"p-integration",document:{nodes:[],connections:[]}}});
 assert.equal(project.statusCode,201,project.body);
 const endpoint="/api/v1/projects/p-integration/assistant/chat";
 const input={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",messages};
 const send=()=>app.inject({method:"POST",url:endpoint,headers,payload:input});
 const first=await send();
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().answer,"接口层成功");
 assert.equal(first.json().retryCount,1);
 assert.equal(upstreamCalls,2);
 payload={choices:[{message:{content:null,reasoning_content:"hidden-reasoning"}}]};
 const second=await send();
 assert.equal(second.statusCode,502,second.body);
 assert.equal(second.json().code,"assistant_response_empty");
 assert.doesNotMatch(second.body,/hidden-reasoning|mock-api-key/);
 const unchanged=await app.inject({method:"GET",url:"/api/v1/projects/p-integration",headers});
 assert.equal(unchanged.json().revision,1);
});
test("ordinary chat SSE works over a real HTTP socket and is recoverable/cancellable",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);let aborted=false;
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  options.signal.addEventListener("abort",()=>{aborted=true},{once:true});
  const body="data: "+JSON.stringify({choices:[{delta:{content:"真"}}]})+"\n\n"+
   "data: "+JSON.stringify({choices:[{delta:{content:"实"},finish_reason:"stop"}]})+"\n\n"+
   "data: [DONE]\n\n";
  return new Response(body,{status:200,headers:{"content-type":"text/event-stream"}});
 }});
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",assistantChat:service});
 const address=await app.listen({host:"127.0.0.1",port:0});t.after(async()=>{await app.close();db.close()});
 const headers={"x-test-owner":"owner","content-type":"application/json",accept:"text/event-stream"};
 await fetch(address+"/api/v1/projects",{method:"POST",headers:{...headers,accept:"application/json"},body:JSON.stringify({id:"p-stream",document:{nodes:[],connections:[]}})});
 const endpoint=address+"/api/v1/projects/p-stream/assistant/chat";const payload={channelId:"c1",provider:"openai_compatible",baseUrl:"http://localhost:8080/v1",model:"demo",turnId:"turn-real",canvasActions:false,messages};
 const response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(payload)});assert.equal(response.status,200);const text=await response.text();assert.match(text,/event: delta/);assert.match(text,/event: done/);
 const replay=await fetch(address+"/api/v1/projects/p-stream/assistant/chat/stream/turn-real?after=0",{headers:{"x-test-owner":"owner"}});assert.equal(replay.status,200);assert.equal((await replay.json()).terminal,true);
 const cancel=await fetch(address+"/api/v1/projects/p-stream/assistant/chat/stream/turn-real/cancel",{method:"POST",headers:{...headers,accept:"application/json"},body:"{}"});assert.equal(cancel.status,200);assert.equal(aborted,false);
});

test("disconnect resumes the same paid turn and cancel aborts an active stream",{timeout:8000},async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let calls=0,finish,aborted=false;
 const app=buildApp({db,authorize:()=>true,assistantChat:async({onDelta,signal})=>{
  calls++;onDelta("前");
  await new Promise((resolve,reject)=>{
   finish=resolve;
   signal.addEventListener("abort",()=>{aborted=true;reject(signal.reason)},{once:true});
  });
  onDelta("后");return {answer:"前后",model:"demo"};
 }});
 const address=await app.listen({host:"127.0.0.1",port:0});t.after(async()=>{await app.close();db.close()});
 const headers={"content-type":"application/json"};
 await fetch(address+"/api/v1/projects",{method:"POST",headers,body:JSON.stringify({id:"resume",document:{nodes:[],connections:[]}})});
 const endpoint=address+"/api/v1/projects/resume/assistant/chat";
 const start=turnId=>fetch(endpoint,{method:"POST",headers:{...headers,accept:"text/event-stream"},body:JSON.stringify({channelId:"c1",provider:"openai",model:"demo",turnId,messages,canvasActions:false})});
 const reader=(await start("original")).body.getReader();
 assert.match(new TextDecoder().decode((await reader.read()).value),/event: delta/);
 await reader.cancel();
 const duplicate=await start("original");assert.equal(duplicate.status,409);await duplicate.text();
 assert.equal(calls,1);assert.equal(aborted,false);finish();
 const replay=await (await fetch(endpoint+"/stream/original?after=1")).json();
 assert.deepEqual(replay.events.map(event=>event.type),["delta","done"]);
 const active=(await start("stop")).body.getReader();await active.read();
 const stopped=await fetch(endpoint+"/stream/stop/cancel",{method:"POST",headers,body:"{}"});assert.equal(stopped.status,200);await stopped.text();
 const terminal=new TextDecoder().decode((await active.read()).value);
 assert.match(terminal,/event: cancelled/);assert.equal((await active.read()).done,true);assert.equal(aborted,true);
});

test("assistant route verifies project and authorization without mutating canvas",async t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 let calls=0;
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner",assistantChat:async()=>{
  calls++;return {answer:"已分析",model:"demo"};}});
 t.after(async()=>{await app.close();db.close()});
 const input={channelId:"c1",provider:"openai_compatible",model:"demo",messages};
 const call=(url,payload=input,headers={"x-test-owner":"owner"})=>
  app.inject({method:"POST",url,headers,payload});
 const path="/api/v1/projects/p1/assistant/chat";
 assert.equal((await call(path,input,{})).statusCode,401);
 assert.equal((await call(path)).statusCode,404);
 const created=await app.inject({method:"POST",url:"/api/v1/projects",headers:{"x-test-owner":"owner"},
  payload:{id:"p1",document:{nodes:[{id:"a",type:"text"}],connections:[]}}});
 assert.equal(created.statusCode,201,created.body);
 const reply=await call(path);
 assert.equal(reply.statusCode,200,reply.body);
 assert.equal(reply.json().answer,"已分析");
 assert.equal(calls,1);
 const project=await app.inject({method:"GET",url:"/api/v1/projects/p1",headers:{"x-test-owner":"owner"}});
 assert.equal(project.json().revision,1);
 assert.equal(project.json().document.nodes.length,1);
 assert.equal((await call(path,{...input,messages:[{role:"tool",content:"bad"}]})).statusCode,400);
});
