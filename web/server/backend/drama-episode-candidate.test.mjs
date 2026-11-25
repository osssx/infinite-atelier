import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import {initializeSchema} from "./schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "./projects.mjs";
import {createDramaRunService,exportDramaRuns,importDramaRuns} from "./drama-runs.mjs";
import {createProjectArchive} from "./project-archive.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {buildApp} from "./app.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {buildEpisodeOptimizeTarget,parseEpisodeOptimizeResult,buildWholeEpisodeOptimizeTarget,parseWholeEpisodeOptimizeResult} from "./drama-episode-optimize.mjs";
import {patchWholeEpisodeCandidateFields} from "./drama-episode-candidate.mjs";
import {unresolvedEventRefs} from "../drama-episode-links.mjs";
import {planEpisodeAdoption,selectEpisodeAdoption} from "./drama-episode-adoption.mjs";

const episode=id=>({id,title:id,synopsis:"Original "+id,events:["Arrival","Discovery"],
 eventItems:[{id:id+"-arrival",text:"Arrival"},{id:id+"-discovery",text:"Discovery"}],
 sourceRefs:[],ending:"End",targetDurationSec:60,sequences:[{id:id+"-scene",title:"Scene",eventRefs:[id+"-arrival"]}]});
const request=(requestId,episodeId="*")=>({requestId,nodeId:"episodes",episodeId,channelId:"channel",provider:"openai",model:"model"});
function fixture(t,{existing=true,target=3,generate}={}){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const initial=[episode("one"),episode("two"),episode("three")];
 const body=JSON.stringify({episodes:initial});
 createProject(db,{id:"p",document:{title:"Episodes",nodes:[
  {id:"story",type:"drama:source",metadata:{dramaConfirmed:"Story",dramaConfirmedVersionId:"source-v1"}},
  {id:"episodes",type:"drama:episodes",metadata:{targetEpisodes:target,...(existing?{dramaDraft:body,dramaConfirmed:body}:{})}},
  {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[]})}}
 ],connections:[{id:"source-plan",fromNodeId:"story",toNodeId:"episodes"},{id:"episode-board",fromNodeId:"episodes",toNodeId:"board"}]}});
 let calls=0;
 const generated=async(config,input,baseline,signal)=>{
  calls++;
  if(generate)return generate(config,input,baseline,signal);
  return JSON.stringify({episodes:(baseline.length?baseline.slice(0,input.targetEpisodes):initial.slice(0,input.targetEpisodes)).map(e=>({...e,synopsis:"Generated "+e.id}))});
 };
 const service=createDramaRunService({db,getProject,validateDocument:validateProjectDocument,emitEvent:emitProjectEvent,generate:generated});
 t.after(()=>db.close());
 return {db,service,initial,body,project:()=>getProject(db,"p"),calls:()=>calls};
}
const draft=p=>JSON.parse(p.document.nodes.find(n=>n.id==="episodes").metadata.dramaDraft).episodes;
const patch=(service,runId,episodeId,expectedRevision,changes)=>service.patchEpisode("p",runId,episodeId,{expectedRevision,changes});

test("scoped generation preserves existing scene IDs, order, references and event identity when model omits or invents structure",async t=>{
 let proposedScenes;
 const {service,initial,project}=fixture(t,{generate:async(config,input,baseline)=>{
  const prior=baseline[0],{sequences,eventItems,...body}=prior;
  const events=["Arrival updated","Discovery"];
  return JSON.stringify({episodes:[{...body,events,sourceRefs:["invented-source"],eventItems:events.map((text,index)=>({id:"invented-"+index,text})),
   ...(proposedScenes===undefined?{}:{sequences:proposedScenes})}]});
 }});
 const before=project();
 for(const [index,scenes] of [undefined,[],[{id:"invented-scene",title:"Wrong"}],[{id:"one-scene",title:"Renamed",sourceRefs:["wrong"],eventRefs:["one-arrival"]}]].entries()){
  proposedScenes=scenes;
  const result=await service.submit("p",request("scoped-structure-"+index,"one"));
  const next=result.candidate.episodes[0];
  assert.equal(next.id,"one");
  assert.deepEqual(next.sequences,index===3?[{...initial[0].sequences[0],title:"Renamed"}]:initial[0].sequences);
  assert.deepEqual(next.eventItems.map(item=>item.id),initial[0].eventItems.map(item=>item.id));
  assert.deepEqual(unresolvedEventRefs(next),[]);
 }
 assert.deepEqual(project(),before);
});

