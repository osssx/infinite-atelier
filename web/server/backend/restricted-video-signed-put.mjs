import {Agent} from "undici";
import {lookup} from "node:dns";
import {isIP} from "node:net";
import {createHash} from "node:crypto";
import {isPublicIPv4,validateTrustedHttpsUrl} from "./trusted-http.mjs";

const invalid=code=>Object.assign(Error(code),{code,statusCode:422});
const limit={video:12*1024*1024,audio:6*1024*1024};
const hash=/^[a-f0-9]{64}$/;

/** Accept arbitrary signed PUBLIC HTTPS hosts, not an operator-maintained
 * allowlist. Reject IP literal hosts and pin ALL resolved A records as public.
 * No cookies, vault Authorization, proxies, redirects or caller headers.
 */
export function validateSignedPutUrl(raw){
 if(typeof raw!=="string"||raw.length>4096||!raw.trim())
  throw invalid("model_signed_put_url_invalid");
 let parsed;
 try{parsed=new URL(raw)}catch{throw invalid("model_signed_put_url_invalid")}
 const hostname=parsed.hostname.toLowerCase();
 if(isIP(hostname.replace(/^\[|\]$/g,""))!==0||
   ["localhost","metadata","metadata.google.internal"].includes(hostname)||
   hostname.endsWith(".internal")||hostname.endsWith(".localhost")||
   hostname.endsWith(".local"))
  throw invalid("model_signed_put_destination_forbidden");
 try{validateTrustedHttpsUrl(raw,{allowedHosts:[parsed.hostname.toLowerCase()]})}
 catch{throw invalid("model_signed_put_destination_forbidden")}
 if(!parsed.pathname||parsed.pathname==="/")throw invalid("model_signed_put_url_invalid");
 return parsed;
}
export function validateSignedPutAsset(asset){
 if(!asset||!["video","audio"].includes(asset.kind)||
  typeof asset.sha256!=="string"||!hash.test(asset.sha256)||
  typeof asset.mimeType!=="string"||typeof asset.dataUrl!=="string"||
  !asset.dataUrl.startsWith("data:"+asset.mimeType+";base64,"))
  throw invalid("model_signed_put_source_invalid");
 const encoded=asset.dataUrl.slice(("data:"+asset.mimeType+";base64,").length);
 if(!encoded||encoded.length>Math.ceil(limit[asset.kind]/3)*4+4||
   !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded))
  throw invalid("model_signed_put_source_invalid");
 const content=Buffer.from(encoded,"base64");
 if(content.length<1||content.length>limit[asset.kind]||
  createHash("sha256").update(content).digest("hex")!==asset.sha256)
  throw invalid("model_signed_put_integrity_invalid");
 return content;
}
export function createRestrictedSignedPut({fetcher=fetch,resolver=lookup}={}){
 const agent=new Agent({connect:{lookup(host,_opts,callback){
  resolver(host,{all:true,family:4},(error,rows)=>{
   if(error||!Array.isArray(rows)||rows.length===0||
      rows.some(row=>!isPublicIPv4(row.address)))
    return callback(invalid("model_signed_put_dns_forbidden"));
   callback(null,rows[0].address,4);
  });
 }}});
 return async function upload({uploadUrl,asset}={}){
  const uri=validateSignedPutUrl(uploadUrl);
  const content=validateSignedPutAsset(asset);
  let response;
  try{
   response=await fetcher(uri.href,{
    method:"PUT",redirect:"manual",dispatcher:agent,
    headers:{"content-type":asset.mimeType},
    body:content,signal:AbortSignal.timeout(120000)
   });
  }catch{
   // Unknown if the provider stored the media. The durable "uploading"
   // barrier is never cleared; manual reconciliation is required.
   throw invalid("model_signed_put_outcome_unknown");
  }
  if(!response||response.status<200||response.status>=300)
   throw invalid("model_signed_put_outcome_unknown");
  try{await response.body?.cancel()}catch{/* storage already acknowledged */}
  return {uploaded:true};
 };
}
