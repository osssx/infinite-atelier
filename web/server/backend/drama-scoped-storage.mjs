/** Read only the requested portion of a creative draft/confirmation.
 * SQLite JSON1 filters array entries inside the DB. Neither project graph
 * hydration nor JavaScript parsing of the whole creative body is required.
 *
 * The indexed graph already stores a pointer, and both old inline fields and
 * current creative_node_payloads are accepted. A chosen historical version
 * remains immutable and is read from canvas_text_versions, not the live draft.
 */
import {createHash} from "node:crypto";
import {stableJson} from "./repository.mjs";
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";
import {readIndexedDramaScope,readIndexedAssetChoices} from "./creative-scope-reads.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const contentPaths={"drama:storyboard":"$.shots","drama:episodes":"$.episodes","drama:assets":"$.assets"};
const jsonQuery=(db,sql,...params)=>db.prepare(sql).all(...params);

const nodeInfoSql=`SELECT json_extract(n.value,'$.type') AS type,
 json_extract(n.value,'$.metadata.dramaConfirmedVersionId') AS confirmedVersionId,
 json_extract(n.value,'$.metadata.dramaDraft') AS inlineDraft,
 json_extract(n.value,'$.metadata.dramaConfirmed') AS inlineConfirmed,
 json_extract(n.value,'$.metadata.content') AS inlineContent,
 json_extract(n.value,'$.metadata.creativePayloadRef') AS pointerRaw,
 json_extract(n.value,'$.metadata.creativePayloadRef.nodeId') AS pointerNodeId,
 json_extract(n.value,'$.metadata.creativePayloadRef.schemaVersion') AS pointerSchemaVersion
 FROM projects p,json_each(p.document_json,'$.nodes') AS n
 WHERE p.id=? AND p.deleted_at IS NULL AND json_extract(n.value,'$.id')=?`;

function resolveBody(db,projectId,nodeId,node,{draft=false,versionId}){
 const selected=draft?null:(versionId??node.confirmedVersionId);
 let payload={draft:node.inlineDraft,confirmed:node.inlineConfirmed,content:node.inlineContent};
 if(node.pointerRaw!==null){
  if(node.pointerNodeId!==nodeId||node.pointerSchemaVersion!==1)throw fail("creative_payload_reference_invalid");
  const found=db.prepare(`SELECT json_extract(payload_json,'$.dramaDraft') AS draft,
   json_extract(payload_json,'$.dramaConfirmed') AS confirmed,
   json_extract(payload_json,'$.content') AS content
   FROM creative_node_payloads WHERE project_id=? AND node_id=?`).get(projectId,nodeId);
  if(!found)throw fail("creative_payload_missing");
  payload=found;
 }
 if(draft)return {versionId:null,body:payload.draft||payload.confirmed||payload.content||""};
 if(selected){
  const history=db.prepare("SELECT content FROM canvas_text_versions WHERE project_id=? AND node_id=? AND id=?")
   .get(projectId,nodeId,selected);
  if(!history)throw fail("text_version_not_found",404);
  return {versionId:selected,body:history.content};
 }
 return {versionId:null,body:payload.confirmed??""};
}

function readReferenceChoices(db,projectId,nodeId){
 const parents=jsonQuery(db,`SELECT json_extract(n.value,'$.id') AS id,
  json_extract(n.value,'$.metadata.dramaConfirmed') AS inlineConfirmed,
  json_extract(n.value,'$.metadata.creativePayloadRef') AS pointerRaw,
  json_extract(n.value,'$.metadata.creativePayloadRef.nodeId') AS pointerNodeId,
  json_extract(n.value,'$.metadata.creativePayloadRef.schemaVersion') AS pointerSchemaVersion
  FROM projects p,json_each(p.document_json,'$.nodes') AS n
  WHERE p.id=? AND p.deleted_at IS NULL AND json_extract(n.value,'$.type')='drama:assets'
   AND EXISTS(SELECT 1 FROM json_each(p.document_json,'$.connections') AS e WHERE
    json_extract(e.value,'$.fromNodeId')=json_extract(n.value,'$.id')
    AND json_extract(e.value,'$.toNodeId')=?)`,projectId,nodeId);
 return parents.flatMap(parent=>{
  let text=parent.inlineConfirmed;
  if(parent.pointerRaw!==null){
   if(parent.pointerNodeId!==parent.id||parent.pointerSchemaVersion!==1)throw fail("creative_payload_reference_invalid");
   const indexed=readIndexedAssetChoices(db,projectId,parent.id);
   if(indexed)return indexed;
   const row=db.prepare(`SELECT json_extract(payload_json,'$.dramaConfirmed') AS content
    FROM creative_node_payloads WHERE project_id=? AND node_id=?`).get(projectId,parent.id);
   if(!row)throw fail("creative_payload_missing");
   text=row.content;
  }
  return (readAssetDraft(text??"")?.assets??[]).map(asset=>({
   id:asset.id,kind:asset.kind,name:asset.name,
   variants:(asset.variants??[]).map(variant=>({id:variant.id,name:variant.name})),
  }));
 });
}

