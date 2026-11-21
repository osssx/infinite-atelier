/** P1 online acceptance against current source without touching the running backend.
 * Read only the configured model channel and encrypted credential from the existing
 * user dataset. All project/ZIP/CAS writes occur in a disposable in-memory/temp store.
 * At most two provider requests (one generation plus one semantic repair); NO retry.
 */
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {loadBackendEnv} from "./load-backend-env.mjs";
import {openP49CReadonlyConfiguredChannel} from "./p49c-configured-channel-live.mjs";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "../server/backend/projects.mjs";
import {mutateTextVersions,readTextVersions} from "../server/backend/canvas-text-versions.mjs";
import {createBlobStore} from "../server/backend/blob-store.mjs";
import {createProjectArchive} from "../server/backend/project-archive.mjs";
import {stableJson} from "../server/backend/repository.mjs";
import {createCredentialVault} from "../server/backend/credential-vault.mjs";
import {createWindowsDpapiProtector} from "../server/backend/credential-protection.mjs";
import {createPinnedOpenAiCompatCall} from "../server/backend/openai-compat-endpoints.mjs";
import {createAssistantChatService} from "../server/backend/assistant-chat.mjs";
import {buildApp} from "../server/backend/app.mjs";

const mode=process.argv.slice(2).join(" ");
if(!["--probe","--ack-cost"].includes(mode))throw Error("usage: --probe or --ack-cost");
if(process.platform!=="win32")throw Error("Windows DPAPI required");
loadBackendEnv();
const {db:source,selected}=openP49CReadonlyConfiguredChannel();
const report={mode,provider:selected.provider,model:selected.model,sourceDatabase:"read-only",
 projectStorage:"isolated ephemeral",providerPosts:0,requestLimit:2,automaticNetworkRetries:0,
 status:"not_started",archive:"not_started"};
