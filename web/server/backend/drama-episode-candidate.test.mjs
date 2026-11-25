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
