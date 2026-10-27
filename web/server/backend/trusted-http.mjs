import {lookup} from "node:dns/promises";
import {request as httpsRequest} from "node:https";
import {isIP} from "node:net";

const fail=(code,statusCode=502)=>Object.assign(Error(code),{code,statusCode});
const DEFAULT_ARK_HOST="ark.cn-beijing.volces.com";
export const ARK_HEALTH_URL="https://"+DEFAULT_ARK_HOST+"/api/v3/contents/generations/tasks/codex-connectivity-check-never-created";

/** Allowlisted HTTPS only: never accept an arbitrary path, scheme or host. */
export function validateTrustedHttpsUrl(raw,{allowedHosts=[DEFAULT_ARK_HOST]}={}){
 let url;
 try{url=new URL(raw)}catch{throw fail("upstream_url_invalid",400)}
 if(url.protocol!=="https:"||url.username||url.password||url.hash||
    (url.port&&url.port!=="443")||isIP(url.hostname)||
    !allowedHosts.includes(url.hostname.toLowerCase()))throw fail("upstream_destination_forbidden",400);
 return url;
}
/** Reject private, loopback, link-local, reserved and IPv4-mapped IPs. This
 * policy intentionally fails closed for IPv6 until its full range is audited.
 */
export function isPublicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split(".").map(Number);
 if(a===0||a===10||a===127||a>=224||a===169&&b===254||
    a===100&&b>=64&&b<=127||a===172&&b>=16&&b<=31||a===192&&[0,168,88].includes(b)||
    a===198&&[18,19,51].includes(b)||a===203&&b===0||
    a===192&&b===0||a===192&&b===0&&c===0||a===192&&b===0&&c===2||
    a===198&&b===51&&c===100||a===203&&b===0&&c===113)return false;
 return true;
}
export async function resolvePinnedPublicIp(url,{resolver=lookup}={}){
 let rows;
 try{rows=await resolver(url.hostname,{all:true,verbatim:true,family:4})}
 catch{throw fail("upstream_dns_unavailable")}
 if(!Array.isArray(rows)||!rows.length||rows.some(row=>!isPublicIPv4(row.address)))
  throw fail("upstream_dns_destination_forbidden");
 return rows[0];
}
/** Read-only, non-billable upstream probe; no redirects, proxy or forwarded
 * browser credentials. Pin the validated DNS IP for the TLS connection.
 */
export async function getTrustedHttps(raw,{allowedHosts=[DEFAULT_ARK_HOST],
 headers={},resolver=lookup,requester=httpsRequest,timeoutMs=15000,maxBytes=256000}={}){
 const url=validateTrustedHttpsUrl(raw,{allowedHosts});
 const selected=await resolvePinnedPublicIp(url,{resolver});
 return new Promise((resolve,reject)=>{
  let done=false;const settle=(err,result)=>{
   if(done)return;done=true;err?reject(err):resolve(result);
  };
  const req=requester(url,{
   method:"GET",headers,timeout:timeoutMs,
   lookup:(_host,_opts,cb)=>cb(null,selected.address,4),
  },res=>{
   if(res.statusCode>=300&&res.statusCode<400){res.resume();return settle(fail("upstream_redirect_forbidden"))}
   const chunks=[];let total=0;
   res.on("data",chunk=>{
    total+=chunk.length;
    if(total>maxBytes)req.destroy(fail("upstream_response_too_large"));
    else chunks.push(chunk);
   });
   res.on("end",()=>settle(null,{statusCode:res.statusCode??502,body:Buffer.concat(chunks)}));
   res.on("error",err=>settle(err));
  });
  req.on("timeout",()=>req.destroy(fail("upstream_timeout")));
  req.on("error",()=>settle(fail("upstream_unavailable")));
  req.end();
 });
}
