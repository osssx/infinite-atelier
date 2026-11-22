/** P3.3c: targeted CAS update of the *authoritative* creative JSON body.
 * This is an optional fast path for canonical v42 indexed storyboards. Older
 * inline, fenced, invalid or unindexed drafts keep the original full validator.
 * The containing transaction is owned by patchDramaShotDraft.
 */
import {createHash} from "node:crypto";
import {readStoryboardDraft,validStoryboardDraftReferences} from "../canvas-text-content.mjs";
import {assertNoRawCredentials,stableJson} from "./repository.mjs";

const fail=(code,statusCode=422)=>Object.assign(Error(code),{code,statusCode});
const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const allowed=new Set(["description","shotSize","camera","action","dialogue","durationSec",
 "sceneId","sceneVariantId","sourceRefs","characterVariantIds","propIds","keyPropIds"]);
const nullable=new Set(["sceneId","sceneVariantId","sequenceId","durationSec"]);
const graphNodeSql=`SELECT json_extract(n.value,'$.type') AS type,
 json_extract(n.value,'$.metadata.creativePayloadRef') AS pointer,
 json_extract(n.value,'$.metadata.creativePayloadRef.nodeId') AS refId,
 json_extract(n.value,'$.metadata.creativePayloadRef.schemaVersion') AS refVersion
 FROM projects p,json_each(p.document_json,'$.nodes') AS n
 WHERE p.id=? AND json_extract(n.value,'$.id')=?`;
const originalBody=`COALESCE(NULLIF(json_extract(payload_json,'$.dramaDraft'),''),
  NULLIF(json_extract(payload_json,'$.dramaConfirmed'),''),
  NULLIF(json_extract(payload_json,'$.content'),''))`;
function hydrateParent(db,projectId,parent){
 const ref=parent.metadata?.creativePayloadRef;
 if(!ref)return parent;
 if(ref.nodeId!==parent.id||ref.schemaVersion!==1)
  throw fail("creative_payload_reference_invalid");
 const record=db.prepare("SELECT payload_json FROM creative_node_payloads WHERE project_id=? AND node_id=?")
  .get(projectId,parent.id);
 if(!record)throw fail("creative_payload_missing");
 const payload=JSON.parse(record.payload_json);
 return {...parent,metadata:{...Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==null)),
  ...parent.metadata}};
}
const textArray=key=>`json_type(entry_json,'$.${key}') IS 'array' AND
 NOT EXISTS(SELECT 1 FROM json_each(entry_json,'$.${key}') AS field WHERE field.type!='text')`;
const optionalText=key=>`(json_type(entry_json,'$.${key}') IS NOT NULL AND
 json_type(entry_json,'$.${key}')!='text')`;
/** A bad *unselected* shot must not be masked by a valid indexed page.
 * SQL checks the same type guards as readStoryboardDraft, without materializing
 * the whole 100+-shot array in JavaScript.
 */
function indexedDraftMalformed(db,projectId,nodeId){
 const failures=[
  "json_type(entry_json) IS NOT 'object'",
  "json_type(entry_json,'$.id') IS NOT 'text'",
  "length(trim(json_extract(entry_json,'$.id')))=0",
  "json_type(entry_json,'$.episodeId') IS NOT 'text'",
  "length(trim(json_extract(entry_json,'$.episodeId')))=0",
  "json_type(entry_json,'$.description') IS NOT 'text'",
  "json_type(entry_json,'$.order') IS NOT 'integer'",
  "json_extract(entry_json,'$.order')<0",
  "json_extract(entry_json,'$.order')>9007199254740991",
  ...["characterVariantIds","propIds","keyPropIds"].map(key=>`NOT (${textArray(key)})`),
  ...["sceneId","sceneVariantId","shotSize","camera","action","dialogue","sequenceId"].map(optionalText),
  `(json_type(entry_json,'$.sourceRefs') IS NOT NULL AND NOT (${textArray("sourceRefs")}))`,
  "(json_type(entry_json,'$.durationSec') IS NOT NULL AND (",
  "json_type(entry_json,'$.durationSec') NOT IN ('integer','real') OR json_extract(entry_json,'$.durationSec')<=0))",
 ];
 // The duration expression above is kept a single OR predicate.
 const where=failures.slice(0,-2).concat(failures.slice(-2).join(" ")).join(" OR ");
 return Boolean(db.prepare(`SELECT 1 FROM creative_scope_entry_index WHERE
  project_id=? AND node_id=? AND stage='draft' AND kind='shots'
  AND (${where}) LIMIT 1`).get(projectId,nodeId));
}
/** Returns false when the old project must use the fully hydrated path.
 * No return value means already completed successfully.
 */
