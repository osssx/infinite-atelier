import test from "node:test";
import assert from "node:assert/strict";
import {fingerprintSource,fingerprintSourceLegacy,matchesSourceFingerprint} from "./repository.mjs";
// Node 24 can erase TS-only imports; exercise the actual browser implementation.
import {fingerprintBackendSource} from "../../src/features/backend-sync/backend-source-fingerprint.ts";

const base={nodes:[
 {id:"prompt",type:"text",title:"Prompt",position:{x:0,y:10},width:420,height:320,
  metadata:{content:"draw mountains",status:"idle",fontSize:14}},
 {id:"image",type:"image",title:"Photo",position:{x:100,y:300},width:400,height:400,
  metadata:{images:[{id:"i1",storageKey:"cas:"+"a".repeat(64),content:"/api/v1/blobs/"+"a".repeat(64),
   status:"success",mimeType:"image/png",naturalWidth:100,naturalHeight:100,bytes:100}],primaryImageId:"i1"}},
 {id:"comfy",type:"comfy:workflow",title:"Generate",position:{x:1000,y:0},width:360,height:250,
  metadata:{comfyWorkflow:{templateId:"t1",templateRevision:"r1",bindingState:"bound",
   inputOverrides:{prompt:"tiger",seed:1}},
   comfyPorts:[{id:"output",direction:"source",valueKind:"IMAGE",label:"Image"}],
   comfyExecution:{runId:"r1",status:"queued"}}}
],connections:[{id:"text-link",fromNodeId:"prompt",fromPortId:"text",toNodeId:"comfy",toPortId:"prompt"},
 {id:"image-link",fromNodeId:"image",fromPortId:"image",toNodeId:"comfy",toPortId:"photo"}]};
const change=(fn)=>{const value=structuredClone(base);fn(value);return value};

