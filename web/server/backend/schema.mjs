import{JOB_STATUSES,EXECUTION_MODES,ARTIFACT_KINDS}from"./contracts.mjs";
export const SCHEMA_VERSION=1;
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
export function initializeSchema(db){
 db.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");
 try{
  db.exec(INITIAL_SCHEMA_SQL);
  const version=db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v??0;
  if(version>SCHEMA_VERSION)throw Error("database_schema_too_new");
  if(version<SCHEMA_VERSION)db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(SCHEMA_VERSION,Date.now());
  db.exec("COMMIT");
 }catch(e){db.exec("ROLLBACK");throw e}
}
