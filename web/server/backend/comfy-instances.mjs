import {createComfyV2Adapter,comfyUpstream} from "./comfy-v2-adapter.mjs";
import {writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const pendingStatuses=["queued","preparing","submitting","submission_unknown","running","collecting","blocked_credential"];
export function validateComfyInstance(value){
 if(!value||typeof value!=="object"||Array.isArray(value)||
    !Object.keys(value).every(key=>key==="id"||key==="url")||
    typeof value.id!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(value.id)||
    typeof value.url!=="string")throw fail("invalid_comfy_instance");
 let url;
 try{url=new URL(value.url)}catch{throw fail("invalid_comfy_instance_url")}
 if(url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||
    !url.port||url.pathname!=="/"||url.username||url.password||url.search||url.hash)
   throw fail("comfy_instance_must_be_exact_loopback_origin");
 return {id:value.id,url:url.origin};
}

/** Live adapter map and persisted instance list are atomically kept in sync.
 * A nonterminal or uncertain run pins its original instance URL; edits to that
 * instance are rejected until the run becomes terminal. No legacy gateway writes.
 */
export function createComfyInstanceRegistry({db,blobStore,upstreamCall=comfyUpstream,initialInstances=[]}={}){
 if(!db||!blobStore)throw Error("invalid_comfy_instance_registry");
 const adapters=Object.create(null),instances=new Map();
 const add=(instance)=>{
  adapters[instance.id]=createComfyV2Adapter({instance,db,blobStore,upstreamCall});
  instances.set(instance.id,instance);
 };
 const configured=initialInstances.map(validateComfyInstance);
 if(configured.length>16||new Set(configured.map(x=>x.id)).size!==configured.length)
  throw fail("invalid_comfy_instances");
 writeTransaction(db,()=>{
  const initialized=db.prepare("SELECT id FROM comfy_instance_registry_state WHERE id=1").get();
  if(!initialized){
   const count=db.prepare("SELECT COUNT(*) AS n FROM comfy_instances").get().n;
   if(count===0)for(const instance of configured)
    db.prepare("INSERT INTO comfy_instances(id,url) VALUES(?,?)").run(instance.id,instance.url);
   db.prepare("INSERT INTO comfy_instance_registry_state(id) VALUES(1)").run();
  }
 });
 for(const row of db.prepare("SELECT id,url FROM comfy_instances ORDER BY id").all())add(validateComfyInstance(row));
 const list=()=>[...instances.values()];
 const pending=id=>db.prepare(`SELECT id FROM jobs WHERE status IN (${pendingStatuses.map(()=>"?").join(",")})
   AND json_extract(snapshot_json,'$.adapterKind')='comfy'
   AND json_extract(snapshot_json,'$.instanceId')=? LIMIT 1`).get(...pendingStatuses,id);
 function save(raw,oldId){
  const item=validateComfyInstance(raw);
  if(oldId!==undefined&&(!/^[A-Za-z0-9_-]{1,64}$/.test(oldId)||!instances.has(oldId)))
   throw fail("comfy_instance_not_found",404);
  if(!oldId&&instances.has(item.id)||oldId&&item.id!==oldId&&instances.has(item.id))
   throw fail("comfy_instance_conflict",409);
  if((!oldId&&instances.size>=16))throw fail("comfy_instance_limit_reached",409);
  // Validate the adapter before writing; the ID determines its immutable lane.
  const adapter=createComfyV2Adapter({instance:item,db,blobStore,upstreamCall});
  writeTransaction(db,()=>{
   if(oldId&&pending(oldId))throw fail("comfy_instance_has_pending_jobs",409);
   if(oldId)db.prepare("DELETE FROM comfy_instances WHERE id=?").run(oldId);
   db.prepare("INSERT INTO comfy_instances(id,url) VALUES(?,?)").run(item.id,item.url);
  });
  if(oldId){delete adapters[oldId];instances.delete(oldId)}
  adapters[item.id]=adapter;instances.set(item.id,item);
  return item;
 }
 function remove(id){
  if(!instances.has(id))throw fail("comfy_instance_not_found",404);
  writeTransaction(db,()=>{
   if(pending(id))throw fail("comfy_instance_has_pending_jobs",409);
   db.prepare("DELETE FROM comfy_instances WHERE id=?").run(id);
  });
  instances.delete(id);delete adapters[id];
  return {deleted:id};
 }
 async function objectInfo(id){
  const instance=instances.get(id);
  if(!instance)throw fail("comfy_instance_not_found",404);
  const info=await upstreamCall(instance,"/object_info",{timeoutMs:10000});
  if(!info||typeof info!=="object"||Array.isArray(info))
   throw fail("comfy_object_info_invalid",502);
  return {instanceId:id,objectInfo:info};
 }
 async function checkedList(){
  return Promise.all(list().map(async(instance)=>{
   try{
    const info=await upstreamCall(instance,"/object_info",{timeoutMs:2500});
    if(!info||typeof info!=="object"||Array.isArray(info))throw Error("invalid_comfy_info");
    return {...instance,reachable:true,classTypes:Object.keys(info)};
   }catch{return {...instance,reachable:false,classTypes:[]}}
  }));
 }
 return {adapters,list,checkedList,objectInfo,save,remove};
}
