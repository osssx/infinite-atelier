import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {mutateTextVersions,readTextVersions,readDramaRevisionScope,insertTextVersions,patchDramaShotDraft} from "./canvas-text-versions.mjs";
import {createDramaRunService,exportDramaRuns,importDramaRuns,initDramaRuns} from "./drama-runs.mjs";
import {reconcileSourceParagraphs,resolveSourceReference} from "./drama-source-paragraphs.mjs";
import {dramaDependencies,inspectDramaDependencies} from "./drama-dependencies.mjs";
import {removedDramaAssetUsages} from "./drama-asset-usage.mjs";
import {readCreativePayload,hydrateCreativeDocument} from "./creative-payloads.mjs";
import {fingerprintSource} from "./repository.mjs";

const snapshot=(id,content)=>({id,content,createdAt:"2026-11-20T00:00:00Z",source:"manual",note:id});
const story=(metadata)=>({id:"story",type:"drama:source",metadata});
const document=(nodes)=>({title:"History",nodes,connections:[]});
test("reference-only publication retains the asset definition revision",t=>{
 const db=setup(t);
 const body=JSON.stringify({assets:[{id:"prop",kind:"prop",name:"Lamp",description:"Lamp",sourceRefs:[]}]});
 const reference=hash=>[{assetId:"prop",imageStorageKey:"cas:"+hash.repeat(64),requiredForRendering:false}];
 createProject(db,{id:"media-version",document:document([{id:"assets",type:"drama:assets",metadata:{dramaDraft:body,
  dramaAssetReferences:reference("a")}}])});
 const confirm=(operationId,expectedRevision)=>mutateTextVersions(db,"media-version","assets",
  {action:"confirm",operationId,expectedRevision},validateProjectDocument,emitProjectEvent);
 confirm("definition",1);
 const original=getProject(db,"media-version");
 original.document.nodes[0].metadata.dramaAssetReferences=reference("b");
 saveSingleUserCanvas(db,{id:"media-version",expectedRevision:2,document:original.document});
 const published=confirm("pictures",3);
 const metadata=published.document.nodes[0].metadata;
 assert.equal(metadata.dramaConfirmedVersionId,"definition");
 assert.equal(metadata.dramaAssetReferenceRevisionId,"pictures");
 const provenance=readTextVersions(db,"media-version","assets","pictures").version.provenance;
 assert.equal(provenance.kind,"references");
 assert.deepEqual(provenance.references,reference("b"));
 assert.throws(()=>mutateTextVersions(db,"media-version","assets",{action:"delete",operationId:"remove",versionId:"pictures"},
  validateProjectDocument,emitProjectEvent),/text_version_in_use/);
});
test("revision scope returns only the selected episode page from an immutable revision",t=>{
 const db=setup(t);
 const shots=Array.from({length:100},(_,index)=>({id:`shot-${index}`,episodeId:index<50?"first":"second",
  sequenceId:index<75?"one":"two",order:index,description:"Shot "+index,characterVariantIds:[],propIds:[],keyPropIds:[]}));
 createProject(db,{id:"paged",document:document([{id:"board",type:"drama:storyboard",metadata:{dramaConfirmedVersionId:"snapshot",dramaDraft:JSON.stringify({shots})}}])});
 insertTextVersions(db,"paged",[{nodeId:"board",id:"snapshot",createdAt:"now",source:"confirmation",content:JSON.stringify({shots})}]);
 const page=readDramaRevisionScope(db,"paged","board",{episodeId:"second",sequenceId:"two",offset:5,limit:10});
 assert.equal(page.total,25);
 assert.equal(page.entries.length,10);
 assert.equal(page.entries[0].id,"shot-80");
 assert.equal(page.versionId,"snapshot");
 const summary=readDramaRevisionScope(db,"paged","board",{summaryOnly:true});
 assert.equal(summary.entries.length,0);
 assert.deepEqual(summary.groups.map(group=>[group.episodeId,group.total]),[["first",50],["second",50]]);
 assert.equal(JSON.stringify(summary).includes("Scene description"),false);
 const draftPage=readDramaRevisionScope(db,"paged","board",{draft:true,episodeId:"second",sequenceId:"two",offset:5,limit:10});
 const command={operationId:"edit-one",shotId:"shot-80",expectedDigest:draftPage.entryDigests[0].digest,changes:{description:"Human revision"}};
 patchDramaShotDraft(db,"paged","board",command,validateProjectDocument,emitProjectEvent);
 const changed=getProject(db,"paged");
 const body=JSON.parse(changed.document.nodes[0].metadata.dramaDraft);
 assert.equal(body.shots[80].description,"Human revision");
 assert.deepEqual(body.shots[0],shots[0]);
 patchDramaShotDraft(db,"paged","board",command,validateProjectDocument,emitProjectEvent);
 assert.equal(getProject(db,"paged").revision,changed.revision);
 assert.throws(()=>patchDramaShotDraft(db,"paged","board",{...command,operationId:"stale"},validateProjectDocument,emitProjectEvent),/drama_candidate_conflict/);
 assert.equal(readDramaRevisionScope(db,"paged","board",{episodeId:"second",sequenceId:"two",offset:5,limit:10}).entries[0].description,"Shot 80");
 const current=readDramaRevisionScope(db,"paged","board",{draft:true,episodeId:"second",sequenceId:"two",offset:5,limit:10});
 assert.throws(()=>patchDramaShotDraft(db,"paged","board",{operationId:"forged-prop",shotId:"shot-80",
  expectedDigest:current.entryDigests[0].digest,changes:{propIds:["unavailable"]}},validateProjectDocument,emitProjectEvent),/drama_draft_invalid/);
 assert.equal(getProject(db,"paged").revision,changed.revision);
});
test("asset publication preserves references from both draft and confirmed shots",t=>{
 const db=setup(t);
 const asset={id:"scene",kind:"scene",name:"Room",description:"Room",sourceRefs:[],variants:[{id:"night",name:"Night",description:"Dark"}]};
 const shot={id:"shot",episodeId:"ep",order:1,description:"Opening",sceneId:"scene",sceneVariantId:"night",
  characterVariantIds:[],propIds:[],keyPropIds:[]};
 const nodes=[{id:"assets",type:"drama:assets",metadata:{
  dramaDraft:JSON.stringify({assets:[{...asset,variants:[]}]}),dramaConfirmed:JSON.stringify({assets:[asset]})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaConfirmed:JSON.stringify({shots:[shot]}),
   dramaDraft:JSON.stringify({shots:[]})}}];
 const graph={nodes,connections:[{id:"edge",fromNodeId:"assets",toNodeId:"board"}]};
 assert.equal(removedDramaAssetUsages(graph,"assets",[{...asset,variants:[]}])[0].state,"confirmed");
 createProject(db,{id:"p",document:graph});
 assert.throws(()=>mutateTextVersions(db,"p","assets",{operationId:"remove",action:"confirm",expectedRevision:1},
  validateProjectDocument,emitProjectEvent),/drama_asset_in_use/);
 assert.equal(getProject(db,"p").revision,1);
 assert.equal(readTextVersions(db,"p","assets").versions.length,0);
});
test("dependency inspection identifies the changed asset without invalidating unchanged entries",()=>{
 const assets={id:"assets",type:"drama:assets",metadata:{dramaConfirmed:JSON.stringify({assets:[
  {id:"one",kind:"prop",name:"One",description:"Old",sourceRefs:[]},
  {id:"two",kind:"prop",name:"Two",description:"Unchanged",sourceRefs:[]},
 ]})}};
 const board={id:"board",type:"drama:storyboard",metadata:{}};
 const graph={nodes:[assets,board],connections:[{id:"edge",fromNodeId:"assets",toNodeId:"board"}]};
 board.metadata.dramaInputDependencies=dramaDependencies(graph,"board");
 assert.equal(inspectDramaDependencies(graph,"board").status,"current");
 const edited=JSON.parse(assets.metadata.dramaConfirmed);
 edited.assets[0].description="New";
 assets.metadata.dramaConfirmed=JSON.stringify(edited);
 assert.deepEqual(inspectDramaDependencies(graph,"board").changes[0].entryIds,["one"]);
 graph.connections=[];
 assert.equal(inspectDramaDependencies(graph,"board").changes[0].kind,"disconnected");
});
test("source paragraph anchors survive insertion and a single edited paragraph",()=>{
 const original=reconcileSourceParagraphs("First\nMiddle\nLast");
 const edited=reconcileSourceParagraphs("First\nChanged\nLast",original);
 assert.deepEqual(edited.map(item=>item.id),original.map(item=>item.id));
 const inserted=reconcileSourceParagraphs("New\nFirst\nChanged\nLast",edited);
 assert.deepEqual(inserted.slice(1).map(item=>item.id),original.map(item=>item.id));
 assert.equal(inserted[0].status,"needs_review");
 const split=reconcileSourceParagraphs("First\nPart one\nPart two\nLast",original);
 assert.equal(split[1].status,"needs_review");
 assert.equal(split[2].status,"needs_review");
 assert.deepEqual(split[1].replaces,[original[1].id]);
 assert.deepEqual(resolveSourceReference(original[1].id,split),{status:"needs_review",paragraphIds:[split[1].id,split[2].id]});
 const repeated=reconcileSourceParagraphs("First\nSame\nSame\nLast");
 const stable=reconcileSourceParagraphs("First\nSame\nSame\nLast",repeated);
 assert.deepEqual(stable.map(item=>item.id),repeated.map(item=>item.id));
 assert.equal(reconcileSourceParagraphs("New\nFirst\nChanged\nLast",inserted)[0].status,"needs_review");
});
function setup(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);t.after(()=>db.close());
 return db;
}
test("a 200-node creative graph stores only payload pointers and retains generation fingerprints",t=>{
 const db=setup(t);
 const shots=Array.from({length:100},(_,index)=>({id:`shot-${index}`,episodeId:"ep",order:index,
  description:"Scene description ".repeat(120),characterVariantIds:[],propIds:[],keyPropIds:[]}));
 const assets=Array.from({length:50},(_,index)=>({id:`prop-${index}`,kind:"prop",name:`Prop ${index}`,
  description:"Asset description ".repeat(80),sourceRefs:[]}));
 const nodes=[{id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots}),dramaConfirmed:JSON.stringify({shots})}},
  {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify({assets}),dramaConfirmed:JSON.stringify({assets})}},
  ...Array.from({length:198},(_,index)=>({id:`text-${index}`,type:"text",metadata:{content:"Text"}}))];
 const graph={nodes,connections:[{id:"link",fromNodeId:"assets",toNodeId:"board"}]};
 createProject(db,{id:"compact",document:graph});
 const raw=db.prepare("SELECT document_json FROM projects WHERE id=?").get("compact").document_json;
 const stored=JSON.parse(raw);
 assert.equal(stored.nodes[0].metadata.dramaDraft,undefined);
 assert.equal(stored.nodes[0].metadata.creativePayloadRef.nodeId,"board");
 assert.ok(Buffer.byteLength(raw)<Buffer.byteLength(JSON.stringify(graph))/10);
 const restored=getProject(db,"compact").document;
 assert.deepEqual(restored,graph);
 assert.equal(fingerprintSource(restored,"board"),fingerprintSource(graph,"board"));
 const compact=getProject(db,"compact",{compact:true});
 compact.document.nodes[0].title="Moved card";
 saveSingleUserCanvas(db,{id:"compact",expectedRevision:1,document:compact.document});
 assert.equal(getProject(db,"compact").document.nodes[0].metadata.dramaDraft,graph.nodes[0].metadata.dramaDraft);
 restored.nodes[0].title="Moved card";
 saveSingleUserCanvas(db,{id:"compact",expectedRevision:2,document:restored});
 assert.deepEqual(getProject(db,"compact").document,restored);
});
test("creative payload dual-write follows saves and confirmation with transactional rollback",t=>{
 const db=setup(t);
 createProject(db,{id:"payload",document:document([story({dramaDraft:"First",content:"First"})])});
 assert.equal(readCreativePayload(db,"payload","story").payload.dramaDraft,"First");
 const compact=document([{id:"story",type:"drama:source",metadata:{creativePayloadRef:{nodeId:"story",schemaVersion:1}}}]);
 assert.equal(hydrateCreativeDocument(db,"payload",compact).nodes[0].metadata.dramaDraft,"First");
 createProject(db,{id:"other",document:document([])});
 assert.throws(()=>hydrateCreativeDocument(db,"other",compact),/creative_payload_missing/);
 assert.equal(compact.nodes[0].metadata.dramaDraft,undefined);
 const confirm=validator=>mutateTextVersions(db,"payload","story",{operationId:"confirm",action:"confirm",expectedRevision:1},validator,emitProjectEvent);
 assert.throws(()=>confirm(()=>{throw Error("rollback")}),/rollback/);
 assert.equal(readCreativePayload(db,"payload","story").payload.dramaConfirmed,null);
 confirm(validateProjectDocument);
 assert.equal(readCreativePayload(db,"payload","story").payload.dramaConfirmed,"First");
 assert.equal(readCreativePayload(db,"payload","story").revision,2);
 saveSingleUserCanvas(db,{id:"payload",expectedRevision:2,document:document([])});
 assert.equal(readCreativePayload(db,"payload","story"),null);
});

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
 let finish;
 let attempts=0;
 const cancellable=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(config,input,baseline,signal){
   attempts++;
   if(attempts===1){
    await new Promise(resolve=>{finish=resolve;});
    assert.equal(signal.aborted,true);
   }
   return JSON.stringify({shots:[shot("replacement","two","Retried")]});
  }});
 const pending=cancellable.submit("p",{...request,requestId:"cancelled-run"});
 assert.equal(cancellable.cancel("p","cancelled-run").status,"cancelled");
 finish();
 assert.equal((await pending).status,"cancelled");
 assert.equal((await cancellable.retry("p","cancelled-run")).status,"ready");
 assert.equal(attempts,2);
 const staged=getProject(db,"p");
 const episodePlan=JSON.parse(staged.document.nodes[2].metadata.dramaConfirmed);
 episodePlan.episodes[1].sequences=[{id:"first",title:"First"},{id:"second",title:"Second"}];
 staged.document.nodes[2].metadata.dramaConfirmed=JSON.stringify(episodePlan);
 saveSingleUserCanvas(db,{id:"p",expectedRevision:staged.revision,document:staged.document});
 const called=[];
 let failSecond=true;
 const dependencies={db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(config,input){
   const sequenceId=input.scope.sequenceId;
   called.push(sequenceId);
   if(sequenceId==="second"&&failSecond)throw Error("temporary failure");
   return JSON.stringify({shots:[{...shot("generated","two",sequenceId),sequenceId}]});
  }};
 const chunked=createDramaRunService(dependencies);
 const failed=await chunked.submit("p",{...request,requestId:"chunked"});
 assert.equal(failed.status,"failed");
 assert.deepEqual(failed.candidate.completedSequenceIds,["first"]);
 initDramaRuns(db);
 failSecond=false;
 const restarted=createDramaRunService(dependencies);
 const resumed=await restarted.retry("p","chunked");
 assert.equal(resumed.status,"ready");
 assert.deepEqual(called,["first","second","second"]);
 assert.deepEqual(resumed.candidate.shots.map(item=>item.sequenceId),["first","second"]);
 const beforePartial=getProject(db,"p");
 const body=JSON.parse(beforePartial.document.nodes[3].metadata.dramaDraft);
 body.shots[0].description="Edited during generation";
 beforePartial.document.nodes[3].metadata.dramaDraft=JSON.stringify(body);
 saveSingleUserCanvas(db,{id:"p",expectedRevision:beforePartial.revision,document:beforePartial.document});
 const chosen=resumed.candidate.shots[0].id;
 const partial=restarted.adopt("p","chunked",[chosen]);
 assert.equal(JSON.parse(partial.document.nodes[3].metadata.dramaDraft).shots[0].description,"Edited during generation");
 assert.equal(restarted.get("p","chunked").status,"ready");
 assert.deepEqual(restarted.get("p","chunked").candidate.adoptedShotIds,[chosen]);
 assert.equal(restarted.adopt("p","chunked",[chosen]).revision,partial.revision);
 assert.throws(()=>restarted.adopt("p","chunked"),/drama_candidate_conflict/);
 let repairCalls=0;
 const repairing=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(config,input,baseline,signal,repair){
   repairCalls++;
   if(!repair)return "Malformed JSON";
   assert.equal(repair.response,"Malformed JSON");
   return JSON.stringify({shots:[{...shot("fixed","two","Fixed"),sequenceId:input.scope.sequenceId}]});
  }});
 const repaired=await repairing.submit("p",{...request,requestId:"repair",sequenceId:"second"});
 assert.equal(repaired.status,"ready");
 assert.equal(repairCalls,2);
 let invalidCalls=0;
 const invalid=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  async generate(){invalidCalls++;return "Still invalid";}});
 const beforeFailure=getProject(db,"p");
 assert.equal((await invalid.submit("p",{...request,requestId:"invalid",sequenceId:"second"})).status,"failed");
 assert.equal(invalidCalls,2);
 assert.deepEqual(getProject(db,"p"),beforeFailure);
 assert.equal((await cancellable.retry("p","cancelled-run")).status,"ready");
 assert.equal(attempts,2);
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
  content:"old",dramaDraft:"old",dramaConfirmed:"new\n",dramaConfirmedVersionId:"c",dramaStage:"source",videoRatio:"16:9",dramaFilmStyle:"paint",
  dramaConfirmedVisual:{artDirection:{},visualStyle:"paint"},
  dramaSourceParagraphs:getProject(db,"p").document.nodes[0].metadata.dramaSourceParagraphs,
  dramaInputDependencies:[],
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


