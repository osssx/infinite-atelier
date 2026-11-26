// @vitest-environment happy-dom
/** Explicit opt-in, read-only registered MiniMax template acceptance. No jobs,
 * provider requests, user-project writes or media downloads. CAS HEAD is a test
 * double; real object_info / compiler pruning / GPU execution remain live gates.
 * ATELIER_TEST_CONFIGURED_VIDEO=1 npm exec -- vitest run drama-video-p6-configured
 */
import {execFileSync} from "node:child_process";
import {describe,it,expect,vi,beforeAll,afterEach} from "vitest";
import {validateSingleRequest,verifyTemplate} from "../../../server/comfy-workflow/compiler.mjs";
import {verifyComfyTemplate,type ComfyWorkflowTemplate} from "@/features/comfy-workflow/template-schema";
import {defaultConfig} from "@/stores/use-config-store";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import {prepareBackendComfyWorkflowRun} from "@/features/backend-sync/backend-comfy-run";
import {buildNodeGenerationContext} from "@/components/canvas/canvas-node-generation";
import {applyDramaProduction,type DramaShotProduction,type DramaVideoInput} from "./drama-pipeline-media";
import {auditDramaProduction,listDramaProductionCapabilities} from "./drama-production-audit";
import {planDramaBatchVideoConfigs} from "./drama-video-config";

const registered=vi.hoisted(()=>({template:null as ComfyWorkflowTemplate|null}));
vi.mock("@/features/comfy-workflow/template-registry",()=>({getComfyTemplate:async(id:string,revision:string)=>
 registered.template?.id===id&&registered.template.revision===revision?registered.template:null}));
