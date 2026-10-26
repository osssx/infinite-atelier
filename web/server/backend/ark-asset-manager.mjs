import {createHash,createHmac} from "node:crypto";
import {createReadStream} from "node:fs";
import {TosClient} from "@volcengine/tos-sdk";
import {writeTransaction} from "./repository.mjs";

const HOST="ark.cn-beijing.volcengineapi.com";
const API="https://"+HOST+"/";
const VALID_ID=/^[A-Za-z0-9_-]{1,160}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const sha256=data=>createHash("sha256").update(data).digest("hex");
const hmac=(key,message)=>createHmac("sha256",key).update(message).digest();

/** Volcengine OpenAPI Signature V4 for fixed Ark Action endpoints only. */
export function signArkAction({action,body,accessKeyId,secretAccessKey,date=new Date()}){
 if(!["CreateAsset","GetAsset"].includes(action))throw fail("ark_asset_action_invalid");
 const when=date.toISOString().replace(/[-:]|\.\d{3}/g,"");
 const day=when.slice(0,8),scope=day+"/cn-beijing/ark/request";
 const bodyHash=sha256(body);
 const names="content-type;host;x-content-sha256;x-date";
 const headers="content-type:application/json\nhost:"+HOST+
   "\nx-content-sha256:"+bodyHash+"\nx-date:"+when+"\n";
 const query="Action="+action+"&Version=2024-01-01";
 const canonical=["POST","/",query,headers,names,bodyHash].join("\n");
 const toSign=["HMAC-SHA256",when,scope,sha256(canonical)].join("\n");
 let key=hmac(secretAccessKey,day);
 key=hmac(key,"cn-beijing");key=hmac(key,"ark");key=hmac(key,"request");
 const signature=createHmac("sha256",key).update(toSign).digest("hex");
 return {url:API+"?"+query,headers:{
  "content-type":"application/json","x-date":when,"x-content-sha256":bodyHash,
  authorization:"HMAC-SHA256 Credential="+accessKeyId+"/"+scope+
   ", SignedHeaders="+names+", Signature="+signature
 }};
}

export function readArkAssetConfig(env=process.env){
 const keys=["ATELIER_ARK_ASSET_AK","ATELIER_ARK_ASSET_SK",
  "ATELIER_ARK_ASSET_GROUP_ID","ATELIER_ARK_TOS_BUCKET"];
 const present=keys.map(k=>typeof env[k]==="string"&&env[k].length>0);
 if(!present.some(Boolean))return null;
 if(!present.every(Boolean))throw fail("ark_asset_config_incomplete",503);
 const [accessKeyId,secretAccessKey,groupId,bucket]=keys.map(k=>env[k]);
 const projectName=env.ATELIER_ARK_ASSET_PROJECT_NAME??"default";
 if(!VALID_ID.test(groupId)||!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)||
    !/^[A-Za-z0-9._-]{1,80}$/.test(projectName)||
    !/^[A-Za-z0-9]{5,128}$/.test(accessKeyId)||secretAccessKey.length<8)
  throw fail("ark_asset_config_invalid",503);
 return {accessKeyId,secretAccessKey,groupId,bucket,projectName};
}
async function jsonResponse(response){
 if(!response?.ok)throw fail("ark_asset_remote_error",502);
 const text=await response.text();
 if(text.length>256000)throw fail("ark_asset_remote_too_large",502);
 let data;
 try{data=JSON.parse(text)}catch{throw fail("ark_asset_remote_json_invalid",502)}
 // Volcengine OpenAPI can report a business error inside HTTP 200.
 // Never mistake the error envelope for an accepted CreateAsset.
 if(data?.ResponseMetadata?.Error)throw fail("ark_asset_remote_rejected",502);
 if(!data||typeof data!=="object"||!data.Result)
  throw fail("ark_asset_remote_payload_invalid",502);
 return data;
}
/** Uploads immutable local CAS video to configured private TOS bucket. This
 * module never exposes AK/SK, signed GET URLs or uploaded bytes via local API.
 * The signed TOS GET URL is passed only to CreateAsset, not stored in SQLite.
 * The 'creating' barrier is durable: an ambiguous CreateAsset must be
 * reconciled by an operator, never blindly replayed after process restart.
 */
