/** S5 story pressure fixture; disposable SQLite/CAS only, no model or Comfy dispatch. */
import {tmpdir} from "node:os";
import {resolve,dirname,basename,join} from "node:path";
import {existsSync,writeFileSync} from "node:fs";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {createProject} from "../server/backend/projects.mjs";
import {insertTextVersions} from "../server/backend/canvas-text-versions.mjs";
import {startServer} from "../server/backend/app.mjs";

if(process.env.ATELIER_STORY_S5_BROWSER_E2E!=="1")throw Error("explicit_test_opt_in_required");
const root=resolve(process.env.ATELIER_DATA_DIR??"");
if(dirname(root).toLowerCase()!==resolve(tmpdir()).toLowerCase()||
 !basename(root).startsWith("infinite-atelier-story-s5-browser-")||!existsSync(root))
 throw Error("isolated_temp_directory_required");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error("invalid_test_port");
const backend=createLocalBackend({dataDir:root,autoLocalSession:true,autoDispatch:false,
 activationRoot:join(root,"activation"),skillsDir:join(root,"skills")});
const {db}=backend;
const projectId="story-s5-browser-200",nodes=[],connections=[],storySamples=[];
const node=(id,type,title,x,y,metadata,width=320,height=310)=>({id,type,title,position:{x,y},width,height,metadata});
function storyBody(index,bytes){
 // Chinese paragraphs with unique readable segment numbers, bounded UTF-8 byte size.
 const paragraphs=[];let length=0;
 for(let n=0;length<bytes;n++){
  const line=`故事 ${index} 第 ${n+1} 段：晨光落在山谷里，旅人打开木门，沿着河岸出发。她记得伙伴的约定，观察路旁的树影，将发现写入日记。`.repeat(2);
  paragraphs.push(line);length+=Buffer.byteLength(line)+(n?2:0);
 }
 const body=paragraphs.join("\n\n");
 return {body,paragraphs:paragraphs.map((text,n)=>({id:`story-${index}-para-${n}`,line:n+1,text,status:"mapped"}))};
}
const digest=text=>{let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
 return "fnv1a:"+text.length+":"+(hash>>>0).toString(16).padStart(8,"0")};
for(let i=0;i<24;i++){
 const {body,paragraphs}=storyBody(i,i%6===1?100*1024:10*1024);
 const id="story-"+i;
 const versionId=id+"-v1";
 const linkedText=("来源 "+i+"：另一个版本的故事片段。\n").repeat(70);
 nodes.push(node(id,"drama:source","长篇故事 "+(i+1),32+(i%6)*360,32+Math.floor(i/6)*350,
  {content:body,dramaDraft:body,dramaConfirmed:body,dramaConfirmedVersionId:versionId,
   dramaSourceParagraphs:paragraphs,dramaTextSourceSync:{nodeId:"source-"+i,edgeId:"source-edge-"+i,digest:digest(linkedText),baselineDigest:digest(body)},dramaFilmStyle:"水彩动画",videoRatio:"16:9",
   dramaConfirmedVisual:{visualStyle:"水彩动画",artDirection:{palette:"",lighting:"",characterDesign:"",anchors:""}}}));
 storySamples.push({id,bytes:Buffer.byteLength(body),characters:body.length,paragraphs:paragraphs.length,preview:body.slice(0,360)});
 // Shared graph includes linked text sources (real digest/index workload).
 nodes.push(node("source-"+i,"text","来源 "+(i+1),2220+(i%6)*260,32+Math.floor(i/6)*220,
  {content:linkedText},220,180));
 connections.push({id:"source-edge-"+i,fromNodeId:"source-"+i,toNodeId:id});
}
for(let i=0;i<152;i++){
 const type=i%8===0?"config":"text";
 nodes.push(node("other-"+i,type,"辅助节点 "+(i+1),32+(i%13)*260,1480+Math.floor(i/13)*220,
  type==="config"?{generationMode:"video",prompt:"镜头风格一致性",seconds:"5"}:{content:"测试辅助文字 "+i},220,180));
 if(i>0&&i%8===0)connections.push({id:"other-edge-"+i,fromNodeId:"other-"+(i-1),toNodeId:"other-"+i});
}
if(nodes.length!==200||storySamples.length!==24)throw Error("fixture_count_mismatch");
const document={title:"S5 长故事隔离验收",nodes,connections};
const hydratedDocumentBytes=Buffer.byteLength(JSON.stringify(document));
if(hydratedDocumentBytes>=4*1024*1024)throw Error("fixture_exceeds_existing_project_limit");
createProject(db,{id:projectId,document});
for(const i of [0,1])insertTextVersions(db,projectId,[{nodeId:"story-"+i,id:"story-"+i+"-v1",
 createdAt:"2026-11-26T00:00:00Z",source:"confirmation",content:nodes.find(n=>n.id==="story-"+i).metadata.dramaConfirmed}]);
let closed=false;
for(const sig of ["SIGTERM","SIGINT"])process.on(sig,()=>void(async()=>{
 if(closed)return;closed=true;await backend.close();process.exit(0);
})());
const backendOrigin=await startServer(backend.app,{host:"127.0.0.1",port});
writeFileSync(join(root,"story-s5-fixture.json"),JSON.stringify({backendOrigin,projectId,nodes:200,storySamples,connections:connections.length,hydratedDocumentBytes}),"utf8");
console.log("STORY_S5_FIXTURE_READY",JSON.stringify({backendOrigin,projectId,stories:storySamples.length,nodes:200}));
