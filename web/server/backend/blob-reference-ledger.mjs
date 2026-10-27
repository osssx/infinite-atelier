import {writeTransaction} from "./repository.mjs";

// Conservative extraction intentionally preserves ANY SHA-256-looking ID in
// owned JSON. False positives retain bytes; false negatives risk data loss.
const hashes=/[a-f0-9]{64}/g;
const sourceQueries=[
 ["project","SELECT id AS owner,document_json AS body FROM projects WHERE deleted_at IS NULL"],
 ["chat","SELECT project_id AS owner,sessions_json AS body FROM project_chats c JOIN projects p ON p.id=c.project_id WHERE p.deleted_at IS NULL"],
 ["job","SELECT id AS owner,snapshot_json AS body FROM jobs"],
 ["comfy_graph","SELECT job_id AS owner,graph_json AS body FROM comfy_job_preparations"],
 ["comfy_files","SELECT job_id AS owner,image_files_json AS body FROM comfy_job_preparations"],
 ["artifact","SELECT id AS owner,blob_id AS body FROM artifacts"],
 ["artifact_metadata","SELECT id AS owner,metadata_json AS body FROM artifacts"],
 ["job_event","SELECT CAST(seq AS TEXT) AS owner,payload_json AS body FROM job_events"],
 ["comfy_template","SELECT template_id || ':' || revision AS owner,payload_json AS body FROM comfy_template_versions"],
 ["ark_asset","SELECT blob_id || ':' || bucket || ':' || project_name || ':' || group_id AS owner,blob_id AS body FROM ark_asset_uploads"],
 ["asset_catalog","SELECT CAST(id AS TEXT) AS owner,assets_json AS body FROM asset_catalog"]
];
export function scanBlobReferenceSources(db,consume){
 for(const [kind,sql] of sourceQueries){
  for(const row of db.prepare(sql).iterate()){
   if(typeof row.body!=="string")continue;
   const seen=new Set();
   for(const hit of row.body.matchAll(hashes))seen.add(hit[0]);
   for(const blobId of seen)consume(kind,String(row.owner),blobId);
  }
 }
}
export function currentBlobReferences(db){
 const found=new Set();
 scanBlobReferenceSources(db,(_kind,_id,hash)=>found.add(hash));
 return found;
}
export function blobReferenceLedgerStatus(db){
 const state=db.prepare("SELECT dirty,change_seq,rebuilt_seq,rebuilt_at FROM blob_ref_ledger_state WHERE id=1").get();
 if(!state)throw Error("blob_reference_ledger_missing");
 return {dirty:!!state.dirty,changeSeq:state.change_seq,rebuiltSeq:state.rebuilt_seq,
  rebuiltAt:state.rebuilt_at,
  entries:db.prepare("SELECT COUNT(*) AS n FROM blob_ref_ledger").get().n};
}
/** Full owner-aware rebuild, guarded by a single BEGIN IMMEDIATE transaction.
 * Known writes mark the ledger dirty via SQL triggers in their own transaction.
 * May run after a crash, offline or during an explicit GC maintenance request.
 */
export function rebuildBlobReferenceLedger(db,{force=false}={}){
 return writeTransaction(db,()=>{
  const state=blobReferenceLedgerStatus(db);
  if(!state.dirty&&!force)return {...state,rebuild:false};
  const insert=db.prepare("INSERT OR IGNORE INTO blob_ref_ledger(source_kind,source_id,blob_id) VALUES(?,?,?)");
  db.prepare("DELETE FROM blob_ref_ledger").run();
  scanBlobReferenceSources(db,(kind,owner,id)=>insert.run(kind,owner,id));
  db.prepare("UPDATE blob_ref_ledger_state SET dirty=0,rebuilt_seq=change_seq,rebuilt_at=? WHERE id=1").run(Date.now());
  return {...blobReferenceLedgerStatus(db),rebuild:true};
 });
}
export function persistedBlobReferences(db){
 const values=new Set();
 for(const row of db.prepare("SELECT DISTINCT blob_id FROM blob_ref_ledger").iterate())values.add(row.blob_id);
 return values;
}
