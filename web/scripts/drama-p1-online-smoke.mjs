/* Isolated live P1 smoke: one app request, temporary project, automatic cleanup.
   User data is not read. No credentials or complete model output are logged.
   The backend may make one structural-repair model call if JSON is malformed. */
import {randomUUID} from "node:crypto";
import {readStoryboardDraft} from "../server/canvas-text-content.mjs";
import {validateDramaPipelineSnapshot} from "../server/backend/drama-pipeline.mjs";
const diagnostic=process.argv.slice(2).join(" ")==="--ack-cost --diagnose";
if(!diagnostic&&process.argv.slice(2).join(" ")!=="--ack-cost")throw Error("explicit_ack_cost_required");
const origin=process.env.ATELIER_P1_LIVE_ORIGIN||"http://127.0.0.1:8788";
if(!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(origin))throw Error("loopback_backend_required");
const login=await fetch(origin+"/api/v1/session",{signal:AbortSignal.timeout(8000)});
const cookie=login.headers.get("set-cookie")?.split(";")[0],session=await login.json();
if(!login.ok||!cookie||!session.csrfToken)throw Error("backend_session_unavailable");
async function call(method,path,body,zip=false){
 const res=await fetch(origin+path,{method,headers:{cookie,accept:"application/json",
  ...(method!=="GET"?{"x-atelier-csrf":session.csrfToken,origin}:{}),
  ...(body!==undefined?{"content-type":zip?"application/zip":"application/json"}:{})},
  ...(body!==undefined?{body:zip?body:JSON.stringify(body)}:{}),
  signal:AbortSignal.timeout(method==="POST"&&(path.includes("/drama-pipeline/runs")||path.endsWith("/drama-pipeline/generate"))?180000:30000)});
 return {status:res.status,data:zip&&method==="GET"?await res.arrayBuffer():await res.json().catch(()=>null)};
}
const config=(await call("GET","/api/v1/ui-settings/model_config")).data?.value;
const selected=config?.textModel,pos=typeof selected==="string"?selected.indexOf("::"):-1;
if(pos<1)throw Error("no_selected_model");
const id=selected.slice(0,pos),model=selected.slice(pos+2),ch=config.channels?.find(c=>c.id===id);
if(!ch||!ch.models?.some(m=>m.name===model&&m.capability==="text"))throw Error("model_config_invalid");
const provider=ch.apiFormat==="openai"?
 (new URL(ch.baseUrl).hostname==="api.openai.com"?"openai":"openai_compatible"):
 ch.apiFormat==="gemini"?"google_gemini":null;
if(!provider)throw Error("unsupported_provider");
const vault=await call("GET","/api/v1/channels/"+encodeURIComponent(id));
if(vault.status!==200||!vault.data?.hasKey)throw Error("channel_key_unavailable");
const episode=(id,title)=>({id,title,synopsis:"示例故事",events:[],sourceRefs:[],ending:"结束"});
const shot=(id,episodeId,description)=>({id,episodeId,order:1,description,
 characterVariantIds:["hero-day"],sceneId:"home",sceneVariantId:"home-day",propIds:[],keyPropIds:[]});