test("historical media dependencies protect superseded reference revisions",t=>{
 const db=setup(t);
 createProject(db,{id:"historical-media",document:document([{id:"assets",type:"drama:assets",metadata:{}}])});
 insertTextVersions(db,"historical-media",[
  {nodeId:"assets",id:"old-media",createdAt:"now",source:"confirmation",content:"old"},
  {nodeId:"archived-board",id:"old-board",createdAt:"now",source:"confirmation",content:"board",
   provenance:{inputDependencies:[{nodeId:"assets",revisionId:"definition",mediaRevisionId:"old-media"}]}}
 ]);
 assert.throws(()=>mutateTextVersions(db,"historical-media","assets",{action:"delete",operationId:"delete-media",versionId:"old-media"},
  validateProjectDocument,emitProjectEvent),/text_version_in_use/);
 assert.equal(readTextVersions(db,"historical-media","assets","old-media").version.id,"old-media");
});


test("visual edits enter downstream dependencies only after confirmation",t=>{
 const db=setup(t);
 createProject(db,{id:"visual-publish",document:{title:"Visual",nodes:[story({dramaDraft:"Story",dramaFilmStyle:"Ink"}),
  {id:"assets",type:"drama:assets",metadata:{}}],connections:[{id:"story-assets",fromNodeId:"story",toNodeId:"assets"}]}});
 const confirm=(operationId,expectedRevision)=>mutateTextVersions(db,"visual-publish","story",
  {action:"confirm",operationId,expectedRevision},validateProjectDocument,emitProjectEvent);
 confirm("visual-original",1);
 const original=getProject(db,"visual-publish");
 const dependencies=dramaDependencies(original.document,"assets");
 original.document.nodes.find(node=>node.id==="assets").metadata.dramaInputDependencies=dependencies;
 original.document.nodes.find(node=>node.id==="story").metadata.dramaFilmStyle="Watercolor";
 saveSingleUserCanvas(db,{id:"visual-publish",expectedRevision:2,document:original.document});
 const draft=getProject(db,"visual-publish");
 assert.equal(inspectDramaDependencies(draft.document,"assets").status,"current");
 assert.equal(draft.document.nodes.find(node=>node.id==="story").metadata.dramaConfirmedVisual.visualStyle,"Ink");
 confirm("visual-updated",3);
 const published=getProject(db,"visual-publish");
 assert.equal(published.document.nodes.find(node=>node.id==="story").metadata.dramaConfirmedVisual.visualStyle,"Watercolor");
 assert.equal(inspectDramaDependencies(published.document,"assets").changes.some(change=>change.kind==="visual_updated"),true);
});


