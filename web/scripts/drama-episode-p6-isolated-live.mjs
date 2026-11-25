/** P6 real-channel acceptance. Synthetic story only; original dataset read-only.
 * --ack-cost allows <=7 actual POSTs (generation with one possible repair,
 * two local proposals, one cancelled request, two whole-episode proposals).
 * No automatic network retries. Logs contain no provider bodies or credentials.
 */
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Readable} from "node:stream";
import {loadBackendEnv} from "./load-backend-env.mjs";
import {openP49CReadonlyConfiguredChannel} from "./p49c-configured-channel-live.mjs";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject,validateProjectDocument,emitProjectEvent} from "../server/backend/projects.mjs";
import {mutateTextVersions,readTextVersions} from "../server/backend/canvas-text-versions.mjs";
import {createBlobStore} from "../server/backend/blob-store.mjs";
import {createProjectArchive} from "../server/backend/project-archive.mjs";
import {createCredentialVault} from "../server/backend/credential-vault.mjs";
import {createWindowsDpapiProtector} from "../server/backend/credential-protection.mjs";
import {createPinnedOpenAiCompatCall} from "../server/backend/openai-compat-endpoints.mjs";
import {createAssistantChatService} from "../server/backend/assistant-chat.mjs";
import {buildApp} from "../server/backend/app.mjs";
import {previewDramaImpact} from "../server/backend/drama-impact.mjs";
import {unresolvedEventRefs} from "../server/drama-episode-links.mjs";
import {stableJson} from "../server/backend/repository.mjs";