const first=shot("one-shot","ep-one","第一集：兔子发现星星");
const second=shot("two-shot","ep-two","第二集：兔子带星星回家");
const story="白色小兔住在森林小屋，第一集在森林发现遗失的星星，第二集在雨后回到小屋，把星星交给兔妈妈。镜头风格为儿童动画。";
const assets={assets:[
 {id:"hero",kind:"character",name:"小白兔",description:"白毛蓝色斗篷",sourceRefs:[],variants:[{id:"hero-day",name:"日常",description:"白毛蓝色斗篷"}]},
 {id:"home",kind:"scene",name:"森林小屋",description:"森林里的木屋",sourceRefs:[],variants:[{id:"home-day",name:"白天",description:"阳光充足"}]}
]};
const raw={nodes:[
 {id:"story",type:"drama:source",metadata:{dramaConfirmed:story,dramaConfirmedVersionId:"story-v1"}},
 {id:"assets",type:"drama:assets",metadata:{dramaConfirmed:JSON.stringify(assets),dramaConfirmedVersionId:"assets-v1"}},
 {id:"episodes",type:"drama:episodes",metadata:{dramaConfirmed:JSON.stringify({episodes:[episode("ep-one","发现星星"),episode("ep-two","归还星星")]}),dramaConfirmedVersionId:"episodes-v1"}},
 {id:"board",type:"drama:storyboard",metadata:{dramaDraft:JSON.stringify({shots:[first,second]}),dramaConfirmed:JSON.stringify({shots:[first,second]}),dramaConfirmedVersionId:"board-v1"}},
 {id:"first-config",type:"config",metadata:{generationMode:"video",dramaShotId:first.id,dramaVideoSource:{nodeId:"board",revisionId:"board-v1",shot:JSON.stringify(first),prompt:"manual one",basePrompt:"first"},prompt:"manual one",composerContent:"manual one",seconds:"9",videoRatio:"16:9"}}
],connections:[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"],["board","first-config"]]
 .map(([fromNodeId,toNodeId],i)=>({id:"edge-"+i,fromNodeId,toNodeId}))};
const projectId="p1-live-"+randomUUID(),temp=[];
const out={provider,model,appRequests:0,providerPostsObserved:"not_available",status:"not_started",cleanup:"pending"};
let fatal=null;
try{
 const created=await call("POST","/api/v1/projects",{id:projectId,document:raw});
 if(created.status!==201)throw Error("create_failed_"+created.status+"_"+created.data?.code);
 temp.push(projectId);
 if(diagnostic){
  out.appRequests++;
  const response=await call("POST","/api/v1/projects/"+projectId+"/drama-pipeline/generate",{
   stage:"storyboard",sourceText:story,context:JSON.stringify({episode:episode("ep-two","归还星星"),assets:assets.assets,existingShots:[second]}),
   channelId:id,provider,model,baseUrl:ch.baseUrl
  });
  out.httpStatus=response.status;
  const answer=response.data?.answer,parsed=typeof answer==="string"?readStoryboardDraft(answer):null;
  let envelope;
  try{envelope=JSON.parse(answer.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1"))}catch{}
  out.answerBytes=typeof answer==="string"?Buffer.byteLength(answer):0;
  out.rootKeys=envelope&&typeof envelope==="object"?Object.keys(envelope).slice(0,10):[];
  out.firstShotKeys=envelope?.shots?.[0]&&typeof envelope.shots[0]==="object"?Object.keys(envelope.shots[0]).slice(0,25):[];
  out.episodeIds=Array.isArray(envelope?.shots)?[...new Set(envelope.shots.map(shot=>shot?.episodeId))].slice(0,8):[];
  out.parsedCount=parsed?.shots.length??0;
  out.validationErrors=parsed?validateDramaPipelineSnapshot({version:1,revision:1,stage:"storyboard",assets:assets.assets,references:[],shots:parsed.shots}).errors.map(error=>error.code):[];
  out.status=response.status!==200?"diagnosis_http_failed":parsed&&out.validationErrors.length===0?"diagnosis_valid":"diagnosis_invalid";
 }else{
 const payload={requestId:"run-"+randomUUID(),nodeId:"board",episodeId:"ep-two",
   channelId:id,provider,model,baseUrl:ch.baseUrl};
 out.appRequests++;
 const result=await call("POST","/api/v1/projects/"+projectId+"/drama-pipeline/runs",payload);
 out.httpStatus=result.status;out.status=result.data?.status||"http_error";
 out.errorCode=result.data?.error||result.data?.code||null;
 out.candidateCount=result.data?.candidate?.shots?.length||0;
 if(result.status===200&&result.data?.status==="ready"){
  const adopted=await call("POST","/api/v1/projects/"+projectId+"/drama-pipeline/runs/"+result.data.id+"/adopt",{});
  out.adoptStatus=adopted.status;
  if(adopted.status===200){
   const nodes=adopted.data.document.nodes,board=nodes.find(n=>n.id==="board");
   const config=nodes.find(n=>n.id==="first-config"),shots=JSON.parse(board.metadata.dramaDraft).shots;
   out.firstEpisodePreserved=shots.find(s=>s.episodeId==="ep-one")?.description===first.description;
   out.firstConfigPreserved=config?.metadata?.prompt==="manual one"&&config.metadata.seconds==="9";
   out.secondEpisodeUpdated=shots.some(s=>s.episodeId==="ep-two"&&s.description!==second.description);
   if(out.firstEpisodePreserved&&out.firstConfigPreserved){
    const archive=await call("GET","/api/v1/projects/"+projectId+"/archive",undefined,true);
    out.archiveStatus=archive.status;
    if(archive.status===200){
     const imported=await call("POST","/api/v1/projects/import-archive",archive.data,true);
     out.importStatus=imported.status;
     if(imported.status===201&&imported.data?.id)temp.push(imported.data.id);
    }
   }
  }
 }
 }
}catch(error){fatal=error;out.errorCode=error?.message||"unknown";out.status="error"}
finally{
 const codes=[];
 for(const id of temp.reverse())try{const d=await call("DELETE","/api/v1/projects/"+id);codes.push(d.status)}
 catch{codes.push("failed")}
 out.cleanup=codes.every(c=>c===200)?"deleted":"incomplete";
 console.log("P1_ONLINE_SMOKE "+JSON.stringify(out));
}
if(diagnostic?fatal||out.status!=="diagnosis_valid"||out.cleanup!=="deleted":
 fatal||out.status!=="ready"||out.adoptStatus!==200||!out.firstEpisodePreserved||
 !out.firstConfigPreserved||out.archiveStatus!==200||out.importStatus!==201||
 out.cleanup!=="deleted")process.exitCode=1;
