import {describe,it,expect} from "vitest";
import {initialHydrationNeedsGraphSave} from "./canvas-initial-hydration";

describe("P4.5f refresh-safe initial canvas hydration",()=>{
 const nodes=[{id:"source",type:"image",metadata:{status:"idle",storageKey:"cas:sha"}},
  {id:"workflow",type:"comfy:workflow",metadata:{comfyWorkflow:{templateId:"fixed",templateRevision:"v1"}}}];
 const edges=[{id:"fixed-edge",fromNodeId:"source",fromPortId:"image",
  toNodeId:"workflow",toPortId:"first_frame"}];
 it("does not treat fresh object identity or runtime image preview hydration as a saved graph mutation",()=>{
  const reset=structuredClone(nodes);
  const reconciled=structuredClone(edges);
  const preview=[...reset.map(n=>({...n,metadata:{...n.metadata,runtimePreview:"blob:local"}}))];
  expect(preview).not.toEqual(nodes);
  // The preview is browser-only: compare BEFORE adding runtime media URLs.
  expect(initialHydrationNeedsGraphSave({persistedNodes:nodes,
   persistedConnections:edges,resetNodes:reset,reconciledConnections:reconciled})).toBe(false);
 });
 it("keeps the real interrupted generation reset eligible for persistence",()=>{
  const running=[{id:"image",type:"image",metadata:{status:"generating"}}];
  const reset=[{id:"image",type:"image",metadata:{status:"idle"}}];
  expect(initialHydrationNeedsGraphSave({persistedNodes:running,
   persistedConnections:[],resetNodes:reset,reconciledConnections:[]})).toBe(true);
 });
 it("keeps real invalid connection repair eligible for persistence",()=>{
  expect(initialHydrationNeedsGraphSave({persistedNodes:nodes,
   persistedConnections:edges,resetNodes:structuredClone(nodes),
   reconciledConnections:[]})).toBe(true);
 });
});