test("candidate editing is isolated, revisioned, bounded and preserves stable event identities",async t=>{
 const {db,service,project,calls}=fixture(t);
 const run=await service.submit("p",request("run"));
 const before=project(),frozen=db.prepare("SELECT frozen,fingerprint FROM drama_runs WHERE id='run'").get();
 assert.equal(run.candidate.revision,0);
 const one=run.candidate.episodes[0],two=run.candidate.episodes[1];
 const unchanged=patch(service,"run",one.id,0,{synopsis:one.synopsis});
 assert.equal(unchanged.candidate.revision,0);
 for(const changes of [{id:"forbidden"},{eventItems:[]},{title:" "},{targetDurationSec:0},{sequences:[{id:"s",title:"a"},{id:"s",title:"b"}]},{events:[12]}]){
  assert.throws(()=>patch(service,"run",one.id,0,changes),/drama_candidate_edit_invalid/);
 }
 const edited=patch(service,"run",one.id,0,{title:"Human title",events:["Arrival changed","Discovery"],targetDurationSec:null});
 assert.equal(edited.candidate.revision,1);
 assert.equal(edited.candidate.episodes[0].eventItems[0].id,one.eventItems[0].id);
 assert.equal(edited.candidate.episodes[0].eventItems[0].text,"Arrival changed");
 assert.deepEqual(edited.candidate.episodes[0].sequences,one.sequences);
 assert.equal(edited.candidate.episodes[0].targetDurationSec,undefined);
 assert.deepEqual(edited.candidate.episodes[1],two);
 assert.deepEqual(edited.candidate.manualChanges.editedEpisodeIds,[one.id]);
 assert.throws(()=>patch(service,"run",one.id,0,{title:"Stale"}),/drama_candidate_revision_conflict/);
 assert.throws(()=>patch(service,"run","unknown",1,{title:"Unknown"}),/drama_episode_candidate_not_found/);
 const list=service.list("p","episodes")[0];
 assert.equal(list.candidate.revision,1);assert.equal(list.candidate.episodeCount,3);
 assert.deepEqual(list.candidate.episodes,[]);assert.deepEqual(list.candidate.manualChanges,edited.candidate.manualChanges);
 assert.deepEqual(project(),before);assert.deepEqual(db.prepare("SELECT frozen,fingerprint FROM drama_runs WHERE id='run'").get(),frozen);
 assert.equal(calls(),1);
});

test("manual exclusions preserve existing draft episodes on adoption; version fence prevents stale or legacy adoption",async t=>{
 const {service,project,initial}=fixture(t);
 const run=await service.submit("p",request("run"));
 patch(service,"run","one",0,{synopsis:"Manual first"});
 const removed=service.deleteEpisode("p","run","two",1);
 assert.equal(removed.candidate.revision,2);
 assert.deepEqual(removed.candidate.episodes.map(e=>e.id),["one","three"]);
 assert.deepEqual(removed.candidate.manualChanges.removedEpisodeIds,["two"]);
 assert.equal(removed.candidate.manualChanges.originalEpisodeIds.length,3);
 assert.throws(()=>service.deleteEpisode("p","run","two",1),/drama_candidate_revision_conflict/);
 assert.throws(()=>service.adopt("p","run"),/drama_candidate_revision_required/);
 assert.throws(()=>service.adopt("p","run",undefined,1),/drama_candidate_revision_conflict/);
 assert.equal(project().revision,1);
 const confirmed=project().document.nodes[1].metadata.dramaConfirmed;
 service.adopt("p","run",undefined,2);
 assert.equal(project().revision,2);
 assert.equal(draft(project())[0].synopsis,"Manual first");
 assert.deepEqual(draft(project())[1],initial[1]);
 assert.equal(draft(project())[2].synopsis,"Generated three");
 assert.equal(project().document.nodes[1].metadata.dramaConfirmed,confirmed);
 assert.throws(()=>patch(service,run.id,"one",2,{title:"After adoption"}),/drama_candidate_not_ready/);
 assert.throws(()=>service.discard("p",run.id,2),/drama_candidate_not_discardable/);
 assert.equal(service.adopt("p",run.id,undefined,2).revision,2);
});

test("excluded newly generated episodes do not enter the draft; empty candidate is forbidden",async t=>{
 const {service,project}=fixture(t,{existing:false});
 const run=await service.submit("p",request("initial"));
 const [one,two,three]=run.candidate.episodes;
 service.deleteEpisode("p",run.id,two.id,0);
 service.deleteEpisode("p",run.id,three.id,1);
 assert.throws(()=>service.deleteEpisode("p",run.id,one.id,2),/drama_candidate_last_episode/);
 assert.equal(service.get("p",run.id).candidate.revision,2);
 service.adopt("p",run.id,undefined,2);
 assert.deepEqual(draft(project()).map(e=>e.id),[one.id]);
 assert.equal(project().document.nodes[1].metadata.targetEpisodes,3);
});

test("discard is idempotent, hidden before list limit, cannot be retried or regenerated with same request ID",async t=>{
 const {service,project,calls}=fixture(t);
 const command=request("discard");
 await service.submit("p",command);
 assert.throws(()=>service.discard("p","discard",1),/drama_candidate_revision_conflict/);
 assert.equal(service.discard("p","discard",0).status,"discarded");
 assert.equal(service.discard("p","discard",0).status,"discarded");
 assert.deepEqual(service.list("p","episodes"),[]);
 assert.equal((await service.retry("p","discard")).status,"discarded");
 assert.equal((await service.submit("p",command)).status,"discarded");
 assert.throws(()=>service.adopt("p","discard"),/drama_candidate_not_ready/);
 assert.throws(()=>patch(service,"discard","one",0,{title:"Stale"}),/drama_candidate_not_ready/);
 assert.equal(calls(),1);assert.equal(project().revision,1);
});

