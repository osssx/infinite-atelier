/** P4.9e existing online channel: readonly DPAPI vault + isolated durable Task.
 * --probe / --init never submit a model request or decrypt the API key.
 * --stage <id> --dir <run> --ack-cost sends at most two Provider POSTs for
 * this one stage. Each further stage demands a separate explicit invocation.
 */
import {fileURLToPath} from "node:url";
import {openP49CReadonlyConfiguredChannel} from "./p49c-configured-channel-live.mjs";
import {createCredentialVault} from "../server/backend/credential-vault.mjs";
import {createWindowsDpapiProtector} from "../server/backend/credential-protection.mjs";
import {initP49E,executeP49EStage} from "./p49e-creative-stage.mjs";

const fail=code=>Object.assign(new Error(code),{code});
const clean=code=>typeof code==="string"&&/^p49e_[a-z0-9_]{2,90}$/.test(code)?code:"p49e_preflight_failed";
export async function runConfiguredP49E(argv){
 if(process.platform!=="win32")throw fail("p49e_requires_windows_dpapi");
 if(!(
  argv.length===1&&["--probe","--init"].includes(argv[0])||
  argv.length===5&&argv[0]==="--stage"&&argv[2]==="--dir"&&argv[4]==="--ack-cost"
 ))throw fail("p49e_usage_invalid");
 const {db,selected}=openP49CReadonlyConfiguredChannel();
 try{
  // Freeze the selected encrypted credential version as well as the model:
  // a key rotation between stages must not silently switch identity.
  const version=db.prepare("SELECT current_version_id FROM channels WHERE id=?")
   .get(selected.channelId)?.current_version_id;
  if(typeof version!=="string"||!version)throw fail("p49e_credential_version_missing");
  const config={mode:"live",provider:selected.provider,
   channelId:selected.channelId,model:selected.model,baseUrl:selected.baseUrl,
   credentialVersion:version};
  if(argv[0]==="--probe")return {
   phase:"probe",provider:selected.provider,model:selected.model,
   encryptedCredentialPresent:selected.keyVersionPresent,
   datasetReadOnly:true,modelPosts:0
  };
  if(argv[0]==="--init"){
   const result=initP49E(config);
   return {phase:"initialized",directory:result.directory,
    model:selected.model,provider:selected.provider,modelPosts:0};
  }
  const vault=createCredentialVault({db,protector:createWindowsDpapiProtector()});
  const meta=vault.get(selected.channelId);
  if(!meta?.hasKey||meta.provider!==selected.provider||
   meta.keyVersion!==config.credentialVersion)throw fail("p49e_selected_channel_unavailable");
  const result=await executeP49EStage(argv[3],{...config,ackCost:true},argv[1],
   {vaultOverride:vault});
  return {phase:"stage_result",directory:result.directory,stageId:result.stageId,
   status:result.status.stages.at(-1)?.status,
   diagnostic:result.status.stages.at(-1)?.modelCalls.at(-1)?.diagnostic??null,
   resultDigest:result.status.stages.at(-1)?.digest,
   modelPosts:result.providerPosts,graphUnchanged:result.status.graphUnchanged,
   semanticVerdict:result.status.semanticVerdict};
 }finally{db.close()}
}
if(process.argv[1]&&fileURLToPath(import.meta.url).toLowerCase()===process.argv[1].toLowerCase()){
 try{
  const result=await runConfiguredP49E(process.argv.slice(2));
  console.log("P49E_CONFIGURED_CHANNEL",JSON.stringify(result));
  if(result.phase==="stage_result"&&result.status==="needs_reconcile")process.exitCode=1;
 }catch(error){
  console.error("P49E_CONFIGURED_ERROR",clean(error?.code));
  process.exitCode=2;
 }
}
