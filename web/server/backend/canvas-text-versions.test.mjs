import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {mutateTextVersions,readTextVersions} from "./canvas-text-versions.mjs";
import {createDramaRunService,exportDramaRuns,importDramaRuns,initDramaRuns} from "./drama-runs.mjs";

const snapshot=(id,content)=>({id,content,createdAt:"2026-11-20T00:00:00Z",source:"manual",note:id});
const story=(metadata)=>({id:"story",type:"drama:source",metadata});
const document=(nodes)=>({title:"History",nodes,connections:[]});
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 return db;
}

test("a single-episode candidate is idempotent and preserves unrelated edits",async t=>{
 const db=setup(t);
 initDramaRuns(db);
 const episode=id=>({id,title:id,synopsis:"Intro",events:[],sourceRefs:[],ending:"End"});
 const shot=(id,episodeId,description)=>({id,episodeId,description,order:1,characterVariantIds:[],propIds:[],keyPropIds:[]});
 const nodes=[story({dramaConfirmed:"Story"}),{id:"assets",type:"drama:assets",metadata:{dramaConfirmed:'{"assets":[]}'}},
  {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:JSON.stringify({episodes:[episode("one"),episode("two")]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[shot("one-shot","one","Original")]})}}];
 const connections=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
  .map(([fromNodeId,toNodeId],index)=>({id:`edge-${index}`,fromNodeId,toNodeId}));
 createProject(db,{id:"p",document:{...document(nodes),connections}});
 let calls=0;
 const runs=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(){calls++;return JSON.stringify({shots:[shot("generated","two","Candidate")]});}});
 const request={requestId:"run",nodeId:"board",episodeId:"two",channelId:"channel",provider:"openai",model:"model"};
 assert.equal((await runs.submit("p",request)).status,"ready");
 assert.equal((await runs.submit("p",request)).status,"ready");
 assert.equal(calls,1);
 const graph=getProject(db,"p").document;
 graph.nodes[3].metadata.dramaDraft=JSON.stringify({shots:[shot("one-shot","one","Human edit")]});
 saveSingleUserCanvas(db,{id:"p",expectedRevision:1,document:graph});
 const adopted=runs.adopt("p","run");
 assert.deepEqual(JSON.parse(adopted.document.nodes[3].metadata.dramaDraft).shots.map(item=>item.description),
  ["Human edit","Candidate"]);
 assert.equal(runs.adopt("p","run").revision,adopted.revision);
 const next=await runs.submit("p",{...request,requestId:"conflict"});
 assert.equal(next.status,"ready");
 const latest=getProject(db,"p");
 latest.document.nodes[3].metadata.dramaDraft=JSON.stringify({shots:[shot("other","two","Manual replacement")]});
 saveSingleUserCanvas(db,{id:"p",expectedRevision:latest.revision,document:latest.document});
 assert.throws(()=>runs.adopt("p","conflict"),/drama_candidate_conflict/);
 assert.equal(runs.get("p","conflict").status,"ready");
 const source=getProject(db,"p").document;
 createProject(db,{id:"restored",document:source});
 importDramaRuns(db,"restored",source,exportDramaRuns(db,"p",source));
 assert.deepEqual(runs.get("restored","conflict"),runs.get("p","conflict"));
});

test("migrates all four node types in place, preserving ordering and current graph revision",t=>{
 const db=setup(t);
 db.exec("DROP TABLE canvas_text_versions; DROP TABLE canvas_text_version_operations; DELETE FROM schema_migrations");
 db.prepare("INSERT INTO schema_migrations VALUES(34,0)").run();
 const nodes=["text","drama:source","drama:episodes","drama:storyboard"].map((type,index)=>({
  id:"node-"+index,type,metadata:{content:"current",textVersions:[snapshot("new","new"),snapshot("old","old")]}
 }));
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)").run("p",JSON.stringify(document(nodes)),7);
 initializeSchema(db);initializeSchema(db);
 const result=getProject(db,"p");
 assert.equal(result.revision,7);
 for(const node of result.document.nodes){
  assert.deepEqual(node.metadata,{content:"current"});
  const {versions}=readTextVersions(db,"p",node.id);
  assert.deepEqual(versions.map(({id,note})=>[id,note]),[["new","new"],["old","old"]]);
  assert.equal("content" in versions[0],false);
  assert.equal(readTextVersions(db,"p",node.id,"old").version.content,"old");
 }
});