export function createArkAssetManager({
 db,blobStore,config,upstreamCall=fetch,client,delay=ms=>new Promise(r=>setTimeout(r,ms)),
 maxPolls=20,pollIntervalMs=4000
}={}){
 if(!db||!blobStore||!config)throw fail("ark_asset_manager_invalid",503);
 if(!Number.isInteger(maxPolls)||maxPolls<1||maxPolls>120)throw fail("ark_asset_polls_invalid");
 const tos=client??new TosClient({
  accessKeyId:config.accessKeyId,accessKeySecret:config.secretAccessKey,
  region:"cn-beijing",endpoint:"tos-cn-beijing.volces.com"
 });
 function record(blobId){
  return db.prepare("SELECT * FROM ark_asset_uploads WHERE blob_id=? AND bucket=? AND project_name=? AND group_id=?")
   .get(blobId,config.bucket,config.projectName,config.groupId);
 }
 async function action(name,payload){
  const body=JSON.stringify(payload);
  const signature=signArkAction({action:name,body,
   accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey});
  let res;
  try{res=await upstreamCall(signature.url,{method:"POST",headers:signature.headers,
   body,redirect:"manual",signal:AbortSignal.timeout(30000)})}
  catch{throw fail("ark_asset_remote_unknown",502)}
  return jsonResponse(res);
 }
 async function validateCAS(ref){
  if(!HASH.test(ref.blobId)||ref.sha256!==ref.blobId||
    !["video/mp4","video/quicktime"].includes(ref.mimeType))
    throw fail("ark_asset_cas_invalid");
  const blob=await blobStore.stat(ref.blobId);
  if(blob.mimeType!==ref.mimeType||blob.byteSize>200*1024*1024||blob.byteSize===0)
   throw fail("ark_asset_cas_invalid");
  const sha=createHash("sha256");
  for await(const chunk of createReadStream(blob.path))sha.update(chunk);
  if(sha.digest("hex")!==ref.sha256)throw fail("ark_asset_cas_corrupt",422);
  return blob;
 }
 async function ensureReady(ref){
  const blob=await validateCAS(ref);
  const key="infinite-atelier/ark-assets/"+config.projectName+"/"+ref.sha256+
   (ref.mimeType==="video/quicktime"?".mov":".mp4");
  let row=record(ref.blobId);
  if(!row){
   // PUT to deterministic TOS key can be safely repeated with the SAME CAS.
   // It is not an Ark CreateAsset and does not create a second asset record.
   await tos.uploadFile({bucket:config.bucket,key,file:blob.path,partSize:8*1024*1024,taskNum:1});
   writeTransaction(db,()=>db.prepare(
    "INSERT OR IGNORE INTO ark_asset_uploads(blob_id,bucket,project_name,group_id,status,object_key,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(ref.blobId,config.bucket,config.projectName,config.groupId,"staged",key,Date.now()));
   row=record(ref.blobId);
  }
  if(row.object_key!==key)throw fail("ark_asset_object_conflict");
  if(row.status==="active"){
   if(!VALID_ID.test(row.asset_id))throw fail("ark_asset_id_invalid");
   return "asset://"+row.asset_id;
  }
  if(row.status==="creating")throw fail("ark_asset_creation_unknown");
  if(row.status==="failed")throw fail("ark_asset_processing_failed");
  if(row.status==="staged"){
   // Resolve and validate signed URL BEFORE creating the no-replay barrier.
   const signedUrl=tos.getPreSignedUrl({bucket:config.bucket,key,method:"GET",expires:86400});
   const u=new URL(signedUrl);
   if(u.protocol!=="https:"||u.hostname!==config.bucket+".tos-cn-beijing.volces.com"||
      u.username||u.password||u.port||u.hash||u.pathname!=="/"+key||
      !u.searchParams.has("X-Tos-Signature"))throw fail("ark_asset_signed_url_invalid");
   const changed=writeTransaction(db,()=>db.prepare(
    "UPDATE ark_asset_uploads SET status='creating',updated_at=? WHERE blob_id=? AND bucket=? AND project_name=? AND group_id=? AND status='staged'")
    .run(Date.now(),ref.blobId,config.bucket,config.projectName,config.groupId).changes);
   if(changed!==1)throw fail("ark_asset_create_conflict");
   // CreateAsset accepts URL + GroupId, NOT binary/form-data or Files API ID.
   const data=await action("CreateAsset",{GroupId:config.groupId,URL:signedUrl,
    AssetType:"Video",Name:"atelier-"+ref.sha256.slice(0,32),ProjectName:config.projectName});
   const assetId=data?.Result?.Id;
   if(!VALID_ID.test(assetId))throw fail("ark_asset_create_response_unknown",502);
   db.prepare("UPDATE ark_asset_uploads SET status='processing',asset_id=?,updated_at=? WHERE blob_id=? AND bucket=? AND project_name=? AND group_id=? AND status='creating'")
    .run(assetId,Date.now(),ref.blobId,config.bucket,config.projectName,config.groupId);
   row=record(ref.blobId);
  }
  if(row.status!=="processing"||!VALID_ID.test(row.asset_id))throw fail("ark_asset_state_invalid");
  for(let i=0;i<maxPolls;i++){
   const result=(await action("GetAsset",{Id:row.asset_id,ProjectName:config.projectName}))?.Result;
   if(result?.Id!==row.asset_id||
      result.GroupId!==undefined&&result.GroupId!==config.groupId||
      result.AssetType!==undefined&&result.AssetType!=="Video")
    throw fail("ark_asset_poll_identity_mismatch",502);
   if(result.Status==="Active"){
    db.prepare("UPDATE ark_asset_uploads SET status='active',updated_at=? WHERE blob_id=? AND bucket=? AND project_name=? AND group_id=? AND status='processing'")
     .run(Date.now(),ref.blobId,config.bucket,config.projectName,config.groupId);
    return "asset://"+row.asset_id;
   }
   if(result.Status==="Failed"){
    db.prepare("UPDATE ark_asset_uploads SET status='failed',updated_at=? WHERE blob_id=? AND bucket=? AND project_name=? AND group_id=?")
     .run(Date.now(),ref.blobId,config.bucket,config.projectName,config.groupId);
    throw fail("ark_asset_processing_failed");
   }
   if(result.Status!=="Processing")throw fail("ark_asset_status_unknown",502);
   if(i<maxPolls-1)await delay(pollIntervalMs);
  }
  throw fail("ark_asset_still_processing",503);
 }
 function readyUrl(ref){
  const row=record(ref.blobId);
  if(!row||row.status!=="active"||!VALID_ID.test(row.asset_id)||
     ref.assetUrl!==undefined&&ref.assetUrl!=="asset://"+row.asset_id)
   throw fail("ark_asset_not_ready");
  return "asset://"+row.asset_id;
 }
 return {ensureReady,readyUrl,record};
}
