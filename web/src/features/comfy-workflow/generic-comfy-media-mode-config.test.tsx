// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {createElement,type ReactElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ComfyMediaUseCaseEditor} from "./comfy-media-use-case-editor";
import {ComfyGenerationModeControl} from "./comfy-generation-mode-control";
import {templatePayloadFromGraph,createComfyTemplate,validateComfyTemplatePayload,type ComfyTemplatePayload,type ComfyObjectInfo} from "./template-schema";
import {assignComfyMediaSlots,resolveComfyMediaMode} from "./comfy-media-slot-assignment";
import {compileSingleWorkflow} from "../../../server/comfy-workflow/compiler.mjs";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";

const graph={
 "photo-loader-a":{class_type:"LoadImage",inputs:{image:"sample-a.png"}},
 "photo-loader-b":{class_type:"LoadImage",inputs:{image:"sample-b.png"}},
 "sampler":{class_type:"UnrecognizedVideoSampler",inputs:{description:"template prompt",ref_a:["photo-loader-a",0],ref_b:["photo-loader-b",0]}}
};
const info:ComfyObjectInfo={
 LoadImage:{input:{required:{image:["STRING",{}]}},output:["IMAGE","MASK"]},
 UnrecognizedVideoSampler:{input:{required:{description:["STRING",{}]},optional:{ref_a:["IMAGE",{}],ref_b:["IMAGE",{}]}},output:["VIDEO"]},
 SaveVideo:{input:{required:{video:["VIDEO",{}],filename_prefix:["STRING",{}]},optional:{format:[["auto"],{}],codec:[["auto"],{}]}},output:[]}
};
function walk(el:unknown):ReactElement[]{
 if(Array.isArray(el))return el.flatMap(walk);
 if(!el||typeof el!=="object"||!("props" in el))return [];
 return [el as ReactElement,...walk((el as ReactElement<{children?:unknown}>).props.children)];
}
const props=(el:ReactElement)=>el.props as Record<string,any>;
const rolePort=(id:string,nodeId:string,label:string):ComfyTemplatePayload["ports"][number]=>({id,label,direction:"target",valueKind:"IMAGE",required:false,inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId,inputName:"image"}]},absentPolicy:{mode:"auto-prune"}});

function configuredUnknownWorkflow(){
 const draft=templatePayloadFromGraph("unrecognized.json",graph);
 draft.ports=[
  rolePort("slot-A","photo-loader-a","Image A"),rolePort("slot-B","photo-loader-b","Image B"),
  {id:"description",label:"Description",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"sampler",inputName:"description"}]}},
  {id:"result",label:"Result",direction:"source",valueKind:"VIDEO",outputBinding:{nodeId:"sampler",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}
 ];
 const controls=()=>walk(ComfyMediaUseCaseEditor({template:draft,onChange:next=>{draft.mediaUseCase=next;}}));
 const outputType=controls().find(e=>props(e).options?.some((o:any)=>o.value==="video")&&props(e).options?.some((o:any)=>o.value==="audio"))!;
 props(outputType).onChange("video");
 props(controls().find(e=>props(e).placeholder==="选择 STRING literal 端口")!).onChange("description");
 props(controls().find(e=>props(e).placeholder==="选择可采集输出")!).onChange("result");
 // Expose the existing ordinary media ports through the editor's slot controls.
 for(const label of ["Image A","Image B"]){
  const row=controls().find(e=>e.type==="label"&&walk(props(e).children).some(c=>props(c).title===label+" · IMAGE"))!;
  props(walk(props(row).children).find(c=>typeof props(c).checked==="boolean")!).onChange({target:{checked:true}});
 }
 props(controls().find(e=>props(e).children==="配置显式能力")!).onClick();
 const mode=(label:string)=>props(controls().find(e=>props(e).children===label&&typeof props(e).checked==="boolean")!).onChange({target:{checked:true}});
 const role=(id:string)=>props(walk(controls().find(e=>props(e)["data-comfy-mode-role"]===id)!).find(e=>props(e).placeholder==="确认角色对应的端口")!);
 mode("文生视频");mode("首帧生成");mode("尾帧生成");mode("首尾帧生成");mode("全能参考");
 role("first_frame:first_frame").onChange(["slot-B"]);
 role("last_frame:last_frame").onChange(["slot-A"]);
 role("first_last_frame:first_frame").onChange(["slot-B"]);
 // Same socket is permitted across modes, but not twice within one mode.
 expect(role("first_last_frame:last_frame").options.find((o:any)=>o.value==="slot-B").disabled).toBe(true);
 role("first_last_frame:last_frame").onChange(["slot-B","slot-A"]);
 role("omni_reference:reference_image").onChange(["slot-B","slot-A"]);
 return draft;
}
const node=(id:string,type="image"):CanvasNodeData=>({id,type,title:id,position:{x:0,y:0},width:100,height:100,metadata:{content:"blob:"+id}});
const edge=(id:string,toPortId?:string):CanvasConnection=>({id,fromNodeId:id,toNodeId:"target",...(toPortId?{fromPortId:"image",toPortId}:{})});

