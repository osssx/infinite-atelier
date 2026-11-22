/** P3.3d: local CAS edits of asset/episode content and stable sequence titles.
 * Not a replacement for identity-changing asset adoption or event/sequence
 * migration. Those existing Agent/Run operations retain full-graph validation.
 */
import {createHash} from "node:crypto";
import {readAssetDraft,readEpisodeDraft} from "../canvas-text-content.mjs";
import {assertNoRawCredentials,stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const types={assets:"drama:assets",episodes:"drama:episodes"};
const body=`COALESCE(NULLIF(json_extract(payload_json,'$.dramaDraft'),''),
 NULLIF(json_extract(payload_json,'$.dramaConfirmed'),''),
 NULLIF(json_extract(payload_json,'$.content'),''))`;
const keys={asset:new Set(["name","description"]),variant:new Set(["name","description"]),
 episode:new Set(["title","synopsis","ending"]),sequence:new Set(["title"])};
const id=(value)=>typeof value==="string"&&value.length>0&&value.length<=256;

const scalar=(base,key)=>`json_type(${base},'$.${key}') IS 'text'`;
const array=(base,key)=>`json_type(${base},'$.${key}') IS 'array'`;
const safeArray=(base,key)=>`CASE WHEN ${array(base,key)} THEN json_extract(${base},'$.${key}') ELSE '[]' END`;
function invalidArray(base,key,alias){
 return `EXISTS(SELECT 1 FROM json_each(${safeArray(base,key)}) AS ${alias}
  WHERE ${alias}.type!='text')`;
}
function invalidOptionalArray(base,key,alias){
 return `(json_type(${base},'$.${key}') IS NOT NULL AND
  (NOT (${array(base,key)}) OR ${invalidArray(base,key,alias)}))`;
}
const assetShape=[
 "json_type(e.entry_json) IS NOT 'object'",
 ...["id","name","description","kind"].map(key=>`NOT (${scalar("e.entry_json",key)})`),
 "length(trim(json_extract(e.entry_json,'$.id')))=0",
 "json_extract(e.entry_json,'$.kind') NOT IN ('character','scene','prop')",
 `NOT (${array("e.entry_json","sourceRefs")})`,
 invalidArray("e.entry_json","sourceRefs","src"),
 invalidOptionalArray("e.entry_json","aliases","alias"),
 "(json_type(e.entry_json,'$.aliases') IS 'array' AND json_array_length(e.entry_json,'$.aliases')>64)",
 "(json_type(e.entry_json,'$.variants') IS NOT NULL AND json_type(e.entry_json,'$.variants') IS NOT 'array')",
 `EXISTS(SELECT 1 FROM json_each(${safeArray("e.entry_json","variants")}) AS v WHERE
  v.type!='object' OR
  json_type(v.value,'$.id') IS NOT 'text' OR
  json_type(v.value,'$.name') IS NOT 'text' OR
  json_type(v.value,'$.description') IS NOT 'text' OR
  length(trim(json_extract(v.value,'$.id')))=0)`,
];
const sequenceArray=safeArray("e.entry_json","sequences");
const eventArray=safeArray("e.entry_json","eventItems");
const episodeShape=[
 "json_type(e.entry_json) IS NOT 'object'",
 ...["id","title","synopsis","ending"].map(key=>`NOT (${scalar("e.entry_json",key)})`),
 "length(trim(json_extract(e.entry_json,'$.id')))=0",
 ...["events","sourceRefs"].flatMap(key=>[
  `NOT (${array("e.entry_json",key)})`,
  invalidArray("e.entry_json",key,key==="events"?"ev":"src"),
 ]),
 "(json_type(e.entry_json,'$.targetDurationSec') IS NOT NULL AND ("+
  "json_type(e.entry_json,'$.targetDurationSec') NOT IN ('integer','real') OR "+
  "json_extract(e.entry_json,'$.targetDurationSec')<=0))",
 "(json_type(e.entry_json,'$.sequences') IS NOT NULL AND json_type(e.entry_json,'$.sequences') IS NOT 'array')",
 `EXISTS(SELECT 1 FROM json_each(${sequenceArray}) AS seq WHERE
  seq.type!='object' OR json_type(seq.value,'$.id') IS NOT 'text' OR
  length(trim(json_extract(seq.value,'$.id')))=0 OR
  json_type(seq.value,'$.title') IS NOT 'text' OR
  ${["sourceRefs","eventRefs","replaces"].map(key=>invalidOptionalArray("seq.value",key,key)).join(" OR ")})`,
 `EXISTS(SELECT 1 FROM (SELECT json_extract(seq.value,'$.id') AS id
  FROM json_each(${sequenceArray}) AS seq GROUP BY json_extract(seq.value,'$.id') HAVING COUNT(*)>1))`,
 "(json_type(e.entry_json,'$.eventItems') IS NOT NULL AND ("+
  "json_type(e.entry_json,'$.eventItems') IS NOT 'array' OR "+
  "json_array_length(e.entry_json,'$.eventItems')!=json_array_length(e.entry_json,'$.events')))",
 `EXISTS(SELECT 1 FROM json_each(${eventArray}) AS item WHERE
  item.type!='object' OR json_type(item.value,'$.id') IS NOT 'text' OR
  length(json_extract(item.value,'$.id'))=0 OR
  json_type(item.value,'$.text') IS NOT 'text' OR
  json_extract(item.value,'$.text') IS NOT
  json_extract(e.entry_json,'$.events[' || item.key || ']') OR
  ${invalidOptionalArray("item.value","replaces","ref")})`,
 `EXISTS(SELECT 1 FROM (SELECT json_extract(item.value,'$.id') AS id
  FROM json_each(${eventArray}) AS item GROUP BY json_extract(item.value,'$.id') HAVING COUNT(*)>1))`,
];
function assertIndexedDraftValid(db,projectId,nodeId,kind,state){
 if(state.entry_count!==state.unique_count)throw fail("drama_draft_invalid");
 const invalid=kind==="assets"?assetShape:episodeShape;
 if(db.prepare(`SELECT 1 FROM creative_scope_entry_index AS e WHERE
  e.project_id=? AND e.node_id=? AND e.stage='draft' AND e.kind=?
  AND (${invalid.join(" OR ")}) LIMIT 1`).get(projectId,nodeId,kind))
  throw fail("drama_draft_invalid");
 if(kind==="assets"){
  const ids=db.prepare(`SELECT COUNT(*) AS count,COUNT(DISTINCT id) AS uniqueCount FROM (
    SELECT entry_id AS id FROM creative_scope_entry_index
     WHERE project_id=? AND node_id=? AND stage='draft' AND kind='assets'
    UNION ALL
    SELECT CASE WHEN variant.type='object' THEN json_extract(variant.value,'$.id') END AS id
    FROM creative_scope_entry_index AS e,
     json_each(${safeArray("e.entry_json","variants")}) AS variant
    WHERE e.project_id=? AND e.node_id=? AND e.stage='draft' AND e.kind='assets'
   )`).get(projectId,nodeId,projectId,nodeId);
  if(ids.count!==ids.uniqueCount)throw fail("drama_draft_invalid");
 }
}
const exactlyOne=(records)=>records.length===1?records[0]:null;
function applyChanges(kind,record,command){
 const {changes,variantId,sequenceId}=command;
 const target=kind==="assets"?(variantId?"variant":"asset"):(sequenceId?"sequence":"episode");
 const allowed=keys[target];
 if(!changes||typeof changes!=="object"||Array.isArray(changes)||
  !Object.keys(changes).length||JSON.stringify(changes).length>12000||
  Object.entries(changes).some(([key,value])=>!allowed.has(key)||
   typeof value!=="string"||value.length>12000||
   ["name","title"].includes(key)&&!value.trim()))
  throw fail("drama_draft_invalid");
 const changed=structuredClone(record);
 if(variantId){
  const variants=changed.variants;
  if(!Array.isArray(variants))throw fail("drama_entry_target_not_found",404);
  const target=exactlyOne(variants.filter(item=>item.id===variantId));
  if(!target)throw fail("drama_entry_target_not_found",404);
  Object.assign(target,changes);
 }else if(sequenceId){
  const sequences=changed.sequences;
  if(!Array.isArray(sequences))throw fail("drama_entry_target_not_found",404);
  const target=exactlyOne(sequences.filter(item=>item.id===sequenceId));
  if(!target)throw fail("drama_entry_target_not_found",404);
  Object.assign(target,changes);
 }else Object.assign(changed,changes);
 const valid=kind==="assets"?readAssetDraft(JSON.stringify({assets:[changed]})):
  readEpisodeDraft(JSON.stringify({episodes:[changed]}));
 if(!valid)throw fail("drama_draft_invalid");
 assertNoRawCredentials(changed);
 return changed;
}
function assertNode(db,projectId,nodeId,kind){
 const row=db.prepare("SELECT revision,document_json FROM projects WHERE id=? AND deleted_at IS NULL")
  .get(projectId);
 if(!row)throw fail("project_not_found",404);
 const document=JSON.parse(row.document_json);
 const node=document.nodes?.find(node=>node.id===nodeId);
 if(!node)throw fail("text_node_not_found",404);
 if(node.type!==types[kind])throw fail("drama_draft_invalid");
 const ref=node.metadata?.creativePayloadRef;
 if(!ref)throw fail("drama_entry_edit_unavailable",409);
 if(ref.nodeId!==nodeId||ref.schemaVersion!==1||
  ["dramaDraft","dramaConfirmed","content"].some(key=>Object.hasOwn(node.metadata,key)))
  throw fail("creative_payload_reference_invalid");
 return {row,document};
}
/** Exactly one target entry or one nested stable-name field per command.
 * No asset IDs, variant IDs, event identities, or sequence topology can change.
 */
/** Caller must already hold BEGIN IMMEDIATE. Deliberately does not advance
 * project revision or write a receipt: a batch can apply multiple entries and
 * commit them with ONE project revision and one batch receipt.
 */
export function applyDramaEntryDraftWithinTransaction(db,projectId,command,validateDocument){
 const {nodeId,kind,entryId,variantId,sequenceId,expectedDigest}=command;
 if(!Object.hasOwn(types,kind)||!id(entryId)||!id(nodeId)||
  typeof expectedDigest!=="string"||!/^[a-f0-9]{64}$/.test(expectedDigest)||
  (variantId!==undefined&&(!id(variantId)||kind!=="assets"))||
  (sequenceId!==undefined&&(!id(sequenceId)||kind!=="episodes"))||
  (variantId&&sequenceId))throw fail("drama_draft_invalid");
 const {row,document}=assertNode(db,projectId,nodeId,kind);
 const state=db.prepare(`SELECT entry_count,unique_count FROM creative_scope_index_state
   WHERE project_id=? AND node_id=? AND stage='draft' AND kind=?`).get(projectId,nodeId,kind);
 if(!state)throw fail("drama_entry_edit_unavailable",409);
 assertIndexedDraftValid(db,projectId,nodeId,kind,state);
 const matches=db.prepare(`SELECT ordinal,entry_json FROM creative_scope_entry_index
   WHERE project_id=? AND node_id=? AND stage='draft' AND kind=? AND entry_id=?`)
   .all(projectId,nodeId,kind,entryId);
 if(matches.length!==1)throw fail("drama_entry_target_not_found",404);
 const item=matches[0],current=JSON.parse(item.entry_json);
 if(digest(current)!==expectedDigest)throw fail("drama_candidate_conflict",409);
 const next=applyChanges(kind,current,command);
 const source=db.prepare(`SELECT json_type(payload_json,'$.dramaDraft') AS draftType,
   json_valid(${body}) AS valid,
   json_type(CASE WHEN json_valid(${body}) THEN ${body} ELSE '{}' END,?) AS listType,
   json_array_length(CASE WHEN json_valid(${body}) THEN ${body} ELSE '{}' END,?) AS length,
   json_extract(CASE WHEN json_valid(${body}) THEN ${body} ELSE '{}' END,?) AS entry
   FROM creative_node_payloads WHERE project_id=? AND node_id=?`)
   .get(`$.${kind}`,`$.${kind}`,`$.${kind}[${item.ordinal}]`,projectId,nodeId);
 if(!source)throw fail("creative_payload_missing");
 if(!source.valid||source.listType!=="array"||
  source.draftType!==null&&source.draftType!=="text")
  throw fail("drama_entry_edit_unavailable",409);
 if(source.length!==state.entry_count)throw fail("drama_draft_invalid");
 let authoritative;
 try{authoritative=JSON.parse(source.entry);}catch{throw fail("drama_draft_invalid");}
 if(digest(authoritative)!==digest(current))throw fail("drama_candidate_conflict",409);
 validateDocument(document);
 const patched=db.prepare(`UPDATE creative_node_payloads
   SET payload_json=json_set(payload_json,'$.dramaDraft',
    (json_set(${body},?,json(?)) || '')),
    project_revision=?
   WHERE project_id=? AND node_id=?`)
   .run(`$.${kind}[${item.ordinal}]`,JSON.stringify(next),row.revision+1,projectId,nodeId);
 if(patched.changes!==1)throw fail("creative_payload_missing");
 return {revision:row.revision+1,nodeId,kind,entryId};
}
export function patchDramaEntryDraft(db,projectId,command,validateDocument,emitEvent){
 return writeTransaction(db,()=>{
  const {nodeId,operationId}=command;
  if(!id(operationId)||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
   throw fail("drama_draft_invalid");
  const fingerprint=digest(command);
  const receipt=db.prepare(`SELECT fingerprint FROM canvas_text_version_operations
   WHERE project_id=? AND node_id=? AND id=?`).get(projectId,nodeId,operationId);
  if(receipt&&receipt.fingerprint!==fingerprint)throw fail("text_version_operation_conflict",409);
  // Even a replay must reject a deleted project, missing node or bad pointer.
  const {row}=assertNode(db,projectId,nodeId,command.kind);
  if(receipt){
   if(!db.prepare("SELECT 1 FROM creative_node_payloads WHERE project_id=? AND node_id=?")
    .get(projectId,nodeId))throw fail("creative_payload_missing");
   return;
  }
  const result=applyDramaEntryDraftWithinTransaction(db,projectId,command,validateDocument);
  const updated=db.prepare("UPDATE projects SET revision=revision+1 WHERE id=? AND revision=?")
   .run(projectId,row.revision);
  if(updated.changes!==1)throw fail("project_revision_conflict",409);
  db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
   .run(projectId,nodeId,operationId,fingerprint,result.revision);
  emitEvent(db,{id:projectId,revision:result.revision,kind:"updated"});
 });
}