test("running candidates cannot be mutated or discarded; a single-episode run cannot lose its last entry",async t=>{
 let release;
 const {service}=fixture(t,{generate:async(config,input,baseline)=>{await new Promise(resolve=>release=resolve);return JSON.stringify({episodes:baseline});}});
 const pending=service.submit("p",request("running","two"));
 assert.throws(()=>service.discard("p","running",0),/drama_candidate_not_discardable/);
 assert.throws(()=>patch(service,"running","two",0,{title:"Running"}),/drama_candidate_not_ready/);
 assert.throws(()=>service.deleteEpisode("p","running","two",0),/drama_candidate_not_ready/);
 release();await pending;
 assert.throws(()=>service.deleteEpisode("p","running","two",0),/drama_candidate_last_episode/);
 assert.equal(patch(service,"running","two",0,{title:"Single"}).candidate.episodes[0].id,"two");
});

test("cancelled in-flight generation must settle before discard; late model result cannot revive a tombstone",async t=>{
 let release;
 const {service,project}=fixture(t,{generate:async(config,input,baseline)=>{await new Promise(resolve=>release=resolve);return JSON.stringify({episodes:baseline});}});
 const pending=service.submit("p",request("late"));
 assert.equal(service.cancel("p","late").status,"cancelled");
 assert.throws(()=>service.discard("p","late",0),/drama_candidate_not_discardable/);
 release();assert.equal((await pending).status,"cancelled");
 assert.equal(service.discard("p","late",0).status,"discarded");
 assert.equal(service.get("p","late").candidate,null);
 assert.equal(project().revision,1);
});

test("editing a candidate does not bypass the original frozen source and baseline checks",async t=>{
 const {service,project,db}=fixture(t);
 await service.submit("p",request("conflict"));
 patch(service,"conflict","one",0,{title:"Candidate"});
 const current=project();
 current.document.nodes[0].metadata.dramaConfirmed="Changed source";
 saveSingleUserCanvas(db,{id:"p",expectedRevision:current.revision,document:current.document});
 assert.throws(()=>service.adopt("p","conflict",undefined,1),/drama_candidate_conflict/);
 assert.equal(service.get("p","conflict").status,"ready");
});

