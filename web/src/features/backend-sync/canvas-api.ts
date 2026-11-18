/** Single-user local Canvas backend. No origin-local project storage. */
export type CanvasRequestDiagnostic={
 lane?:"graph"|"viewport"|"chats";
 field?:string;keyword?:string;
};
const laneLabel={graph:"节点图",viewport:"视口",chats:"聊天"};
export class CanvasApiError extends Error{
 constructor(readonly code:string,readonly status:number,
  readonly method?:string,readonly endpoint?:string,readonly details?:CanvasRequestDiagnostic){
  const field=details?.field&&details.field!=="/"?
   details.field:details?.keyword==="required"?"/（缺少必填字段）":"";
  const where=details?.lane?laneLabel[details.lane]+"保存":
   method&&endpoint?method+" "+endpoint.replace(/\/api\/v1\/projects\/[^/]+/,"/api/v1/projects/:id"):"";
  super(code+(where?" ["+where+(field?" "+field:"")+"]":""));
  this.name="CanvasApiError";
 }
}
let csrf:string|null=null,initializing:Promise<string>|null=null;
export async function canvasSession(force=false):Promise<string>{
 if(csrf&&!force)return csrf;
 if(initializing)return initializing;
 initializing=(async()=>{
  const response=await fetch("/api/v1/session",{credentials:"same-origin",cache:"no-store"});
  if(!response.ok)throw new CanvasApiError("backend_unavailable",response.status);
  const data=await response.json() as {csrfToken?:string};
  if(typeof data.csrfToken!=="string"||!data.csrfToken)
   throw new CanvasApiError("backend_invalid_session",response.status);
  csrf=data.csrfToken;return csrf;
 })();
 try{return await initializing}finally{initializing=null}
}
export async function canvasApi<T>(path:string,method="GET",payload?:unknown,signal?:AbortSignal):Promise<T>{
 if(!path.startsWith("/api/v1/"))throw Error("invalid_canvas_api_path");
 for(let attempts=0;attempts<2;attempts++){
  const token=await canvasSession(attempts>0);
  let response:Response;
  try{response=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
   signal,
   headers:{"accept":"application/json",...(method!=="GET"?{"x-atelier-csrf":token}:{}),
    ...(payload===undefined?{}:{"content-type":"application/json"})},
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})})}
  catch(error){if(signal?.aborted)throw new DOMException("Aborted","AbortError");throw new CanvasApiError("backend_unavailable",0)}
  if(response.status===401&&attempts===0){csrf=null;continue}
  const data:unknown=await response.json().catch(()=>null);
  if(!response.ok){
   const code=(data&&typeof data==="object"&&"code" in data&&typeof data.code==="string")?data.code:"backend_http_error";
   const details=data&&typeof data==="object"&&"details" in data?
    (data as {details?:unknown}).details:null;
   const safe=details&&typeof details==="object"&&!Array.isArray(details)?
    details as CanvasRequestDiagnostic:undefined;
   throw new CanvasApiError(code,response.status,method,path,
    safe&&["graph","viewport","chats"].includes(safe.lane??"")&&
     typeof safe.field==="string"&&safe.field.length<=128&&
     typeof safe.keyword==="string"&&safe.keyword.length<=32?safe:undefined);
  }
  if(!data||typeof data!=="object")throw new CanvasApiError("backend_invalid_json",response.status);
  return data as T;
 }
 throw new CanvasApiError("backend_unauthorized",401);
}
type AssistantStreamEvent<T>={seq:number;type:string;text?:string;result?:T;code?:string};
export async function canvasApiStream<T>(path:string,payload:{turnId:string},signal:AbortSignal,onDelta?:(text:string)=>void):Promise<T>{
 let token=await canvasSession();
 let cursor=0;
 const consume=(event:AssistantStreamEvent<T>)=>{
  if(event.seq<=cursor)return;
  if(event.seq!==cursor+1)throw new CanvasApiError("assistant_stream_incomplete",502);
  cursor=event.seq;
  if(event.type==="delta")onDelta?.(event.text??"");
  if(event.type==="error"||event.type==="cancelled")throw new CanvasApiError(event.code??"assistant_failed",502);
  return event.type==="done"?event.result:undefined;
 };
 try{
  const send=()=>fetch(path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,
   headers:{accept:"text/event-stream","content-type":"application/json","x-atelier-csrf":token},body:JSON.stringify(payload)});
  let response=await send();
  if(response.status===401){await response.body?.cancel();token=await canvasSession(true);response=await send();}
  if(!response.ok){const data=await response.json().catch(()=>null);throw new CanvasApiError(data?.code??"backend_http_error",response.status,"POST",path);}
  if(!response.body)throw new CanvasApiError("backend_invalid_stream",response.status);
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";
  try{
   for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});
    const blocks=buffer.split("\n\n");buffer=blocks.pop()??"";
    for(const block of blocks){const data=block.split("\n").find(line=>line.startsWith("data:"))?.slice(5).trim();if(!data)continue;
     const result=consume(JSON.parse(data));if(result!==undefined)return result;
    }
   }
  }finally{void reader.cancel().catch(()=>{});}
 }catch(error){
  if(signal.aborted||(error instanceof CanvasApiError&&error.code!=="assistant_model_call_in_progress"&&error.code!=="assistant_stream_incomplete"))throw error;
 }
 if(payload.turnId){
  const deadline=Date.now()+5*60_000;
  while(!signal.aborted&&Date.now()<deadline){
   let state;
   try{state=await readCanvasAssistantStream<T>(path,payload.turnId,cursor,signal);}
   catch(error){if(signal.aborted)throw error;if(error instanceof CanvasApiError&&error.status>=400&&error.status<500)break;}
   for(const event of state?.events??[]){const result=consume(event);if(result!==undefined)return result;}
   if(state?.terminal)break;
   await new Promise(resolve=>setTimeout(resolve,600));
  }
 }
 signal.throwIfAborted();
 throw new CanvasApiError("assistant_stream_incomplete",502);
}
export async function readCanvasAssistantStream<T>(path:string,turnId:string,after=0,signal?:AbortSignal):Promise<{events:AssistantStreamEvent<T>[];terminal:boolean}>{
 return canvasApi(path+"/stream/"+encodeURIComponent(turnId)+"?after="+after,"GET",undefined,signal);
}
export async function cancelCanvasAssistantStream(path:string,turnId:string,signal?:AbortSignal){
 return canvasApi<{turnId:string;cancelled:boolean}>(path+"/stream/"+encodeURIComponent(turnId)+"/cancel","POST",{},signal);
}
export type CanvasBackendProject={id:string;revision:number;document:Record<string,unknown>};
export type CanvasBackendSummary={id:string;title:string;revision:number;createdAt?:string;updatedAt?:string;nodeCount:number;connectionCount:number};
