/** Single-user local Canvas backend. No origin-local project storage. */
export class CanvasApiError extends Error{
 constructor(readonly code:string,readonly status:number){super(code)}
}
let csrf:string|null=null,initializing:Promise<string>|null=null;
export async function canvasSession(force=false):Promise<string>{
 if(csrf&&!force)return csrf;
 if(initializing)return initializing;
 initializing=(async()=>{
  const response=await fetch("/api/v1/session",{credentials:"same-origin",cache:"no-store"});
  if(!response.ok)throw new CanvasApiError("backend_unavailable",response.status);
  const data=await response.json() as {csrfToken?:string};
  if(typeof data.csrfToken!=="string"||!data.csrfToken)
   throw new CanvasApiError("backend_invalid_session",response.status);
  csrf=data.csrfToken;return csrf;
 })();
 try{return await initializing}finally{initializing=null}
}
export async function canvasApi<T>(path:string,method="GET",payload?:unknown):Promise<T>{
 if(!path.startsWith("/api/v1/"))throw Error("invalid_canvas_api_path");
 for(let attempts=0;attempts<2;attempts++){
  const token=await canvasSession(attempts>0);
  let response:Response;
  try{response=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
   headers:{"accept":"application/json",...(method!=="GET"?{"x-atelier-csrf":token}:{}),
    ...(payload===undefined?{}:{"content-type":"application/json"})},
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})})}
  catch{throw new CanvasApiError("backend_unavailable",0)}
  if(response.status===401&&attempts===0){csrf=null;continue}
  const data:unknown=await response.json().catch(()=>null);
  if(!response.ok){
   const code=(data&&typeof data==="object"&&"code" in data&&typeof data.code==="string")?data.code:"backend_http_error";
   throw new CanvasApiError(code,response.status);
  }
  if(!data||typeof data!=="object")throw new CanvasApiError("backend_invalid_json",response.status);
  return data as T;
 }
 throw new CanvasApiError("backend_unauthorized",401);
}
export type CanvasBackendProject={id:string;revision:number;document:Record<string,unknown>};
export type CanvasBackendSummary={id:string;title:string;revision:number;nodeCount:number;connectionCount:number;updatedAt?:number};