test("v2 source fingerprint agrees with browser, remains stable under cosmetic and output changes",async()=>{
 const initial=fingerprintSource(base,"comfy");
 assert.match(initial,/^v2:[a-f0-9]{64}$/);
 assert.equal(await fingerprintBackendSource(base,"comfy"),initial);
 const shifted=change(doc=>{
  for(const n of doc.nodes){n.position={x:n.position.x+120,y:42};n.width=250;n.height=250;
   n.title+=" renamed";n.metadata.status="loading";n.metadata.errorDetails="display only";
  }
  doc.nodes[0].metadata.comfyExecution={runId:"another",status:"succeeded"};
  doc.nodes[1].metadata.images[0].status="error";
  doc.nodes[2].metadata.comfyWorkflow.lastRunId="recent";
  doc.nodes[2].metadata.comfyWorkflow.bindingState="needs-instance-binding";
  doc.connections[0].id="regenerated-ui-id";
 });
 assert.notEqual(fingerprintSourceLegacy(shifted,"comfy"),fingerprintSourceLegacy(base,"comfy"));
 assert.equal(fingerprintSource(shifted,"comfy"),initial);
 assert.equal(await fingerprintBackendSource(shifted,"comfy"),initial);
 const output=change(doc=>{
  doc.nodes.push({id:"artifact-1",type:"image",title:"Result",position:{x:1,y:1},width:100,height:100,
   metadata:{storageKey:"cas:"+"f".repeat(64)}});
  doc.connections.push({id:"result-edge",fromNodeId:"comfy",fromPortId:"output",toNodeId:"artifact-1",toPortId:"comfy-artifact"});
 });
 assert.equal(fingerprintSource(output,"comfy"),initial);
});
test("v2 fingerprints block edits to frozen text, image selection, workflow overrides and incoming edges",async()=>{
 const initial=fingerprintSource(base,"comfy");
 const edits=[
  doc=>{doc.nodes[0].metadata.content="different prompt"},
  doc=>{doc.nodes[1].metadata.images[0].storageKey="cas:"+"b".repeat(64)},
  doc=>{doc.nodes[1].metadata.primaryImageId="new-choice"},
  doc=>{doc.nodes[2].metadata.comfyWorkflow.inputOverrides.seed=2},
  doc=>{doc.connections[0].toPortId="other"},
  doc=>{doc.connections.pop()},
  doc=>{doc.nodes[2].metadata.comfyPorts[0].valueKind="STRING"},
  doc=>{doc.nodes[1].metadata.model="other"}
 ];
 for(const edit of edits){
  const graph=change(edit);
  assert.notEqual(fingerprintSource(graph,"comfy"),initial);
  assert.equal(await fingerprintBackendSource(graph,"comfy"),fingerprintSource(graph,"comfy"));
 }
});
test("legacy already-collected standalone Comfy request can recover only verified frozen inputs",()=>{
 const doc={nodes:[structuredClone(base.nodes[2])],connections:[]};
 const legacy=fingerprintSourceLegacy(doc,"comfy");
 const frozen={adapterKind:"comfy",instanceId:"comfy-local",
  comfyTemplate:{id:"t1",revision:"r1"},comfyRequest:{instanceId:"comfy-local",
   nodes:[{id:"comfy",templateId:"t1",templateRevision:"r1",inputOverrides:{prompt:"tiger",seed:1}}],
   edges:[],externalInputs:[]}};
 const altered=structuredClone(doc);
 altered.nodes[0].position.x=999;
 altered.nodes[0].title="Moved";
 assert.notEqual(fingerprintSourceLegacy(altered,"comfy"),legacy);
 assert.equal(matchesSourceFingerprint(altered,"comfy",legacy,frozen),true);
 // Observed from the real 2026-10-27 blocked job: a previous successful
 // standalone job has no current instanceId and is now marked unbound.
 const unbound=structuredClone(altered);
 unbound.nodes[0].metadata.comfyWorkflow.bindingState="needs-instance-binding";
 delete unbound.nodes[0].metadata.comfyWorkflow.instanceId;
 assert.equal(matchesSourceFingerprint(unbound,"comfy",legacy,frozen),true);
 // Changing the actual GPU target or overriding a prompt remains prohibited.
 const changedInstance=structuredClone(unbound);
 changedInstance.nodes[0].metadata.comfyWorkflow.instanceId="different-instance";
 assert.equal(matchesSourceFingerprint(changedInstance,"comfy",legacy,frozen),false);
 const incompatible=structuredClone(unbound);
 incompatible.nodes[0].metadata.comfyWorkflow.bindingState="incompatible";
 assert.equal(matchesSourceFingerprint(incompatible,"comfy",legacy,frozen),false);
 const tamperedPrompt=structuredClone(unbound);
 tamperedPrompt.nodes[0].metadata.comfyWorkflow.inputOverrides.prompt="different";
 assert.equal(matchesSourceFingerprint(tamperedPrompt,"comfy",legacy,frozen),false);
 const unsafe=structuredClone(altered);unsafe.nodes[0].metadata.comfyWorkflow.inputOverrides.seed=2;
 assert.equal(matchesSourceFingerprint(unsafe,"comfy",legacy,frozen),false);
 assert.equal(matchesSourceFingerprint(altered,"comfy",legacy,{
  ...frozen,comfyRequest:{...frozen.comfyRequest,externalInputs:[{kind:"asset"}]}}),false);
 assert.equal(matchesSourceFingerprint(altered,"comfy",legacy,{adapterKind:"model"}),false);
 const withEdge=structuredClone(altered);
 withEdge.nodes.push({id:"media",type:"image"});
 withEdge.connections.push({id:"e",fromNodeId:"media",toNodeId:"comfy"});
 assert.equal(matchesSourceFingerprint(withEdge,"comfy",legacy,frozen),false);
 assert.equal(matchesSourceFingerprint(doc,"comfy",legacy,{}),true);
});
