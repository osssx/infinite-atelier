/** P3.3b: rebuildable per-entry read indexes.
 * Creative Node payload JSON remains authoritative for Agent, frozen Jobs, ZIP
 * and legacy editing. These rows are not a competing writable representation.
 * Database triggers rebuild both stages inside the originating transaction.
 */
const bodyFor=stage=>stage==="draft"?
 `COALESCE(NULLIF(json_extract(NEW.payload_json,'$.dramaDraft'),''),
   NULLIF(json_extract(NEW.payload_json,'$.dramaConfirmed'),''),
   json_extract(NEW.payload_json,'$.content'),'')`:
 `COALESCE(json_extract(NEW.payload_json,'$.dramaConfirmed'),'')`;
const kinds=[["shots","$.shots"],["episodes","$.episodes"],["assets","$.assets"]];
function rebuildStatement(stage,kind,path){
 const raw=bodyFor(stage);
 // No json_each call is permitted on incomplete JSON editor drafts.
 const safe=`CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END`;
 const ready=`json_type(${safe},'${path}')='array'`;
 return `
 INSERT INTO creative_scope_entry_index
  (project_id,node_id,stage,kind,ordinal,entry_id,episode_id,sequence_id,entry_json)
 SELECT NEW.project_id,NEW.node_id,'${stage}','${kind}',CAST(j.key AS INTEGER),
  CASE WHEN j.type='object' THEN json_extract(j.value,'$.id') END,
  ${kind==="shots"?"CASE WHEN j.type='object' THEN json_extract(j.value,'$.episodeId') END":"NULL"},
  ${kind==="shots"?"CASE WHEN j.type='object' THEN json_extract(j.value,'$.sequenceId') END":"NULL"},
  CASE WHEN j.type='text' THEN json_quote(j.value)
       WHEN j.type='null' THEN 'null' ELSE json(j.value) END
 FROM json_each(${safe},'${path}') j
 WHERE ${ready};
 INSERT INTO creative_scope_index_state(project_id,node_id,stage,kind,entry_count,unique_count)
 SELECT NEW.project_id,NEW.node_id,'${stage}','${kind}',COUNT(*),COUNT(DISTINCT entry_id)
 FROM creative_scope_entry_index
 WHERE project_id=NEW.project_id AND node_id=NEW.node_id AND stage='${stage}' AND kind='${kind}'
 HAVING ${ready};`;
}
const refresh=`
 DELETE FROM creative_scope_index_state WHERE project_id=NEW.project_id AND node_id=NEW.node_id;
 DELETE FROM creative_scope_entry_index WHERE project_id=NEW.project_id AND node_id=NEW.node_id;
 ${["draft","confirmed"].flatMap(stage=>kinds.map(([kind,path])=>rebuildStatement(stage,kind,path))).join("\n")}
`;
function rebuildHistoryStatement(kind,path){
 const safe="CASE WHEN json_valid(NEW.content) THEN NEW.content ELSE '{}' END";
 const ready="json_type("+safe+",'"+path+"')='array'";
 return [
  "INSERT INTO creative_scope_history_entries"+
   " (project_id,node_id,version_id,kind,ordinal,entry_id,episode_id,sequence_id,entry_json)",
  " SELECT NEW.project_id,NEW.node_id,NEW.id,'"+kind+"',CAST(j.key AS INTEGER),",
  " CASE WHEN j.type='object' THEN json_extract(j.value,'$.id') END,",
  kind==="shots"?
   " CASE WHEN j.type='object' THEN json_extract(j.value,'$.episodeId') END, "+
   "CASE WHEN j.type='object' THEN json_extract(j.value,'$.sequenceId') END,":
   " NULL,NULL,",
  " CASE WHEN j.type='text' THEN json_quote(j.value)"+
   " WHEN j.type='null' THEN 'null' ELSE json(j.value) END",
  " FROM json_each("+safe+",'"+path+"') j WHERE "+ready+";",
  "INSERT INTO creative_scope_history_state (project_id,node_id,version_id,kind,entry_count,unique_count)",
  " SELECT NEW.project_id,NEW.node_id,NEW.id,'"+kind+"',COUNT(*),COUNT(DISTINCT entry_id)",
  " FROM creative_scope_history_entries WHERE project_id=NEW.project_id AND node_id=NEW.node_id"+
   " AND version_id=NEW.id AND kind='"+kind+"' HAVING "+ready+";",
 ].join("\n");
}
const historyRefresh=[
 "DELETE FROM creative_scope_history_state WHERE project_id=NEW.project_id AND node_id=NEW.node_id AND version_id=NEW.id;",
 "DELETE FROM creative_scope_history_entries WHERE project_id=NEW.project_id AND node_id=NEW.node_id AND version_id=NEW.id;",
 ...kinds.map(([kind,path])=>rebuildHistoryStatement(kind,path)),
].join("\n");
export const CREATIVE_SCOPE_INDEX_SCHEMA=`
 CREATE TABLE IF NOT EXISTS creative_scope_entry_index(
  project_id TEXT NOT NULL,node_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('draft','confirmed')),
  kind TEXT NOT NULL CHECK(kind IN ('shots','episodes','assets')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),entry_id TEXT,episode_id TEXT,sequence_id TEXT,
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  PRIMARY KEY(project_id,node_id,stage,kind,ordinal),
  FOREIGN KEY(project_id,node_id) REFERENCES creative_node_payloads(project_id,node_id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS creative_scope_entries_by_episode
  ON creative_scope_entry_index(project_id,node_id,stage,kind,episode_id,sequence_id,ordinal);
 CREATE INDEX IF NOT EXISTS creative_scope_entries_by_id
  ON creative_scope_entry_index(project_id,node_id,stage,kind,entry_id);
 CREATE TABLE IF NOT EXISTS creative_scope_index_state(
  project_id TEXT NOT NULL,node_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('draft','confirmed')),
  kind TEXT NOT NULL CHECK(kind IN ('shots','episodes','assets')),
  entry_count INTEGER NOT NULL,unique_count INTEGER NOT NULL,
  PRIMARY KEY(project_id,node_id,stage,kind),
  FOREIGN KEY(project_id,node_id) REFERENCES creative_node_payloads(project_id,node_id) ON DELETE CASCADE);
 CREATE TRIGGER IF NOT EXISTS creative_scope_payload_insert
  AFTER INSERT ON creative_node_payloads BEGIN ${refresh} END;
 CREATE TRIGGER IF NOT EXISTS creative_scope_payload_update
  AFTER UPDATE OF payload_json ON creative_node_payloads BEGIN ${refresh} END;
 CREATE TABLE IF NOT EXISTS creative_scope_history_entries(
  project_id TEXT NOT NULL,node_id TEXT NOT NULL,version_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('shots','episodes','assets')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  entry_id TEXT,episode_id TEXT,sequence_id TEXT,
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  PRIMARY KEY(project_id,node_id,version_id,kind,ordinal),
  FOREIGN KEY(project_id,node_id,version_id)
   REFERENCES canvas_text_versions(project_id,node_id,id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS creative_scope_history_by_episode
  ON creative_scope_history_entries(project_id,node_id,version_id,kind,episode_id,sequence_id,ordinal);
 CREATE INDEX IF NOT EXISTS creative_scope_history_by_id
  ON creative_scope_history_entries(project_id,node_id,version_id,kind,entry_id);
 CREATE TABLE IF NOT EXISTS creative_scope_history_state(
  project_id TEXT NOT NULL,node_id TEXT NOT NULL,version_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('shots','episodes','assets')),
  entry_count INTEGER NOT NULL,unique_count INTEGER NOT NULL,
  PRIMARY KEY(project_id,node_id,version_id,kind),
  FOREIGN KEY(project_id,node_id,version_id)
   REFERENCES canvas_text_versions(project_id,node_id,id) ON DELETE CASCADE);
 CREATE TRIGGER IF NOT EXISTS creative_scope_history_insert
  AFTER INSERT ON canvas_text_versions WHEN NEW.source='confirmation' BEGIN ${historyRefresh} END;
 CREATE TRIGGER IF NOT EXISTS creative_scope_history_update
  AFTER UPDATE OF content ON canvas_text_versions WHEN NEW.source='confirmation' BEGIN ${historyRefresh} END;
`;
