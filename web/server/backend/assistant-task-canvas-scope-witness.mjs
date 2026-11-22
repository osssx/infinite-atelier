/** P3.3g. Versioned, read-only scope witness for a frozen Canvas Step.
 *
 * This is an additional fail-closed preflight, never an alternative to the
 * full projectGraphDigest or to approval/Task/Run source checks. It uses the
 * persisted compact graph and hydrates only the roots and their transitive
 * upstream nodes. It has no writes, inference or provider access.
 */
import {createHash} from "node:crypto";
import {hydrateCreativeDocument} from "./creative-payloads.mjs";
import {stableJson} from "./repository.mjs";

const fail=()=>Object.assign(Error("assistant_step_source_changed"),
 {code:"assistant_step_source_changed",statusCode:409});
const hash=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const fields=["nodeId","groupId","fromNodeId","toNodeId","from","to"];
const compareId=(a,b)=>a<b?-1:a>b?1:0;
function actionRoots(document,actions){
 const known=new Set((document.nodes??[]).map(node=>node.id));
 const byEdge=new Map((document.connections??[]).map(edge=>[edge.id,edge]));
 const names=new Set();
 for(const action of actions){
  for(const key of fields)if(typeof action[key]==="string")names.add(action[key]);
  for(const key of ["nodeIds","members"])if(Array.isArray(action[key]))
   for(const value of action[key])if(typeof value==="string")names.add(value);
  if(typeof action.connectionId==="string"){
   const edge=byEdge.get(action.connectionId);
   if(edge){names.add(edge.fromNodeId);names.add(edge.toNodeId);}
  }
 }
 // New-node aliases are not yet in the graph. A deterministic Task ref
 // collision remains protected by the normal preview and full graph checks.
 return [...names].filter(name=>known.has(name)).sort(compareId);
}
function scopeItems(document,roots){
 const edges=document.connections??[],selected=new Set(roots),queue=[...roots];
 const incoming=new Map();
 for(const edge of edges){
  const list=incoming.get(edge.toNodeId)??[];
  list.push(edge.fromNodeId);incoming.set(edge.toNodeId,list);
 }
 // Storyboards can depend on assets, episodes, scenes and intermediate sources.
 // Include every ancestor with an O(nodes+edges) reverse traversal.
 for(let index=0;index<queue.length;index++){
  for(const parent of incoming.get(queue[index])??[])if(!selected.has(parent)){
   selected.add(parent);queue.push(parent);
  }
 }
 const nodes=(document.nodes??[]).filter(node=>selected.has(node.id))
  .sort((a,b)=>compareId(a.id,b.id));
 // Preserve incident-edge changes as part of the witness, even for an
 // outgoing link to a node whose body is outside the scope.
 const connections=edges.filter(edge=>selected.has(edge.fromNodeId)||selected.has(edge.toNodeId))
  .sort((a,b)=>compareId(a.id,b.id));
 return {nodes,connections};
}
export function freezeAssistantCanvasScopeWitness(db,projectId,compactDocument,actions){
 if(!Array.isArray(actions)||!Array.isArray(compactDocument?.nodes)||
  !Array.isArray(compactDocument.connections))throw fail();
 const roots=actionRoots(compactDocument,actions);
 // Pure creation without an existing graph target has no meaningful
 // per-node witness; all such plans retain the mandatory full-graph fence.
 if(!roots.length)return null;
 const items=scopeItems(compactDocument,roots);
 const hydrated=hydrateCreativeDocument(db,projectId,{nodes:items.nodes}).nodes;
 return {schemaVersion:1,rootDigest:hash(roots),rootCount:roots.length,
  nodeCount:hydrated.length,edgeCount:items.connections.length,
  contentDigest:hash({roots,nodes:hydrated,connections:items.connections})};
}
export function assertAssistantCanvasScopeWitness(db,projectId,compactDocument,actions,expected){
 // Existing frozen Steps and exported Task data predate P3.3g. They stay
 // compatible but MUST still pass their original whole-graph checks.
 if(expected===undefined)return;
 if(expected===null||typeof expected!=="object"||Array.isArray(expected)||
  Object.keys(expected).sort().join(",")!==
    ["contentDigest","edgeCount","nodeCount","rootCount","rootDigest","schemaVersion"].sort().join(",")||
  expected.schemaVersion!==1||
  ![expected.rootCount,expected.nodeCount,expected.edgeCount].every(
   value=>Number.isSafeInteger(value)&&value>=0)||
  ![expected.rootDigest,expected.contentDigest].every(
   value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)))
  throw fail();
 try{
  const now=freezeAssistantCanvasScopeWitness(db,projectId,compactDocument,actions);
  if(!now||stableJson(now)!==stableJson(expected))throw fail();
 }catch{
  // No unexpected source data or pointer errors should become an approval or
  // execution authorization; present one stable existing conflict code.
  throw fail();
 }
}
