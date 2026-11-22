/** Read-only fast path for P3.3b, using the transactionally maintained
 * per-entry index. Historical immutable versions use the legacy scoped query.
 */
import {createHash} from "node:crypto";
import {readStoryboardDraft,readEpisodeDraft,readAssetDraft} from "../canvas-text-content.mjs";
import {stableJson} from "./repository.mjs";

const fail=(code)=>Object.assign(Error(code),{code,statusCode:422});
const digest=item=>createHash("sha256").update(stableJson(item)).digest("hex");
const kinds={"drama:storyboard":"shots","drama:episodes":"episodes","drama:assets":"assets"};
const livePart="FROM creative_scope_entry_index WHERE project_id=? AND node_id=? AND stage=? AND kind=?";
const historyPart="FROM creative_scope_history_entries WHERE project_id=? AND node_id=? AND version_id=? AND kind=?";
function indexState(db,projectId,nodeId,stage,kind){
 return db.prepare("SELECT entry_count,unique_count FROM creative_scope_index_state "+
  "WHERE project_id=? AND node_id=? AND stage=? AND kind=?").get(projectId,nodeId,stage,kind);
}
function historyIndexState(db,projectId,nodeId,versionId,kind){
 return db.prepare("SELECT entry_count,unique_count FROM creative_scope_history_state "+
  "WHERE project_id=? AND node_id=? AND version_id=? AND kind=?").get(projectId,nodeId,versionId,kind);
}
function assertValid(state){
 if(state.entry_count!==state.unique_count)throw fail("drama_draft_invalid");
}
const projectFields=(entries,kind)=>{
 const parsed=JSON.stringify({[kind]:entries});
 const valid=kind==="shots"?readStoryboardDraft(parsed):kind==="episodes"?readEpisodeDraft(parsed):readAssetDraft(parsed);
 if(!valid)throw fail("drama_draft_invalid");
};
/** Null means the index is not eligible: inline legacy data, invalid draft,
 * or an unindexed historical revision. Never guess missing indexes.
 */
export function readIndexedDramaScope(db,projectId,nodeId,node,params){
 const kind=kinds[node.type];
 if(!kind||node.pointerRaw===null)return null;
 if(node.pointerNodeId!==nodeId||node.pointerSchemaVersion!==1)throw fail("creative_payload_reference_invalid");
 const {draft=false,versionId,episodeId,sequenceId,entryId,offset=0,limit=50,summaryOnly=false}=params;
 const pinned=draft?null:(versionId??node.confirmedVersionId??null);
 const stage=draft?"draft":"confirmed";
 const state=pinned?historyIndexState(db,projectId,nodeId,pinned,kind):
  indexState(db,projectId,nodeId,stage,kind);
 if(!state)return null;
 assertValid(state);
 const part=pinned?historyPart:livePart;
 // Predicates, not OR-guards, let SQLite seek by episode/sequence or ID.
 const predicates=[],args=[projectId,nodeId,pinned??stage,kind];
 if(episodeId){predicates.push(kind==="shots"?"episode_id=?":"entry_id=?");args.push(episodeId);}
 if(sequenceId){predicates.push("sequence_id=?");args.push(sequenceId);}
 if(entryId){predicates.push("entry_id=?");args.push(entryId);}
 const where=predicates.length?" AND "+predicates.join(" AND "):"";
 const total=predicates.length?db.prepare("SELECT COUNT(*) AS total "+part+where).get(...args).total:
  state.entry_count;
 const groups=[];
 if(kind==="shots"){
  const rows=db.prepare("SELECT episode_id AS episodeId,sequence_id AS sequenceId, "+
   "COUNT(*) AS count,MIN(ordinal) AS firstIndex "+part+
   " GROUP BY episode_id,sequence_id ORDER BY firstIndex").all(projectId,nodeId,pinned??stage,kind);
  for(const row of rows){
   let group=groups.find(item=>item.episodeId===row.episodeId);
   if(!group){group={episodeId:row.episodeId,total:0,sequenceIds:[]};groups.push(group)}
   group.total+=row.count;
   if(row.sequenceId&&!group.sequenceIds.includes(row.sequenceId))group.sequenceIds.push(row.sequenceId);
  }
 }
 const rows=summaryOnly?[]:db.prepare("SELECT entry_json "+part+where+
  " ORDER BY ordinal LIMIT ? OFFSET ?").all(...args,limit,offset);
 const entries=rows.map(row=>JSON.parse(row.entry_json));
 if(entries.length)projectFields(entries,kind);
 return {versionId:pinned,total,offset,limit,groups,entries,
  referenceChoices:null,entryDigests:entries.map(item=>({id:item.id,digest:digest(item)}))};
}
/** The fallback original page reader can still resolve inline or malformed
 * historical assets. For indexed payloads we project small reference choices
 * without ever copying asset descriptions or the full asset JSON into JS.
 */
export function readIndexedAssetChoices(db,projectId,nodeId){
 const state=indexState(db,projectId,nodeId,"confirmed","assets");
 if(!state)return null;
 assertValid(state);
 const rows=db.prepare("SELECT json_extract(entry_json,'$.id') AS id,"+
  "json_extract(entry_json,'$.kind') AS kind,"+
  "json_extract(entry_json,'$.name') AS name,"+
  "json_extract(entry_json,'$.variants') AS variants "+livePart+
  " ORDER BY ordinal").all(projectId,nodeId,"confirmed","assets");
 return rows.map(row=>({id:row.id,kind:row.kind,name:row.name,
  variants:(JSON.parse(row.variants??"[]")).map(item=>({id:item.id,name:item.name}))}));
}
