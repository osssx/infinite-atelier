import {randomUUID} from "node:crypto";
import {writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const validProvider=p=>typeof p==="string"&&/^[A-Za-z0-9._-]{1,64}$/.test(p);
const context=(channelId,versionId)=>"InfiniteAtelier:v2:"+channelId+":"+versionId;
const view=row=>({
 id:row.id,provider:row.provider,displayName:row.display_name,
 hasKey:row.current_version_id!==null,keyVersion:row.current_version_id,
 createdAt:row.created_at,updatedAt:row.updated_at
});
const versionView=row=>({id:row.id,channelId:row.channel_id,version:row.version_num,
 createdAt:row.created_at,revokedAt:row.revoked_at});

/** Encrypted versions never leave the backend; only metadata crosses HTTP. */
export function createCredentialVault({db,protector}={}){
 if(!db||typeof protector?.protect!=="function"||typeof protector?.unprotect!=="function")
  throw Error("credential_vault_protector_required");
 function list(){
  return db.prepare("SELECT id,provider,display_name,current_version_id,created_at,updated_at FROM channels ORDER BY created_at,id").all().map(view);
 }
 function get(id){
  const row=db.prepare("SELECT id,provider,display_name,current_version_id,created_at,updated_at FROM channels WHERE id=?").get(id);
  if(!row)throw fail("channel_not_found",404);
  return view(row);
 }
 function listVersions(channelId){
  get(channelId);
  return db.prepare("SELECT id,channel_id,version_num,created_at,revoked_at FROM credential_versions WHERE channel_id=? ORDER BY version_num").all(channelId).map(versionView);
 }
 function protect(apiKey,channelId,versionId){
  if(typeof apiKey!=="string"||!apiKey.trim()||Buffer.byteLength(apiKey,"utf8")>8192)
   throw fail("invalid_credential_value");
  const bytes=Buffer.from(apiKey,"utf8");
  try{
   const out=protector.protect(bytes,context(channelId,versionId));
   if(!Buffer.isBuffer(out)||!out.length)throw fail("credential_protection_unavailable",503);
   return out;
  }finally{bytes.fill(0)}
 }
 function create({id=randomUUID(),provider,displayName,apiKey}={}){
  if(!validId(id)||!validProvider(provider)||typeof displayName!=="string"||
    !displayName.trim()||displayName.length>128)throw fail("invalid_channel_config");
  const versionId=randomUUID(),cipher=protect(apiKey,id,versionId);
  return writeTransaction(db,()=>{
   if(db.prepare("SELECT id FROM channels WHERE id=?").get(id))throw fail("channel_id_conflict",409);
   const now=Date.now();
   db.prepare("INSERT INTO channels(id,provider,display_name,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
     .run(id,provider,displayName.trim(),null,now,now);
   db.prepare("INSERT INTO credential_versions(id,channel_id,version_num,ciphertext,created_at) VALUES(?,?,?,?,?)")
     .run(versionId,id,1,cipher,now);
   db.prepare("UPDATE channels SET current_version_id=? WHERE id=?").run(versionId,id);
   return get(id);
  });
 }
 function rotate(channelId,{apiKey,expectedKeyVersion}={}){
  if(typeof expectedKeyVersion!=="string"&&expectedKeyVersion!==null)
   throw fail("expected_credential_version_required");
  const versionId=randomUUID(),cipher=protect(apiKey,channelId,versionId);
  return writeTransaction(db,()=>{
   const existing=db.prepare("SELECT * FROM channels WHERE id=?").get(channelId);
   if(!existing)throw fail("channel_not_found",404);
   if(existing.current_version_id!==expectedKeyVersion)throw fail("credential_version_conflict",409);
   const num=db.prepare("SELECT COALESCE(MAX(version_num),0)+1 AS n FROM credential_versions WHERE channel_id=?").get(channelId).n;
   const now=Date.now();
   db.prepare("INSERT INTO credential_versions(id,channel_id,version_num,ciphertext,created_at) VALUES(?,?,?,?,?)")
     .run(versionId,channelId,num,cipher,now);
   db.prepare("UPDATE channels SET current_version_id=?,updated_at=? WHERE id=?").run(versionId,now,channelId);
   return get(channelId);
  });
 }
 function revoke(channelId,versionId){
  return writeTransaction(db,()=>{
   const old=db.prepare("SELECT id,revoked_at FROM credential_versions WHERE id=? AND channel_id=?")
     .get(versionId,channelId);
   if(!old)throw fail("credential_missing",404);
   if(old.revoked_at!==null)return get(channelId);
   const now=Date.now();
   db.prepare("UPDATE credential_versions SET revoked_at=? WHERE id=?").run(now,versionId);
   db.prepare("UPDATE channels SET current_version_id=NULL,updated_at=? WHERE id=? AND current_version_id=?")
     .run(now,channelId,versionId);
   return get(channelId);
  });
 }
 function checkReference(versionId,channelId){
  if(typeof versionId!=="string"||!versionId)throw fail("credential_missing",404);
  const row=db.prepare("SELECT id,channel_id,version_num,created_at,revoked_at FROM credential_versions WHERE id=?")
    .get(versionId);
  if(!row||(channelId!==undefined&&row.channel_id!==channelId))throw fail("credential_missing",404);
  if(row.revoked_at!==null)throw fail("credential_revoked",409);
  return versionView(row);
 }
 /** Internal adapter only: synchronous callback minimizes lifetime of unprotected bytes. */
 function withSecretVersion(versionId,consumer,{channelId}={}){
  if(typeof consumer!=="function")throw Error("invalid_secret_consumer");
  checkReference(versionId,channelId);
  const row=db.prepare("SELECT channel_id,ciphertext FROM credential_versions WHERE id=?").get(versionId);
  let plain;
  try{
   plain=protector.unprotect(Buffer.from(row.ciphertext),context(row.channel_id,versionId));
   if(!Buffer.isBuffer(plain))throw Error("invalid_unprotected_credential");
   const result=consumer(plain);
   if(result&&typeof result.then==="function")throw Error("async_secret_consumer_forbidden");
   return result;
  }catch(err){
   if(err.code==="credential_protection_unavailable")throw err;
   if(err.message==="async_secret_consumer_forbidden")throw err;
   throw fail("credential_decryption_failed",503);
  }finally{plain?.fill(0)}
 }
 return {list,get,create,rotate,revoke,listVersions,checkReference,withSecretVersion};
}
