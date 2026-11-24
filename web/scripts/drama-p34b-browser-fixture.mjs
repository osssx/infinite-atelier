/** P3.4b browser fixture: isolated SQLite/CAS, never the user's dataset. */
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {existsSync,writeFileSync,createReadStream} from "node:fs";
import {spawnSync} from "node:child_process";
import {Readable} from "node:stream";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {createProject} from "../server/backend/projects.mjs";
import {insertTextVersions} from "../server/backend/canvas-text-versions.mjs";
import {startServer} from "../server/backend/app.mjs";
if(process.env.ATELIER_P34B_BROWSER_E2E!=="1")throw Error("explicit_test_opt_in_required");
const root=resolve(process.env.ATELIER_DATA_DIR??"");
if(dirname(root).toLowerCase()!==resolve(tmpdir()).toLowerCase()||
 !basename(root).startsWith("infinite-atelier-p34b-browser-")||!existsSync(root))
 throw Error("isolated_temp_directory_required");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error("invalid_test_port");
const backend=createLocalBackend({dataDir:root,autoLocalSession:true,autoDispatch:false,
 activationRoot:join(root,"activation"),skillsDir:join(root,"skills")});
const {db,blobStore}=backend;
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ywoAAAAASUVORK5CYII=","base64");
const image=await blobStore.put(Readable.from([png]),{mime:"image/png"});
const samplePath=join(root,"sample-64x64.mp4");
const result=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","color=c=blue:s=64x64:r=3:d=1",
 "-t","1","-pix_fmt","yuv420p","-c:v","libx264","-movflags","+faststart",samplePath],{timeout:15000});
if(result.status!==0)throw Error("fixture_ffmpeg_failed:"+String(result.stderr));
const video=await blobStore.put(createReadStream(samplePath),{mime:"video/mp4"});
const assets=Array.from({length:50},(_,i)=>({id:"asset-"+i,kind:"prop",name:"道具 "+i,
 description:("资产说明 "+i+" 用于场景分镜的一致性检查。").repeat(8),sourceRefs:[]}));
const episodes=Array.from({length:4},(_,i)=>({id:"ep-"+i,title:"第 "+(i+1)+" 集",
 synopsis:("第 "+(i+1)+" 集剧情梗概 ").repeat(17),ending:"结尾",events:[],sourceRefs:[],
 sequences:Array.from({length:3},(_,j)=>({id:"ep-"+i+"-seq-"+j,title:"场次 "+(j+1)}))}));
const shotCount=process.env.ATELIER_DRAMA_P5_BROWSER_E2E==="1"?200:100;
const shotsPerEpisode=shotCount/4;
const shots=Array.from({length:shotCount},(_,i)=>({id:"shot-"+i,episodeId:"ep-"+Math.floor(i/shotsPerEpisode),
 sequenceId:"ep-"+Math.floor(i/shotsPerEpisode)+"-seq-"+Math.min(2,Math.floor((i%shotsPerEpisode)*3/shotsPerEpisode)),
 order:i+1,shotSize:"中景",description:("镜头 "+i+" 画面描述：角色在场景中行动。").repeat(35),
 action:"镜头移动 "+i,dialogue:"",characterVariantIds:[],propIds:[],keyPropIds:[],sourceRefs:[]}));
const node=(id,type,index,metadata,width=220,height=180)=>({
 id,type,title:id,position:{x:36+(index%13)*265,y:36+Math.floor(index/13)*220},
 width,height,metadata
});
const nodes=[
 node("assets","drama:assets",0,{dramaDraft:JSON.stringify({assets}),dramaConfirmed:JSON.stringify({assets}),
  ...(process.env.ATELIER_ASSET_P6_BROWSER_E2E==="1"?{dramaAssetCandidate:{
   id:"p6-review",baseline:JSON.stringify({assets}),assets:Array.from({length:12},(_,i)=>({id:"candidate-"+i,
    kind:"prop",name:"待审核道具 "+i,description:"新增道具说明 "+i,sourceRefs:[]}))}}:{})},340,360),
 node("episodes","drama:episodes",1,{dramaDraft:JSON.stringify({episodes}),dramaConfirmed:JSON.stringify({episodes})},340,360),
 node("board","drama:storyboard",2,{dramaDraft:JSON.stringify({shots}),dramaConfirmed:JSON.stringify({shots}),
  dramaConfirmedVersionId:"p34b-v1",...(shotCount===200?{dramaShotProduction:{"shot-50":{mode:"first_frame"},"shot-100":{mode:"first_frame"}}}:{})},420,410)
];
for(let i=0;i<197;i++){
 const k=i+3;
 if(i<97)nodes.push(node("text-"+i,"text",k,{content:("说明 "+i+" 输入/资产可见性 ").repeat(8)}));
 else if(i<167)nodes.push(node("image-"+(i-97),"image",k,{
   content:"/api/v1/blobs/"+image.blobId,storageKey:"cas:"+image.blobId,
   mimeType:"image/png",naturalWidth:1,naturalHeight:1,status:"success"}));
 else if(i<182)nodes.push(node("video-"+(i-167),"video",k,{
   content:"/api/v1/blobs/"+video.blobId,storageKey:"cas:"+video.blobId,
   mimeType:"video/mp4",naturalWidth:64,naturalHeight:64,status:"success"}));
 else nodes.push(node("config-"+(i-182),"config",k,{generationMode:"video",prompt:"风格一致性 "+i,seconds:"5"}));
}
if(nodes.length!==200||shots.length!==shotCount||assets.length!==50)throw Error("fixture_count_mismatch");
const connections=[
 {id:"l-assets-board",fromNodeId:"assets",toNodeId:"board"},
 {id:"l-episodes-board",fromNodeId:"episodes",toNodeId:"board"}
];
for(let i=0;i<68;i++)connections.push({id:"link-"+i,
 fromNodeId:"text-"+i,toNodeId:"image-"+(i%70)});
const projectId="p34b-browser-200";
createProject(db,{id:projectId,document:{title:"P3.4b 大画布真实浏览器验收",nodes,connections}});
insertTextVersions(db,projectId,[{nodeId:"board",id:"p34b-v1",createdAt:"2026-11-22T00:00:00Z",
 source:"confirmation",content:JSON.stringify({shots})}]);
let closed=false;
for(const sig of ["SIGTERM","SIGINT"])process.on(sig,()=>void (async()=>{
 if(closed)return;closed=true;await backend.close();process.exit(0);
})());
const backendOrigin=await startServer(backend.app,{host:"127.0.0.1",port});
writeFileSync(join(root,"p34b-fixture.json"),JSON.stringify({backendOrigin,projectId,
 nodes:200,assets:50,episodes:4,shots:shotCount,media:{images:70,videos:15},connections:connections.length,
 imageBytes:image.byteSize,videoBytes:video.byteSize}),"utf8");
console.log("P34B_BROWSER_FIXTURE_READY",JSON.stringify({backendOrigin,projectId,nodes:200,shots:shotCount,assets:50}));
