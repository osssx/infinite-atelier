/** P3.3h: strictly whitelisted approved Task content edits.
 *
 * This is NOT an independent batch API or a Task approval bypass. The only
 * caller runs inside the original BEGIN IMMEDIATE Step/Attempt transaction,
 * after its approval, source, bindings and full graph digest are checked.
 * The frozen post-graph SHA makes a SQL/legacy semantic mismatch fail closed
 * and rolls the entire Task transaction back.
 */
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {applyDramaEntryDraftWithinTransaction} from "./drama-entry-cas.mjs";
import {tryPatchIndexedShotDraft} from "./drama-shot-cas.mjs";

const fail=()=>Object.assign(Error("assistant_step_source_changed"),
 {code:"assistant_step_source_changed",statusCode:409});
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const types={patch_drama_asset:["drama:assets","assets","assetId"],
 patch_drama_episode:["drama:episodes","episodes","episodeId"],
 patch_storyboard_shot:["drama:storyboard","shots","shotId"]};
const allowed={
 patch_drama_asset:new Set(["name","description"]),
 patch_drama_episode:new Set(["title","synopsis","ending"]),
 patch_storyboard_shot:new Set(["description","shotSize","camera","action","dialogue"])
};
const validId=value=>typeof value==="string"&&value.length>0&&value.length<=256;
const pointer=node=>node?.metadata?.creativePayloadRef?.nodeId===node.id&&
 node.metadata.creativePayloadRef.schemaVersion===1&&
 !["dramaDraft","dramaConfirmed","content"].some(key=>Object.hasOwn(node.metadata,key));

export function freezeAssistantTaskScopedPatches(db,projectId,compact,original,preview,actions){
 if(!Array.isArray(actions)||!actions.length||actions.length>16||
  actions.some(a=>!Object.hasOwn(types,a.type)))return null;
 const indexed=new Map(compact.nodes.map(node=>[node.id,node]));
 const hydrated=new Map(original.nodes.map(node=>[node.id,node]));
 const previewNodes=new Map(preview.nodes.map(node=>[node.id,node]));
 const duplicates=new Set(),edits=[],candidates=new Map();
 for(const a of actions){
  const [nodeType,kind,key]=types[a.type],node=indexed.get(a.nodeId),
   before=hydrated.get(a.nodeId),after=previewNodes.get(a.nodeId),
   entryId=a[key];
  const fields=allowed[a.type];
  if(!node||node.type!==nodeType||!pointer(node)||!before||!after||
   !validId(entryId)||!a.changes||typeof a.changes!=="object"||
   Array.isArray(a.changes)||!Object.keys(a.changes).length||
   Object.entries(a.changes).some(([field,value])=>!fields.has(field)||
    typeof value!=="string"||value.length>12000||
    ["name","title"].includes(field)&&!value.trim()))return null;
  const targetKey=JSON.stringify([a.nodeId,kind,entryId]);
  if(duplicates.has(targetKey))return null; // repeated parent requires legacy sequential semantics
  duplicates.add(targetKey);
  const source=before.metadata?.dramaDraft;
  if(typeof source!=="string"||!source)return null;
  let data,entries;
  try{
   data=JSON.parse(source);
   if(JSON.stringify(data)!==source||!Array.isArray(data[kind]))return null;
   entries=data[kind];
  }catch{return null;}
  const matches=entries.filter(item=>item?.id===entryId);
  if(matches.length!==1)return null;
  const previous=matches[0],variantId=a.type==="patch_drama_asset"?a.variantId:undefined;
  let candidate;
  try{
   const at=entries.findIndex(item=>item?.id===entryId);
   candidate=candidates.get(a.nodeId)??structuredClone(data);
   candidates.set(a.nodeId,candidate);   const parent=candidate[kind][at];
   if(variantId!==undefined){
    if(!validId(variantId)||!Array.isArray(parent.variants)||
     parent.variants.filter(v=>v?.id===variantId).length!==1)return null;
    Object.assign(parent.variants.find(v=>v.id===variantId),a.changes);
   }else Object.assign(parent,a.changes);
  }catch{return null;}
  const state=db.prepare(`SELECT entry_count,unique_count FROM creative_scope_index_state
   WHERE project_id=? AND node_id=? AND stage='draft' AND kind=?`)
   .get(projectId,a.nodeId,kind);
  if(!state||state.entry_count!==state.unique_count||state.entry_count!==entries.length)
   return null;
  const row=db.prepare(`SELECT entry_json FROM creative_scope_entry_index
   WHERE project_id=? AND node_id=? AND stage='draft' AND kind=? AND entry_id=?`)
   .all(projectId,a.nodeId,kind,entryId);
  if(row.length!==1)return null;
  try{if(digest(JSON.parse(row[0].entry_json))!==digest(previous))return null;}
  catch{return null;}
  edits.push({nodeId:a.nodeId,kind,entryId,expectedDigest:digest(previous),
   ...(variantId!==undefined?{variantId}:{})});
 }
 // Independent entries in one node are an atomic safe batch. All preview
 // metadata must match these direct content changes, not legacy normalization.
 for(const [nodeId,candidate] of candidates){
  const before=hydrated.get(nodeId),after=previewNodes.get(nodeId);
  if(JSON.stringify(candidate)!==after.metadata?.dramaDraft||
   Object.keys(before.metadata??{}).some(field=>field!=="dramaDraft"&&
    stableJson(before.metadata[field])!==stableJson(after.metadata?.[field]))||
   Object.keys(after.metadata??{}).some(field=>field!=="dramaDraft"&&
    !Object.hasOwn(before.metadata??{},field)))return null;
 }
 // May only touch the explicitly frozen draft fields. The original planner
 // has already validated the whole preview and all Task dependency bindings.
 const record={schemaVersion:1,edits,expectedPostGraphDigest:digest(preview)};
 return Buffer.byteLength(stableJson(record))<=4096?record:null;
}
export function applyAssistantTaskScopedPatches(db,projectId,actions,frozen,
 validateDocument,emitEvent){
 if(!frozen||frozen.schemaVersion!==1||
  !Array.isArray(frozen.edits)||frozen.edits.length!==actions.length||
  typeof frozen.expectedPostGraphDigest!=="string"||
  !/^[a-f0-9]{64}$/.test(frozen.expectedPostGraphDigest))throw fail();
 for(let i=0;i<actions.length;i++){
  const a=actions[i],entry=frozen.edits[i],spec=types[a.type];
  if(!spec||entry.nodeId!==a.nodeId||entry.kind!==spec[1]||
   entry.entryId!==a[spec[2]]||
   (entry.variantId??undefined)!==(a.variantId??undefined)||
   !/^[a-f0-9]{64}$/.test(entry.expectedDigest))throw fail();
  const patch={...entry,changes:a.changes};
  try{
   if(entry.kind==="shots"){
    if(!tryPatchIndexedShotDraft(db,projectId,entry.nodeId,
     {shotId:entry.entryId,expectedDigest:entry.expectedDigest,changes:a.changes},
     validateDocument,emitEvent,null,{deferProjectCommit:true}))throw fail();
   }else applyDramaEntryDraftWithinTransaction(db,projectId,patch,validateDocument);
  }catch{throw fail();}
 }
 return actions.length;
}