/** Add human-readable titles from the single linked confirmed episode plan.
 * The stable IDs stay untouched. The indexed path projects just sequence
 * titles in SQLite without fetching whole episode bodies into JavaScript.
 */
function withSequenceTitles(db,projectId,nodeId,groups){
 if(!groups.some(group=>group.sequenceIds?.length))return groups;
 try{
  const parents=jsonQuery(db,`SELECT json_extract(n.value,'$.id') AS id
   FROM projects p,json_each(p.document_json,'$.nodes') AS n
   WHERE p.id=? AND p.deleted_at IS NULL
    AND json_extract(n.value,'$.type')='drama:episodes'
    AND EXISTS(SELECT 1 FROM json_each(p.document_json,'$.connections') AS edge
     WHERE json_extract(edge.value,'$.fromNodeId')=json_extract(n.value,'$.id')
      AND json_extract(edge.value,'$.toNodeId')=?)`,projectId,nodeId);
  if(parents.length!==1)return groups;
  const parentId=parents[0].id;
  const parent=db.prepare(nodeInfoSql).get(projectId,parentId);
  if(!parent)return groups;
  const confirmedId=parent.confirmedVersionId;
  const historical=confirmedId&&db.prepare(`SELECT entry_count,unique_count FROM creative_scope_history_state
   WHERE project_id=? AND node_id=? AND version_id=? AND kind='episodes'`)
   .get(projectId,parentId,confirmedId);
  const current=!confirmedId&&db.prepare(`SELECT entry_count,unique_count FROM creative_scope_index_state
   WHERE project_id=? AND node_id=? AND stage='confirmed' AND kind='episodes'`)
   .get(projectId,parentId);
  let rows=[];
  if(historical&&historical.entry_count===historical.unique_count){
   rows=jsonQuery(db,`SELECT json_extract(i.entry_json,'$.id') AS episodeId,
    json_extract(seq.value,'$.id') AS sequenceId,json_extract(seq.value,'$.title') AS title
    FROM creative_scope_history_entries AS i,json_each(i.entry_json,'$.sequences') AS seq
    WHERE i.project_id=? AND i.node_id=? AND i.version_id=? AND i.kind='episodes'`,
    projectId,parentId,confirmedId);
  }else if(current&&current.entry_count===current.unique_count){
   rows=jsonQuery(db,`SELECT json_extract(i.entry_json,'$.id') AS episodeId,
    json_extract(seq.value,'$.id') AS sequenceId,json_extract(seq.value,'$.title') AS title
    FROM creative_scope_entry_index AS i,json_each(i.entry_json,'$.sequences') AS seq
    WHERE i.project_id=? AND i.node_id=? AND i.stage='confirmed' AND i.kind='episodes'`,
    projectId,parentId);
  }else{
   const selected=resolveBody(db,projectId,parentId,parent,{draft:false});
   const body=selected.body.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1");
   if(body&&db.prepare("SELECT json_valid(?) AS valid").get(body).valid){
    rows=jsonQuery(db,`SELECT json_extract(ep.value,'$.id') AS episodeId,
     json_extract(seq.value,'$.id') AS sequenceId,json_extract(seq.value,'$.title') AS title
     FROM json_each(?,'$.episodes') AS ep,json_each(ep.value,'$.sequences') AS seq`,body);
   }
  }
  const names=new Map();
  for(const row of rows){
   if(typeof row.episodeId==="string"&&typeof row.sequenceId==="string"&&
    typeof row.title==="string"&&row.title.trim())
    names.set(row.episodeId+"\u0000"+row.sequenceId,row.title.trim());
  }
  return groups.map(group=>({...group,sequenceTitles:Object.fromEntries(
   group.sequenceIds.flatMap(id=>{
    const title=names.get(group.episodeId+"\u0000"+id);
    return title?[[id,title]]:[];
   }))}));
 }catch{
  // Missing/legacy upstream metadata must not block the scoped shot query.
  return groups;
 }
}