test("episode candidates preserve unrelated edits, reject same-episode conflicts and round-trip archives",async t=>{
 const db=setup(t);
 const episode=id=>({id,title:id,synopsis:"Original "+id,events:["Event"],sourceRefs:[],ending:"End"});
 const first=episode("one"),second=episode("two");
 createProject(db,{id:"episode-runs",document:{title:"Episodes",nodes:[story({dramaConfirmed:"Story",dramaConfirmedVersionId:"source-v1"}),
  {id:"episodes",type:"drama:episodes",metadata:{targetEpisodes:2,dramaDraft:JSON.stringify({episodes:[first,second]})}}],
  connections:[{id:"source-episodes",fromNodeId:"story",toNodeId:"episodes"}]}});
 let calls=0,release;
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  generate:async(config,input,baseline)=>{calls++;await new Promise(resolve=>release=resolve);
   assert.equal(input.stage,"episodes");return JSON.stringify({episodes:[{...baseline[0],synopsis:"Generated"}]});}});
 const request={requestId:"second-pass",nodeId:"episodes",episodeId:"two",channelId:"channel",provider:"openai",model:"model"};
 const pending=service.submit("episode-runs",request);
 assert.equal(service.get("episode-runs","second-pass").status,"running");
 await service.submit("episode-runs",request);
 assert.equal(calls,1);
 const changed=getProject(db,"episode-runs");
 changed.document.nodes[1].metadata.dramaDraft=JSON.stringify({episodes:[{...first,synopsis:"Human first"},second]});
 saveSingleUserCanvas(db,{id:"episode-runs",expectedRevision:1,document:changed.document});
 release();await pending;
 service.adopt("episode-runs","second-pass");
 const adopted=JSON.parse(getProject(db,"episode-runs").document.nodes[1].metadata.dramaDraft).episodes;
 assert.equal(adopted[0].synopsis,"Human first");assert.equal(adopted[1].synopsis,"Generated");assert.equal(adopted[1].id,"two");
 assert.equal(service.adopt("episode-runs","second-pass").revision,3);
 const conflicting=service.submit("episode-runs",{...request,requestId:"conflicting"});
 const human=getProject(db,"episode-runs");
 human.document.nodes[1].metadata.dramaDraft=JSON.stringify({episodes:[adopted[0],{...adopted[1],ending:"Human second"}]});
 saveSingleUserCanvas(db,{id:"episode-runs",expectedRevision:3,document:human.document});
 release();await conflicting;
 assert.throws(()=>service.adopt("episode-runs","conflicting"),/drama_candidate_conflict/);
 assert.equal(service.get("episode-runs","conflicting").status,"ready");
 const current=getProject(db,"episode-runs");
 const exported=exportDramaRuns(db,"episode-runs",current.document);
 assert.equal(exported.length,2);
 createProject(db,{id:"imported-episode-runs",document:current.document});
 importDramaRuns(db,"imported-episode-runs",current.document,exported);
 assert.deepEqual(service.get("imported-episode-runs","conflicting").candidate,service.get("episode-runs","conflicting").candidate);
});

test("initial episode planning remains a candidate until explicit adoption",async t=>{
 const db=setup(t);
 createProject(db,{id:"initial-episodes",document:{title:"Initial",nodes:[story({dramaConfirmed:"Story"}),
  {id:"episodes",type:"drama:episodes",metadata:{targetEpisodes:2}}],connections:[{id:"source-plan",fromNodeId:"story",toNodeId:"episodes"}]}});
 const episode=title=>({id:title,title,synopsis:title,events:[],sourceRefs:[],ending:"End"});
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,
  generate:async()=>JSON.stringify({episodes:[episode("First"),episode("Second")]})});
 const run=await service.submit("initial-episodes",{requestId:"initial",nodeId:"episodes",episodeId:"*",channelId:"channel",provider:"openai",model:"model"});
 assert.equal(run.status,"ready");assert.equal(getProject(db,"initial-episodes").document.nodes[1].metadata.dramaDraft,undefined);
 service.adopt("initial-episodes","initial");
 const metadata=getProject(db,"initial-episodes").document.nodes[1].metadata;
 assert.equal(JSON.parse(metadata.dramaDraft).episodes.length,2);assert.equal(metadata.dramaConfirmed,undefined);
});
