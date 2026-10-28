import {Agent} from "undici";
import {lookup} from "node:dns";
import {isIP} from "node:net";
import {validateCompatResolvedAddress,normalizeOpenAiCompatBaseUrl} from "./openai-compat-endpoints.mjs";
import {validateTrustedHttpsUrl} from "./trusted-http.mjs";

const fail=code=>Object.assign(Error(code),{code,statusCode:502});
const MAX_BYTES=200*1024*1024;

/** Read provider-supplied video media without forwarding API credentials.
 * HTTPS signed CDN URLs are accepted with public DNS pinning; local HTTP
 * video downloads are allowed only from the frozen API origin.
 */
export function createRestrictedVideoDownloader({blobStore,fetcher=fetch,resolver=lookup,
 maxBytes=MAX_BYTES}={}){
 if(!blobStore||maxBytes<1||maxBytes>MAX_BYTES)throw Error("video_downloader_invalid");
 const agent=new Agent({connect:{lookup(hostname,_options,cb){
  resolver(hostname,{all:true,family:4},(error,rows)=>{
   if(error||!rows?.length)return cb(fail("video_download_dns_forbidden"));
   try{
    for(const row of rows)validateCompatResolvedAddress(hostname,row.address);
    cb(null,rows[0].address,4);
   }catch{cb(fail("video_download_dns_forbidden"))}
  });
 }}});
 async function importUrl(raw,{endpointBaseUrl}={}){
  if(typeof raw!=="string"||raw.length>4096)throw fail("video_download_url_invalid");
  let url,base;
  try{
   url=new URL(raw);
   base=new URL(normalizeOpenAiCompatBaseUrl(endpointBaseUrl));
  }catch{throw fail("video_download_url_invalid")}
  if(url.username||url.password||url.hash||!["https:","http:"].includes(url.protocol))
   throw fail("video_download_url_invalid");
  // No arbitrary private HTTP fetches, including cloud metadata.
  if(url.protocol!=="https:"&&url.origin!==base.origin)
   throw fail("video_download_destination_forbidden");
  if(url.origin!==base.origin){
   try{validateTrustedHttpsUrl(url.href,{allowedHosts:[url.hostname.toLowerCase()]})}
   catch{throw fail("video_download_destination_forbidden")}
  }else{
   try{normalizeOpenAiCompatBaseUrl(url.origin)}
   catch{throw fail("video_download_destination_forbidden")}
  }
  let response;
  try{response=await fetcher(url.href,{method:"GET",redirect:"manual",dispatcher:agent,
   signal:AbortSignal.timeout(180000)})}
  catch{throw fail("video_download_unavailable")}
  if(!response.ok||response.status>=300||!response.body)
   throw fail("video_download_rejected");
  const declared=response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if(declared&& !["application/octet-stream","video/mp4","video/webm"].includes(declared))
   throw fail("video_download_mime_unsupported");
  let total=0;
  async function* chunks(){
   for await(const part of response.body){
    const bytes=Buffer.from(part);total+=bytes.length;
    if(total>maxBytes)throw fail("video_download_too_large");
    yield bytes;
   }
  }
  // The CAS validates actual bytes and MIME signature, not server headers.
  // To know MIME from a webm/mp4 signature without buffering the video, sniff
  // the first streamed chunk before committing the async iterator to CAS.
  const iterator=chunks()[Symbol.asyncIterator]();
  const prefixParts=[];let prefixSize=0;
  while(prefixSize<16){
   const part=await iterator.next();if(part.done)break;
   const bytes=Buffer.from(part.value);
   prefixParts.push(bytes);prefixSize+=bytes.length;
  }
  if(!prefixParts.length)throw fail("video_download_empty");
  const prefix=Buffer.concat(prefixParts.map((part,i)=>{
   const offset=prefixParts.slice(0,i).reduce((sum,p)=>sum+p.length,0);
   return part.subarray(0,Math.max(0,16-offset));
  }));
  const mp4=prefix.length>=12&&prefix.toString("ascii",4,8)==="ftyp";
  const webm=prefix.length>=4&&prefix.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  const mime=mp4?"video/mp4":webm?"video/webm":null;
  if(!mime)throw fail("video_download_invalid_media");
  if(declared&&declared!=="application/octet-stream"&&declared!==mime)
   throw fail("video_download_mime_mismatch");
  async function* media(){
   for(const part of prefixParts)yield part;
   for await(const part of {[Symbol.asyncIterator]:()=>iterator})yield part;
  }
  return blobStore.put(media(),{mime});
 }
 return {importUrl};
}
