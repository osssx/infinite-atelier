/** Volatile ComfyUI /ws progress. SQLite jobs and /history remain authoritative.
 * No previews, sampler frames or prompt text are written to persistent storage.
 */
const MAX_PREVIEW=256*1024;
const safeId=value=>typeof value==="string"&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const safeText=(value,max=500)=>typeof value==="string"?value.slice(0,max):"";
export function parseComfyExecutionError(data){
 if(!data||typeof data!=="object")return null;
 const nodeId=safeId(String(data.node_id??""))?String(data.node_id):null;
 const classType=safeText(data.node_type,100);
 const type=safeText(data.exception_type,100);
 // Exception messages may contain prompt or API credentials. Keep only the
 // structured exception type publicly; full details stay on ComfyUI itself.
 return {nodeId,classType,type,message:type||"ComfyUI 节点执行失败"};
}
export function parseComfyPromptError(body){
 if(!body||typeof body!=="object")return null;
 const nodeErrors=body.node_errors;
 const found=nodeErrors&&typeof nodeErrors==="object"?
  Object.entries(nodeErrors).find(([id,value])=>safeId(id)&&value&&typeof value==="object"&&Array.isArray(value.errors)&&value.errors.length):null;
 if(found){
  const [nodeId,detail]=found;
  const first=detail.errors[0]??{};
  const type=safeText(first.type,100)||safeText(body.error?.type,100);
  return {nodeId,classType:safeText(detail.class_type,100),type,message:type||"ComfyUI 工作流参数校验失败"};
 }
 const type=safeText(body.error?.type,100);
 return {nodeId:null,classType:"",type,message:type||"ComfyUI 工作流参数校验失败"};
}
/** The compiled graph retains ComfyUI's _meta.title, including custom node titles. */
function executionNodeName(graph,nodeId){
 if(!nodeId||!graph||!Object.prototype.hasOwnProperty.call(graph,nodeId))return null;
 const node=graph[nodeId];
 const title=typeof node?._meta?.title==="string"?node._meta.title.trim().replace(/\s+/g," ").slice(0,120):"";
 const classType=typeof node?.class_type==="string"?node.class_type.slice(0,120):"";
 return title||classType||null;
}
export function parseComfySocketMessage(raw,promptId,graph){
 if(typeof raw!=="string")return null;
 let envelope;
 try{envelope=JSON.parse(raw)}catch{return null}
 if(!envelope||typeof envelope!=="object")return null;
 const data=envelope.data;
 if(!data||typeof data!=="object"||data.prompt_id!==promptId)return null;
 const nodeId=safeId(String(data.node??data.node_id??""))?String(data.node??data.node_id):null;
 const nodeName=executionNodeName(graph,nodeId);
 if(envelope.type==="execution_error"){
  const error=parseComfyExecutionError(data);
  return error?{kind:"error",error}:null;
 }
 if(envelope.type==="executing"&&nodeId)return {kind:"progress",currentNode:nodeId,step:null,steps:null,value:null,
  ...(nodeName?{nodeName}:{})};
 if(envelope.type==="progress"&&Number.isFinite(data.value)&&Number.isFinite(data.max)&&data.max>0){
  return {kind:"progress",currentNode:nodeId,step:Math.max(0,Math.floor(data.value)),steps:Math.floor(data.max),
   value:Math.max(0,Math.min(1,data.value/data.max)),...(nodeName?{nodeName}:{})};
 }
 return null;
}
export function parseComfyPreview(raw){
 if(!(raw instanceof ArrayBuffer)&&!ArrayBuffer.isView(raw))return null;
 const b=Buffer.from(raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength));
 if(b.length<12||b.length>MAX_PREVIEW+8||b.readUInt32BE(0)!==1)return null;
 const format=b.readUInt32BE(4),bytes=b.subarray(8);
 const mime=format===1?"image/jpeg":format===2?"image/png":null;
 if(!mime||format===1&&!(bytes[0]===255&&bytes[1]===216)||
    format===2&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
 return {kind:"preview",mime,data:bytes.toString("base64")};
}
export function createComfyLiveHub({WebSocketImpl=globalThis.WebSocket,now=()=>Date.now()}={}){
 const entries=new Map();
 function entry(id){
  let value=entries.get(id);
  if(!value){value={listeners:new Set(),snapshots:new Map(),socket:null,lastProgress:0,lastPreview:0,closed:false};entries.set(id,value)}
  return value;
 }
 function publish(jobId,update){
  const e=entry(jobId),time=now();
  if(update.kind==="preview"&&time-e.lastPreview<1000)return;
  if(update.kind==="progress"&&update.currentNode===null)
   update={...update,currentNode:e.snapshots.get("progress")?.currentNode??null,
    ...(e.snapshots.get("progress")?.nodeName?{nodeName:e.snapshots.get("progress").nodeName}:{})};
  if(update.kind==="progress"&&time-e.lastProgress<200&&
      e.snapshots.get("progress")?.currentNode===update.currentNode)return;
  if(update.kind==="preview")e.lastPreview=time;
  if(update.kind==="progress")e.lastProgress=time;
  e.snapshots.set(update.kind,update);
  for(const callback of e.listeners){try{callback(update)}catch{/* one client must not block another */}}
 }
 function subscribe(jobId,callback){
  const e=entry(jobId);e.listeners.add(callback);
  for(const item of e.snapshots.values())callback(item);
  return ()=>e.listeners.delete(callback);
 }
 function disconnect(jobId){
  const e=entries.get(jobId);
  if(!e)return;
  e.closed=true;
  const socket=e.socket;e.socket=null;
  try{socket?.close()}catch{}
  e.snapshots.delete("preview");
  if(e.cleanup)clearTimeout(e.cleanup);
  e.cleanup=setTimeout(()=>{if(e.closed&&entries.get(jobId)===e)entries.delete(jobId)},5*60*1000);
  e.cleanup.unref?.();
 }
 function observe({jobId,promptId,clientId,url,graph}){
  if(!WebSocketImpl||!safeId(jobId)||!safeId(promptId)||!safeId(clientId))return;
  const e=entry(jobId);
  if(e.socket&&!e.closed)return;
  // Polling may be frequent; a rejected WebSocket must not reconnect every tick.
  if(!e.closed&&e.lastConnectAt!==undefined&&now()-e.lastConnectAt<2000)return;
  e.lastConnectAt=now();
  e.closed=false;
  if(e.cleanup){clearTimeout(e.cleanup);e.cleanup=null}
  let address;
  try{const target=new URL(url);if(target.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(target.hostname))return;
   target.protocol="ws:";target.pathname="/ws";target.searchParams.set("clientId",clientId);address=target.toString();
  }catch{return}
  let socket;
  try{socket=new WebSocketImpl(address)}catch{return}
  e.socket=socket;
  try{socket.binaryType="arraybuffer"}catch{}
  socket.addEventListener("message",msg=>{
   if(e.closed||e.socket!==socket)return;
   const update=parseComfySocketMessage(msg.data,promptId,graph);
   if(update)publish(jobId,update);
   else if(typeof msg.data!=="string"){
    const preview=parseComfyPreview(msg.data);
    if(preview)publish(jobId,preview);
   }
  });
  socket.addEventListener("close",()=>{if(e.socket===socket)e.socket=null});
  socket.addEventListener("error",()=>{/* connection is optional; polling continues */});
 }
 function dispose(){
  for(const id of entries.keys()){
   disconnect(id);
   const timer=entries.get(id)?.cleanup;
   if(timer)clearTimeout(timer);
  }
  entries.clear();
 }
 return {publish,subscribe,observe,disconnect,dispose};
}
