import {Agent,fetch as undiciFetch} from "undici";
import {lookup} from "node:dns";
import {isIP} from "node:net";
import {createHash} from "node:crypto";
import {isPublicIPv4} from "./trusted-http.mjs";

const fail=(code)=>Object.assign(Error(code),{code,statusCode:400});
export const DEFAULT_OPENAI_ENDPOINT="https://api.openai.com/v1";
const plainHost=host=>host.replace(/^\[|\]$/g,"").toLowerCase();
const localHost=host=>["localhost","127.0.0.1","::1"].includes(plainHost(host));
const privateLanIPv4=address=>{
 if(isIP(address)!==4)return false;
 const [a,b]=address.split(".").map(Number);
 return a===10 || a===172&&b>=16&&b<=31 || a===192&&b===168;
};
const forbiddenNames=new Set(["metadata","metadata.google.internal","instance-data","instance-data.ec2.internal"]);
// Some desktop proxy clients map HTTPS hostnames into RFC 2544 benchmarking
// addresses (198.18.0.0/15). Keep DNS pinned and certificate verification on:
// this is allowed ONLY for HTTPS DNS names, never a literal IP or HTTP URL.
const proxyFakeIPv4=address=>{
 if(isIP(address)!==4)return false;
 const [a,b]=address.split(".").map(Number);
 return a===198&&(b===18||b===19);
};

/** No channel/operator allowlist. A saved user channel URL is authoritative.
 * Reject credential-bearing, non-HTTP and metadata endpoints; allow explicit
 * LAN/loopback IPs for a local developer proxy, including arbitrary ports.
 */
export function normalizeOpenAiCompatBaseUrl(raw){
 if(typeof raw!=="string"||raw.trim().length<8||raw.length>1024)throw fail("model_endpoint_config_invalid");
 const input=raw.trim();
 let url;
 try{url=new URL(input)}catch{throw fail("model_endpoint_config_invalid")}
 const host=plainHost(url.hostname);
 if(!["http:","https:"].includes(url.protocol)||url.username||url.password||
    url.search||url.hash||!host||forbiddenNames.has(host)||
    host.endsWith(".internal")||host.endsWith(".localhost")&&!localHost(host)||
    /%(?:2f|5c|00)/i.test(input)||url.pathname.includes("\\")||
    (isIP(host)===4&&!isPublicIPv4(host)&&!privateLanIPv4(host)&&!localHost(host))||
    (isIP(host)===6&&!localHost(host)))
  throw fail("model_endpoint_config_invalid");
 return url.toString().replace(/\/+$/,"");
}
export const compatEndpointFingerprint=url=>"sha256:"+createHash("sha256").update(url).digest("hex");

/** DNS checks run at connect time with a pinned IP, not via a preflight DNS
 * lookup followed by an unguarded fetch. Remote DNS names cannot rebind to
 * RFC1918, link-local or metadata targets. Explicit LAN IPs are intentional.
 */
export function validateCompatResolvedAddress(hostname,address,{protocol="http:"}={}){
 const host=plainHost(hostname);
 if(isIP(address)!==4)throw fail("model_endpoint_dns_forbidden");
 if(localHost(host)){
  if(address==="127.0.0.1")return;
  throw fail("model_endpoint_dns_forbidden");
 }
 if(isIP(host)===4){
  if(host===address&&(isPublicIPv4(address)||privateLanIPv4(address)))return;
  throw fail("model_endpoint_dns_forbidden");
 }
 if(!isPublicIPv4(address)&&!(protocol==="https:"&&proxyFakeIPv4(address)))
  throw fail("model_endpoint_dns_forbidden");
}
export function createPinnedOpenAiCompatCall({fetcher=undiciFetch,resolver=lookup,
 allowGetModels=false,allowVideoPollGet=false,allowVideoCancel=false}={}){
 // Separate pinned agents for HTTP and HTTPS so concurrent requests cannot
 // change one another's DNS policy while the async lookup is still running.
 const createAgent=protocol=>new Agent({connect:{lookup(hostname,options,callback){
  resolver(hostname,{all:true,family:4},(error,rows)=>{
   if(error||!Array.isArray(rows)||!rows.length)return callback(fail("model_endpoint_dns_forbidden"));
   try{
    for(const row of rows)validateCompatResolvedAddress(hostname,row.address,{protocol});
    // Node 24 may request lookup({all:true}) for autoSelectFamily.
    // Returning a scalar IP then produces ERR_INVALID_IP_ADDRESS.
    if(options?.all)callback(null,[{address:rows[0].address,family:4}]);
    else callback(null,rows[0].address,4);
   }catch{callback(fail("model_endpoint_dns_forbidden"))}
  });
 }}});
 const agents={"http:":createAgent("http:"),"https:":createAgent("https:")};
 return async(url,options)=>{
  const target=new URL(url);
  normalizeOpenAiCompatBaseUrl(url);
  if(!(options?.method==="POST"||
    allowGetModels&&options?.method==="GET"&&target.pathname.endsWith("/models")||
    allowVideoPollGet&&options?.method==="GET"&&/\/[A-Za-z0-9_-]{1,128}$/.test(target.pathname)||
    allowVideoCancel&&options?.method==="DELETE"&&/\/[A-Za-z0-9_-]{1,128}$/.test(target.pathname))||
    target.search||target.hash)
   throw fail("model_endpoint_url_invalid");
  return fetcher(url,{...options,redirect:"manual",dispatcher:agents[target.protocol]});
 };
}