test("story confirmation, stale autosave, backup restore and replay are transactional",t=>{
 const db=setup(t);
 const initial=document([story({dramaDraft:"new\n",content:"new\n",dramaConfirmed:"old",videoRatio:"16:9",dramaFilmStyle:"paint"})]);
 createProject(db,{id:"p",document:initial});
 const change=(command,validator=validateProjectDocument)=>mutateTextVersions(db,"p","story",command,validator,emitProjectEvent);
 const confirm={operationId:"c",action:"confirm",expectedRevision:1};
 assert.throws(()=>change(confirm,()=>{throw Error("injected")}),/injected/);
 assert.deepEqual(readTextVersions(db,"p","story").versions,[]);
 assert.equal(getProject(db,"p").revision,1);
 assert.equal(change(confirm).revision,2);
 assert.equal(change(confirm).revision,2);
 assert.throws(()=>saveSingleUserCanvas(db,{id:"p",expectedRevision:1,document:initial}),/project_revision_conflict/);
 const [published,legacy]=readTextVersions(db,"p","story").versions;
 assert.equal(published.id,"c");
 assert.throws(()=>change({operationId:"delete",action:"delete",versionId:"c"}),/text_version_in_use/);
 const edited=getProject(db,"p").document;
 Object.assign(edited.nodes[0].metadata,{dramaDraft:"unsaved",content:"unsaved"});
 saveSingleUserCanvas(db,{id:"p",expectedRevision:2,document:edited});
 assert.throws(()=>change({operationId:"r",action:"restore",expectedRevision:3,versionId:legacy.id,mode:"direct"}),/text_version_backup_required/);
 const restore={operationId:"r",action:"restore",expectedRevision:3,versionId:legacy.id,mode:"backup"};
 assert.equal(change(restore).revision,4);
 assert.equal(change(restore).revision,4);
 assert.deepEqual(getProject(db,"p").document.nodes[0].metadata,{
  content:"old",dramaDraft:"old",dramaConfirmed:"new\n",dramaConfirmedVersionId:"c",dramaStage:"source",videoRatio:"16:9",dramaFilmStyle:"paint"
 });
 assert.equal(readTextVersions(db,"p","story","r").version.content,"unsaved");
 saveSingleUserCanvas(db,{id:"p",expectedRevision:4,document:document([])});
 assert.throws(()=>readTextVersions(db,"p","story"),/text_node_not_found/);
 saveSingleUserCanvas(db,{id:"p",expectedRevision:5,document:document([initial.nodes[0],{...initial.nodes[0],id:"copy"}])});
 assert.equal(readTextVersions(db,"p","story").versions.length,3);
 assert.equal(readTextVersions(db,"p","copy").versions.length,0);
});

test("a full manual history permits publication",t=>{
 const db=setup(t);
 const versions=Array.from({length:50},(_,index)=>snapshot("v"+index,"body "+index));
 const current=document([story({dramaDraft:"next",dramaConfirmed:"previous",textVersions:versions})]);
 createProject(db,{id:"p",document:current});
 const change=command=>mutateTextVersions(db,"p","story",command,validateProjectDocument,emitProjectEvent);
 change({operationId:"full",action:"confirm",expectedRevision:1});
 assert.equal(readTextVersions(db,"p","story").versions.length,52);
 assert.equal(getProject(db,"p").document.nodes[0].metadata.dramaConfirmed,"next");
});

test("restores structured draft bodies without changing confirmation or shot links",t=>{
 const db=setup(t);
 const episode=JSON.stringify({episodes:[{id:"ep",title:"One",synopsis:"Intro",events:[],sourceRefs:[],ending:"End"}]});
 const shot={id:"shot",episodeId:"ep",order:1,description:"Opening",sceneId:"scene",characterVariantIds:["costume"],propIds:[],keyPropIds:[]};
 const storyboard=JSON.stringify({shots:[shot]});
 const nodes=[["episodes",episode],["storyboard",storyboard]].map(([stage,body])=>({
  id:stage,type:"drama:"+stage,metadata:{dramaDraft:body,dramaConfirmed:"confirmed",
   textVersions:[snapshot("valid",body),snapshot("invalid","plain text")]}
 }));
 const project=createProject(db,{id:"p",document:document(nodes)});
 for(const [index,node] of project.document.nodes.entries()){
  const command={action:"restore",expectedRevision:project.revision+index+1,mode:"overwrite"};
  const graph=getProject(db,"p").document;
  graph.nodes[index].metadata.dramaDraft="unsaved";
  saveSingleUserCanvas(db,{id:"p",expectedRevision:getProject(db,"p").revision,document:graph});
  command.expectedRevision=getProject(db,"p").revision;
  const change=(operationId,versionId)=>mutateTextVersions(db,"p",node.id,{...command,operationId,versionId},validateProjectDocument,emitProjectEvent);
  assert.throws(()=>change("bad","invalid"),/text_version_invalid_restore/);
  change("restore","valid");
  assert.equal(getProject(db,"p").document.nodes[index].metadata.dramaConfirmed,"confirmed");
  assert.equal(getProject(db,"p").document.nodes[index].metadata.dramaDraft,index===0?episode:storyboard);
 }
});
