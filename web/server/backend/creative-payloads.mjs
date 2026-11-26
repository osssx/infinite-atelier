/** Creative bodies are persisted separately and reconstructed for legacy callers. */
const refresh=`
 INSERT INTO creative_node_payloads(project_id,node_id,project_revision,payload_json)
 SELECT NEW.id,json_extract(node.value,'$.id'),NEW.revision,
  json_object('dramaDraft',json_extract(node.value,'$.metadata.dramaDraft'),
   'dramaConfirmed',json_extract(node.value,'$.metadata.dramaConfirmed'),
   'content',json_extract(node.value,'$.metadata.content'),
   'dramaSourceParagraphs',json_extract(node.value,'$.metadata.dramaSourceParagraphs'),
   'dramaAssetReferences',json_extract(node.value,'$.metadata.dramaAssetReferences'),
   'dramaAssetCandidate',json_extract(node.value,'$.metadata.dramaAssetCandidate'))
 FROM json_each(NEW.document_json,'$.nodes') AS node
 WHERE json_extract(node.value,'$.type') IN ('drama:source','drama:assets','drama:episodes','drama:storyboard')
 AND json_extract(node.value,'$.metadata.creativePayloadRef') IS NULL
 ON CONFLICT(project_id,node_id) DO UPDATE SET project_revision=excluded.project_revision,payload_json=excluded.payload_json;
 DELETE FROM creative_node_payloads WHERE project_id=NEW.id AND node_id NOT IN
  (SELECT json_extract(value,'$.id') FROM json_each(NEW.document_json,'$.nodes')
   WHERE json_extract(value,'$.type') IN ('drama:source','drama:assets','drama:episodes','drama:storyboard'));
 UPDATE projects SET document_json=json_set(document_json,'$.nodes',json((
  SELECT json_group_array(json(CASE WHEN json_extract(node.value,'$.type') IN
   ('drama:source','drama:assets','drama:episodes','drama:storyboard')
   THEN json_set(json_remove(node.value,'$.metadata.dramaDraft','$.metadata.dramaConfirmed','$.metadata.content',
    '$.metadata.dramaSourceParagraphs','$.metadata.dramaAssetReferences','$.metadata.dramaAssetCandidate'),
    '$.metadata.creativePayloadRef',json_object('nodeId',json_extract(node.value,'$.id'),'schemaVersion',1))
   ELSE node.value END)) FROM json_each(document_json,'$.nodes') AS node)))
 WHERE id=NEW.id AND EXISTS(SELECT 1 FROM json_each(document_json,'$.nodes') AS node
  WHERE json_extract(node.value,'$.type') IN ('drama:source','drama:assets','drama:episodes','drama:storyboard')
   AND json_extract(node.value,'$.metadata.creativePayloadRef') IS NULL);`;

export const CREATIVE_PAYLOAD_SCHEMA=`CREATE TABLE IF NOT EXISTS creative_node_payloads(
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL,project_revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),PRIMARY KEY(project_id,node_id));
 CREATE TRIGGER IF NOT EXISTS creative_payload_insert AFTER INSERT ON projects BEGIN ${refresh} END;
 CREATE TRIGGER IF NOT EXISTS creative_payload_update AFTER UPDATE OF document_json ON projects BEGIN ${refresh} END;`;

export function readCreativePayload(db,projectId,nodeId){
 const project=db.prepare("SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!project)throw Object.assign(Error("project_not_found"),{code:"project_not_found",statusCode:404});
 const row=db.prepare("SELECT payload_json,project_revision FROM creative_node_payloads WHERE project_id=? AND node_id=?")
  .get(projectId,nodeId);
 if(!row)return null;
 return {revision:row.project_revision,projectRevision:project.revision,payload:JSON.parse(row.payload_json)};
}

/** Read-only canvas projection: never persist previews or expose full creative bodies. */
export function projectStorySummaries(db,projectId,document){
 if(!Array.isArray(document?.nodes))return document;
 if(!document.nodes.some(node=>node?.type==="drama:source"&&node.metadata?.creativePayloadRef))return document;
 const read=db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id=? AND node_id=?");
 return {...document,nodes:document.nodes.map(node=>{
  if(node?.type!=="drama:source"||!node.metadata?.creativePayloadRef)return node;
  const row=read.get(projectId,node.id);
  if(!row)return node;
  const payload=JSON.parse(row.payload_json);
  const draft=payload.dramaDraft??payload.content??payload.dramaConfirmed??"";
  const confirmed=payload.dramaConfirmed;
  const summary={preview:draft.slice(0,360),length:draft.length,hasText:Boolean(draft.trim()),
   confirmedTextMatches:Boolean(draft.trim())&&draft===confirmed,hadConfirmed:Boolean(confirmed?.trim()),
   hasStoredText:[payload.dramaDraft,payload.content,confirmed].some(value=>Boolean(value?.trim()))};
  return {...node,metadata:{...node.metadata,dramaStorySummary:summary}};
 })};
}

export function stripStorySummaries(document){
 if(!Array.isArray(document?.nodes)||!document.nodes.some(node=>node?.metadata?.dramaStorySummary!==undefined))return document;
 return {...document,nodes:document.nodes.map(node=>{
  if(node?.metadata?.dramaStorySummary===undefined)return node;
  const {dramaStorySummary,...metadata}=node.metadata;
  return {...node,metadata};
 })};
}

export function hydrateCreativeDocument(db,projectId,document){
 document=stripStorySummaries(document);
 if(!Array.isArray(document?.nodes))return document;
 if(!document.nodes.some(node=>node?.metadata?.creativePayloadRef))return document;
 const read=db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id=? AND node_id=?");
 const nodes=document.nodes.map(node=>{
  const reference=node?.metadata?.creativePayloadRef;
  if(!reference)return node;
  if(reference.nodeId!==node.id||reference.schemaVersion!==1)
   throw Object.assign(Error("creative_payload_reference_invalid"),{code:"creative_payload_reference_invalid",statusCode:422});
  const row=read.get(projectId,node.id);
  if(!row)throw Object.assign(Error("creative_payload_missing"),{code:"creative_payload_missing",statusCode:422});
  const payload=Object.fromEntries(Object.entries(JSON.parse(row.payload_json)).filter(([,value])=>value!==null));
  const {creativePayloadRef,...metadata}=node.metadata;
  return {...node,metadata:{...payload,...metadata}};
 });
 return {...document,nodes};
}