describe("generic Comfy media configuration",()=>{
 it("imports arbitrary node and port identifiers, configures every video mode through the same editor, and saves",async()=>{
  const draft=configuredUnknownWorkflow(),use=draft.mediaUseCase!;
  expect(use.modeBindings?.first_frame?.rolePorts).toEqual({first_frame:["slot-B"]});
  expect(use.modeBindings?.last_frame?.rolePorts).toEqual({last_frame:["slot-A"]});
  expect(use.modeBindings?.first_last_frame?.rolePorts).toEqual({first_frame:["slot-B"],last_frame:["slot-A"]});
  expect(use.modeBindings?.omni_reference?.rolePorts).toEqual({reference_image:["slot-B","slot-A"],reference_video:[],reference_audio:[]});
  // Image-only omni reference does not require phantom audio or video slots.
  expect(use.mediaCapabilities?.modes.find(m=>m.id==="omni_reference")?.inputs).toMatchObject([{role:"reference_image",minItems:0,maxItems:2},{role:"reference_video",minItems:0,maxItems:0},{role:"reference_audio",minItems:0,maxItems:0}]);
  expect(()=>validateComfyTemplatePayload(draft,info)).not.toThrow();
  const t=await createComfyTemplate("generic-video",draft,info);
  const html=renderToStaticMarkup(createElement(ComfyGenerationModeControl,{template:t,value:"first_last_frame",onChange:()=>{}}));
  expect(html).toContain("首帧：Image B；尾帧：Image A");
  expect(html).toContain("不会自动添加提示词");
  const nodes=[node("target","video"),node("a"),node("b")];
  expect(assignComfyMediaSlots(t,"target",nodes,[edge("a"),edge("b")],"first_last_frame")).toEqual({slots:{"slot-B":{nodeId:"a"},"slot-A":{nodeId:"b"}},errors:[]});
  // A typed edge to a specific slot must win; automatic selection must not guess a different role.
  expect(resolveComfyMediaMode(t,"target",[node("target","comfy:workflow"),node("a")],[edge("a","slot-A")])).toBe("last_frame");
  const defaultOmni={...t,mediaUseCase:{...use,mediaCapabilities:{...use.mediaCapabilities!,defaultMode:"omni_reference" as const}}};
  expect(resolveComfyMediaMode(defaultOmni,"target",nodes,[])).toBe("text_to_video");
 });
 it("compiles all configured modes for an unknown graph and preserves the user's exact prompt",async()=>{
  const t=await createComfyTemplate("generic-video",configuredUnknownWorkflow(),info);
  const userPrompt="Keep  spaces. <Custom 1>\n自定义用户提示词";
  for(const [mode,slots] of [["text_to_video",[]],["first_frame",["slot-B"]],["last_frame",["slot-A"]],["first_last_frame",["slot-B","slot-A"]],["omni_reference",["slot-B","slot-A"]]] as const){
   const externalInputs=slots.map((_,i)=>({kind:"asset",sourceNodeId:"picture-"+i,sourcePortId:"image",valueKind:"IMAGE",assetId:String(i+1).repeat(64),sha256:String(i+1).repeat(64)}));
   const req={schemaVersion:2,projectId:"p",canvasRevision:"1",instanceId:"local",idempotencyKey:"generic-"+mode,nodes:[{id:"target",templateId:t.id,templateRevision:t.revision,inputOverrides:{description:userPrompt}}],rootOutputs:[{nodeId:"target",portId:"result"}],edges:slots.map((slot,i)=>({fromNodeId:"picture-"+i,fromPortId:"image",toNodeId:"target",toPortId:slot})),externalInputs,runOptions:{mediaMode:mode}};
   const mediaFiles=Object.fromEntries(externalInputs.map(input=>[input.assetId,"staged-"+input.assetId+".png"]));
   const result=compileSingleWorkflow(req,t,{info,mediaFiles});
   const compiled=result.graph["w_target__sampler"].inputs;
   expect(compiled.description).toBe(userPrompt);
   expect(Boolean(compiled.ref_a)).toBe(slots.includes("slot-A" as never));
   expect(Boolean(compiled.ref_b)).toBe(slots.includes("slot-B" as never));
   if(mode==="first_last_frame")expect(()=>compileSingleWorkflow({...req,edges:req.edges.slice(0,1),externalInputs:req.externalInputs.slice(0,1)},t,{info,mediaFiles})).toThrow(/template_media_request_invalid/);
  }
 });
});
