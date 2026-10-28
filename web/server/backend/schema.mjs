import{JOB_STATUSES,EXECUTION_MODES,ARTIFACT_KINDS}from"./contracts.mjs";
export const SCHEMA_VERSION=17;
const quoted=x=>x.map(s=>"'"+s+"'").join(",");
export const INITIAL_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,document_json TEXT NOT NULL CHECK(json_valid(document_json)),revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS project_viewports(project_id TEXT PRIMARY KEY REFERENCES projects(id),viewport_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL CHECK(byte_size>=0),mime TEXT NOT NULL,relative_path TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(
 id TEXT PRIMARY KEY,principal TEXT NOT NULL,project_scope TEXT NOT NULL,
 project_id TEXT REFERENCES projects(id),target_node_id TEXT,
 expected_project_revision INTEGER,source_fingerprint TEXT,
 idempotency_key TEXT NOT NULL,request_fingerprint TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 execution_mode TEXT NOT NULL CHECK(execution_mode IN (${quoted(EXECUTION_MODES)})),
 status TEXT NOT NULL CHECK(status IN (${quoted(JOB_STATUSES)})),
 upstream_task_id TEXT,attempt_id TEXT,submit_marker TEXT,submission_started_at INTEGER,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(principal,project_scope,idempotency_key),
 CHECK((project_id IS NULL AND project_scope='') OR(project_id IS NOT NULL AND project_scope=project_id)),
 CHECK((project_id IS NULL AND target_node_id IS NULL) OR
 (project_id IS NOT NULL AND target_node_id IS NOT NULL AND expected_project_revision IS NOT NULL AND source_fingerprint IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status,created_at);
CREATE TABLE IF NOT EXISTS job_attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,secret_version_ref TEXT,upstream_task_id TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT);
CREATE TABLE IF NOT EXISTS artifacts(
 id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),
 port_id TEXT CHECK(port_id IS NULL OR length(port_id)>0),item_key TEXT NOT NULL CHECK(length(item_key)>0),
 blob_id TEXT NOT NULL REFERENCES blobs(id),
 kind TEXT NOT NULL CHECK(kind IN (${quoted(ARTIFACT_KINDS)})),
 mime TEXT NOT NULL,sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_port ON artifacts(job_id,port_id,item_key) WHERE port_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_no_port ON artifacts(job_id,item_key) WHERE port_id IS NULL;
CREATE TABLE IF NOT EXISTS materializations(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),artifact_id TEXT NOT NULL REFERENCES artifacts(id),project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,node_id TEXT,reason TEXT,UNIQUE(project_id,artifact_id));
CREATE TABLE IF NOT EXISTS job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),kind TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_job_events_job_seq ON job_events(job_id,seq);
`;

/** Schema v2: versioned encrypted credentials. Cipher bytes are never in
 * channel configuration JSON or the jobs snapshot. Old versions are retained
 * across rotations for already-frozen jobs unless explicitly revoked.
 */
export const CREDENTIAL_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS channels(
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 display_name TEXT NOT NULL,
 current_version_id TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credential_versions(
 id TEXT PRIMARY KEY,
 channel_id TEXT NOT NULL REFERENCES channels(id),
 version_num INTEGER NOT NULL CHECK(version_num>0),
 ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
 created_at INTEGER NOT NULL,
 revoked_at INTEGER,
 UNIQUE(channel_id,version_num)
);
CREATE INDEX IF NOT EXISTS ix_credential_versions_channel ON credential_versions(channel_id,version_num);
CREATE TRIGGER IF NOT EXISTS credential_cipher_immutable
 BEFORE UPDATE OF ciphertext,channel_id,version_num ON credential_versions
 BEGIN SELECT RAISE(ABORT,'immutable_credential_version'); END;
CREATE TRIGGER IF NOT EXISTS credential_version_no_delete
 BEFORE DELETE ON credential_versions
 BEGIN SELECT RAISE(ABORT,'immutable_credential_version'); END;
`;

/** v3 durable ownership, restart receipt and the explicit submit barrier.
 * Leases are never reclaimed on timeout inside a live process: only the
 * exclusively locked replacement process performs startup recovery.
 */
