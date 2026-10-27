import {ARK_HEALTH_URL,getTrustedHttps} from "./trusted-http.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
/** Never submits a paid task. A guaranteed-nonexistent task ID probes only
 * the configured official Ark endpoint and encrypted credential in SQLite.
 */
export function createArkChannelHealth({vault,probe=getTrustedHttps}={}){
 if(!vault)throw Error("ark_health_vault_required");
 return async function check(channelId){
  const channel=vault.get(channelId);
  if(channel.provider!=="volcengine_ark")throw fail("ark_channel_provider_invalid",400);
  if(!channel.hasKey||!channel.keyVersion)throw fail("ark_channel_key_missing",409);
  const bearer=vault.withSecretVersion(channel.keyVersion,
   bytes=>"Bearer "+bytes.toString("utf8"),{channelId});
  let result;
  try{result=await probe(ARK_HEALTH_URL,{
   headers:{authorization:bearer,accept:"application/json"},
   allowedHosts:["ark.cn-beijing.volces.com"],timeoutMs:15000,maxBytes:256000
  })}catch{return {reachable:false,authenticated:false,reason:"ark_upstream_unavailable"}}
  // 404 on our never-created identifier confirms route and auth. No POST.
  if(result.statusCode===404||result.statusCode>=200&&result.statusCode<300)
   return {reachable:true,authenticated:true};
  if([401,403].includes(result.statusCode))return {reachable:true,authenticated:false,reason:"ark_auth_failed"};
  return {reachable:false,authenticated:false,reason:"ark_upstream_unexpected_status"};
 };
}
