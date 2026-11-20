import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {mutateTextVersions,readTextVersions} from "./canvas-text-versions.mjs";

const snapshot=(id,content)=>({id,content,createdAt:"2026-11-20T00:00:00Z",source:"manual",note:id});
const story=(metadata)=>({id:"story",type:"drama:source",metadata});
const document=(nodes)=>({title:"History",nodes,connections:[]});
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 return db;
}

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
 assert.deepEqual(readTextVersions(db,"p","story").versions.map(v=>v.id),["c"]);
 assert.throws(()=>change({operationId:"r",action:"restore",expectedRevision:2,versionId:"c",mode:"direct"}),/text_version_backup_required/);
 const restore={operationId:"r",action:"restore",expectedRevision:2,versionId:"c",mode:"backup"};
 assert.equal(change(restore).revision,3);
 assert.equal(change(restore).revision,3);
 assert.deepEqual(getProject(db,"p").document.nodes[0].metadata,{
  content:"old",dramaDraft:"old",dramaConfirmed:"new\n",dramaStage:"source",videoRatio:"16:9",dramaFilmStyle:"paint"
 });
 assert.equal(readTextVersions(db,"p","story","r").version.content,"new\n");
 saveSingleUserCanvas(db,{id:"p",expectedRevision:3,document:document([])});
 assert.throws(()=>readTextVersions(db,"p","story"),/text_node_not_found/);
 saveSingleUserCanvas(db,{id:"p",expectedRevision:4,document:document([initial.nodes[0],{...initial.nodes[0],id:"copy"}])});
 assert.equal(readTextVersions(db,"p","story").versions.length,2);
 assert.equal(readTextVersions(db,"p","copy").versions.length,0);
});

test("a full history only blocks confirmation when a new archive is needed",t=>{
 const db=setup(t);
 const versions=Array.from({length:50},(_,index)=>snapshot("v"+index,"body "+index));
 const current=document([story({dramaDraft:"next",dramaConfirmed:"previous",textVersions:versions})]);
 createProject(db,{id:"p",document:current});
 const change=command=>mutateTextVersions(db,"p","story",command,validateProjectDocument,emitProjectEvent);
 assert.throws(()=>change({operationId:"full",action:"confirm",expectedRevision:1}),/text_version_limit/);
 assert.equal(getProject(db,"p").document.nodes[0].metadata.dramaConfirmed,"previous");
 assert.equal(readTextVersions(db,"p","story").versions.length,50);
 const graph=getProject(db,"p").document;
 graph.nodes[0].metadata.dramaConfirmed="body 45";
 saveSingleUserCanvas(db,{id:"p",expectedRevision:1,document:graph});
 change({operationId:"already-saved",action:"confirm",expectedRevision:2});
 assert.equal(readTextVersions(db,"p","story").versions.length,50);
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