export const COORDINATOR_SCHEMA_SQL=`
ALTER TABLE jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN lease_acquired_at INTEGER;
ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE jobs ADD COLUMN recovery_receipt_json TEXT CHECK(recovery_receipt_json IS NULL OR json_valid(recovery_receipt_json));
CREATE INDEX IF NOT EXISTS ix_jobs_lease ON jobs(lease_owner,status,created_at);
CREATE INDEX IF NOT EXISTS ix_job_attempts_job ON job_attempts(job_id,started_at);
`;

/** Compilation is pinned before /prompt. No recompilation in submit or restart paths. */
export const COMFY_PREPARATIONS_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS comfy_job_preparations(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 graph_json TEXT NOT NULL CHECK(json_valid(graph_json)),
 capture_map_json TEXT NOT NULL CHECK(json_valid(capture_map_json)),
 graph_hash TEXT NOT NULL,
 image_files_json TEXT NOT NULL CHECK(json_valid(image_files_json)),
 workflow_node_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
`;

/** Persisted poll and collection due-times. Never schedules a second submit. */
export const JOB_SCHEDULE_SCHEMA_SQL=`
ALTER TABLE materializations ADD COLUMN next_due_at INTEGER;
ALTER TABLE materializations ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS job_schedules(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 due_at INTEGER NOT NULL DEFAULT 0,
 poll_failures INTEGER NOT NULL DEFAULT 0,
 collect_failures INTEGER NOT NULL DEFAULT 0,
 last_reason TEXT,
 CHECK(poll_failures>=0 AND collect_failures>=0)
);
CREATE INDEX IF NOT EXISTS ix_job_schedules_due ON job_schedules(due_at);
`;
export const PROJECT_EVENTS_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS project_events(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('created','updated','materialized')),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_project_events_project ON project_events(project_id,seq);
`;
/** Dedicated P2 state; graph revisions never change for viewport/chat updates. */
export const CANVAS_STATE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS project_chats(
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 sessions_json TEXT NOT NULL CHECK(json_valid(sessions_json)),
 active_chat_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at INTEGER NOT NULL
);
`;
/** P4.4 local video -> TOS -> CreateAsset -> GetAsset.
 * 'creating' is an irreversible submit barrier; unknown outcomes must never
 * cause a second CreateAsset after an unclean restart.
 */
export const ARK_ASSET_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS ark_asset_uploads(
 blob_id TEXT NOT NULL REFERENCES blobs(id),
 bucket TEXT NOT NULL,
 project_name TEXT NOT NULL,
 group_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('staged','creating','processing','active','failed')),
 asset_id TEXT,
 object_key TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(blob_id,bucket,project_name,group_id)
);
CREATE INDEX IF NOT EXISTS ix_ark_asset_uploads_status ON ark_asset_uploads(status);
`;
/** P4.5: immutable Comfy workflow versions with replaceable named preset pointers. */
export const COMFY_REGISTRY_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS comfy_template_versions(
 template_id TEXT NOT NULL,revision TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 created_at INTEGER NOT NULL,PRIMARY KEY(template_id,revision)
);
CREATE TABLE IF NOT EXISTS comfy_presets(
 id TEXT PRIMARY KEY,name TEXT NOT NULL,template_id TEXT NOT NULL,revision TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 FOREIGN KEY(template_id,revision) REFERENCES comfy_template_versions(template_id,revision)
);
CREATE INDEX IF NOT EXISTS ix_comfy_presets_template ON comfy_presets(template_id,revision);
`;
/** v10: Conservative persisted CAS references. Triggers only mark dirty in
 * the SAME SQLite transaction as source edits. A maintenance rebuild produces
 * the exact owner/hash rows; GC also rescans live sources before unlinking.
 */
export const BLOB_REF_LEDGER_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS blob_ref_ledger_state(
 id INTEGER PRIMARY KEY CHECK(id=1),dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
 change_seq INTEGER NOT NULL DEFAULT 0,rebuilt_seq INTEGER NOT NULL DEFAULT 0,
 rebuilt_at INTEGER
);
INSERT OR IGNORE INTO blob_ref_ledger_state(id,dirty,change_seq,rebuilt_seq)
 VALUES(1,1,0,0);
CREATE TABLE IF NOT EXISTS blob_ref_ledger(
 source_kind TEXT NOT NULL,source_id TEXT NOT NULL,blob_id TEXT NOT NULL,
 PRIMARY KEY(source_kind,source_id,blob_id)
);
CREATE INDEX IF NOT EXISTS ix_blob_ref_ledger_blob ON blob_ref_ledger(blob_id);
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_projects_insert AFTER INSERT ON projects
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_projects_update AFTER UPDATE ON projects
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_projects_delete AFTER DELETE ON projects
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_project_chats_insert AFTER INSERT ON project_chats
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_project_chats_update AFTER UPDATE ON project_chats
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_project_chats_delete AFTER DELETE ON project_chats
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_jobs_insert AFTER INSERT ON jobs
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_jobs_update AFTER UPDATE ON jobs
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_jobs_delete AFTER DELETE ON jobs
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_job_preparations_insert AFTER INSERT ON comfy_job_preparations
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_job_preparations_update AFTER UPDATE ON comfy_job_preparations
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_job_preparations_delete AFTER DELETE ON comfy_job_preparations
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_artifacts_insert AFTER INSERT ON artifacts
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_artifacts_update AFTER UPDATE ON artifacts
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_artifacts_delete AFTER DELETE ON artifacts
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_job_events_insert AFTER INSERT ON job_events
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_job_events_update AFTER UPDATE ON job_events
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_job_events_delete AFTER DELETE ON job_events
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_template_versions_insert AFTER INSERT ON comfy_template_versions
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_template_versions_update AFTER UPDATE ON comfy_template_versions
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_comfy_template_versions_delete AFTER DELETE ON comfy_template_versions
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_ark_asset_uploads_insert AFTER INSERT ON ark_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_ark_asset_uploads_update AFTER UPDATE ON ark_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_ark_asset_uploads_delete AFTER DELETE ON ark_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
`;
/** P5.4a: Non-Canvas Asset Library metadata becomes backup-safe SQLite.
 * Binary media lives in the existing CAS BlobStore. Explicit browser imports
 * must upload and validate media before this catalog can point at it.
 */
export const ASSET_CATALOG_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS asset_catalog(
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 assets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(assets_json))
);
INSERT OR IGNORE INTO asset_catalog(id,revision,assets_json) VALUES(1,1,'[]');
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_asset_catalog_update AFTER UPDATE ON asset_catalog
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
`;
/** v12: non-secret, revision-fenced UI settings. Encrypted credentials
 * remain exclusively in the existing vault; raw API keys are never settings.
 */
export const UI_SETTINGS_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS ui_settings(
 name TEXT PRIMARY KEY CHECK(name IN ('model_config','theme')),
 revision INTEGER NOT NULL CHECK(revision>0),
 value_json TEXT NOT NULL CHECK(json_valid(value_json))
);
INSERT OR IGNORE INTO ui_settings(name,revision,value_json)
 VALUES('model_config',1,'{}');
INSERT OR IGNORE INTO ui_settings(name,revision,value_json)
 VALUES('theme',1,'"dark"');
`;
/** v13: authoritative Skill metadata, versioned text and optional original
 * archive bytes. The old browser IndexedDB is untouched and never a fallback.
 */
