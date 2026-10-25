import {randomUUID} from "node:crypto";
import {stableJson,writeTransaction,assertNoRawCredentials} from "./repository.mjs";
const problem=(code,statusCode=400,details)=>Object.assign(new Error(code),{code,statusCode,details});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
export function validateProjectDocument(document){
 if(!document||typeof document!=="object"||Array.isArray(document)||!Array.isArray(document.nodes)||!Array.isArray(document.connections))throw problem("invalid_project_document");
 assertNoRawCredentials(document);
 const ids=new Set();
 for(const n of document.nodes){if(!n||!validId(n.id)||ids.has(n.id)||typeof n.type!=="string")throw problem("invalid_project_document");ids.add(n.id)}
 for(const c of document.connections){if(!c||!ids.has(c.fromNodeId)||!ids.has(c.toNodeId)||c.fromNodeId===c.toNodeId)throw problem("invalid_project_document")}
 const json=stableJson(document);
 if(Buffer.byteLength(json)>4*1024*1024)throw problem("project_document_too_large",413);
 return json;
}
const map=row=>row?{id:row.id,revision:row.revision,document:JSON.parse(row.document_json),deletedAt:row.deleted_at}:null;
export function createProject(db,{id=randomUUID(),document}){
 if(!validId(id))throw problem("invalid_project_id");
 const content=validateProjectDocument(document);
 return writeTransaction(db,()=>{
  if(db.prepare("SELECT id FROM projects WHERE id=?").get(id))throw problem("project_id_conflict",409);
  db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,1)").run(id,content);
  return map(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
 });
}
export function getProject(db,id){
 const row=db.prepare("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(id);
 if(!row)throw problem("project_not_found",404);
 return map(row);
}
export function patchProject(db,{id,expectedRevision,document}){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw problem("expected_revision_required");
 const content=validateProjectDocument(document);
 return writeTransaction(db,()=>{
  const changed=db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL").run(content,id,expectedRevision);
  if(!changed.changes){
   const current=db.prepare("SELECT revision,deleted_at FROM projects WHERE id=?").get(id);
   if(!current||current.deleted_at!==null)throw problem("project_not_found",404);
   throw problem("project_revision_conflict",409,{currentRevision:current.revision});
  }
  return map(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
 });
}
