/** Backend-owned immutable media identity; shared by Canvas & media readers. */
const RE=/^cas:([a-f0-9]{64})$/;
export const isCanvasCasKey=(key:string)=>RE.test(key);
export function canvasCasUrl(storageKey:string):string|null{
 const match=storageKey.match(RE);
 return match?"/api/v1/blobs/"+match[1]:null;
}
export function canvasCasKey(blobId:string):string{
 if(!/^[a-f0-9]{64}$/.test(blobId))throw Error("canvas_invalid_blob_id");
 return "cas:"+blobId;
}
export async function getCanvasBlob(storageKey:string):Promise<Blob|null>{
 const url=canvasCasUrl(storageKey);
 if(!url)return null;
 const response=await fetch(url,{credentials:"same-origin"});
 if(!response.ok)throw Error("canvas_blob_read_failed:"+response.status);
 return response.blob();
}
