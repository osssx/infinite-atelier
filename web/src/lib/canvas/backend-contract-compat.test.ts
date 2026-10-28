import {beforeAll,describe,expect,it,vi} from "vitest";
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {registerBuiltinNodes} from "@/components/canvas/nodes/builtin-nodes";
import {COMFY_WORKFLOW_MOCK_TYPE} from "./canvas-ports";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {reconcileComfyArtifactConnections,validateCanvasPortConnections} from "./canvas-port-connections";
import {attachComfyArtifactMetadata} from "../../../server/backend/comfy-provenance.mjs";

beforeAll(()=>registerBuiltinNodes());
const kinds=[
 {kind:"image",type:CanvasNodeType.Image,port:"out-image",socket:"IMAGE"},
 {kind:"video",type:CanvasNodeType.Video,port:"out-video",socket:"VIDEO"},
 {kind:"audio",type:CanvasNodeType.Audio,port:"out-audio",socket:"AUDIO"},
 {kind:"text",type:CanvasNodeType.Text,port:"out-text",socket:"STRING"},
] as const;
const node=(id:string,type:string,metadata:CanvasNodeData["metadata"]={}):CanvasNodeData=>
 ({id,type,title:id,position:{x:0,y:0},width:400,height:240,
  metadata:type===COMFY_WORKFLOW_MOCK_TYPE&&metadata?.comfyPorts
   ?{...metadata,comfyWorkflow:{templateId:"test-template",templateRevision:"a".repeat(64),
      bindingState:"bound",inputOverrides:{}}}:metadata});

describe("server-side Comfy provenance remains compatible with client port validation",()=>{
 it("can connect four typed generated artifacts with the existing canvas validation",()=>{
  const workflow=node("wf",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:kinds.map(k=>({
   id:k.port,label:k.port,direction:"source" as const,valueKind:k.socket
  }))});
  const outputs=kinds.map((k,i)=>node("out-"+i,k.type,attachComfyArtifactMetadata({},{
   runId:"run",artifactId:"art-"+i,workflowNodeId:"wf",portId:k.port,kind:k.kind,index:i
  })));
  const all=[workflow,...outputs];
  const edges=reconcileComfyArtifactConnections(all,[],(()=>{let index=0;return()=>String(++index)})());
  expect(edges).toHaveLength(4);
  expect(validateCanvasPortConnections(all,edges)).toEqual([]);
  expect(edges[0].toPortId).toBe("comfy-artifact");
  expect(reconcileComfyArtifactConnections(all,edges,()=>{throw Error("duplicate")})).toEqual(edges);
 });
 it("preserves archived artifact but cannot connect a wrong source port",()=>{
  const workflow=node("wf",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:[
   {id:"image",label:"Image",direction:"source",valueKind:"IMAGE"}
  ]});
  const bad=node("bad",CanvasNodeType.Image,attachComfyArtifactMetadata({},{
   runId:"run",artifactId:"a",workflowNodeId:"wf",portId:"missing",kind:"image",index:0
  }));
  expect(reconcileComfyArtifactConnections([workflow,bad],[],()=> "new")).toEqual([]);
 });
});