test("ZIP roundtrip retains edits, exclusions and discarded request tombstones; legacy and tampered metadata are checked",async t=>{
 const {db,service,project}=fixture(t);
 const dir=mkdtempSync(join(tmpdir(),"atelier-episode-candidate-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80}));
 const blobStore=createBlobStore({db,dataDir:dir,maxBlobBytes:10_000_000});
 const archive=createProjectArchive({db,blobStore});
 await service.submit("p",request("edited"));
 patch(service,"edited","one",0,{title:"Human"});
 service.deleteEpisode("p","edited","two",1);
 await service.submit("p",request("discarded"));
 service.discard("p","discarded",0);
 await service.submit("p",request("legacy"));
 const legacy=service.get("p","legacy").candidate;delete legacy.revision;
 db.prepare("UPDATE drama_runs SET candidate=? WHERE project_id='p' AND id='legacy'").run(JSON.stringify(legacy));
 const zip=Buffer.concat(await Array.fromAsync((await archive.exportProject("p")).stream));
 const restored=await archive.importProject(Readable.from([zip]));
 for(const run of ["edited","discarded","legacy"])assert.deepEqual(service.get(restored.id,run),service.get("p",run));
 assert.equal(service.list(restored.id,"episodes").length,2);
 assert.equal(service.list(restored.id,"episodes").find(r=>r.id==="legacy").candidate.revision,0);
 assert.equal(service.patchEpisode(restored.id,"legacy","one",{expectedRevision:0,changes:{title:"Legacy edit"}}).candidate.revision,1);
 const exported=exportDramaRuns(db,"p",project().document);
 const edited=exported.find(r=>r.id==="edited");
 const invalids=[
  {...edited,state:"failed"},
  {...edited,candidate:{...edited.candidate,revision:null}},
  {...edited,candidate:{...edited.candidate,revision:0}},
  {...edited,candidate:{...edited.candidate,manualChanges:{...edited.candidate.manualChanges,removedEpisodeIds:[]}}},
  {...edited,candidate:{...edited.candidate,manualChanges:{...edited.candidate.manualChanges,editedEpisodeIds:["two"]}}},
  {...edited,candidate:{...edited.candidate,manualChanges:{...edited.candidate.manualChanges,originalEpisodeIds:["one","three","unknown"]}}}
 ];
 for(let i=0;i<invalids.length;i++){
  const id="invalid-"+i;createProject(db,{id,document:project().document});
  assert.throws(()=>importDramaRuns(db,id,project().document,[invalids[i]]),/archive_invalid_drama_runs/);
 }
});

test("HTTP PATCH, DELETE and adopt enforce candidate revisions, authorization and scoped payloads",async t=>{
 const {db,service,project}=fixture(t);
 await service.submit("p",request("http"));
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes"});
 t.after(()=>app.close());
 const headers={"x-test-owner":"yes"},root="/api/v1/projects/p/drama-pipeline/runs/http",url=root+"/episodes/one";
 const call=(method,path,payload)=>app.inject({method,url:path,headers,...(payload?{payload}:{})});
 assert.equal((await app.inject({method:"DELETE",url:root+"?expectedRevision=0"})).statusCode,401);
 let res=await call("PATCH",url,{expectedRevision:0,changes:{id:"bad"}});
 assert.equal(res.statusCode,422,res.body);assert.equal(res.json().code,"drama_candidate_edit_invalid");
 res=await call("PATCH",url,{expectedRevision:0,changes:{title:"HTTP edit"}});
 assert.equal(res.statusCode,200,res.body);assert.equal(res.json().candidate.revision,1);
 res=await call("DELETE",root+"/episodes/two?expectedRevision=0");
 assert.equal(res.statusCode,409,res.body);assert.equal(res.json().code,"drama_candidate_revision_conflict");
 res=await call("DELETE",root+"/episodes/two?expectedRevision=1");
 assert.equal(res.statusCode,200,res.body);assert.equal(res.json().candidate.revision,2);
 res=await call("POST",root+"/adopt",{});
 assert.equal(res.statusCode,422,res.body);assert.equal(res.json().code,"drama_candidate_revision_required");
 assert.equal(project().revision,1);
 res=await call("POST",root+"/adopt",{expectedRevision:2});
 assert.equal(res.statusCode,200,res.body);assert.equal(draft(project())[0].title,"HTTP edit");
 await service.submit("p",request("delete-http"));
 res=await call("DELETE","/api/v1/projects/p/drama-pipeline/runs/delete-http?expectedRevision=0");
 assert.equal(res.statusCode,200,res.body);assert.equal(res.json().status,"discarded");
});

const optimizeBody={expectedRevision:0,field:"synopsis",mode:"selection",draft:"人工作品：旧片段；尾部保持",selection:{start:5,end:8},
 instruction:"增强悬念，不修改前后文",channelId:"channel",provider:"openai",model:"model"};

test("optimization target uses the unsaved draft, excludes the saved field, and applies only the selected UTF-16 range",()=>{
 const ep=episode("one"),input={story:"Original story"};
 const target=buildEpisodeOptimizeTarget(optimizeBody,ep,input);
 const payload=JSON.parse(target.prompt.slice(target.prompt.lastIndexOf("\n")+1));
 assert.equal(payload.currentDraft,optimizeBody.draft);
 assert.equal(payload.selectedText,"旧片段");
 assert.equal(payload.context.synopsis,undefined);
 assert.equal(payload.context.storyExcerpt,input.story);
 assert.equal(payload.instruction,optimizeBody.instruction);
 assert.deepEqual(parseEpisodeOptimizeResult('{"replacement":"新悬念"}',target,ep),{replacement:"新悬念",value:"人工作品：新悬念；尾部保持"});
 for(const bad of ["plain","{}",'{"replacement":1}','{"replacement":" "}','{"replacement":"新","id":"bad"}','{"replacement":"x","changes":{}}']){
  assert.throws(()=>parseEpisodeOptimizeResult(bad,target,ep),/drama_episode_optimize_result_invalid/);
 }
 for(const patch of [{field:"targetDurationSec"},{mode:"field"},{selection:{start:4,end:4}},{selection:{start:0,end:100}},
  {draft:"😀测试",selection:{start:1,end:3}},{instruction:" "},{sequenceId:"one-scene"},{draft:"x".repeat(12001)}]){
  assert.throws(()=>buildEpisodeOptimizeTarget({...optimizeBody,...patch},ep,input),/drama_episode_optimize_invalid/);
 }
 const whole=buildEpisodeOptimizeTarget({...optimizeBody,mode:"field",selection:undefined,field:"events",draft:"人工事件"},ep,input);
 assert.equal(parseEpisodeOptimizeResult('{"replacement":"事件一\\n事件二"}',whole,ep).value,"事件一\n事件二");
 const scene=buildEpisodeOptimizeTarget({...optimizeBody,mode:"field",selection:undefined,field:"sequenceTitle",sequenceId:"one-scene",draft:"手动改名"},ep,input);
 assert.equal(parseEpisodeOptimizeResult('{"replacement":"新场次"}',scene,ep).value,"新场次");
 assert.throws(()=>parseEpisodeOptimizeResult('{"replacement":"标题\\n下一行"}',scene,ep),/drama_episode_optimize_result_invalid/);
 assert.throws(()=>buildEpisodeOptimizeTarget({...optimizeBody,field:"sequenceTitle",sequenceId:"missing"},ep,input),/drama_episode_optimize_invalid/);
});

test("HTTP optimize is a read-only plain model request, validates scope and output, then reuses candidate PATCH",async t=>{
 const {db,service,project}=fixture(t);
 await service.submit("p",request("ai"));
 const before=project(),saved=service.get("p","ai");
 let calls=[],answer='{"replacement":"新悬念"}';
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="yes",assistantChat:async command=>{calls.push(command);return {answer};}});
 t.after(()=>app.close());
 const root="/api/v1/projects/p/drama-pipeline/runs/ai/episodes/one",headers={"x-test-owner":"yes"};
 const optimize=(payload=optimizeBody,url=root+"/optimize")=>app.inject({method:"POST",url,headers,payload});
 assert.equal((await app.inject({method:"POST",url:root+"/optimize",payload:optimizeBody})).statusCode,401);
 for(const [payload,url,status] of [[{...optimizeBody,expectedRevision:1},undefined,409],[{...optimizeBody,instruction:" "},undefined,422],
  [optimizeBody,root.replace("/one","/missing")+"/optimize",404],[{...optimizeBody,selection:{start:9,end:2}},undefined,422]]){
  const res=await optimize(payload,url);assert.equal(res.statusCode,status,res.body);
 }
 assert.equal(calls.length,0);
 const res=await optimize();assert.equal(res.statusCode,200,res.body);
 assert.equal(res.headers["cache-control"],"no-store");
 assert.deepEqual(res.json(),{runId:"ai",episodeId:"one",revision:0,field:"synopsis",mode:"selection",start:5,end:8,replacement:"新悬念",value:"人工作品：新悬念；尾部保持"});
 assert.equal(calls.length,1);
 assert.equal(calls[0].canvasActions,false);assert.equal(calls[0].plainCanvasChat,true);assert.deepEqual(calls[0].skillTools,[]);
 assert.match(calls[0].messages[0].content,/人工作品：旧片段；尾部保持/);
 assert.deepEqual(project(),before);assert.deepEqual(service.get("p","ai"),saved);
 answer='{"replacement":"恶意越权","episodes":[]}';
 const invalid=await optimize();assert.equal(invalid.statusCode,422,invalid.body);
 assert.equal(invalid.json().code,"drama_episode_optimize_result_invalid");
 assert.deepEqual(service.get("p","ai"),saved);
 const patched=await app.inject({method:"PATCH",url:root,headers,payload:{expectedRevision:0,changes:{synopsis:res.json().value}}});
 assert.equal(patched.statusCode,200,patched.body);assert.equal(patched.json().candidate.revision,1);
 assert.equal(patched.json().candidate.episodes[0].synopsis,res.json().value);
 assert.deepEqual(project(),before);
});

