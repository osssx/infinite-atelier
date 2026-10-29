import {randomUUID} from "node:crypto";
import {stableJson,writeTransaction,assertNoRawCredentials} from "./repository.mjs";
import {validCanvasNodeId} from "../canvas-node-id.mjs";
import {initialCanvasState} from "./canvas-state.mjs";
const problem=(code,statusCode=400,details)=>Object.assign(new Error(code),{code,statusCode,details});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
/** Separate project graph from P2 state. The old document fields never
 * become a second writable copy of viewport/chat after schema v7. */
const graphDocument=doc=>{
 if(!doc||typeof doc!=="object"||Array.isArray(doc))return doc;
 const {viewport,chatSessions,activeChatId,...graph}=doc;
 return graph;
};

export function validateProjectDocument(document){
 if(!document||typeof document!=="object"||Array.isArray(document)||!Array.isArray(document.nodes)||!Array.isArray(document.connections))throw problem("invalid_project_document",400,{reason:"graph_shape"});
 assertNoRawCredentials(document);
 const ids=new Set();
 for(const [index,n] of document.nodes.entries()){
  if(!n||!validCanvasNodeId(n.id))
   throw problem("invalid_project_document",400,{reason:"node_id",nodeIndex:index});
  if(ids.has(n.id))
   throw problem("invalid_project_document",400,{reason:"duplicate_node_id",nodeIndex:index});
  if(typeof n.type!=="string")
   throw problem("invalid_project_document",400,{reason:"node_type",nodeIndex:index});
  ids.add(n.id);
 }
 for(const [index,c] of document.connections.entries()){
  if(!c||!ids.has(c.fromNodeId)||!ids.has(c.toNodeId))
   throw problem("invalid_project_document",400,{reason:"dangling_connection",connectionIndex:index});
  if(c.fromNodeId===c.toNodeId)
   throw problem("invalid_project_document",400,{reason:"self_connection",connectionIndex:index});
 }
 const json=stableJson(document);
 if(Buffer.byteLength(json)>4*1024*1024)throw problem("project_document_too_large",413);
 return json;
}
const map=row=>row?{id:row.id,revision:row.revision,document:JSON.parse(row.document_json),deletedAt:row.deleted_at}:null;
export function emitProjectEvent(db,{id,revision,kind}){
 db.prepare("INSERT INTO project_events(project_id,revision,kind,created_at) VALUES(?,?,?,?)")
  .run(id,revision,kind,Date.now());
}
export function listProjectSummaries(db){
 return db.prepare("SELECT id,revision,document_json FROM projects WHERE deleted_at IS NULL ORDER BY id").all()
  .map(row=>{
   const doc=JSON.parse(row.document_json);
   return {id:row.id,revision:row.revision,title:typeof doc.title==="string"&&doc.title.trim()?doc.title:row.id,
    nodeCount:doc.nodes.length,connectionCount:doc.connections.length};
  });
}
export function projectEventCursor(db){
 return db.prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM project_events").get().cursor;
}

export function createProject(db,{id=randomUUID(),document}){
 if(!validId(id))throw problem("invalid_project_id");
 const content=validateProjectDocument(graphDocument(document));
 return writeTransaction(db,()=>{
  if(db.prepare("SELECT id FROM projects WHERE id=?").get(id))throw problem("project_id_conflict",409);
  db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,1)").run(id,content);
  initialCanvasState(db,id,document);
  emitProjectEvent(db,{id,revision:1,kind:"created"});
  return map(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
 });
}
export function getProject(db,id){
 const row=db.prepare("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(id);
 if(!row)throw problem("project_not_found",404);
 return map(row);
}
export function deleteProject(db,id){
 if(!validId(id))throw problem("invalid_project_id");
 return writeTransaction(db,()=>{
  const current=db.prepare("SELECT revision FROM projects WHERE id=? AND deleted_at IS NULL").get(id);
  if(!current)throw problem("project_not_found",404);
  db.prepare("UPDATE projects SET deleted_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL")
   .run(Date.now(),id);
  // v6 event-kind constraint: the list consumer re-fetches after any update.
  emitProjectEvent(db,{id,revision:current.revision+1,kind:"updated"});
  return {id,deleted:true};
 });
}
/** Single-user autosave: the editor owns ordinary nodes; the background
 * materializer owns new CAS results. A late save must not erase a completed
 * background output. No multi-user conflict/rebase protocol is needed.
 */
export function saveSingleUserCanvas(db,{id,expectedRevision,document}){
 if(!validId(id))throw problem("invalid_project_id");
 if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1))
  throw problem("expected_revision_required");
 const incoming=graphDocument(document);
 validateProjectDocument(incoming);
 return writeTransaction(db,()=>{
  const row=db.prepare("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(id);
  if(!row)throw problem("project_not_found",404);
  const current=JSON.parse(row.document_json);
  const next={...incoming,nodes:[...incoming.nodes],connections:[...incoming.connections]};
  if(expectedRevision===undefined||expectedRevision<row.revision){
   const ids=new Set(next.nodes.map(n=>n.id));
   const edges=new Set(next.connections.map(e=>e.id));
   const restored=new Set();
   for(const node of current.nodes){
    const origin=node.metadata?.comfyArtifact??node.metadata?.modelArtifact;
    if(!origin||node.id!=="artifact-"+origin.artifactId||ids.has(node.id))continue;
    const materialized=db.prepare(
     "SELECT 1 FROM materializations WHERE artifact_id=? AND node_id=? AND project_id=? AND status='materialized' LIMIT 1"
    ).get(origin.artifactId,node.id,id);
    if(!materialized)continue;
    next.nodes.push(node);ids.add(node.id);restored.add(node.id);
   }
   for(const edge of current.connections){
    if(!restored.has(edge.toNodeId)||edges.has(edge.id)||!ids.has(edge.fromNodeId))continue;
    // An edited workflow may have changed or removed the output port.
    // Keep its already generated artifact, but do not restore a stale edge.
    const source=next.nodes.find(n=>n.id===edge.fromNodeId);
    if(edge.fromPortId&&source?.type==="comfy:workflow"&&
       !source.metadata?.comfyPorts?.some(p=>p.id===edge.fromPortId&&p.direction==="source"))
     continue;
    next.connections.push(edge);edges.add(edge.id);
   }
  }
  const content=validateProjectDocument(next);
  const revision=row.revision+1;
  db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=? AND deleted_at IS NULL")
   .run(content,revision,id);
  emitProjectEvent(db,{id,revision,kind:"updated"});
  return map(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
 });
}

export function patchProject(db,{id,expectedRevision,document}){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw problem("expected_revision_required");
 const content=validateProjectDocument(graphDocument(document));
 return writeTransaction(db,()=>{
  const changed=db.prepare("UPDATE projects SET document_json=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL").run(content,id,expectedRevision);
  if(!changed.changes){
   const current=db.prepare("SELECT revision,deleted_at FROM projects WHERE id=?").get(id);
   if(!current||current.deleted_at!==null)throw problem("project_not_found",404);
   throw problem("project_revision_conflict",409,{currentRevision:current.revision});
  }
  emitProjectEvent(db,{id,revision:expectedRevision+1,kind:"updated"});
  return map(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
 });
}