export const SKILL_REGISTRY_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS skill_registry_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 1);
INSERT OR IGNORE INTO skill_registry_state(id,revision) VALUES(1,1);
CREATE TABLE IF NOT EXISTS skill_entries(
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,description TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 scope_project_id TEXT,
 active_version TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_versions(
 skill_id TEXT NOT NULL REFERENCES skill_entries(id) ON DELETE CASCADE,
 version TEXT NOT NULL,
 hash TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 skill_md TEXT NOT NULL,
 resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
 archive_bytes BLOB,
 PRIMARY KEY(skill_id,version)
);
`;
/** v14 short-lived server-issued authorization bound to exact CAS bytes.
 * Grant consumption and Job insertion are in a single SQLite transaction.
 */
export const SKILL_GRANT_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS skill_job_grants(
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 blob_id TEXT NOT NULL REFERENCES blobs(id),
 registry_revision INTEGER NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 job_id TEXT UNIQUE REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS ix_skill_job_grants_project ON skill_job_grants(project_id,expires_at);
`;
/** v15: local Comfy execution instances share the SQLite JobCoordinator source of truth. */
export const COMFY_INSTANCES_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS comfy_instances(
 id TEXT PRIMARY KEY,
 url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comfy_instance_registry_state(
 id INTEGER PRIMARY KEY CHECK(id=1)
);
`;
/** v16: history removal is an isolated visibility tombstone. Jobs, idempotency,
 * remote submission receipts, collected CAS artifacts and provenance remain intact.
 */
export const JOB_HISTORY_HIDDEN_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS job_history_hidden(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 hidden_at INTEGER NOT NULL
);
`;
/** v17: durable upload barriers for custom provider asset IDs.
 * Never retry an ambiguous upload; the persisted uploading state blocks
 * automatic network replay until manual provider reconciliation.
 */
export const SCRIPT_ASSET_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS script_asset_uploads(
 job_id TEXT NOT NULL REFERENCES jobs(id),
 reference_index INTEGER NOT NULL CHECK(reference_index>=0),
 blob_id TEXT NOT NULL REFERENCES blobs(id),
 script_fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('uploading','active','rejected')),
 remote_asset_id TEXT,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,reference_index),
 CHECK((status='active' AND remote_asset_id IS NOT NULL) OR
       (status!='active' AND remote_asset_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_script_asset_upload_status ON script_asset_uploads(status);
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_script_asset_insert AFTER INSERT ON script_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_script_asset_update AFTER UPDATE ON script_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS blob_ref_dirty_script_asset_delete AFTER DELETE ON script_asset_uploads
 BEGIN UPDATE blob_ref_ledger_state SET dirty=1,change_seq=change_seq+1 WHERE id=1; END;
`;
export function initializeSchema(db){
 db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");
 try{
  db.exec(INITIAL_SCHEMA_SQL);
  const version=db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v??0;
  if(version>SCHEMA_VERSION)throw Error("database_schema_too_new");
  if(version<2)db.exec(CREDENTIAL_SCHEMA_SQL);
  if(version<3)db.exec(COORDINATOR_SCHEMA_SQL);
  if(version<4)db.exec(COMFY_PREPARATIONS_SCHEMA_SQL);
  if(version<5)db.exec(JOB_SCHEDULE_SCHEMA_SQL);
  if(version<6)db.exec(PROJECT_EVENTS_SCHEMA_SQL);
  if(version<7){
   db.exec(CANVAS_STATE_SCHEMA_SQL);
   db.prepare(`INSERT OR IGNORE INTO project_viewports(project_id,viewport_json,revision)
    SELECT id, CASE WHEN json_type(document_json,'$.viewport')='object'
      THEN json_extract(document_json,'$.viewport') ELSE '{"x":0,"y":0,"k":1}' END,1
    FROM projects`).run();
   db.prepare(`INSERT OR IGNORE INTO project_chats(project_id,sessions_json,active_chat_id,revision,updated_at)
    SELECT id,
      CASE WHEN json_type(document_json,'$.chatSessions')='array'
        THEN json_extract(document_json,'$.chatSessions') ELSE '[]' END,
      CASE WHEN json_type(document_json,'$.activeChatId')='text'
        THEN json_extract(document_json,'$.activeChatId') ELSE NULL END,
      1,?
    FROM projects`).run(Date.now());
  }
  if(version<8)db.exec(ARK_ASSET_SCHEMA_SQL);
  if(version<9)db.exec(COMFY_REGISTRY_SCHEMA_SQL);
  if(version<10)db.exec(BLOB_REF_LEDGER_SCHEMA_SQL);
  if(version<11)db.exec(ASSET_CATALOG_SCHEMA_SQL);
  if(version<12)db.exec(UI_SETTINGS_SCHEMA_SQL);
  if(version<13)db.exec(SKILL_REGISTRY_SCHEMA_SQL);
  if(version<14)db.exec(SKILL_GRANT_SCHEMA_SQL);
  if(version<15)db.exec(COMFY_INSTANCES_SCHEMA_SQL);
  if(version<16)db.exec(JOB_HISTORY_HIDDEN_SCHEMA_SQL);
  if(version<17)db.exec(SCRIPT_ASSET_SCHEMA_SQL);
  if(version<SCHEMA_VERSION)db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(SCHEMA_VERSION,Date.now());
  db.exec("COMMIT");
 }catch(e){db.exec("ROLLBACK");throw e}
}