test("optimization rejects duplicate concurrent requests and discards a result when candidate version changes in flight",async t=>{
 const {db,service,project}=fixture(t);
 await service.submit("p",request("ai-race"));
 let release,started;
 const entered=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve);
 let calls=0;
 const app=buildApp({db,authorize:()=>true,assistantChat:async()=>{calls++;started();await pending;return {answer:'{"replacement":"新悬念"}'};}});
 t.after(()=>app.close());
 const url="/api/v1/projects/p/drama-pipeline/runs/ai-race/episodes/one/optimize";
 const submit=()=>app.inject({method:"POST",url,payload:optimizeBody});
 const first=submit();await entered;
 try{
  const duplicate=await submit();assert.equal(duplicate.statusCode,409,duplicate.body);assert.equal(duplicate.json().code,"drama_episode_optimize_busy");
  patch(service,"ai-race","one",0,{synopsis:"另一个修改"});
 }finally{release();}
 const stale=await first;assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,"drama_candidate_revision_conflict");
 assert.equal(calls,1);assert.equal(service.get("p","ai-race").candidate.episodes[0].synopsis,"另一个修改");
 assert.equal(project().revision,1);
 const fresh=await app.inject({method:"POST",url,payload:{...optimizeBody,expectedRevision:1}});
 assert.equal(fresh.statusCode,200,fresh.body);assert.equal(calls,2);
 service.discard("p","ai-race",1);
 const discarded=await app.inject({method:"POST",url,payload:{...optimizeBody,expectedRevision:1}});
 assert.equal(discarded.statusCode,409,discarded.body);assert.equal(calls,2);
});

const wholeBody={expectedRevision:0,fields:["synopsis","events","scenePlans","ending"],draftChanges:{},
 instruction:"强化冲突",previousInstructions:[],channelId:"channel",provider:"openai",model:"model"};
const wholeChanges={synopsis:"改写梗概",events:["Arrival","New clue","Discovery"],scenePlans:[{title:"线索场次",eventIndices:[0,1]}],ending:"反转"};

