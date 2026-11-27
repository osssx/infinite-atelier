// @vitest-environment node
// Opt-in local-only test: ATELIER_TEST_LOCAL_COMFY=1; add ATELIER_TEST_H3_GPU=1 for two H3 diffusion runs.
import {test,expect} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {initializeSchema} from "../../../server/backend/schema.mjs";
import {createBlobStore} from "../../../server/backend/blob-store.mjs";
import {createComfyV2Adapters,readComfyWorkflowObjectInfo} from "../../../server/backend/comfy-v2-adapter.mjs";
import {createJobCoordinator} from "../../../server/backend/job-coordinator.mjs";
import {submitJob,fingerprintSource} from "../../../server/backend/repository.mjs";
import {createProject,getProject} from "../../../server/backend/projects.mjs";
import {createCanvasMaterializer} from "../../../server/backend/canvas-materializer.mjs";
import {compileSingleWorkflow,workflowObjectInfoClasses} from "../../../server/comfy-workflow/compiler.mjs";
import {createComfyTemplate,templatePayloadFromGraph} from "./template-schema";
import {minimaxH3Ref2VBundledTemplate} from "./minimax-h3-ref2v-preset";
const instance={id:"local",url:"http://127.0.0.1:8188"};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const enabled=process.env.ATELIER_TEST_LOCAL_COMFY==="1",gpu=enabled&&process.env.ATELIER_TEST_H3_GPU==="1";
async function fixture(fn){
 const queue=await (await fetch(instance.url+"/queue",{signal:AbortSignal.timeout(5000)})).json();
 expect(queue.queue_running.length+queue.queue_pending.length,"Use an idle local ComfyUI instance").toBe(0);
 const folder=await mkdtemp(join(tmpdir(),"atelier-ref2v-live-"));
 const db=new DatabaseSync(":memory:");
 try {
  initializeSchema(db);
  const blobStore=createBlobStore({db,dataDir:folder});
  const adapters=createComfyV2Adapters({instances:[instance],db,blobStore});
  const coordinator=createJobCoordinator({db,adapters:{comfy:adapters}});
  coordinator.recoverAtStartup();
  await fn({folder,db,blobStore,coordinator});
 }finally{db.close();await rm(folder,{recursive:true,force:true});}
}
function ffmpeg(name,args){
 const result=spawnSync(process.env["ATELIER_"+name.toUpperCase()+"_PATH"]||name,args,{windowsHide:true,encoding:"utf8",timeout:30000,maxBuffer:2_000_000});
 expect(result.status,result.stderr||String(result.error??"")).toBe(0);
 return result.stdout;
}
async function clip(f,rate){
 const file=join(f.folder,"source-"+rate+".mp4");
 ffmpeg("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=64x64:rate="+rate,"-t","2","-pix_fmt","yuv420p","-c:v","libx264","-y",file]);
 return f.blobStore.put(createReadStream(file),{mime:"video/mp4"});
}
function request(template,asset,tag,overrides={},mode){
 const nodeId="workflow-"+tag,projectId="project-"+tag,sourceNodeId="video-"+tag;
 const edges=asset?[{fromNodeId:sourceNodeId,fromPortId:"video",toNodeId:nodeId,toPortId:"reference_video_0"}]:[];
 return {schemaVersion:2,projectId,canvasRevision:"1",instanceId:instance.id,idempotencyKey:"ref2v-"+tag,
  nodes:[{id:nodeId,templateId:template.id,templateRevision:template.revision,inputOverrides:overrides}],
  rootOutputs:[{nodeId,portId:"video"}],edges,
  externalInputs:asset?[{kind:"asset",sourceNodeId,sourcePortId:"video",valueKind:"VIDEO",assetId:asset.blobId,sha256:asset.blobId}]:[],
  runOptions:mode?{mediaMode:mode}:{}};
}
async function run(f,template,req,timeoutMs){
 const nodeId=req.nodes[0].id;
 const mediaMime={VIDEO:"video/mp4",IMAGE:"image/png",AUDIO:"audio/wav"};
 const nodes=[...req.externalInputs.map((item,index)=>({id:item.sourceNodeId,type:item.valueKind.toLowerCase(),title:"source",position:{x:0,y:index*140},width:120,height:120,
  metadata:{storageKey:"cas:"+item.assetId,mimeType:mediaMime[item.valueKind]}})),
 {id:nodeId,type:"comfy:workflow",title:"Ref2V live",position:{x:300,y:0},width:240,height:180,
  metadata:{comfyWorkflow:{templateId:template.id,templateRevision:template.revision},comfyPorts:template.ports.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}))}}];
 const document={nodes,connections:req.edges.map((edge,i)=>({id:"edge-"+i,...edge}))};
 const project=createProject(f.db,{id:req.projectId,document});
 const id=submitJob(f.db,{projectId:project.id,targetNodeId:nodeId,expectedProjectRevision:project.revision,
  sourceNodeFingerprint:fingerprintSource(document,nodeId),idempotencyKey:req.idempotencyKey,requestFingerprint:req.idempotencyKey,executionMode:"poll",
  snapshot:{adapterKind:"comfy",instanceId:instance.id,comfyTemplate:template,comfyRequest:req}}).jobId;
 const start=Date.now();let job;
 while(Date.now()-start<timeoutMs){
  await f.coordinator.tick();
  job=f.db.prepare("SELECT status,upstream_task_id FROM jobs WHERE id=?").get(id);
  if(job.status==="succeeded")break;
  if(["failed","cancelled","submission_unknown"].includes(job.status))throw Error(JSON.stringify({job,events:f.db.prepare("SELECT kind,payload_json FROM job_events WHERE job_id=? ORDER BY rowid DESC LIMIT 6").all(id)}));
  await pause(500);
 }
 expect(job?.status,"Local Comfy job "+id).toBe("succeeded");
 const graph=JSON.parse(f.db.prepare("SELECT graph_json FROM comfy_job_preparations WHERE job_id=?").get(id).graph_json);
 const materializer=createCanvasMaterializer({db:f.db,blobStore:f.blobStore});
 const result=await materializer.runOnce();
 expect(result.filter(item=>item.status==="materialized")).toHaveLength(1);
 const artifact=f.db.prepare("SELECT blob_id FROM artifacts WHERE job_id=? AND kind='video'").get(id);
 expect(artifact).toBeTruthy();
 const file=await f.blobStore.stat(artifact.blob_id);
 expect(file.mimeType).toBe("video/mp4");
 expect(getProject(f.db,project.id).document.nodes.length).toBe(nodes.length+1);
 return {graph,file,elapsedMs:Date.now()-start};
}
function loaderTemplate(){
 const src=minimaxH3Ref2VBundledTemplate();
 const graph={"139":structuredClone(src.apiGraph["139"]),
  "out":{class_type:"CreateVideo",inputs:{images:["139",0],fps:24}},
  "save":{class_type:"SaveVideo",inputs:{video:["out",0],filename_prefix:"atelier-ref2v-smoke/decoded",format:"auto","format.codec":"auto",codec:"auto"}}};
 const payload=templatePayloadFromGraph("Reference decoder",graph);
 payload.ports=[{...src.ports.find(p=>p.id==="reference_video_0"),required:true,absentPolicy:{mode:"keep-template"}},
 {id:"video",label:"Video",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"out",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}];
 return createComfyTemplate("ref2v-decode",payload);
}
test.skipIf(!enabled)("real VHS decoder: 30 and 60 fps CAS video -> 48 frames at 24 fps, persisted and materialized",async()=>{
 await fixture(async f=>{
  const template=await loaderTemplate();
  for(const rate of [30,60]){
   const asset=await clip(f,rate),req=request(template,asset,"fps-"+rate);
   const result=await run(f,template,req,90000);
   const loader=result.graph["w_"+req.nodes[0].id+"__139"];
   expect(loader.inputs.video).toBe("atelier_"+asset.blobId+".mp4");
   expect(loader.inputs.force_rate).toBe(24);
   const stream=JSON.parse(ffmpeg("ffprobe",["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames,r_frame_rate","-of","json",result.file.path])).streams[0];
   expect(stream.r_frame_rate).toBe("24/1");expect(Number(stream.nb_read_frames)).toBe(48);
   console.log("H3_REF2V_DECODE",JSON.stringify({sourceFps:rate,outputFps:24,frames:48,elapsedMs:result.elapsedMs}));
  }
 });
},240000);
test.skipIf(!enabled)("real H3 node definitions compile both prompt-only and populated video graphs",async()=>{
 const template=await createComfyTemplate("h3-ref2v-live",minimaxH3Ref2VBundledTemplate());
 const asset={blobId:"a".repeat(64)};
 const full=request(template,asset,"compile",{},"omni_reference"),empty=request(template,null,"empty",{},"text_to_video");
 const info=await readComfyWorkflowObjectInfo(instance,workflowObjectInfoClasses(full,template));
 const ref=compileSingleWorkflow(full,template,{info,mediaFiles:{[asset.blobId]:"atelier_"+asset.blobId+".mp4"}});
 expect(ref.graph["w_workflow-compile__129"].inputs["ref_videos.ref_video_0"]).toEqual(["w_workflow-compile__139",0]);
 expect(ref.graph["w_workflow-compile__139"].inputs.force_rate).toBe(24);
 const noRef=compileSingleWorkflow(empty,template,{info,mediaFiles:{}});
 expect(noRef.graph["w_workflow-empty__139"]).toBeUndefined();
 expect(Object.keys(noRef.graph["w_workflow-empty__129"].inputs).filter(k=>k.startsWith("ref_images.")||k.startsWith("ref_videos.")||k.startsWith("ref_audios."))).toEqual([]);
},30000);
test.skipIf(!enabled)("real H3 definitions compile all three keyframe modes with the exact user prompt",async()=>{
 const template=await createComfyTemplate("h3-ref2v-keyframes",minimaxH3Ref2VBundledTemplate());
 const prompt="User's custom prompt: <Picture 1>\n保持原始提示词。";
 for(const [mode,count] of [["first_frame",1],["last_frame",1],["first_last_frame",2]]){
  const req=request(template,null,mode,{prompt},mode);
  for(let i=0;i<count;i++){
   const sourceNodeId="picture-"+i,assetId=String(i+1).repeat(64);
   req.edges.push({fromNodeId:sourceNodeId,fromPortId:"image",toNodeId:req.nodes[0].id,toPortId:"reference_image_"+i});
   req.externalInputs.push({kind:"asset",sourceNodeId,sourcePortId:"image",valueKind:"IMAGE",assetId,sha256:assetId});
  }
  const info=await readComfyWorkflowObjectInfo(instance,workflowObjectInfoClasses(req,template));
  const mediaFiles=Object.fromEntries(req.externalInputs.map(input=>[input.assetId,"atelier_"+input.assetId+".png"]));
  const result=compileSingleWorkflow(req,template,{info,mediaFiles});
  const model=result.graph["w_"+req.nodes[0].id+"__129"].inputs;
  expect(model.prompt).toBe(prompt);
  expect(Object.keys(model).filter(k=>/^ref_(images|videos|audios)\./.test(k)).sort()).toEqual(Array.from({length:count},(_,i)=>"ref_images.ref_image_"+i));
  expect(model["ref_images.ref_image_0"]).toEqual(["w_"+req.nodes[0].id+"__114",0]);
  if(count===2)expect(model["ref_images.ref_image_1"]).toEqual(["w_"+req.nodes[0].id+"__130",0]);
  const invalid=structuredClone(req);invalid.edges.pop();invalid.externalInputs.pop();
  expect(()=>compileSingleWorkflow(invalid,template,{info,mediaFiles})).toThrow(/template_media_request_invalid/);
 }
},30000);
function userKeyframePrompt(mode){
 return mode==="first_frame"?"<Picture 1> is the opening frame. Slowly pan across the scene.":
  mode==="last_frame"?"Slowly pan across the scene, ending on <Picture 1>.":
  "Begin at <Picture 1> and smoothly transition to <Picture 2> as the final frame.";
}
function keyframeRequest(template,mode,tag,images){
 const req=request(template,null,tag,{prompt:userKeyframePrompt(mode),duration:2,megapixels:0.1,ref_image_size:"match"},mode);
 for(const [i,asset] of images.entries()){
  const sourceNodeId="frame-"+i+"-"+tag;
  req.externalInputs.push({kind:"asset",sourceNodeId,sourcePortId:"image",valueKind:"IMAGE",assetId:asset.blobId,sha256:asset.blobId});
  req.edges.push({fromNodeId:sourceNodeId,fromPortId:"image",toNodeId:req.nodes[0].id,toPortId:"reference_image_"+i});
 }
 return req;
}
function expectKeyframeGraph(result,tag,mode){
 const id="w_workflow-"+tag+"__129",model=result.graph[id];
 const both=mode==="first_last_frame";
 expect(model.class_type).toBe("MiniMaxH3ReferenceToVideo");
 expect(Object.keys(model.inputs).filter(k=>/^ref_images\./.test(k)).sort()).toEqual(both?["ref_images.ref_image_0","ref_images.ref_image_1"]:["ref_images.ref_image_0"]);
 expect(Object.keys(model.inputs).filter(k=>/^ref_(videos|audios)\./.test(k))).toEqual([]);
 expect(model.inputs.prompt).toBe(userKeyframePrompt(mode));
 expect(model.inputs.first_frame).toBeUndefined();
 expect(model.inputs.last_frame).toBeUndefined();
}
test.skipIf(!enabled)("real H3 schemas compile all three keyframe modes with existing reference image sockets and exact user prompts",async()=>{
 const template=await createComfyTemplate("h3-ref2v-keyframe-live",minimaxH3Ref2VBundledTemplate());
 const a={blobId:"a".repeat(64)},b={blobId:"b".repeat(64)};
 const mediaFiles={[a.blobId]:"first.png",[b.blobId]:"last.png"};
 const info=await readComfyWorkflowObjectInfo(instance,template.requirements.classTypes);
 for(const mode of ["first_frame","last_frame","first_last_frame"]){
  const tag="compile-"+mode,req=keyframeRequest(template,mode,tag,mode==="first_last_frame"?[a,b]:[a]);
  const original=JSON.stringify({template,req});
  const result=compileSingleWorkflow(req,template,{info,mediaFiles});
  expectKeyframeGraph(result,tag,mode);
  expect(JSON.stringify({template,req})).toBe(original);
  expect(compileSingleWorkflow(req,template,{info,mediaFiles}).graphHash).toBe(result.graphHash);
  expect(()=>compileSingleWorkflow(keyframeRequest(template,mode,tag,[]),template,{info,mediaFiles})).toThrow(/template_media_request_invalid/);
 }
},30000);
test.skipIf(!gpu)("real H3 Ref2V keyframe modes generate and materialize with exact user prompts",async()=>{
 await fixture(async f=>{
  const template=await createComfyTemplate("h3-ref2v-keyframes-gpu",minimaxH3Ref2VBundledTemplate());
  const assets=[];
  for(const color of ["blue","red"]){
   const file=join(f.folder,color+".png");
   ffmpeg("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c="+color+":size=64x64","-frames:v","1","-threads","1","-y",file]);
   assets.push(await f.blobStore.put(createReadStream(file),{mime:"image/png"}));
  }
  for(const mode of ["first_frame","last_frame","first_last_frame"]){
   const tag="gpu-"+mode,req=keyframeRequest(template,mode,tag,mode==="first_last_frame"?assets:[assets[mode==="last_frame"?1:0]]);
   const result=await run(f,template,req,600000);
   expectKeyframeGraph(result,tag,mode);
   const stream=JSON.parse(ffmpeg("ffprobe",["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames,r_frame_rate,width,height","-of","json",result.file.path])).streams[0];
   expect(stream.r_frame_rate).toBe("24/1");expect(Number(stream.nb_read_frames)).toBeGreaterThanOrEqual(5);
   console.log("H3_REF2V_KEYFRAME",JSON.stringify({mode,frames:Number(stream.nb_read_frames),fps:stream.r_frame_rate,width:stream.width,height:stream.height,elapsedMs:result.elapsedMs}));
  }
 });
},1850000);
test.skipIf(!gpu)("real MiniMax H3 reference-to-video generation through CAS and materialization",async()=>{
 await fixture(async f=>{
  const template=await createComfyTemplate("h3-ref2v-live",minimaxH3Ref2VBundledTemplate());
  const asset=await clip(f,30);
  const req=request(template,asset,"h3-gpu",{prompt:"<Video 1> Animate this colorful geometric pattern with a slow camera movement.",duration:2,megapixels:0.1,ref_image_size:"match"},"omni_reference");
  const result=await run(f,template,req,600000);
  expect(result.graph["w_workflow-h3-gpu__129"].inputs["ref_videos.ref_video_0"]).toEqual(["w_workflow-h3-gpu__139",0]);
  const stream=JSON.parse(ffmpeg("ffprobe",["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames,r_frame_rate,width,height","-of","json",result.file.path])).streams[0];
  expect(stream.r_frame_rate).toBe("24/1");expect(Number(stream.nb_read_frames)).toBeGreaterThanOrEqual(5);
  console.log("H3_REF2V_GENERATION",JSON.stringify({frames:Number(stream.nb_read_frames),fps:stream.r_frame_rate,width:stream.width,height:stream.height,elapsedMs:result.elapsedMs}));
 });
},660000);
test.skipIf(!gpu)("real H3 consumes VIDEO + sparse IMAGE + AUDIO reference slots without sample files",async()=>{
 await fixture(async f=>{
  const template=await createComfyTemplate("h3-ref2v-mixed-live",minimaxH3Ref2VBundledTemplate());
  const asset=await clip(f,60);
  const image=join(f.folder,"image.png"),audio=join(f.folder,"audio.wav");
  ffmpeg("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:size=64x64","-frames:v","1","-threads","1","-y",image]);
  ffmpeg("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","2","-c:a","pcm_s16le","-y",audio]);
  const imageAsset=await f.blobStore.put(createReadStream(image),{mime:"image/png"}),audioAsset=await f.blobStore.put(createReadStream(audio),{mime:"audio/wav"});
  const req=request(template,asset,"mixed",{prompt:"Use <Picture 1> as the color reference, <Video 1> as the motion reference, and <Audio 1> as the sound reference.",duration:2,megapixels:0.1,ref_image_size:"match"},"omni_reference");
  for(const [kind,port,media] of [["IMAGE","reference_image_3",imageAsset],["AUDIO","reference_audio_2",audioAsset]]){
   const sourceNodeId="source-"+kind.toLowerCase()+"-mixed",sourcePortId=kind.toLowerCase();
   req.externalInputs.push({kind:"asset",sourceNodeId,sourcePortId,valueKind:kind,assetId:media.blobId,sha256:media.blobId});
   req.edges.push({fromNodeId:sourceNodeId,fromPortId:sourcePortId,toNodeId:req.nodes[0].id,toPortId:port});
  }
  const result=await run(f,template,req,600000);
  const model=result.graph["w_workflow-mixed__129"].inputs;
  expect(Object.keys(model).filter(k=>/^ref_(images|videos|audios)\./.test(k)).sort()).toEqual(["ref_audios.ref_audio_2","ref_images.ref_image_3","ref_videos.ref_video_0"]);
  expect(model["ref_videos.ref_video_0"]).toEqual(["w_workflow-mixed__139",0]);
  expect(result.graph["w_workflow-mixed__132"].inputs.image).toBe("atelier_"+imageAsset.blobId+".png");
  expect(result.graph["w_workflow-mixed__138"].inputs.audio).toBe("atelier_"+audioAsset.blobId+".wav");
  const stream=JSON.parse(ffmpeg("ffprobe",["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=nb_read_frames,r_frame_rate,width,height","-of","json",result.file.path])).streams[0];
  expect(stream.r_frame_rate).toBe("24/1");expect(Number(stream.nb_read_frames)).toBeGreaterThanOrEqual(5);
  console.log("H3_REF2V_MIXED",JSON.stringify({frames:Number(stream.nb_read_frames),fps:stream.r_frame_rate,width:stream.width,height:stream.height,elapsedMs:result.elapsedMs}));
 });
},660000);

