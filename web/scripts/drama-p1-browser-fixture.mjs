/** Isolated P1 browser fixture. Never reads/updates the user's data. */
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {existsSync,writeFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {initializeSchema} from "../server/backend/schema.mjs";
import {createProject,getProject,saveSingleUserCanvas,validateProjectDocument,emitProjectEvent} from "../server/backend/projects.mjs";
import {mutateTextVersions} from "../server/backend/canvas-text-versions.mjs";
import {createBlobStore} from "../server/backend/blob-store.mjs";
import {createProjectArchive} from "../server/backend/project-archive.mjs";
import {createLocalSessionAuth} from "../server/backend/session.mjs";
import {buildApp,startServer} from "../server/backend/app.mjs";

if(process.env.ATELIER_DRAMA_P1_BROWSER_E2E!=="1")throw Error("explicit_test_opt_in_required");
const root=resolve(process.env.ATELIER_DATA_DIR??"");
if(dirname(root).toLowerCase()!==resolve(tmpdir()).toLowerCase()||
 !basename(root).startsWith("infinite-atelier-drama-p1-browser-")||!existsSync(root))
 throw Error("isolated_temp_directory_required");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error("invalid_test_port");
const db=new DatabaseSync(":memory:");initializeSchema(db);
const blobStore=createBlobStore({db,dataDir:root,maxBlobBytes:10000000});
const projectArchive=createProjectArchive({db,blobStore});
const projectId="drama-p1-browser",runModel="fixture-text";
const e1={id:"shot-one",episodeId:"ep-one",order:1,description:"第一集，主角在家",characterVariantIds:["hero-day"],sceneId:"home",sceneVariantId:"home-day",propIds:[],keyPropIds:[]};
const e2={...e1,id:"shot-two",episodeId:"ep-two",sequenceId:"seq-harbor",description:"第二集，主角出门"};
const assetPlan={assets:[
 {id:"hero",kind:"character",name:"主角",description:"穿蓝色衣服",sourceRefs:[],variants:[{id:"hero-day",name:"日常",description:"蓝衣"}]},
 {id:"home",kind:"scene",name:"家",description:"共用场景",sourceRefs:[],variants:[{id:"home-day",name:"白天",description:"日光"}]}
]};
const format=(id,type,x,y,metadata)=>({id,type,title:id,position:{x,y},width:340,height:310,metadata});
const nodes=[
 format("story","drama:source",40,40,{content:"主角从家出发，经过森林，回家。",dramaDraft:"主角从家出发，经过森林，回家。"}),
 format("assets","drama:assets",430,40,{dramaDraft:JSON.stringify(assetPlan)}),
 format("episodes","drama:episodes",430,450,{targetEpisodes:2,dramaDraft:JSON.stringify({episodes:[
  {id:"ep-one",title:"第一集",synopsis:"离开家",events:[],sourceRefs:[],ending:"出发"},
  {id:"ep-two",title:"第二集",synopsis:"回家",events:[],sourceRefs:[],ending:"回家",
    sequences:[{id:"seq-harbor",title:"码头送别"}]}]})}),
 format("board","drama:storyboard",840,40,{dramaDraft:JSON.stringify({shots:[e1,e2]})})
];
const connections=[["story","assets"],["story","episodes"],["assets","board"],["episodes","board"]]
 .map(([fromNodeId,toNodeId],i)=>({id:"link-"+i,fromNodeId,toNodeId}));
createProject(db,{id:projectId,document:{title:"P1 浏览器隔离验收",nodes,connections}});
for(const id of ["story","assets","episodes","board"]){
 const rev=getProject(db,projectId).revision;
 mutateTextVersions(db,projectId,id,{action:"confirm",operationId:id+"-v1",expectedRevision:rev},
  validateProjectDocument,emitProjectEvent);
}
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ywoAAAAASUVORK5CYII=","base64");
const blob=await blobStore.put([png],{mime:"image/png"}),key="cas:"+blob.blobId;
const before=getProject(db,projectId);
before.document.nodes.push(format("legacy-image","image",1360,520,{
 storageKey:key,content:"/api/v1/blobs/"+blob.blobId,status:"success"
 }),format("first-config","config",1280,40,{
  generationMode:"video",dramaShotId:"shot-one",dramaVideoSource:{nodeId:"board",revisionId:"board-v1",
  shot:JSON.stringify(e1),referenceKeys:[key],prompt:"手工编辑的第一集提示词",basePrompt:e1.description},
  prompt:"手工编辑的第一集提示词",composerContent:"手工编辑的第一集提示词",
  seconds:"9",videoRatio:"4:3",videoMode:"first_frame",videoReferences:[{id:"legacy-image",kind:"image",role:"first_frame"}]
 }),format("second-config","config",1280,370,{
  generationMode:"video",dramaShotId:"shot-two",dramaVideoSource:{nodeId:"board",revisionId:"board-v1",
  shot:JSON.stringify(e2),referenceKeys:[],prompt:e2.description,basePrompt:e2.description},
  prompt:e2.description,composerContent:e2.description,videoMode:"text_to_video",seconds:"6"
 }));
before.document.connections.push({id:"board-config",fromNodeId:"board",toNodeId:"first-config"},
 {id:"image-config",fromNodeId:"legacy-image",toNodeId:"first-config"});
before.document.connections.push({id:"board-second-config",fromNodeId:"board",toNodeId:"second-config"});
saveSingleUserCanvas(db,{id:projectId,expectedRevision:before.revision,document:before.document});

const settings={channels:[{id:"p1mock",name:"P1 fixture only",baseUrl:"https://example.com/v1",apiKey:"",
 apiFormat:"openai",models:[{name:runModel,capability:"text"}]}],
 textModel:"p1mock::"+runModel};
db.prepare("UPDATE ui_settings SET value_json=? WHERE name='model_config'").run(JSON.stringify(settings));
let modelCalls=0;
const vault={list:()=>[{id:"p1mock",provider:"openai_compatible",hasKey:true,keyVersion:"test-only"}],
 get:id=>id==="p1mock"?{id,provider:"openai_compatible",hasKey:true,keyVersion:"test-only"}:
  Object.assign(Error("channel_not_found"),{statusCode:404}),
 listVersions:()=>[],create:()=>{throw Error("fixture_no_credential_mutation")},
 rotate:()=>{throw Error("fixture_no_credential_mutation")},
 revoke:()=>{throw Error("fixture_no_credential_mutation")}
};
const app=buildApp({db,sessionAuth:createLocalSessionAuth(),autoLocalSession:true,blobStore,projectArchive,vault,
 assistantChat:async()=>{
  modelCalls++;
  return {answer:JSON.stringify({shots:[{...e2,description:"浏览器实际触发的第二集候选"}]})};
 },modelKinds:["text"]});
let shutdown=false;
async function close(){if(shutdown)return;shutdown=true;console.log("P1_BROWSER_FIXTURE_MODEL_CALLS",modelCalls);await app.close();db.close()}
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>void close().then(()=>process.exit(0)));
const backendOrigin=await startServer(app,{host:"127.0.0.1",port});
writeFileSync(join(root,"p1-fixture.json"),JSON.stringify({backendOrigin,projectId,
 initialRevision:getProject(db,projectId).revision,firstConfigId:"first-config",originalPrompt:"手工编辑的第一集提示词"}),"utf8");
console.log("P1_BROWSER_FIXTURE_READY",JSON.stringify({backendOrigin,projectId}));