test("whole optimization validates selected fields and uses latest accepted edits and bounded applied history",()=>{
 const ep=episode("one");
 const command={...wholeBody,draftChanges:{synopsis:"人工已修订"},previousInstructions:["保留主角","加深冲突"]};
 const target=buildWholeEpisodeOptimizeTarget(command,ep,{story:"Story"},{next:episode("two")});
 const payload=JSON.parse(target.prompt.slice(target.prompt.lastIndexOf("\n")+1));
 assert.equal(payload.currentEpisode.synopsis,"人工已修订");
 assert.deepEqual(payload.previousInstructions,command.previousInstructions);
 assert.equal(payload.nextEpisode.title,"two");
 assert.deepEqual(payload.currentEpisode.scenePlans,[{title:"Scene",eventIndices:[0],unresolvedCount:0}]);
 const result=parseWholeEpisodeOptimizeResult(JSON.stringify({changes:wholeChanges}),target,ep);
 assert.deepEqual(result.changes,wholeChanges);
 assert.deepEqual(result.linkedFields,["events","scenePlans"]);
 assert.ok(result.warnings.length);
 for(const changes of [{id:"new"},{title:"not allowed"},{scenePlans:[{id:"bad",title:"scene",eventIndices:[0]}]},
  {scenePlans:[]},{scenePlans:[{title:"scene",eventIndices:[99]}]},{scenePlans:[{title:"scene",eventIndices:[0,0]}]},{events:[12]}]){
  assert.throws(()=>parseWholeEpisodeOptimizeResult(JSON.stringify({changes}),target,ep),/drama_episode_optimize_result_invalid/);
 }
 assert.throws(()=>buildWholeEpisodeOptimizeTarget({...command,previousInstructions:Array(6).fill("x")},ep,{story:"Story"}),/drama_episode_optimize_invalid/);
 const local=buildEpisodeOptimizeTarget({...optimizeBody,previousInstructions:["第一次"]},ep,{story:"Story"});
 assert.deepEqual(JSON.parse(local.prompt.slice(local.prompt.lastIndexOf("\n")+1)).previousInstructions,["第一次"]);
});

test("whole patch preserves scene identity and sources, remaps new events at the final save, rejects dangling associations",()=>{
 const ep=episode("one");
 ep.sequences[0].sourceRefs=["paragraph-1"];ep.sequences[0].replaces=["old-scene"];
 assert.throws(()=>patchWholeEpisodeCandidateFields(ep,{events:["Discovery"]}),/drama_episode_optimize_relation_conflict/);
 const result=patchWholeEpisodeCandidateFields(ep,wholeChanges);
 assert.equal(result.id,ep.id);
 assert.equal(result.sequences[0].id,ep.sequences[0].id);
 assert.deepEqual(result.sequences[0].sourceRefs,["paragraph-1"]);
 assert.deepEqual(result.sequences[0].replaces,["old-scene"]);
 assert.equal(result.eventItems[0].id,ep.eventItems[0].id);
 assert.equal(result.eventItems[2].id,ep.eventItems[1].id);
 assert.deepEqual(result.sequences[0].eventRefs,[result.eventItems[0].id,result.eventItems[1].id]);
 assert.deepEqual(unresolvedEventRefs(result),[]);
 assert.throws(()=>buildWholeEpisodeOptimizeTarget({...wholeBody,fields:["events"],draftChanges:wholeChanges},ep,{story:"Story"}),/drama_episode_optimize_relation_conflict/);
 const target=buildWholeEpisodeOptimizeTarget({...wholeBody,draftChanges:wholeChanges},ep,{story:"Story"});
 assert.throws(()=>parseWholeEpisodeOptimizeResult(JSON.stringify({changes:{events:["Discovery"]}}),target,ep),/drama_episode_optimize_relation_conflict/);
});

test("whole HTTP preview and repeated rounds are read only; selected fields save atomically with CAS and link validation",async t=>{
 const {db,service,project}=fixture(t);
 const run=await service.submit("p",request("whole")),before=project();
 const prompts=[];
 let changes=wholeChanges;
 const app=buildApp({db,authorize:()=>true,assistantChat:async command=>{prompts.push(command.messages[0].content);return {answer:JSON.stringify({changes})};}});
 t.after(()=>app.close());
 const root="/api/v1/projects/p/drama-pipeline/runs/whole/episodes/one";
 const optimize=(payload=wholeBody)=>app.inject({method:"POST",url:root+"/optimize-episode",payload});
 const save=changes=>app.inject({method:"PATCH",url:root,payload:{expectedRevision:0,wholeEpisode:true,changes}});
 const preview=await optimize();assert.equal(preview.statusCode,200,preview.body);
 assert.deepEqual(preview.json().linkedFields,["events","scenePlans"]);
 assert.deepEqual(service.get("p","whole"),run);
 changes={ending:"再次优化"};
 const again=await optimize({...wholeBody,draftChanges:{synopsis:wholeChanges.synopsis},previousInstructions:["强化冲突"]});
 assert.equal(again.statusCode,200,again.body);
 const nextPrompt=JSON.parse(prompts.at(-1).slice(prompts.at(-1).lastIndexOf("\n")+1));
 assert.equal(nextPrompt.currentEpisode.synopsis,wholeChanges.synopsis);
 assert.deepEqual(nextPrompt.previousInstructions,["强化冲突"]);
 assert.deepEqual(service.get("p","whole"),run);
 const invalid=await save({events:["Discovery"],synopsis:"不能部分保存"});
 assert.equal(invalid.statusCode,422,invalid.body);assert.equal(invalid.json().code,"drama_episode_optimize_relation_conflict");
 assert.deepEqual(service.get("p","whole"),run);
 const {ending,...selected}=wholeChanges;
 const saved=await save(selected);assert.equal(saved.statusCode,200,saved.body);
 const candidate=saved.json().candidate;
 assert.equal(candidate.revision,1);assert.equal(candidate.episodes[0].ending,run.candidate.episodes[0].ending);
 assert.equal(candidate.episodes[0].synopsis,selected.synopsis);
 assert.deepEqual(unresolvedEventRefs(candidate.episodes[0]),[]);
 assert.deepEqual(candidate.episodes.slice(1),run.candidate.episodes.slice(1));
 assert.deepEqual(project(),before);
 const stale=await save({synopsis:"stale"});assert.equal(stale.statusCode,409,stale.body);
});

