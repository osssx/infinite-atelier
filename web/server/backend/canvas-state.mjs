import {writeTransaction,stableJson,assertNoRawCredentials} from "./repository.mjs";
const fail=(code,statusCode=400,details)=>Object.assign(Error(code),{code,statusCode,details});
export const DEFAULT_VIEWPORT=Object.freeze({x:0,y:0,k:1});
function activeProject(db,id){
 if(!db.prepare("SELECT 1 AS active FROM projects WHERE id=? AND deleted_at IS NULL").get(id))
  throw fail("project_not_found",404);
}
function encodeViewport(value){
 if(!value||Array.isArray(value)||typeof value!=="object"||
  !["x","y","k"].every(key=>typeof value[key]==="number"&&Number.isFinite(value[key]))||
  Math.abs(value.x)>1e9||Math.abs(value.y)>1e9||value.k<=0||value.k>100)
  throw fail("invalid_canvas_viewport");
 return stableJson({x:value.x,y:value.y,k:value.k});
}
function encodeChats(sessions,activeChatId){
 if(!Array.isArray(sessions)||sessions.length>500||!(activeChatId===null||
  (typeof activeChatId==="string"&&activeChatId.length>0&&activeChatId.length<=128)))
  throw fail("invalid_canvas_chats");
 const ids=new Set();
 for(const session of sessions){
  if(!session||typeof session!=="object"||typeof session.id!=="string"||
   session.id.length===0||session.id.length>128||ids.has(session.id)||
   typeof session.title!=="string"||!Array.isArray(session.messages))
   throw fail("invalid_canvas_chats");
  ids.add(session.id);
 }
 if(activeChatId!==null&&!ids.has(activeChatId))throw fail("invalid_canvas_chats");
 assertNoRawCredentials({sessions});
 const json=stableJson(sessions);
 if(Buffer.byteLength(json)>4*1024*1024)throw fail("canvas_chats_too_large",413);
 return json;
}
export function initialCanvasState(db,id,{viewport,chatSessions,activeChatId}={}){
 const viewportJson=encodeViewport(viewport??DEFAULT_VIEWPORT);
 const sessionsJson=encodeChats(chatSessions??[],activeChatId??null);
 db.prepare("INSERT INTO project_viewports(project_id,viewport_json,revision) VALUES(?,?,1)").run(id,viewportJson);
 db.prepare("INSERT INTO project_chats(project_id,sessions_json,active_chat_id,revision,updated_at) VALUES(?,?,?,1,?)")
  .run(id,sessionsJson,activeChatId??null,Date.now());
}
export function getCanvasViewport(db,id){
 activeProject(db,id);
 const row=db.prepare("SELECT viewport_json,revision FROM project_viewports WHERE project_id=?").get(id);
 return {viewport:row?JSON.parse(row.viewport_json):DEFAULT_VIEWPORT,revision:row?.revision??1};
}
export function putCanvasViewport(db,id,{viewport,expectedRevision}){
 const json=encodeViewport(viewport);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fail("expected_revision_required");
 return writeTransaction(db,()=>{
  activeProject(db,id);
  const result=db.prepare("UPDATE project_viewports SET viewport_json=?,revision=revision+1 WHERE project_id=? AND revision=?")
   .run(json,id,expectedRevision);
  if(!result.changes)throw fail("viewport_revision_conflict",409);
  return {viewport:JSON.parse(json),revision:expectedRevision+1};
 });
}
export function getCanvasChats(db,id){
 activeProject(db,id);
 const row=db.prepare("SELECT sessions_json,active_chat_id,revision FROM project_chats WHERE project_id=?").get(id);
 return {sessions:row?JSON.parse(row.sessions_json):[],activeChatId:row?.active_chat_id??null,revision:row?.revision??1};
}
export function putCanvasChats(db,id,{sessions,activeChatId,expectedRevision}){
 const json=encodeChats(sessions,activeChatId);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fail("expected_revision_required");
 return writeTransaction(db,()=>{
  activeProject(db,id);
  const result=db.prepare("UPDATE project_chats SET sessions_json=?,active_chat_id=?,revision=revision+1,updated_at=? WHERE project_id=? AND revision=?")
   .run(json,activeChatId,Date.now(),id,expectedRevision);
  if(!result.changes)throw fail("chats_revision_conflict",409);
  return {sessions:JSON.parse(json),activeChatId,revision:expectedRevision+1};
 });
}