const mode=process.argv.slice(2).join(" ");
if(!["--probe","--ack-cost","--ack-cost --generation-only"].includes(mode))throw Error("usage: --probe or --ack-cost [--generation-only]");
const generationOnly=mode.endsWith("--generation-only");
const report={mode,providerPosts:0,requestLimit:generationOnly?1:7,automaticNetworkRetries:0,checks:[],requests:[],success:false};
let source,db,app,root,stage="probe",cancelStarted,cancelSettled;
const check=(condition,name)=>{if(!condition)throw Object.assign(Error(name),{code:name});report.checks.push(name);};
const eq=(actual,expected,name)=>check(stableJson(actual)===stableJson(expected),name);
try{
 loadBackendEnv();
 const channel=openP49CReadonlyConfiguredChannel();source=channel.db;
 const selected=channel.selected;
 report.provider=selected.provider;report.model=selected.model;
 const vault=createCredentialVault({db:source,protector:createWindowsDpapiProtector()});
 check(vault.get(selected.channelId).hasKey,"credential_available");
 if(mode==="--probe"){report.success=true;}
 else{
  root=mkdtempSync(join(tmpdir(),"atelier-episode-p6-live-"));
  db=new DatabaseSync(":memory:");initializeSchema(db);
  const blobStore=createBlobStore({db,dataDir:root,maxBlobBytes:10_000_000}),archive=createProjectArchive({db,blobStore});
  const upstream=createPinnedOpenAiCompatCall();
  const guarded=async(url,options)=>{
   if(report.providerPosts>=report.requestLimit)throw Error("p6_online_cap_reached");
   report.providerPosts++;
   const entry={stage,elapsedMs:0,httpStatus:null,aborted:false};report.requests.push(entry);
   const start=Date.now();
   if(stage==="cancel")cancelStarted?.();
   try{const response=await upstream(url,options);entry.httpStatus=response.status;return response;}
   finally{entry.elapsedMs=Date.now()-start;entry.aborted=options.signal?.aborted===true;if(entry.stage==="cancel")cancelSettled?.();}
  };
  const ask=createAssistantChatService({vault,compatibleUpstreamCall:guarded,maxRetries:0,requestTimeoutMs:90000,retryDelayMs:0});
  app=buildApp({db,authorize:req=>req.headers["x-p6-owner"]==="isolated",blobStore,projectArchive:archive,assistantChat:ask});
  const id="p6",story="小兔在森林里发现一颗遗失的星星，决定把它送回家。\n第二天，小兔将星星交给兔妈妈，两人一起把星星送回天空。";
  const events=["小兔走进森林","小兔发现星星并决定送回"];
  const ep1={id:"ep-one",title:"发现星星",synopsis:"小兔发现遗失星星。",events,eventItems:events.map((text,i)=>({id:"event-one-"+i,text})),
   sourceRefs:["paragraph-one"],ending:"小兔决定送回星星。",targetDurationSec:60,sequences:[{id:"scene-one",title:"森林发现",sourceRefs:["paragraph-one"],eventRefs:["event-one-0","event-one-1"]}]};
  const ep2={id:"ep-two",title:"星星归家",synopsis:"小兔与妈妈一起送星星回天空。",events:["小兔回家"],sourceRefs:["paragraph-two"],ending:"星星回到天空。"};
  const shots=[{id:"shot-one",episodeId:"ep-one",sequenceId:"scene-one",order:1,description:"小兔在森林发现星星",characterVariantIds:[],propIds:[],keyPropIds:[]},
   {id:"shot-two",episodeId:"ep-two",order:1,description:"小兔回到家",characterVariantIds:[],propIds:[],keyPropIds:[]}];
  const nodes=[
   {id:"story",type:"drama:source",metadata:{content:story,dramaDraft:story,dramaSourceParagraphs:story.split("\n").map((text,i)=>({id:i?"paragraph-two":"paragraph-one",text,line:i+1,status:"located"}))}},
   {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify({assets:[]})}},
   {id:"episodes",type:"drama:episodes",metadata:{targetEpisodes:2,dramaDraft:JSON.stringify({episodes:[ep1,ep2]})}},
   {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots})}},
   {id:"config-one",type:"config",metadata:{dramaShotId:"shot-one",dramaVideoSource:{nodeId:"board",revisionId:"board-v1"},prompt:"人工保留配置"}}
  ];
  const connections=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"],["board","config-one"]].map(([fromNodeId,toNodeId],i)=>({id:"link-"+i,fromNodeId,toNodeId}));
  createProject(db,{id,document:{title:"P6 synthetic isolated",nodes,connections}});
  const project=()=>getProject(db,id);
  const node=(n,p=project())=>p.document.nodes.find(item=>item.id===n);
  const confirm=(n,v)=>mutateTextVersions(db,id,n,{action:"confirm",operationId:v,expectedRevision:project().revision},validateProjectDocument,emitProjectEvent);
  for(const n of ["story","assets","episodes","board"])confirm(n,n+"-v1");
  const before=project(),original=JSON.parse(node("episodes",before).metadata.dramaDraft).episodes;
  const config={channelId:selected.channelId,provider:selected.provider,model:selected.model,baseUrl:selected.baseUrl};
  const headers={"x-p6-owner":"isolated"};
  const base="/api/v1/projects/"+id+"/drama-pipeline",runPath=base+"/runs/live-episode",entryPath=runPath+"/episodes/ep-one";
  const call=async(method,url,payload,expected=200)=>{
   const res=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
   if(res.statusCode!==expected){const data=res.json();throw Object.assign(Error("http_"+res.statusCode),{code:data.code??"http_"+res.statusCode});}
   return res.json();
  };
  const read=()=>call("GET",runPath),patch=(revision,changes,wholeEpisode=false)=>call("PATCH",entryPath,{expectedRevision:revision,changes,wholeEpisode});
  stage="generation";
  let run=await call("POST",base+"/runs",{requestId:"live-episode",nodeId:"episodes",episodeId:"ep-one",...config});
  report.generationStatus=run.status;report.generationError=run.error??null;
  check(run.status==="ready"&&run.candidate.episodes.length===1&&run.candidate.episodes[0].id==="ep-one","real_generation_ready");
  eq(project(),before,"generation_read_only");
  // Explicit human structure review after generation. Keep original scene ID,
  // source range, and link using generated event identities (not model IDs).
  const generated=run.candidate.episodes[0];
  check(generated.events.length>0,"generated_events");
  report.generatedSceneCount=generated.sequences?.length??0;
  report.generatedSceneIdentityPreserved=generated.sequences?.some(item=>item.id==="scene-one")??false;
  if(generationOnly){
   check(report.generatedSceneCount===1&&report.generatedSceneIdentityPreserved,"scoped_generated_scene_preserved");
   eq(generated.sourceRefs,original[0].sourceRefs,"scoped_generated_source_range_preserved");
   report.unresolvedEventRefs=unresolvedEventRefs(generated).length;
   report.success=true;
  }else{
  run=await patch(0,{sourceRefs:["paragraph-one"],sequences:[{id:"scene-one",title:"森林发现",sourceRefs:["paragraph-one"],eventRefs:generated.eventItems.map(item=>item.id)}]});
  const saved=run,revision=run.candidate.revision;
  const local=async(draft,selection,instruction,previousInstructions=[])=>call("POST",entryPath+"/optimize",{...config,expectedRevision:revision,field:"synopsis",mode:"selection",draft,selection,instruction,previousInstructions});
  stage="local-1";
  const draft="小兔来到森林。发现一颗星星。它决定送星星回家。",selection={start:7,end:14};
  // Derive exact selection so the UTF-16 boundary is checked, not guessed.
  selection.start=draft.indexOf("发现一颗星星");selection.end=selection.start+"发现一颗星星".length;
  const instruction="将选中片段改写为更有童趣的短句，明确写出星星发出金色微光，不要加入新人物，不要重复前后文。";
  const one=await local(draft,selection,instruction);
  check(one.value===draft.slice(0,selection.start)+one.replacement+draft.slice(selection.end)&&one.replacement.includes("星星"),"real_local_exact_splice");
  report.localFirstCharacters=one.replacement.length;
  stage="local-2";
  const two=await local(one.value,{start:selection.start,end:selection.start+one.replacement.length},"把选区内文字缩短为不超过18个汉字的句子，保留星星和微光。",[instruction]);
  check(two.value===one.value.slice(0,selection.start)+two.replacement+one.value.slice(selection.start+one.replacement.length),"real_local_second_splice");
  report.localSecondCharacters=two.replacement.length;report.localSecondMentionsStar=two.replacement.includes("星星");
  eq(await read(),saved,"local_rounds_read_only");
  run=await patch(revision,{synopsis:two.value});
  // Actual loopback client disconnect after the real provider call begins.
  stage="cancel";
  const entered=new Promise(resolve=>cancelStarted=resolve),settled=new Promise(resolve=>cancelSettled=resolve);
  const address=await app.listen({host:"127.0.0.1",port:0});
  const aborter=new AbortController();
  const pending=fetch(address+entryPath+"/optimize",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({...config,expectedRevision:run.candidate.revision,field:"ending",mode:"field",draft:"小兔决定送星星回家。",instruction:"优化这句话。"}),signal:aborter.signal}).then(()=>false,error=>error.name==="AbortError");
  const wait=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("p6_cancel_wait_timeout")),ms);})]).finally(()=>clearTimeout(timer));};
  await wait(entered,10000);aborter.abort();
  check(await pending,"real_http_client_cancelled");
  await wait(settled,15000);
  check(report.requests.at(-1).aborted,"real_provider_transport_abort");
  // Allow route finally to release the per-run guard.
  await new Promise(resolve=>setTimeout(resolve,100));
  eq(await read(),run,"cancel_read_only");
  const whole=(draftChanges,instruction,previousInstructions)=>call("POST",entryPath+"/optimize-episode",{...config,expectedRevision:run.candidate.revision,
   fields:["synopsis","events","scenePlans","ending"],draftChanges,instruction,previousInstructions});
  stage="whole-1";
  const firstInstruction="优化整集。梗概增加星星微光；将剧情事件写成恰好两条：小兔走进森林，小兔发现星星并决定送回。场次规划保留一个场次，名称为森林寻星，关联最终事件0和1。结尾体现小兔决定送星星回家。输出 changes，必须包含 events、scenePlans、synopsis、ending。";
  const first=await whole({},firstInstruction,[]);
  check(first.changes.events?.length===2&&first.changes.scenePlans?.length===1&&first.linkedFields.includes("events")&&first.linkedFields.includes("scenePlans"),"real_whole_linked_proposal");
  // Accept linked fields and synopsis; explicitly reject the first ending.
  const {ending:rejected,...accepted}=first.changes;
  stage="whole-2";
  const next=await whole(accepted,"只修改本集结尾：小兔捧着星星，期待明天与妈妈一起把星星送回天空。不要修改其它字段。",[firstInstruction]);
  check(typeof next.changes.ending==="string"&&next.changes.ending.trim(),"real_whole_second_proposal");
  eq(await read(),run,"whole_rounds_read_only");
  const changed={...accepted,ending:next.changes.ending};
  stage="save";
  const priorRevision=run.candidate.revision;
  run=await patch(priorRevision,changed,true);
  check(run.candidate.revision===priorRevision+1,"whole_atomic_revision");
  const edited=run.candidate.episodes[0];
  check(edited.sequences[0].id==="scene-one"&&!unresolvedEventRefs(edited).length,"stable_scene_and_event_refs");
  eq(project(),before,"all_candidate_writes_isolated");
  const review=await call("GET",runPath+"/preview");
  check(!review.fullAdoptBlocked&&review.items[0].impact.shots===1&&review.items[0].impact.configs===1,"review_impact");
  stage="adopt";
  await call("POST",runPath+"/adopt",{expectedRevision:run.candidate.revision,episodeIds:["ep-one"],reviewToken:review.reviewToken});
  eq(JSON.parse(node("episodes").metadata.dramaDraft).episodes[1],original[1],"unselected_episode_preserved");
  eq(node("episodes").metadata.dramaConfirmed,node("episodes",before).metadata.dramaConfirmed,"adopt_not_confirm");
  eq(node("board"),node("board",before),"board_unchanged_after_adopt");
  eq(node("config-one"),node("config-one",before),"config_unchanged_after_adopt");
  confirm("episodes","episodes-v2");
  const confirmed=JSON.parse(node("episodes").metadata.dramaConfirmed).episodes[0];
  eq(confirmed,edited,"confirm_preserves_candidate_identities");
  const impact=previewDramaImpact(project().document,"board");
  check(impact.status==="stale"&&impact.impact.shotIds.includes("shot-one")&&!impact.impact.shotIds.includes("shot-two"),"confirmed_downstream_impact");
  eq(node("board"),node("board",before),"board_not_mutated_after_confirm");
  eq(node("config-one"),node("config-one",before),"config_not_mutated_after_confirm");
  const adopted=await read();
  const exported=await archive.exportProject(id),zip=Buffer.concat(await Array.fromAsync(exported.stream));
  const restored=await archive.importProject(Readable.from([zip]));
  const recovered=await call("GET","/api/v1/projects/"+restored.id+"/drama-pipeline/runs/live-episode");
  eq(recovered,adopted,"zip_candidate_and_adoption");
  const restoredProject=getProject(db,restored.id);
  eq(node("episodes",restoredProject).metadata.dramaConfirmed,node("episodes").metadata.dramaConfirmed,"zip_confirmed_content");
  check(readTextVersions(db,restored.id,"episodes").versions.filter(item=>item.source==="confirmation").length===2,"zip_confirmed_history");
  eq(node("config-one",restoredProject).metadata.prompt,node("config-one").metadata.prompt,"zip_config");
  report.zipBytes=zip.length;report.finalCandidateRevision=run.candidate.revision;report.success=true;
  }
 }
}catch(error){report.failedStage=stage;report.errorCode=typeof error?.code==="string"&&/^[a-zA-Z0-9_]{1,100}$/.test(error.code)?error.code:typeof error?.message==="string"&&/^[a-zA-Z0-9_]{1,100}$/.test(error.message)?error.message:"p6_assertion_or_unexpected_error";process.exitCode=1;}
finally{
 try{await app?.close()}catch{}
 try{db?.close()}catch{}
 try{source?.close()}catch{}
 if(root)try{rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100})}catch{}
 console.log("EPISODE_P6_LIVE "+JSON.stringify(report));
}