test("episode review differentiates explicit exclusions, actual omissions, reordered rows and downstream impact",()=>{
 const one=episode("one"),two=episode("two"),three=episode("three"),four=episode("four");
 const board={id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[
  {id:"shot-one",episodeId:"one",order:1,sequenceId:"one-scene",description:"Shot",characterVariantIds:[],propIds:[],keyPropIds:[]},
  {id:"shot-three",episodeId:"three",order:1,description:"Shot",characterVariantIds:[],propIds:[],keyPropIds:[]}
 ]})}};
 const config={id:"config",type:"config",metadata:{dramaShotId:"shot-three",dramaVideoSource:{nodeId:"board"}}};
 const document={nodes:[board,config],connections:[{fromNodeId:"episodes",toNodeId:"board"}]};
 const candidate={revision:1,episodes:[{...one,synopsis:"New",sequences:[]},four],manualChanges:{originalEpisodeIds:["two","one","four"],removedEpisodeIds:["two"]}};
 const current=[one,two,three];
 const plan=planEpisodeAdoption({document,nodeId:"episodes",scope:"*",current,baseline:current,candidate,sourceChanged:false,inputFence:{}});
 assert.deepEqual(plan.full.map(item=>item.id),["two","one","four"]);
 assert.deepEqual(plan.summary,{added:1,replaced:1,deleted:1,reordered:0,unchanged:0,preserved:1});
 assert.equal(plan.items.find(item=>item.id==="two").selectable,false);
 assert.equal(plan.items.find(item=>item.id==="one").impact.missingSceneShots,1);
 assert.equal(plan.items.find(item=>item.id==="three").impact.missingEpisodeShots,1);
 assert.equal(plan.items.find(item=>item.id==="three").impact.configs,1);
 const selected=selectEpisodeAdoption(plan,current,["one","four"]);
 assert.deepEqual(selected.map(item=>item.id),["one","four","two","three"]);
 assert.deepEqual(selected.find(item=>item.id==="two"),two);
 assert.deepEqual(selected.find(item=>item.id==="three"),three);
 assert.throws(()=>selectEpisodeAdoption(plan,current,["two"]),/drama_episode_adoption_invalid/);
 assert.deepEqual(selectEpisodeAdoption(plan,current).map(item=>item.id),["two","one","four"]);
});

test("HTTP review is read only, token fences candidate edits, selected adoption is terminal and persists audit",async t=>{
 const {db,service,project,initial}=fixture(t,{target:2});
 await service.submit("p",request("review"));
 const app=buildApp({db,authorize:()=>true});t.after(()=>app.close());
 const root="/api/v1/projects/p/drama-pipeline/runs/review";
 const before=project();
 const preview=async()=>{const res=await app.inject({method:"GET",url:root+"/preview"});assert.equal(res.statusCode,200,res.body);return res.json();};
 const adopt=payload=>app.inject({method:"POST",url:root+"/adopt",payload});
 const first=await preview();
 assert.equal(first.summary.deleted,1);assert.equal(first.summary.replaced,2);
 assert.deepEqual(project(),before);
 assert.equal((await adopt({episodeIds:["one"],expectedRevision:0})).statusCode,409);
 patch(service,"review","one",0,{title:"Reviewed title"});
 assert.equal((await adopt({episodeIds:["one"],expectedRevision:1,reviewToken:first.reviewToken})).statusCode,409);
 const second=await preview();
 const command={episodeIds:["one"],expectedRevision:1,reviewToken:second.reviewToken};
 assert.equal((await adopt({...command,episodeIds:["unknown"]})).statusCode,422);
 assert.equal((await adopt(command)).statusCode,200);
 assert.equal(draft(project())[0].title,"Reviewed title");
 assert.deepEqual(draft(project()).slice(1),initial.slice(1));
 assert.equal(project().document.nodes[1].metadata.dramaConfirmed,before.document.nodes[1].metadata.dramaConfirmed);
 assert.equal(service.get("p","review").status,"adopted");
 assert.deepEqual(service.get("p","review").candidate.adoption,{mode:"selected",episodeIds:["one"],appliedEpisodeIds:["one"],reviewToken:second.reviewToken});
 const revision=project().revision;
 assert.equal((await adopt(command)).statusCode,200);assert.equal(project().revision,revision);
 assert.equal((await adopt({...command,episodeIds:["two"]})).statusCode,409);
 const archive=exportDramaRuns(db,"p",project().document);
 createProject(db,{id:"restore-review",document:project().document});importDramaRuns(db,"restore-review",project().document,archive);
 assert.deepEqual(service.get("restore-review","review"),service.get("p","review"));
 createProject(db,{id:"bad-review",document:project().document});
 assert.throws(()=>importDramaRuns(db,"bad-review",project().document,[{...archive[0],state:"ready"}]),/archive_invalid_drama_runs/);
});