/** Returns null only for stages handled by the legacy source-paragraph route. */
export function readPagedDramaScope(db,projectId,nodeId,{versionId,episodeId,sequenceId,entryId,offset=0,limit=50,summaryOnly=false,draft=false,includeReferenceChoices=true}={}){
 const node=db.prepare(nodeInfoSql).get(projectId,nodeId);
 if(!node){
  const project=db.prepare("SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
  throw fail(project?"text_node_not_found":"project_not_found",404);
 }
 const path=contentPaths[node.type];
 if(!path)return null;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)
  throw fail("drama_scope_pagination_invalid",400);
 const indexed=readIndexedDramaScope(db,projectId,nodeId,node,{draft,versionId,episodeId,sequenceId,entryId,offset,limit,summaryOnly});
 if(indexed)return {...indexed,groups:node.type==="drama:storyboard"?
  withSequenceTitles(db,projectId,nodeId,indexed.groups):indexed.groups,
  referenceChoices:summaryOnly||!includeReferenceChoices||node.type!=="drama:storyboard"?[]:
  readReferenceChoices(db,projectId,nodeId)};
 const selected=resolveBody(db,projectId,nodeId,node,{draft,versionId});
 // Older drafts sometimes used fenced JSON. They remain readable without
 // migrating / mutating the node or changing any selected history revision.
 const body=selected.body.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,"$1");
 if(!body)return {versionId:selected.versionId,total:0,offset,limit,groups:[],entries:[],referenceChoices:[],entryDigests:[]};
 const shape=db.prepare("SELECT json_valid(?) AS valid").get(body);
 if(!shape.valid||db.prepare("SELECT json_type(?,?) AS kind").get(body,path).kind!=="array")
  throw fail("drama_draft_invalid");
 // JSON1 iterates over entries without returning the entire collection to JS.
 const where=`(?='' OR json_extract(value,'$.episodeId')=? OR json_extract(value,'$.id')=?)
   AND (?='' OR json_extract(value,'$.sequenceId')=?)
   AND (?='' OR json_extract(value,'$.id')=?)`;
 const params=[episodeId??"",episodeId??"",episodeId??"",sequenceId??"",sequenceId??"",entryId??"",entryId??""];
 const total=db.prepare(`SELECT COUNT(*) AS total FROM json_each(?,?) WHERE ${where}`).get(body,path,...params).total;
 // A duplicated ID outside the displayed page must not make an otherwise
 // valid-looking edit target ambiguous. Enforce global identities in SQL.
 const identity=db.prepare(`SELECT COUNT(*) AS count,COUNT(DISTINCT json_extract(value,'$.id')) AS distinctIds
  FROM json_each(?,?)`).get(body,path);
 if(identity.count!==identity.distinctIds)throw fail("drama_draft_invalid");
 const grouped=node.type==="drama:storyboard"?jsonQuery(db,`SELECT
   json_extract(value,'$.episodeId') AS episodeId,
   json_extract(value,'$.sequenceId') AS sequenceId,
   COUNT(*) AS count,MIN(CAST(key AS INTEGER)) AS firstIndex
   FROM json_each(?,?) GROUP BY episodeId,sequenceId ORDER BY firstIndex`,body,path):[];
 const groups=[];
 for(const group of grouped){
  let row=groups.find(value=>value.episodeId===group.episodeId);
  if(!row){row={episodeId:group.episodeId,total:0,sequenceIds:[]};groups.push(row)}
  row.total+=group.count;
  if(group.sequenceId&&!row.sequenceIds.includes(group.sequenceId))row.sequenceIds.push(group.sequenceId);
 }
 const rows=summaryOnly?[]:jsonQuery(db,`SELECT value FROM json_each(?,?) WHERE ${where}
  ORDER BY CAST(key AS INTEGER) LIMIT ? OFFSET ?`,body,path,...params,limit,offset);
 const entries=rows.map(row=>JSON.parse(row.value));
 // Validate only the page; the full input JSON stays inside SQLite. An
 // invalid entry must not be silently displayed as an editable valid shot.
 if(entries.length){
  const pageBody=JSON.stringify({[path.slice(2)]:entries});
  const valid=node.type==="drama:storyboard"?readStoryboardDraft(pageBody):
   node.type==="drama:episodes"?readEpisodeDraft(pageBody):readAssetDraft(pageBody);
  if(!valid)throw fail("drama_draft_invalid");
 }
 const referenceChoices=summaryOnly||!includeReferenceChoices||node.type!=="drama:storyboard"?[]:readReferenceChoices(db,projectId,nodeId);
 return {versionId:selected.versionId,total,offset,limit,
  groups:node.type==="drama:storyboard"?withSequenceTitles(db,projectId,nodeId,groups):groups,
  entries,referenceChoices,entryDigests:entries.map(item=>({id:item.id,digest:digest(item)}))};
}
