/** Origin-local preference only. Never store session tokens, project snapshots or secrets. */
const prefix="atelier:backend-sync:opt-in:";
export function prefersBackendProject(id:string):boolean{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return false;
 try{return window.localStorage.getItem(prefix+id)==="1"}catch{return false}
}
export function setBackendProjectPreference(id:string,enabled:boolean):void{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))return;
 try{
  if(enabled)window.localStorage.setItem(prefix+id,"1");
  else window.localStorage.removeItem(prefix+id);
 }catch{/* private browsing: explicit sync still works for this session */}
}
