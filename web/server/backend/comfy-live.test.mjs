import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {comfyUpstream} from "./comfy-v2-adapter.mjs";
import {createComfyLiveHub,parseComfySocketMessage,parseComfyPreview,parseComfyPromptError,parseKJPreviewMessage} from "./comfy-live.mjs";

const frame=(type,data)=>JSON.stringify({type,data});
const png=Buffer.from("89504e470d0a1a0a0000000d49484452","hex");
class FakeSocket {
 static all=[];
 constructor(url){this.url=url;this.listeners=new Map();this.closed=false;FakeSocket.all.push(this)}
 addEventListener(kind,listener){const items=this.listeners.get(kind)??[];items.push(listener);this.listeners.set(kind,items)}
 emit(kind,data){for(const handler of this.listeners.get(kind)??[])handler({data})}
 close(){this.closed=true;this.emit("close",null)}
}
test("native websocket filters unrelated prompts; legacy unscoped binary preview is disabled",()=>{
 FakeSocket.all=[];
 let time=1000;
 const hub=createComfyLiveHub({WebSocketImpl:FakeSocket,now:()=>time});
 const events=[],off=hub.subscribe("job-1",event=>events.push(event));
 hub.observe({jobId:"job-1",promptId:"prompt-a",clientId:"attempt-1",url:"http://127.0.0.1:8188"});
 assert.equal(FakeSocket.all.length,1);
 const ws=FakeSocket.all[0];
 assert.match(ws.url,/\/ws\?clientId=attempt-1$/);
 ws.emit("message",frame("executing",{prompt_id:"prompt-b",node:"w_wf__1"}));
 assert.equal(events.length,0);
 ws.emit("message",frame("executing",{prompt_id:"prompt-a",node:"w_wf__12"}));
 assert.deepEqual(events[0],{kind:"progress",currentNode:"w_wf__12",step:null,steps:null,value:null});
 time+=250;
 ws.emit("message",frame("progress",{prompt_id:"prompt-a",value:5,max:20}));
 assert.deepEqual(events[1],{kind:"progress",currentNode:"w_wf__12",step:5,steps:20,value:.25});
 const bytes=Buffer.alloc(8);bytes.writeUInt32BE(1,0);bytes.writeUInt32BE(2,4);
 const combined=Buffer.concat([bytes,png]);
 ws.emit("message",combined.buffer.slice(combined.byteOffset,combined.byteOffset+combined.byteLength));
 assert.equal(events.at(-1).kind,"progress");
 const recovered=[];
 hub.subscribe("job-1",event=>recovered.push(event));
 assert.deepEqual(recovered.map(item=>item.kind),["progress"]);
 hub.disconnect("job-1");
 assert.equal(ws.closed,true);
 ws.emit("message",frame("progress",{prompt_id:"prompt-a",value:20,max:20}));
 assert.equal(events.length,2);
 off();hub.dispose();
});
test("KJ preview override accepts only the bound namespaced node and matching prompt",()=>{
 const image=png.toString("base64"),nodeId="w_canvas-1__105_200";
 const message=data=>JSON.stringify({type:"kj_preview_override",data});
 const valid=parseKJPreviewMessage(message({node_id:nodeId,image,mime:"image/png",w:2,h:2,step:4,total:20}),{nodeId,promptId:"p-1"});
 assert.equal(valid.kind,"preview");assert.equal(valid.steps,20);assert.deepEqual(valid.bytes,png);
 assert.equal(parseKJPreviewMessage(message({node_id:"w_other__105_200",image,mime:"image/png",step:4,total:20}),{nodeId,promptId:"p-1"}),null);
 assert.equal(parseKJPreviewMessage(message({node_id:nodeId,prompt_id:"p-2",image,mime:"image/png",step:4,total:20}),{nodeId,promptId:"p-1"}),null);
 assert.equal(parseKJPreviewMessage(message({node_id:nodeId,image:"not-base64",mime:"image/png",step:4,total:20}),{nodeId}),null);
});
test("preview cache is bounded, SSE carries metadata only, and disconnect releases media",()=>{
 let time=0;const hub=createComfyLiveHub({WebSocketImpl:FakeSocket,now:()=>time});
 const payload=Buffer.alloc(4*1024*1024),updates=[];hub.subscribe("live-0",item=>updates.push(item));
 for(let i=0;i<17;i++){time+=1001;hub.publish("live-"+i,{kind:"preview",mime:"image/webp",bytes:payload,step:i,steps:20})}
 assert.equal(hub.getPreview("live-0"),null);
 assert.equal(hub.getPreview("live-16").bytes.length,4*1024*1024);
 assert.deepEqual(updates.map(({kind,mime,version,step,steps})=>({kind,mime,version,step,steps})),[
  {kind:"preview",mime:"image/webp",version:1,step:0,steps:20}
 ]);
 assert.equal(Object.hasOwn(updates[0],"bytes"),false);
 hub.disconnect("live-16");assert.equal(hub.getPreview("live-16"),null);hub.dispose();
});
test("task socket stages pre-acceptance previews and publishes only after prompt ID matches",()=>{
 FakeSocket.all=[];let time=1000;const hub=createComfyLiveHub({WebSocketImpl:FakeSocket,now:()=>time});
 const nodeId="w_canvas-1__105_200",events=[];hub.subscribe("job-kj",item=>events.push(item));
 const args={jobId:"job-kj",promptId:null,clientId:"attempt-1",url:"http://127.0.0.1:8188",previewNodeId:nodeId,graph:{}};
 hub.observe(args);const ws=FakeSocket.all[0],image=png.toString("base64");
 const send=prompt_id=>ws.emit("message",frame("kj_preview_override",{prompt_id,node_id:nodeId,image,mime:"image/png",w:2,h:2,step:1,total:4}));
 send("other-prompt");hub.observe({...args,promptId:"prompt-1"});
 assert.equal(events.length,0);
 time+=1001;send("prompt-1");
 assert.equal(events.length,1);assert.equal(events[0].kind,"preview");assert.equal(events[0].version,1);
 assert.equal(hub.getPreview("job-kj").mime,"image/png");hub.disconnect("job-kj");hub.dispose();
});
test("Comfy execution title comes from compiled graph; class_type and ID remain fallbacks",()=>{
 const graph={
  "w_wf__105_14":{class_type:"SamplerCustomAdvanced",_meta:{title:"  自定义采样器（高级）  "}},
  "w_wf__105_15":{class_type:"BasicGuider",_meta:{title:"   "}}
 };
 const named=parseComfySocketMessage(frame("executing",{prompt_id:"prompt-a",node:"w_wf__105_14"}),"prompt-a",graph);
 assert.equal(named.nodeName,"自定义采样器（高级）");
 const typed=parseComfySocketMessage(frame("executing",{prompt_id:"prompt-a",node:"w_wf__105_15"}),"prompt-a",graph);
 assert.equal(typed.nodeName,"BasicGuider");
 const unknown=parseComfySocketMessage(frame("executing",{prompt_id:"prompt-a",node:"w_wf__capture_image"}),"prompt-a",graph);
 assert.equal(unknown.nodeName,undefined);
 assert.equal(parseComfySocketMessage(frame("executing",{prompt_id:"other",node:"w_wf__105_14"}),"prompt-a",graph),null);
});
test("Sampler updates without node ID retain the last named executing node",()=>{
 FakeSocket.all=[];
 let time=1000;
 const hub=createComfyLiveHub({WebSocketImpl:FakeSocket,now:()=>time});
 const events=[],graph={"w_wf__105_14":{class_type:"SamplerCustomAdvanced",_meta:{title:"自定义采样器（高级）"}}};
 hub.subscribe("job-title",event=>events.push(event));
 hub.observe({jobId:"job-title",promptId:"prompt-a",clientId:"attempt-1",url:"http://127.0.0.1:8188",graph});
 const ws=FakeSocket.all.at(-1);
 ws.emit("message",frame("executing",{prompt_id:"prompt-a",node:"w_wf__105_14"}));
 time+=250;
 ws.emit("message",frame("progress",{prompt_id:"prompt-a",value:2,max:6}));
 assert.equal(events[0].nodeName,"自定义采样器（高级）");
 assert.deepEqual({...events[1]},{kind:"progress",currentNode:"w_wf__105_14",step:2,steps:6,value:2/6,nodeName:"自定义采样器（高级）"});
 hub.dispose();
});
test("WebSocket reconnect is bounded when backend polls faster than socket can recover",()=>{
 FakeSocket.all=[];
 let time=1000;
 const hub=createComfyLiveHub({WebSocketImpl:FakeSocket,now:()=>time});
 const args={jobId:"job-1",promptId:"prompt-a",clientId:"attempt-1",url:"http://127.0.0.1:8188"};
 hub.observe(args);
 FakeSocket.all[0].close();
 hub.observe(args);
 assert.equal(FakeSocket.all.length,1);
 time+=2100;
 hub.observe(args);
 assert.equal(FakeSocket.all.length,2);
 hub.dispose();
});
test("websocket event parser drops malformed, foreign and oversized preview events",()=>{
 assert.equal(parseComfySocketMessage("{","a"),null);
 assert.equal(parseComfySocketMessage(frame("progress",{prompt_id:"b",value:2,max:10}),"a"),null);
 assert.equal(parseComfySocketMessage(frame("progress",{prompt_id:"a",value:2,max:0}),"a"),null);
 const invalid=Buffer.alloc(8+256*1024+1);invalid.writeUInt32BE(1,0);invalid.writeUInt32BE(2,4);
 assert.equal(parseComfyPreview(invalid),null);
 assert.equal(parseComfyPreview(new ArrayBuffer(8)),null);
});
test("prompt validation diagnostics include node/type but never echo user values",()=>{
 const detail=parseComfyPromptError({error:{type:"prompt_outputs_failed_validation"},node_errors:{
  "w_wf__115":{class_type:"ResolutionSelector",errors:[{type:"value_not_in_list",message:"secret=token-123"}]}
 }});
 assert.deepEqual(detail,{nodeId:"w_wf__115",classType:"ResolutionSelector",type:"value_not_in_list",message:"value_not_in_list"});
 assert.ok(!JSON.stringify(detail).includes("token-123"));
});
test("native /prompt 400 preserves a redacted typed Comfy diagnostic",async t=>{
 const server=createServer((_req,res)=>{
  res.writeHead(400,{"content-type":"application/json"});
  res.end(JSON.stringify({node_errors:{"w_wf__115":{class_type:"ResolutionSelector",errors:[{type:"value_not_in_list",message:"secret=123"}]}}}));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url="http://127.0.0.1:"+server.address().port;
 await assert.rejects(comfyUpstream({url},"/prompt",{method:"POST",body:"{}"}),err=>{
  assert.equal(err.confirmedNotAccepted,true);
  assert.equal(err.comfyDiagnostic.nodeId,"w_wf__115");
  assert.equal(err.comfyDiagnostic.type,"value_not_in_list");
  return true;
 });
});