let db,app,root;
const ensure=(condition,code)=>{if(!condition)throw Object.assign(Error(code),{code})};
try{
 const vault=createCredentialVault({db:source,protector:createWindowsDpapiProtector()});
 const channel=vault.get(selected.channelId);
 ensure(channel.hasKey&&channel.keyVersion,"selected_channel_missing");
 report.credentialPresent=true;
 if(mode==="--probe"){report.status="ready";console.log("P1_ISOLATED_LIVE "+JSON.stringify(report));}
 else{
  root=mkdtempSync(join(tmpdir(),"infinite-atelier-p1-isolated-live-"));
  db=new DatabaseSync(":memory:");initializeSchema(db);
  const blobStore=createBlobStore({db,dataDir:root,maxBlobBytes:10_000_000});
  const archive=createProjectArchive({db,blobStore});
  const upstream=createPinnedOpenAiCompatCall();
  const guarded=(url,options)=>{
   ensure(report.providerPosts<2,"online_provider_post_cap_reached");
   report.providerPosts++;
   return upstream(url,options);
  };
  const assistantChat=createAssistantChatService({
   vault,compatibleUpstreamCall:guarded,maxRetries:0,requestTimeoutMs:90000,retryDelayMs:0,
  });
  app=buildApp({db,authorize:req=>req.headers["x-p1-owner"]==="isolated",
   blobStore,projectArchive:archive,assistantChat});
  const projectId="p1-isolated-live-"+randomUUID();
  const e1={id:"shot-one",episodeId:"ep-one",order:1,description:"第一集：小兔在森林发现星星",
   characterVariantIds:["hero-day"],sceneId:"home",sceneVariantId:"home-day",propIds:[],keyPropIds:[]};
  const e2={...e1,id:"shot-two",episodeId:"ep-two",description:"第二集：小兔把星星带回家"};
  const assetPlan={assets:[
   {id:"hero",kind:"character",name:"小兔",description:"白色小兔，穿蓝色斗篷",sourceRefs:[],
    variants:[{id:"hero-day",name:"日常",description:"白毛蓝色斗篷"}]},
   {id:"home",kind:"scene",name:"森林木屋",description:"森林里的温馨木屋",sourceRefs:[],
    variants:[{id:"home-day",name:"白天",description:"阳光清澈"}]},
  ]};
  const episodic={episodes:[
   {id:"ep-one",title:"发现星星",synopsis:"发现遗失星星",events:["主角出门","在森林发现一颗星星"],sourceRefs:[],ending:"决定送回"},
   {id:"ep-two",title:"星星归家",synopsis:"主角带星星回到家",events:["主角穿过森林","把星星送回家"],sourceRefs:[],ending:"小兔和妈妈团聚"},
  ]};
  const story="儿童动画：第一集，一只穿蓝色斗篷的白色小兔从森林木屋出发，在林间发现遗失的星星。第二集，小兔带着星星穿过森林，返回木屋，将星星交给兔妈妈，和妈妈团聚。";
  const nodes=[
   {id:"story",type:"drama:source",metadata:{content:story,dramaDraft:story}},
   {id:"assets",type:"drama:assets",metadata:{dramaDraft:JSON.stringify(assetPlan)}},
   {id:"episodes",type:"drama:episodes",metadata:{dramaDraft:JSON.stringify(episodic)}},
   {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[e1,e2]})}},
  ];
  const connections=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
   .map(([fromNodeId,toNodeId],i)=>({id:"link-"+i,fromNodeId,toNodeId}));
  createProject(db,{id:projectId,document:{title:"P1 isolated live",nodes,connections}});
  for(const id of ["story","assets","episodes","board"]){
   const revision=getProject(db,projectId).revision;
   mutateTextVersions(db,projectId,id,{action:"confirm",operationId:id+"-v1",expectedRevision:revision},
    validateProjectDocument,emitProjectEvent);
  }
  // Only synthetic test media, to validate old Config and its CAS archive links.
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ywoAAAAASUVORK5CYII=","base64");
  const blob=await blobStore.put([png],{mime:"image/png"}),imageKey="cas:"+blob.blobId;
  const before=getProject(db,projectId);
  const legacy={id:"legacy-image",type:"image",metadata:{storageKey:imageKey,content:"/api/v1/blobs/"+blob.blobId}};
  const config={id:"first-config",type:"config",metadata:{
   generationMode:"video",dramaShotId:e1.id,dramaVideoSource:{
    nodeId:"board",revisionId:"board-v1",shot:JSON.stringify(e1),
    referenceKeys:[imageKey],prompt:"人工保留：第一集原始提示词",basePrompt:e1.description,
   },prompt:"人工保留：第一集原始提示词",composerContent:"人工保留：第一集原始提示词",
   seconds:"9",videoRatio:"4:3",videoMode:"first_frame",model:"manual-config",
   videoReferences:[{id:"legacy-image",kind:"image",role:"first_frame"}],
  }};
  before.document.nodes.push(legacy,config);
  before.document.connections.push(
   {id:"board-config",fromNodeId:"board",toNodeId:"first-config"},
   {id:"image-config",fromNodeId:"legacy-image",toNodeId:"first-config"},
  );
  saveSingleUserCanvas(db,{id:projectId,expectedRevision:before.revision,document:before.document});
  const original=getProject(db,projectId);
  const configBefore=JSON.stringify(original.document.nodes.find(n=>n.id==="first-config"));
  const edgesBefore=JSON.stringify(original.document.connections.filter(e=>e.toNodeId==="first-config"));
  const request={requestId:"isolated-"+randomUUID(),nodeId:"board",episodeId:"ep-two",
   channelId:selected.channelId,provider:selected.provider,model:selected.model,baseUrl:selected.baseUrl};
  const start=Date.now();
  const result=await app.inject({method:"POST",url:"/api/v1/projects/"+projectId+"/drama-pipeline/runs",
   headers:{"x-p1-owner":"isolated"},payload:request});
  report.elapsedMs=Date.now()-start;
  report.httpStatus=result.statusCode;
  const run=result.json();
  report.status=run.status??"http_error";
  report.errorCode=run.error??run.code??null;
  report.candidateCount=run.candidate?.shots?.length??0;
  report.candidateValid=report.status==="ready"&&report.candidateCount>0&&
   run.candidate.shots.every(shot=>shot.episodeId==="ep-two"&&shot.description.length>0);
  if(report.candidateValid){
   const applied=await app.inject({method:"POST",
    url:"/api/v1/projects/"+projectId+"/drama-pipeline/runs/"+encodeURIComponent(run.id)+"/adopt",
    headers:{"x-p1-owner":"isolated"},payload:{}});
   report.adoptStatus=applied.statusCode;
   if(applied.statusCode===200){
    const next=getProject(db,projectId),node=id=>next.document.nodes.find(n=>n.id===id);
    const shots=JSON.parse(node("board").metadata.dramaDraft).shots;
    report.firstEpisodePreserved=shots.some(shot=>shot.id===e1.id&&stableJson(shot)===stableJson(e1));
    report.secondEpisodeReplaced=shots.some(shot=>shot.episodeId==="ep-two"&&shot.description!==e2.description);
    report.configPreserved=JSON.stringify(node("first-config"))===configBefore;
    report.configLinksPreserved=JSON.stringify(next.document.connections.filter(e=>e.toNodeId==="first-config"))===edgesBefore;
    if(report.firstEpisodePreserved&&report.configPreserved&&report.configLinksPreserved){
     mutateTextVersions(db,projectId,"board",{
      action:"confirm",operationId:"board-v2",expectedRevision:next.revision,
     },validateProjectDocument,emitProjectEvent);
     const current=getProject(db,projectId);
     report.confirmedRevision=current.document.nodes.find(n=>n.id==="board").metadata.dramaConfirmedVersionId;
     report.confirmedVersions=readTextVersions(db,projectId,"board").versions.filter(v=>v.source==="confirmation").length;
     const exported=await archive.exportProject(projectId);
     const chunks=[];for await(const chunk of exported.stream)chunks.push(chunk);
     const zip=Buffer.concat(chunks);
     report.zipBytes=zip.length;
     const imported=await archive.importProject(Readable.from([zip]));
     const restored=getProject(db,imported.id);
     report.archive=(restored.document.nodes.find(n=>n.id==="first-config")?.metadata?.prompt===
      config.metadata.prompt&&
      restored.document.nodes.find(n=>n.id==="board")?.metadata?.dramaConfirmedVersionId==="board-v2"&&
      readTextVersions(db,imported.id,"board").versions.filter(v=>v.source==="confirmation").length===2)
      ?"passed":"failed";
    }
   }
  }
  report.success=report.status==="ready"&&report.candidateValid&&
   report.adoptStatus===200&&report.firstEpisodePreserved&&report.secondEpisodeReplaced&&
   report.configPreserved&&report.configLinksPreserved&&report.confirmedRevision==="board-v2"&&
   report.confirmedVersions===2&&report.providerPosts>=1&&report.providerPosts<=2&&
   report.archive==="passed";
  console.log("P1_ISOLATED_LIVE "+JSON.stringify(report));
  if(!report.success)process.exitCode=1;
 }
}catch(error){
 report.status="error";
 report.errorCode=String(error?.code||error?.message||"unknown").slice(0,140);
 console.log("P1_ISOLATED_LIVE "+JSON.stringify(report));
 process.exitCode=1;
}finally{
 try{await app?.close()}catch{}
 try{db?.close()}catch{}
 try{source.close()}catch{}
 if(root)try{rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100})}catch{}
}
