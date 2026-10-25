import{JOB_STATUSES,EXECUTION_MODES,ARTIFACT_KINDS}from"./contracts.mjs";
export const SCHEMA_VERSION=6;
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
  if(version<SCHEMA_VERSION)db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(SCHEMA_VERSION,Date.now());
  db.exec("COMMIT");
 }catch(e){db.exec("ROLLBACK");throw e}
}