afterEach(()=>vi.unstubAllGlobals());
describe.skipIf(process.env.ATELIER_TEST_CONFIGURED_VIDEO!=="1")("P6 installed MiniMax FL2V read-only acceptance",()=>{
 let template:ComfyWorkflowTemplate;
 beforeAll(async()=>{
  // Run registry composition in native Node (not Vite's browser URL shim).
  // Only the selected workflow is returned in memory; never log its prompt or
  // user settings, and do not open the live backend runtime for writes.
  const read=String.raw`
   import{DatabaseSync}from"node:sqlite";
   import{join}from"node:path";
   import{resolveLocalDataDir}from"./server/backend/runtime.mjs";
   import{loadBackendEnv}from"./scripts/load-backend-env.mjs";
   import{createComfyRegistry}from"./server/backend/comfy-registry.mjs";
   loadBackendEnv();
   const root=resolveLocalDataDir(),db=new DatabaseSync(join(root,"db","atelier.sqlite"),{readOnly:true});
   try{
    const preset=db.prepare("SELECT template_id,revision FROM comfy_presets WHERE template_id=? ORDER BY name LIMIT 1").get("video-minimax-h3-fl2v-turbo");
    if(!preset)throw Error("configured MiniMax FL2V preset missing");
    const row=db.prepare("SELECT workflow_hash FROM comfy_template_versions WHERE template_id=? AND revision=?").get(preset.template_id,preset.revision);
    if(!row?.workflow_hash)throw Error("registered graph must already be migrated");
    const template=createComfyRegistry(db,{workflowsDir:join(root,"workflows")}).find(preset.template_id,preset.revision);
    process.stdout.write(JSON.stringify(template));
   }finally{db.close();}
  `;
  template=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",read],{encoding:"utf8",timeout:20000,maxBuffer:8*1024*1024}));
  await verifyComfyTemplate(template);verifyTemplate(template);
  registered.template=template;
  expect(template.mediaUseCase?.channel).toBe("video");
 });
 it("freezes three independent real-template configurations and prepares the actual submission requests without dispatch",async()=>{
  const target={kind:"comfy" as const,templateId:template.id,templateRevision:template.revision};
  const config={...defaultConfig,comfyWorkflowDefaults:{video:{templateId:template.id,templateRevision:template.revision}}};
  const capabilities=await listDramaProductionCapabilities(config);
  const modes=["text_to_video","first_frame","first_last_frame"] as const;
  const key=(char:string)=>"cas:"+char.repeat(64);
  const settings:Record<string,DramaShotProduction>={};
  const prepared:DramaVideoInput[]=[];
  for(const [index,mode] of modes.entries()){
   expect(capabilities.modes.find(m=>m.mode===mode)?.available).toBe(true);
   const shot={id:"p6-shot-"+index,episodeId:"p6-episode",order:index+1,description:"Synthetic forest scene",durationSec:5,
    characterVariantIds:[],propIds:[],keyPropIds:[]};
   const setting:DramaShotProduction={mode,target,promptOverride:{text:"P6 synthetic manual prompt "+mode,sourceFingerprint:"test"},durationSec:7,aspectRatio:"9:16",
    ...(index?{firstFrame:key("a")}:{}) ,...(index===2?{lastFrame:key("b")}:{})};
   settings[shot.id]=setting;
   const input=applyDramaProduction({shot,prompt:"Automatic prompt",referenceImages:[]},setting);
   const audit=await auditDramaProduction(input,config,{setting,sourceRevisionId:"v1",visualStyle:"Do not append this style"});
   // The currently installed preset has no duration/ratio mapping. In future
   // revisions adapt these test planning values to the actual declared limits.
   expect(audit.ready,audit.error).toBe(true);
   expect(audit.input?.productionSnapshot?.manualPrompt).toBe(true);
   expect(audit.input?.productionSnapshot?.prompt).toBe(setting.promptOverride?.text);
   for(const key of ["duration_seconds","aspect_ratio"] as const){
    expect(audit.input?.productionSnapshot?.workflowControlledParameters?.includes(key)).toBe(!audit.input?.comfyParameterPorts?.[key]);
   }
   prepared.push(audit.input!);
  }
  const source=createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmedVersionId:"v1",dramaShotProduction:settings});
  const {graph,result}=planDramaBatchVideoConfigs(source,prepared.map(i=>i.shot),prepared,[source],[]);
  expect(result.failures).toEqual([]);expect(result.createdShotIds).toHaveLength(3);
  const bridge={state:{status:"connected"},assertNoActiveJob:vi.fn(async()=>{}),assertComfyReady:vi.fn(async()=>{}),
   saveProjectNow:vi.fn(async()=>{throw Error("read-only acceptance attempted save")}),
   uploadFrozenBlob:vi.fn(async()=>{throw Error("read-only acceptance attempted upload")}),
   submitFrozenJob:vi.fn(async()=>{throw Error("read-only acceptance attempted submit")})};
  const head=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   expect(init?.method).toBe("HEAD");return new Response(null,{status:200,headers:{"content-type":"image/png","content-length":"128"}});
  });vi.stubGlobal("fetch",head);
  for(const [index,mode] of modes.entries()){
   const node=graph.nodes.find(n=>n.id===graph.configIds[index])!;
   const binding=node.metadata!.comfyWorkflowSelections!.video!;
   const prompt=buildNodeGenerationContext(node.id,graph.nodes,graph.connections,node.metadata!.prompt!).prompt;
   const run=await prepareBackendComfyWorkflowRun({bridge,projectId:"p6-fixture",workflowNode:node,nodes:graph.nodes,connections:graph.connections,
    template,instanceId:"comfy-local",outputPortIds:[template.mediaUseCase!.primaryOutputPortId],prompt,mediaBinding:binding,workflowMode:"video",generationMode:mode},{readOnly:true});
   const req={...run.comfyRequest,projectId:"p6-fixture",canvasRevision:"1",idempotencyKey:"p6-"+index};
   expect(()=>validateSingleRequest(req,template)).not.toThrow();
   expect(req.runOptions.mediaMode).toBe(mode);
   expect(req.nodes[0].templateRevision).toBe(template.revision);
   const mapping=template.mediaUseCase!.modeBindings![mode]!;
   const promptPort=mapping.promptPortId??template.mediaUseCase!.promptPortId;
   expect(req.nodes[0].inputOverrides[promptPort]).toBe(prompt);
   expect(prompt.startsWith(settings[prepared[index].shot.id].promptOverride!.text)).toBe(true);
   expect(prompt).not.toMatch(/@\[node:|Do not append this style|Automatic prompt/);
   expect(req.externalInputs.map(x=>x.assetId)).toEqual(index===0?[]:index===1?["a".repeat(64)]:["a".repeat(64),"b".repeat(64)]);
   expect(req.edges.map(x=>x.toPortId).sort()).toEqual(Object.values(mapping.rolePorts??{}).flat().sort());
   console.log("P6_CONFIGURED_REQUEST",JSON.stringify({template:template.name,mode,mediaCount:req.externalInputs.length,promptExactPrefix:true,
    mappedParameters:Object.keys(mapping.parameterPorts??{}),workflowControlled:prepared[index].productionSnapshot?.workflowControlledParameters}));
  }
  expect(bridge.saveProjectNow).not.toHaveBeenCalled();expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();expect(bridge.submitFrozenJob).not.toHaveBeenCalled();
  expect(head).toHaveBeenCalledTimes(3);
 });
});
