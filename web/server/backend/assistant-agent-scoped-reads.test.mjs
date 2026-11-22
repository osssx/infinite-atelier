import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,emitProjectEvent,validateProjectDocument,getProject} from "./projects.mjs";
import {createAssistantTask,appendAssistantTaskTurn} from "./assistant-tasks.mjs";
import {createAssistantAgentReadSession} from "./assistant-agent-read-tools.mjs";
import {patchDramaScopedBatch} from "./drama-scoped-batch-cas.mjs";
import {readDramaRevisionScope,insertTextVersions} from "./canvas-text-versions.mjs";
import {discoverAssistantCreativeCharacters} from "./assistant-creative-context.mjs";
import {discoverAssistantCreativeMaterials} from "./assistant-creative-materials.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";

const source="Unrelated payload must not be fetched";
const assets=Array.from({length:50},(_,i)=>({id:"asset-"+i,kind:"prop",
 name:"Asset "+i,description:"Asset description "+i,sourceRefs:[],
 ...(i===37?{storageKey:"secret-media-slot",variants:[{id:"v37",name:"Day",description:"Light"}]}:{})}));
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"Episode "+i,
 synopsis:"Summary "+i,ending:"End "+i,events:["Event "+i],sourceRefs:[]}));
const shots=Array.from({length:100},(_,i)=>({id:"shot-"+i,episodeId:"ep-"+Math.floor(i/25),
 order:i%25,description:i===75?"Target shot "+("夜间拍摄".repeat(420)):"Shot "+i,
 characterVariantIds:[],propIds:[],keyPropIds:[]}));
function document(){
 return {title:"200 nodes scoped Agent read",nodes:[
  {id:"assets",type:"drama:assets",title:"Asset plans",metadata:{
   dramaDraft:JSON.stringify({assets}),dramaConfirmed:JSON.stringify({assets})}},
  {id:"episodes",type:"drama:episodes",title:"Episode plans",metadata:{
   dramaDraft:JSON.stringify({episodes}),dramaConfirmed:JSON.stringify({episodes})}},
  {id:"board",type:"drama:storyboard",title:"Storyboard",metadata:{
   dramaDraft:JSON.stringify({shots}),dramaConfirmed:JSON.stringify({shots}),
   dramaConfirmedVersionId:"board-frozen"}},
  {id:"hidden-board",type:"drama:storyboard",title:"Hidden private storyboard",metadata:{
   dramaDraft:JSON.stringify({shots:[{id:"secret-shot",episodeId:"hidden",order:0,
    description:source,characterVariantIds:[],propIds:[],keyPropIds:[]}]})}},
  ...Array.from({length:196},(_,i)=>({id:"text-"+i,type:"text",title:"Text "+i,
   metadata:{content:"safe text "+i}}))
 ],connections:[{id:"edge",fromNodeId:"assets",toNodeId:"board"}]};
}
function fixture(t,{policy={includeContext:true,scope:"selection",includedIds:["assets","episodes","board"]}}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:document()});
 insertTextVersions(db,"p",[{nodeId:"board",id:"board-frozen",source:"confirmation",
  createdAt:"2026-11-22T00:00:00Z",content:JSON.stringify({shots})}]);
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"查询剧本创作范围",requestId:"create-task"}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",
  messageId:"current",text:"请只读当前选中的资产、剧集和分镜",
  contextPolicy:policy});
 const session=()=>createAssistantAgentReadSession(db,{projectId:"p",taskId:task.id,
  turnMessageId:"current",requestId:"agent-model"});
 return {db,task,session};
}
const invoke=(session,name,args,callId)=>JSON.parse(session.invoke(name,args,{callId})).data;

