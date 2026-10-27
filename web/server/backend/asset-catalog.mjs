import {writeTransaction} from "./repository.mjs";

const MAX_BYTES=3*1024*1024;
const MAX_ITEMS=5000;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const CAS=/^cas:([0-9a-f]{64})$/;
const urlOf=id=>"/api/v1/blobs/"+id;
const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const plain=x=>x&&typeof x==="object"&&!Array.isArray(x);
const cleanText=(text,max)=>typeof text==="string"&&text.length<=max;
function checkUrl(url){
 return cleanText(url,2048)&&!url.startsWith("blob:")&&!url.startsWith("data:");
}
function validate(db,assets){
 if(!Array.isArray(assets)||assets.length>MAX_ITEMS)throw fail("asset_catalog_invalid");
 const seen=new Set();
 for(const a of assets){
  if(!plain(a)||typeof a.id!=="string"||!ID.test(a.id)||seen.has(a.id)||
   !["text","image","video"].includes(a.kind)||
   !cleanText(a.title,512)||!cleanText(a.coverUrl,2048)||
   !checkUrl(a.coverUrl)||!Array.isArray(a.tags)||a.tags.length>64||
   !a.tags.every(x=>cleanText(x,128))||
   !cleanText(a.createdAt,64)||!cleanText(a.updatedAt,64)||
   (a.source!==undefined&&!cleanText(a.source,2048))||
   (a.note!==undefined&&!cleanText(a.note,20000))||
   !plain(a.data))throw fail("asset_catalog_invalid");
  seen.add(a.id);
  if(a.kind==="text"){
   if(!cleanText(a.data.content,500000))throw fail("asset_catalog_invalid");
   continue;
  }
  const match=CAS.exec(a.data.storageKey??"");
  if(!match)throw fail("asset_catalog_media_not_portable",422);
  const hash=match[1];
  const record=db.prepare("SELECT mime,byte_size,status FROM blobs WHERE id=?").get(hash);
  if(!record||record.status!=="ready")throw fail("asset_catalog_blob_missing",422);
  if(!record.mime.startsWith(a.kind+"/")||
   a.data.mimeType!==record.mime||a.data.bytes!==record.byte_size||
   !Number.isSafeInteger(a.data.width)||a.data.width<0||
   !Number.isSafeInteger(a.data.height)||a.data.height<0||
   (a.kind==="image"?a.data.dataUrl:a.data.url)!==urlOf(hash))
   throw fail("asset_catalog_media_mismatch",422);
 }
 const json=JSON.stringify(assets);
 if(Buffer.byteLength(json,"utf8")>MAX_BYTES)throw fail("asset_catalog_too_large",413);
 return json;
}
export function getAssetCatalog(db){
 const row=db.prepare("SELECT revision,assets_json FROM asset_catalog WHERE id=1").get();
 if(!row)throw Error("asset_catalog_missing");
 return {revision:row.revision,assets:JSON.parse(row.assets_json)};
}
export function putAssetCatalog(db,{expectedRevision,assets}={}){
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)
  throw fail("asset_catalog_revision_required");
 return writeTransaction(db,()=>{
  const row=db.prepare("SELECT revision FROM asset_catalog WHERE id=1").get();
  if(row?.revision!==expectedRevision)throw fail("asset_catalog_revision_conflict",409);
  const json=validate(db,assets);
  const result=db.prepare("UPDATE asset_catalog SET assets_json=?,revision=revision+1 WHERE id=1 AND revision=?")
   .run(json,expectedRevision);
  if(result.changes!==1)throw fail("asset_catalog_revision_conflict",409);
  return {revision:expectedRevision+1,assets};
 });
}