export function tryPatchIndexedShotDraft(db,projectId,nodeId,command,validateDocument,emitEvent,fingerprint,{deferProjectCommit=false}={}){
 const project=db.prepare("SELECT revision,document_json FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!project)throw fail("project_not_found",404);
 const graph=JSON.parse(project.document_json);
 const node=graph.nodes?.find(item=>item.id===nodeId);
 if(!node||node.type!=="drama:storyboard")throw fail("drama_draft_invalid");
 const ref=node.metadata?.creativePayloadRef;
 if(!ref)return false;
 if(ref.nodeId!==nodeId||ref.schemaVersion!==1)throw fail("creative_payload_reference_invalid");
 // The persisted compact node must never compete with the authoritative
 // payload by also carrying an inline copy of its creative text.
 if(["dramaDraft","dramaConfirmed","content"].some(key=>
  Object.hasOwn(node.metadata??{},key)))
  throw fail("creative_payload_reference_invalid");
 const meta=db.prepare(graphNodeSql).get(projectId,nodeId);
 if(!meta||meta.refId!==nodeId||meta.refVersion!==1)throw fail("creative_payload_reference_invalid");
 const state=db.prepare(`SELECT entry_count,unique_count FROM creative_scope_index_state
  WHERE project_id=? AND node_id=? AND stage='draft' AND kind='shots'`).get(projectId,nodeId);
 if(!state)return false;
 if(state.entry_count!==state.unique_count)throw fail("drama_draft_invalid");
 if(indexedDraftMalformed(db,projectId,nodeId))return false;
 const indexed=db.prepare(`SELECT ordinal,entry_json FROM creative_scope_entry_index
  WHERE project_id=? AND node_id=? AND stage='draft' AND kind='shots' AND entry_id=?`)
  .all(projectId,nodeId,command.shotId);
 if(indexed.length!==1)throw fail("drama_candidate_conflict",409);
 const entry=indexed[0],shot=JSON.parse(entry.entry_json);
 if(!readStoryboardDraft(JSON.stringify({shots:[shot]})))return false;
 if(digest(shot)!==command.expectedDigest)throw fail("drama_candidate_conflict",409);
 if(!command.changes||typeof command.changes!=="object"||Array.isArray(command.changes)||
  !Object.keys(command.changes).length||
  Object.keys(command.changes).some(key=>!allowed.has(key)))
  throw fail("drama_draft_invalid");
 const updated={...shot,...command.changes};
 for(const key of nullable)if(updated[key]===null)delete updated[key];
 if(!readStoryboardDraft(JSON.stringify({shots:[updated]})))throw fail("drama_draft_invalid");
 assertNoRawCredentials(updated);
 // Resolve only upstream dependencies, not all 200+ canvas node payloads.
 const parents=new Set((graph.connections??[]).filter(edge=>edge.toNodeId===nodeId)
  .map(edge=>edge.fromNodeId));
 const dependencies=(graph.nodes??[]).filter(item=>parents.has(item.id))
  .map(item=>hydrateParent(db,projectId,item));
 const previousNode={...node,metadata:{...node.metadata,dramaDraft:JSON.stringify({shots:[shot]})}};
 if(!validStoryboardDraftReferences(previousNode,JSON.stringify({shots:[updated]}),
  dependencies,(graph.connections??[])))
  throw fail("drama_draft_invalid");
 // Fast path only when the complete source is canonical JSON, and the indexed
 // entry still agrees with its exact ordinal in authoritative storage.
 const source=db.prepare(`SELECT
   json_type(payload_json,'$.dramaDraft') AS type,
   json_valid(${originalBody}) AS valid,
   json_array_length(CASE WHEN json_valid(${originalBody}) THEN ${originalBody} ELSE '{}' END,'$.shots') AS shotCount,
   json_type(CASE WHEN json_valid(${originalBody}) THEN ${originalBody} ELSE '{}' END,'$.shots') AS listType,
   json_extract(CASE WHEN json_valid(${originalBody}) THEN ${originalBody} ELSE '{}' END,?) AS exact
  FROM creative_node_payloads WHERE project_id=? AND node_id=?`)
  .get(`$.shots[${entry.ordinal}]`,projectId,nodeId);
 if(!source||!source.valid||source.listType!=="array")return false;
 if(source.type!==null&&source.type!=="text")return false;
 if(source.shotCount!==state.entry_count)throw fail("drama_draft_invalid");
 let actual;
 try{actual=JSON.parse(source.exact);}catch{throw fail("drama_draft_invalid");}
 if(digest(actual)!==digest(shot))throw fail("drama_candidate_conflict",409);
  // The old graph has not changed; validating its compact pointer document
 // preserves the existing size/credentials/dangling-edge guard.
 validateDocument(graph);
 const newPath=`$.shots[${entry.ordinal}]`;
 const wrote=db.prepare(`UPDATE creative_node_payloads SET
  payload_json=json_set(payload_json,'$.dramaDraft',
   (json_set(${originalBody},?,json(?)) || '')),
  project_revision=? WHERE project_id=? AND node_id=?`)
  .run(newPath,JSON.stringify(updated),project.revision+1,projectId,nodeId);
 if(wrote.changes!==1)throw fail("creative_payload_missing");
 if(deferProjectCommit)return true;
  const revision=db.prepare("UPDATE projects SET revision=revision+1 WHERE id=? AND revision=?")
  .run(projectId,project.revision);
 if(revision.changes!==1)throw fail("project_revision_conflict",409);
 db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
  .run(projectId,nodeId,command.operationId,fingerprint,project.revision+1);
 emitEvent(db,{id:projectId,revision:project.revision+1,kind:"updated"});
 return true;
}
