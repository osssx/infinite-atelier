import {describe,it,expect} from "vitest";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import {rebaseCanvasArtifactAdditions} from "./canvas-artifact-save-rebase";

const prompt=(title="Prompt"):CanvasNodeData=>({id:"prompt",type:"text",title,
 position:{x:0,y:0},width:240,height:180,metadata:{content:"original"}});
const generated=(id="a1"):CanvasNodeData=>({id:"artifact-"+id,type:"video",title:"Generated video",
 position:{x:280,y:0},width:420,height:236,
 metadata:{storageKey:"cas:"+"a".repeat(64),content:"/api/v1/blobs/"+"a".repeat(64),
 comfyArtifact:{runId:"j1",artifactId:id,workflowNodeId:"prompt",
 portId:"out",kind:"video",index:0}}});
const link:CanvasConnection={id:"artifact-edge-a1",fromNodeId:"prompt",toNodeId:"artifact-a1",
 fromPortId:"out",toPortId:"comfy-artifact"};

describe("SQLite autosave rebase after backend materialization",()=>{
 it("keeps an edited prompt and remotely added video with its connection",()=>{
  const base={nodes:[prompt()],connections:[]};
  const local={nodes:[{...prompt(),metadata:{content:"replaced during generation"}}],connections:[]};
  const remote={nodes:[prompt(),generated()],connections:[link]};
  const merged=rebaseCanvasArtifactAdditions(base,local,remote)!;
  expect(merged).not.toBeNull();
  expect(merged.nodes).toHaveLength(2);
  expect(merged.nodes[0].metadata?.content).toBe("replaced during generation");
  expect(merged.nodes[1].metadata?.comfyArtifact?.artifactId).toBe("a1");
  expect(merged.connections).toEqual([link]);
 });
 it("keeps generated artifact detached if its original source was deleted locally",()=>{
  const result=rebaseCanvasArtifactAdditions({nodes:[prompt()],connections:[]},
   {nodes:[],connections:[]},{nodes:[prompt(),generated()],connections:[link]})!;
  expect(result.nodes.map(n=>n.id)).toEqual(["artifact-a1"]);
  expect(result.connections).toEqual([]);
 });
 it("preserves an existing local user edge alongside a detached remote result",()=>{
  const user={id:"user",type:"text",title:"User",position:{x:5,y:5},width:100,height:100};
  const localEdge={id:"user-edge",fromNodeId:"prompt",toNodeId:"user"};
  const result=rebaseCanvasArtifactAdditions({nodes:[prompt()],connections:[]},
   {nodes:[prompt(),user],connections:[localEdge]},
   {nodes:[prompt(),generated()],connections:[]})!;
  expect(result.nodes).toHaveLength(3);
  expect(result.connections).toEqual([localEdge]);
 });
 it("rejects remote edits to existing nodes and edges or ID collisions",()=>{
  const original={nodes:[prompt()],connections:[]};
  const local={nodes:[{...prompt(),title:"Local"}],connections:[]};
  const mutatedRemote={nodes:[{...prompt(),title:"Other tab"},generated()],connections:[link]};
  expect(rebaseCanvasArtifactAdditions(original,local,mutatedRemote)).toBeNull();
  expect(rebaseCanvasArtifactAdditions(original,
   {nodes:[prompt(),generated()],connections:[]},
   {nodes:[prompt(),{...generated(),title:"Different"}],connections:[]})).toBeNull();
  expect(rebaseCanvasArtifactAdditions(original,local,
   {nodes:[prompt(),{...generated(),metadata:{content:"spoof"}}],connections:[]})).toBeNull();
  expect(rebaseCanvasArtifactAdditions(original,local,
   {nodes:[prompt(),generated()],connections:[
    {...link,fromNodeId:"prompt",fromPortId:"wrong"}]})).toBeNull();
 });
});
