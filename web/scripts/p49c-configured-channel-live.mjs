/** P4.9c: reuse the selected online text model in the user's existing
 * Infinite Atelier channel vault WITHOUT opening its writable runtime.
 * Read-only channel metadata and DPAPI credential access; all Task writes go
 * to the P4.9b independent in-memory SQLite DB.
 * --probe: no model POST or key decryption.
 * --run --ack-cost: at most four creative turns/eight outbound model POSTs.
 */
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {resolveLocalDataDir} from "../server/backend/runtime.mjs";
import {createWindowsDpapiProtector} from "../server/backend/credential-protection.mjs";
import {createCredentialVault} from "../server/backend/credential-vault.mjs";
import {normalizeOpenAiCompatBaseUrl} from "../server/backend/openai-compat-endpoints.mjs";
import {runP49BAcceptance} from "./p49b-creative-quality.mjs";

const fail=code=>Object.assign(Error(code),{code});
export function resolveP49CConfiguredChannel(db){
 if(!db||typeof db.prepare!=="function")throw fail("p49c_readonly_database_required");
 const row=db.prepare("SELECT value_json FROM ui_settings WHERE name='model_config'").get();
 if(!row?.value_json)throw fail("p49c_model_config_missing");
 let config;
 try{config=JSON.parse(row.value_json)}catch{throw fail("p49c_model_config_invalid")}
 const selected=config?.textModel;
 const pos=typeof selected==="string"?selected.indexOf("::"):-1;
 if(pos<1||pos===selected.length-2)throw fail("p49c_text_model_not_selected");
 const uiId=selected.slice(0,pos),model=selected.slice(pos+2);
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(uiId)||!model||model.length>128)
  throw fail("p49c_text_model_reference_invalid");
 const candidates=(Array.isArray(config?.channels)?config.channels:[])
  .filter(channel=>channel?.id===uiId);
 if(candidates.length!==1)throw fail("p49c_selected_channel_not_unique");
 const entry=candidates[0];
 const saved=db.prepare("SELECT id,provider,display_name,current_version_id FROM channels WHERE id=?")
  .get(uiId);
 if(!saved||!saved.current_version_id)throw fail("p49c_channel_not_available");
 if(saved.provider!=="openai_compatible")throw fail("p49c_channel_provider_not_supported");
 if(entry.name!==saved.display_name)throw fail("p49c_channel_identity_mismatch");
 const baseUrl=normalizeOpenAiCompatBaseUrl(entry.baseUrl);
 if(new URL(baseUrl).protocol!=="https:")throw fail("p49c_online_channel_https_required");
 // Prevent pointing the evaluator at hidden local services or unselected
 // online channels; the user-selected model/channel pair is authoritative.
 return {channelId:uiId,displayName:saved.display_name,provider:saved.provider,
  model,baseUrl,keyVersionPresent:true};
}
export function openP49CReadonlyConfiguredChannel({dataDir}={}){
 const dir=resolveLocalDataDir(dataDir),file=join(dir,"db","atelier.sqlite");
 if(!existsSync(file))throw fail("p49c_existing_dataset_missing");
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const selected=resolveP49CConfiguredChannel(db);
  return {db,selected};
 }catch(error){db.close();throw error}
}
async function main(argv){
 const args=argv.join(" ");
 if(!["--probe","--run --ack-cost"].includes(args))throw fail("p49c_usage_invalid");
 if(process.platform!=="win32")throw fail("p49c_dpapi_windows_required");
 const {db,selected}=openP49CReadonlyConfiguredChannel();
 try{
  if(args==="--probe"){
   console.log("P49C_CONFIGURED_CHANNEL_PROBE",JSON.stringify({
    provider:selected.provider,displayName:selected.displayName,
    model:selected.model,encryptedCredentialPresent:selected.keyVersionPresent,
    baseUrlScheme:new URL(selected.baseUrl).protocol,
    realModelCalls:0,protectedDatasetReadOnly:true
   }));
   return;
  }
  const vault=createCredentialVault({db,protector:createWindowsDpapiProtector()});
  // This call decrypts only inside the existing vault callback and does not
  // print or expose the secret. The original credential remains in DPAPI.
  const meta=vault.get(selected.channelId);
  if(!meta.hasKey||meta.provider!==selected.provider)throw fail("p49c_channel_unavailable");
  // Do not log the key, the temporary request Authorization header or the
  // complete provider body. The P4.9b runner writes only isolated Task output.
  const outcome=await runP49BAcceptance({
   mode:"live",ackCost:true,provider:selected.provider,
   channelId:selected.channelId,model:selected.model,baseUrl:selected.baseUrl
  },{vaultOverride:vault});
  console.log("P49C_CONFIGURED_CHANNEL_RESULT",JSON.stringify({
   provider:selected.provider,displayName:selected.displayName,
   model:selected.model,stages:outcome.report.stages.length,
   providerPosts:outcome.report.providerPosts,
   executionStatus:outcome.report.executionStatus,
   graphUnchanged:outcome.report.graphUnchanged,
   humanReviewRequired:true,reportPath:outcome.reportPath
  }));
  if(!outcome.success)process.exitCode=1;
 }finally{db.close()}
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===
 process.argv[1].toLowerCase()){
 try{await main(process.argv.slice(2))}
 catch(error){
  // Never print stack traces; a malformed channel label/config can be private.
  console.error("P49C_CONFIGURED_CHANNEL_ERROR",
   typeof error?.code==="string"&&/^p49c_[a-z0-9_]{2,80}$/.test(error.code)?
    error.code:"p49c_channel_preflight_failed");
  process.exitCode=2;
 }
}