test("P3.3f: 200-node manifest and map ignore missing hidden creative bodies",t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").run();
 const session=f.session();
 const map=invoke(session,"canvas_get_map",{},"map");
 assert.deepEqual(map.nodes.map(n=>n.id),["assets","episodes","board"]);
 assert.ok(!JSON.stringify(map).includes("hidden-board"));
 assert.ok(!JSON.stringify(map).includes(source));
 const connections=invoke(session,"canvas_get_connections",{},"connections");
 assert.equal(connections.connections.length,1);
 const history=invoke(session,"task_read_history",{},"history");
 assert.equal(history.steps.length,0);
 assert.throws(()=>invoke(session,"canvas_read_nodes",{node_ids:["hidden-board"],shot_id:"secret-shot"},"denied"),
  {code:"assistant_agent_context_scope_denied"});
});
test("P3.3f: indexed assets, episodes and shot ID are read without restoring the whole creative graph",t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").run();
 const s=f.session();
 const asset=invoke(s,"canvas_read_nodes",{node_ids:["assets"],asset_id:"asset-37"},"asset");
 assert.equal(asset.nodes[0].asset.name,"Asset 37");
 assert.equal(asset.nodes[0].asset.storageKey,undefined);
 assert.ok(!JSON.stringify(asset).includes("secret-media-slot"));
 assert.equal(asset.nodes[0].source,"dramaDraft");
 const episode=invoke(s,"canvas_read_nodes",{node_ids:["episodes"],episode_id:"ep-3"},"episode");
 assert.equal(episode.nodes[0].episode.synopsis,"Summary 3");
 assert.equal(episode.nodes[0].episode.sourceRefs.length,0);
 const shot=invoke(s,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-75"},"shot");
 assert.equal(shot.nodes[0].shotId,"shot-75");
 assert.equal(shot.nodes[0].shotNumber,1);
 assert.ok(shot.nodes[0].content?.length>0||shot.nodes[0].shot);
 assert.ok(s.bytes<=12*1024);
 assert.ok(!JSON.stringify({asset,episode,shot}).includes(source));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_events WHERE kind='agent_read_tool_completed'").get().n,3);
});
test("P3.3f: indexed long shot paging and confirmed historical shot remain stable",t=>{
 const f=fixture(t),s=f.session();
 const first=invoke(s,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-75",offset:0},"first");
 assert.equal(first.nodes[0].source,"dramaDraft");
 assert.ok(first.nextOffset>0);
 let content=first.nodes[0].content,nextOffset=first.nextOffset;
 for(let i=0;i<4&&nextOffset!==null;i++){
  const page=invoke(s,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-75",offset:nextOffset},"page-"+i);
  content+=page.nodes[0].content;nextOffset=page.nextOffset;
 }
 assert.equal(nextOffset,null);
 assert.equal(JSON.parse(content).description,
  "Target shot "+("夜间拍摄".repeat(420)));
 const confirmed=invoke(s,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-0",version:"confirmed"},"confirmed");
 assert.equal(confirmed.nodes[0].source,"dramaConfirmed");
 assert.equal(confirmed.nodes[0].shotId,"shot-0");
 assert.equal(confirmed.nodes[0].shotNumber,1);
});
test("P3.3f: scoped Agent selectors do not leak hidden nodes, broaden overview or bypass budgets",t=>{
 const f=fixture(t),s=f.session();
 assert.throws(()=>invoke(s,"canvas_read_nodes",{node_ids:["hidden-board"],shot_id:"secret-shot"},"foreign"),
  {code:"assistant_agent_context_scope_denied"});
 assert.throws(()=>invoke(s,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-75",asset_id:"asset-37"},"wrong"),
  {code:"assistant_agent_tool_arguments_invalid"});
 const overview=fixture(t,{policy:{includeContext:true,scope:"overview",includedIds:[]}}).session();
 assert.throws(()=>invoke(overview,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-75"},"overview"),
  {code:"assistant_agent_context_scope_denied"});
});
test("P3.3f: read-only Agent freezes revision; a scoped batch invalidates the old read session without Task writes",t=>{
 const f=fixture(t),s=f.session(),project=getProject(f.db,"p",{compact:true});
 const digest=readDramaRevisionScope(f.db,"p","assets",{draft:true,entryId:"asset-37"}).entryDigests[0].digest;
 patchDramaScopedBatch(f.db,"p",{operationId:"next-batch",expectedRevision:project.revision,edits:[
  {nodeId:"assets",kind:"assets",entryId:"asset-37",expectedDigest:digest,changes:{name:"Changed"}}
 ]},validateProjectDocument,emitProjectEvent);
 assert.throws(()=>invoke(s,"canvas_read_nodes",{node_ids:["assets"],asset_id:"asset-37"},"late"),
  {code:"assistant_agent_read_source_changed"});
 const updated=f.session();
 const result=invoke(updated,"canvas_read_nodes",{node_ids:["assets"],asset_id:"asset-37"},"fresh");
 assert.equal(result.nodes[0].asset.name,"Changed");
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});
test("P3.3f: creative.search sources never load unrelated, unselected missing payloads",t=>{
 const f=fixture(t,{policy:{includeContext:true,scope:"selection",
  includedIds:["text-0","text-1"]}});
 f.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='board'").run();
 const session=f.session();
 const searched=invoke(session,"creative_search",{kind:"character"},"creative");
 assert.ok(!JSON.stringify(searched).includes(source));
 const materials=discoverAssistantCreativeMaterials(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current",kinds:["story","scene"]});
 assert.ok(Array.isArray(materials.materials));
 const candidates=discoverAssistantCreativeCharacters(f.db,{projectId:"p",taskId:f.task.id,
  turnMessageId:"current"});
 assert.ok(Array.isArray(candidates.groups));
});
test("P3.3f: selected creative text is still searchable by body with no hidden payload hydration",t=>{
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 createProject(db,{id:"p",document:{nodes:[
  {id:"source-visible",type:"drama:source",title:"Selected story",metadata:{
   content:"Hidden-in-title free content with 星河蓝鲸 keyword",
   dramaDraft:"Another draft"}},
  {id:"source-hidden",type:"drama:source",title:"Unselected story",metadata:{
   content:"Private secret 星河蓝鲸 keyword"}}
 ],connections:[]}});
 const task=createAssistantTask(db,{projectId:"p",chatSessionId:"chat",
  rootMessageId:"root",originalRequest:"find selected story",requestId:"task"}).task;
 appendAssistantTaskTurn(db,{projectId:"p",taskId:task.id,requestId:"turn",messageId:"current",
  text:"search within selected context",contextPolicy:{includeContext:true,scope:"selection",
   includedIds:["source-visible"]}});
 db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='source-hidden'").run();
 const s=createAssistantAgentReadSession(db,{projectId:"p",taskId:task.id,
  turnMessageId:"current",requestId:"model"});
 const search=invoke(s,"canvas_search_nodes",{query:"星河蓝鲸"},"search");
 assert.deepEqual(search.matches.map(item=>item.id),["source-visible"]);
 assert.ok(!JSON.stringify(search).includes("Private secret"));
 const body=invoke(s,"canvas_read_nodes",{node_ids:["source-visible"],offset:0},"read");
 assert.ok(body.nodes[0].content);
});
test("P3.3f: missing selected indexed entry falls back to the selected legacy body, not hidden nodes",t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").run();
 // Simulate a pre-indexed legacy project where an indexed draft state is not
 // present: only the chosen node may be hydrated for the compatibility reader.
 f.db.prepare("DELETE FROM creative_scope_index_state WHERE project_id='p' AND node_id='board' AND stage='draft'").run();
 const session=f.session();
 const selected=invoke(session,"canvas_read_nodes",{node_ids:["board"],shot_id:"shot-0"},"fallback");
 assert.equal(selected.nodes[0].shotId,"shot-0");
 assert.equal(selected.nodes[0].shot.description,"Shot 0");
});
test("P3.3f: authenticated Agent HTTP tool rounds never hydrate a missing unselected creative node",async t=>{
 const f=fixture(t);
 f.db.prepare("DELETE FROM creative_node_payloads WHERE project_id='p' AND node_id='hidden-board'").run();
 const providerRequests=[];
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,fn)=>fn(Buffer.from("mock-key"))};
 const assistantChat=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const request=JSON.parse(options.body);
  providerRequests.push(request);
  const response=providerRequests.length===1?{choices:[{message:{
    role:"assistant",content:null,tool_calls:[{id:"read-asset",type:"function",
     function:{name:"canvas_read_nodes",arguments:JSON.stringify({node_ids:["assets"],asset_id:"asset-37"})}}
    ]},finish_reason:"tool_calls"}]}:
   {choices:[{message:{role:"assistant",content:"资产 37 已读取，未查看其他节点。"},finish_reason:"stop"}]};
  return new Response(JSON.stringify(response),{status:200});
 }});
 const app=buildApp({db:f.db,assistantChat,authorize:()=>true});
 t.after(async()=>app.close());
 const response=await app.inject({method:"POST",url:"/api/v1/projects/p/assistant/chat",payload:{
  channelId:"ch",provider:"openai_compatible",baseUrl:"http://127.0.0.1:8188/v1",model:"mock",
  canvasActions:false,agentReadTools:true,
  messages:[{role:"user",content:"请只读当前选中的资产、剧集和分镜"}],
  task:{taskId:f.task.id,turnMessageId:"current",requestId:"http-indexed-agent"}
 }});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().answer,"资产 37 已读取，未查看其他节点。");
 assert.equal(providerRequests.length,2,"only one read tool and one final model answer");
 const providerText=JSON.stringify(providerRequests);
 assert.ok(providerText.includes("Asset 37"));
 assert.ok(!providerText.includes(source));
 assert.ok(!providerText.includes("secret-media-slot"));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_steps").get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM assistant_task_attempts").get().n,0);
});
