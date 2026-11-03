export type ComfyPreviewMedia={kind:"preview";mime:"image/png"|"image/jpeg"|"image/webp"|"video/mp4";version:number;step?:number;steps?:number};
type Dependencies={fetcher?:typeof fetch;createUrl?:(blob:Blob)=>string;revokeUrl?:(url:string)=>void;decodeWebpFrame?:(blob:Blob)=>Promise<Blob>};

async function firstWebpFrame(blob:Blob):Promise<Blob>{
 if(typeof createImageBitmap!=="function")return blob;
 const bitmap=await createImageBitmap(blob),canvas=document.createElement("canvas");
 canvas.width=bitmap.width;canvas.height=bitmap.height;
 const context=canvas.getContext("2d");if(!context){bitmap.close();throw Error("preview_canvas_unavailable")}
 context.drawImage(bitmap,0,0);bitmap.close();
 return new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error("preview_frame_invalid")),"image/png"));
}

/** Latest-wins media loader. Keeps the previous good frame until its replacement is ready. */
export function createComfyPreviewMediaController(deps:Dependencies={}){
 const fetcher=deps.fetcher??fetch,createUrl=deps.createUrl??(blob=>URL.createObjectURL(blob)),
  revokeUrl=deps.revokeUrl??(url=>URL.revokeObjectURL(url));
 let request:AbortController|null=null,current:{runId:string;url:string}|null=null;
 function abortPending(){request?.abort();request=null}
 async function load(runId:string,preview:ComfyPreviewMedia,reducedMotion=false):Promise<{runId:string;url:string;mime:string}|null>{
  abortPending();
  if(current&&current.runId!==runId){revokeUrl(current.url);current=null;}
  const controller=new AbortController();request=controller;
  try{
   const response=await fetcher(`/api/v1/jobs/${encodeURIComponent(runId)}/preview`,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
   if(!response.ok||Number(response.headers.get("X-Preview-Version"))!==preview.version)throw Error("preview_unavailable");
   const blob=await response.blob();if(blob.type!==preview.mime)throw Error("preview_mime_mismatch");
   const display=preview.mime==="image/webp"&&reducedMotion
    ?await (deps.decodeWebpFrame??firstWebpFrame)(blob):blob;
   if(controller.signal.aborted)return null;
   const nextUrl=createUrl(display),previous=current;
   current={runId,url:nextUrl};if(previous)revokeUrl(previous.url);
   return {runId,url:nextUrl,mime:display.type||preview.mime};
  }catch{return null}finally{if(request===controller)request=null}
 }
 function clear(){abortPending();if(current)revokeUrl(current.url);current=null}
 return {load,abortPending,clear,dispose:clear};
}