test("review blocks newly dangling events; selected unaffected row remains adoptable",async t=>{
 const {service,project}=fixture(t);
 await service.submit("p",request("relations"));
 patch(service,"relations","one",0,{events:["Discovery"]});
 const review=service.preview("p","relations");
 assert.equal(review.fullAdoptBlocked,true);
 assert.equal(review.items.find(item=>item.id==="one").blocked,true);
 assert.throws(()=>service.adopt("p","relations",undefined,1,undefined,review.reviewToken),/drama_episode_adoption_invalid/);
 assert.throws(()=>service.adopt("p","relations",undefined,1,["one"],review.reviewToken),/drama_episode_adoption_invalid/);
 service.adopt("p","relations",undefined,1,["two"],review.reviewToken);
 assert.equal(draft(project())[0].synopsis,"Original one");
 assert.equal(draft(project())[1].synopsis,"Generated two");
});

test("P6 optimization recovers from actual assistant transport timeout, network rejection and invalid JSON without writes",async t=>{
 const {db,service,project}=fixture(t);
 const run=await service.submit("p",request("faults")),before=project();
 let scenario="timeout",calls=0;
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"fixture"}),withSecretVersion:(_,consume)=>consume(Buffer.from("test-only"))};
 const assistantChat=createAssistantChatService({vault,maxRetries:0,requestTimeoutMs:30,retryDelayMs:0,
  compatibleUpstreamCall:async(_url,{signal})=>{
   calls++;
   if(scenario==="timeout")return new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(Error("test_deadline_missing")),500);
    signal.addEventListener("abort",()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
   });
   if(scenario==="network")throw Error("synthetic_network_failure");
   return Response.json({choices:[{message:{content:scenario==="malformed"?"not JSON":'{"replacement":"恢复后的建议"}'}}]});
  }});
 const app=buildApp({db,authorize:()=>true,assistantChat});t.after(()=>app.close());
 const root="/api/v1/projects/p/drama-pipeline/runs/faults/episodes/one/optimize";
 const payload={...optimizeBody,provider:"openai_compatible",baseUrl:"https://example.com/v1"};
 for(const [mode,status,code] of [["timeout",504,"assistant_upstream_retry_exhausted"],["network",502,"assistant_upstream_unavailable"],["malformed",422,"drama_episode_optimize_result_invalid"],["success",200,null]]){
  scenario=mode;
  const res=await app.inject({method:"POST",url:root,payload});
  assert.equal(res.statusCode,status,res.body);
  if(code)assert.equal(res.json().code,code);
  else assert.equal(res.json().replacement,"恢复后的建议");
  assert.deepEqual(service.get("p","faults"),run);
  assert.deepEqual(project(),before);
 }
 assert.equal(calls,4);
});

test("review token fences changed downstream associations and changed source revision, not unrelated canvas edits",async t=>{
 const {db,service,project}=fixture(t);
 const save=mutate=>{
  const current=project();mutate(current.document);
  saveSingleUserCanvas(db,{id:"p",expectedRevision:current.revision,document:current.document});
 };
 await service.submit("p",request("fenced"));
 const initial=service.preview("p","fenced");
 save(doc=>{doc.title="Unrelated canvas rename";});
 assert.equal(service.preview("p","fenced").reviewToken,initial.reviewToken);
 save(doc=>{doc.nodes.find(n=>n.id==="board").metadata.dramaDraft=JSON.stringify({shots:[{
  id:"one-shot",episodeId:"one",order:1,sequenceId:"one-scene",description:"Shot",characterVariantIds:[],propIds:[],keyPropIds:[]
 }]});});
 const changed=service.preview("p","fenced");
 assert.notEqual(changed.reviewToken,initial.reviewToken);
 assert.equal(changed.items.find(item=>item.id==="one").impact.shots,1);
 assert.throws(()=>service.adopt("p","fenced",undefined,0,["one"],initial.reviewToken),/drama_episode_review_conflict/);
 save(doc=>{doc.nodes.find(n=>n.id==="story").metadata.dramaConfirmedVersionId="source-v2";});
 assert.equal(service.preview("p","fenced").sourceChanged,true);
 assert.throws(()=>service.adopt("p","fenced",undefined,0),/drama_candidate_conflict/);
 assert.equal(service.get("p","fenced").status,"ready");
 await service.submit("p",request("baseline"));
 save(doc=>{const node=doc.nodes.find(n=>n.id==="episodes");const draft=JSON.parse(node.metadata.dramaDraft);
  draft.episodes[1].synopsis="Unrelated human draft edit";node.metadata.dramaDraft=JSON.stringify(draft);});
 const conflicted=service.preview("p","baseline");
 assert.equal(conflicted.baselineChanged,true);
 assert.throws(()=>service.adopt("p","baseline",undefined,0,["one"],conflicted.reviewToken),/drama_candidate_conflict/);
 await service.submit("p",request("scoped","one"));
 const scoped=service.preview("p","scoped");
 assert.deepEqual(scoped.items.map(item=>item.id),["one"]);
 service.adopt("p","scoped",undefined,0,undefined,scoped.reviewToken);
 assert.equal(draft(project())[1].synopsis,"Unrelated human draft edit");
});
