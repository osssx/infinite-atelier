/** Update the registered MiniMax H3 preset to use an available VAE.
 * Default is a read-only dry run. --apply creates a NEW immutable template
 * revision and atomically rebinds the preset; it never submits a Job.
 * Usage: node scripts/minimax-h3-vae-update.mjs [--apply]
 */
import {DatabaseSync} from "node:sqlite";
import {createHash,randomUUID} from "node:crypto";
import {join} from "node:path";
import {loadBackendEnv} from "./load-backend-env.mjs";
import {resolveLocalDataDir} from "../server/backend/runtime.mjs";
import {createComfyRegistry,validateComfyTemplate} from "../server/backend/comfy-registry.mjs";
import {compileSingleWorkflow} from "../server/comfy-workflow/compiler.mjs";

const oldVae="minimax_h3_video_vae_int8_convrot_v2.safetensors";
const newVae="minimax_h3_video_vae_int8_convrot.safetensors";
const templateId="video-minimax-h3-i2v-turbo";
const apply=process.argv.slice(2).includes("--apply");
if(process.argv.slice(2).some(x=>x!=="--apply"))throw Error("unsupported_argument");
loadBackendEnv();
const root=resolveLocalDataDir();
const db=new DatabaseSync(join(root,"db","atelier.sqlite"),{readOnly:!apply});
db.exec("PRAGMA busy_timeout=3000");
const canonical=value=>Array.isArray(value)?value.map(canonical):
 value!==null&&typeof value==="object"?
 Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const ensure=(ok,code)=>{if(!ok)throw Error(code)};
try{
 const rows=db.prepare("SELECT id,name,template_id,revision,workflow_id,source,kind,parent_id FROM comfy_presets WHERE template_id=?").all(templateId);
 ensure(rows.length===1,"unique_minimax_preset_missing");
 const row=rows[0];
 const {readFileSync}=await import("node:fs");
 const old=db.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?")
  .get(templateId,row.revision);
 ensure(old?.workflow_hash,"registered_template_version_missing");
 const payload=JSON.parse(old.payload_json),graph=JSON.parse(readFileSync(join(root,"workflows",old.workflow_hash+".json"),"utf8"));
 let changed=0;
 for(const node of Object.values(graph)){
  if(node.class_type!=="VAELoader")continue;
  if(node.inputs?.vae_name===oldVae){node.inputs.vae_name=newVae;changed++;}
 }
 const already=Object.values(graph).some(node=>node.class_type==="VAELoader"&&node.inputs?.vae_name===newVae);
 ensure(changed===1||(changed===0&&already),"unexpected_vae_mapping");
 const requirements=structuredClone(payload.requirements);
 const assets=requirements.modelAssets;
 if(Array.isArray(assets)){
  const at=assets.indexOf(oldVae);
  if(at>=0)assets[at]=newVae;
  else ensure(assets.includes(newVae),"vae_requirement_missing");
 }
 const content={apiGraph:graph,ports:payload.ports,requirements,
  ...(payload.previewBinding!==undefined?{previewBinding:payload.previewBinding}:{}),
  ...(payload.mediaUseCase!==undefined?{mediaUseCase:payload.mediaUseCase}:{})};
 const revision=digest(content);
 const template=validateComfyTemplate({id:templateId,name:row.name,revision,...content});
 const origin=process.env.ATELIER_COMFY_URL||"http://127.0.0.1:8188";
 const infoResponse=await fetch(origin+"/object_info",{signal:AbortSignal.timeout(30000)});
 ensure(infoResponse.ok,"comfy_object_info_unavailable");
 const info=await infoResponse.json();
 ensure(info.VAELoader?.input?.required?.vae_name?.[0]?.includes(newVae),"vae_not_available_in_comfy");
 ensure(template.requirements.classTypes.every(type=>Boolean(info[type])),"missing_comfy_classes");
 const hash="a".repeat(64),nodeId="minimax-i2v-workflow";
 const request={schemaVersion:2,projectId:"vae-preflight-"+randomUUID().slice(0,8),
  canvasRevision:"3",instanceId:process.env.ATELIER_COMFY_INSTANCE_ID||"comfy-local",
  idempotencyKey:randomUUID(),rootOutputs:[{nodeId,portId:"video"}],
  nodes:[{id:nodeId,templateId:template.id,templateRevision:revision,
   inputOverrides:{prompt:"A ceramic teapot slowly rotates",duration:1,aspect_ratio:"1:1 (Square)",
    megapixels:0.2,lightning:true,lightning_steps:4,seed:42}}],
  edges:[{fromNodeId:"source",fromPortId:"image",toNodeId:nodeId,toPortId:"first_frame"}],
  externalInputs:[{kind:"asset",sourceNodeId:"source",sourcePortId:"image",
   valueKind:"IMAGE",assetId:hash,sha256:hash}],runOptions:{}};
 const compiled=compileSingleWorkflow(request,template,{info,mediaFiles:{[hash]:"atelier_"+hash+".png"}});
 ensure(compiled.decisions.first_frame==="edge"&&compiled.captureMap.some(x=>x.kind==="video"),"minimax_compile_invalid");
 const infoLog={event:"MINIMAX_VAE_PREFLIGHT_PASS",applied:false,originalRevision:row.revision,
  proposedRevision:revision,vae:newVae,workflowNodes:Object.keys(compiled.graph).length,
  fromTrustedImage:true,proposedChanges:changed,noJobSubmitted:true};
 console.log(JSON.stringify(infoLog));
 if(apply&&changed===1){
  // Native workflow registry API publishes immutable graph bytes, then
  // atomically inserts the version and updates ONLY this preset binding.
  const current=db.prepare("SELECT revision FROM comfy_presets WHERE id=?").get(row.id);
  ensure(current?.revision===row.revision,"preset_changed_during_preflight");
  const registry=createComfyRegistry(db,{workflowsDir:join(root,"workflows")});
  const {workflowHash}=registry.publishWorkflowGraph(row.workflow_id,graph);
  const saved=registry.savePresetBinding({
   id:row.id,name:row.name,templateId,revision,workflowId:row.workflow_id,
   source:row.source,kind:row.kind,...(row.parent_id?{parentId:row.parent_id}:{})
  },workflowHash,{id:templateId,name:row.name,revision,ports:payload.ports,requirements,
   ...(payload.previewBinding!==undefined?{previewBinding:payload.previewBinding}:{}),
   ...(payload.mediaUseCase!==undefined?{mediaUseCase:payload.mediaUseCase}:{})});
  registry.setVersionNote(templateId,revision,"MiniMax H3 VAE: use installed "+newVae+"; previous revision retained");
  ensure(registry.find(templateId,revision)?.apiGraph?.["105_11"]?.inputs?.vae_name===newVae,
   "registered_version_verification_failed");
  console.log(JSON.stringify({event:"MINIMAX_VAE_PRESET_UPDATED",applied:true,
   presetId:saved.id,oldRevision:row.revision,newRevision:revision,vae:newVae,noJobSubmitted:true}));
 }else if(apply)console.log(JSON.stringify({event:"MINIMAX_VAE_ALREADY_ACTIVE",revision,vae:newVae,noJobSubmitted:true}));
}finally{db.close()}
