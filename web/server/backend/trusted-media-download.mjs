import {request as httpsRequest} from "node:https";
import {lookup} from "node:dns/promises";
import {validateTrustedHttpsUrl,resolvePinnedPublicIp} from "./trusted-http.mjs";
import {classifyMediaDownloadResponse} from "../media-download-policy.mjs";

const fail=(code,statusCode=502)=>Object.assign(Error(code),{code,statusCode});
const MAX_MEDIA_BYTES=200*1024*1024;
const HOSTS=["ark.cn-beijing.volces.com","ark-content-generation-cn-beijing.tos-cn-beijing.volces.com"];
const supported=new Set(["image/png","image/jpeg","image/webp","video/mp4","video/quicktime",
 "video/webm","audio/wav","audio/flac","audio/mpeg"]);
function inferType(head){
 if(head.length>=8&&head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
 if(head.length>=3&&head[0]===255&&head[1]===216&&head[2]===255)return "image/jpeg";
 if(head.toString("ascii",0,4)==="RIFF"&&head.toString("ascii",8,12)==="WEBP")return "image/webp";
 if(head.toString("ascii",4,8)==="ftyp")return "video/mp4";
 if(head.length>=4&&head.subarray(0,4).equals(Buffer.from([26,69,223,163])))return "video/webm";
 if(head.toString("ascii",0,4)==="RIFF"&&head.toString("ascii",8,12)==="WAVE")return "audio/wav";
 if(head.toString("ascii",0,4)==="fLaC")return "audio/flac";
 if(head.toString("ascii",0,3)==="ID3"||head[0]===255&&(head[1]&0xe0)===0xe0)return "audio/mpeg";
 return null;
}
/** Imports only allowlisted HTTPS media into SQLite CAS; never returns a
 * signed remote URL. Stream to disk, cap bytes, block redirects/DNS rebinding.
 */
export function createTrustedMediaDownloader({blobStore,requester=httpsRequest,resolver=lookup,maxBytes=MAX_MEDIA_BYTES}={}){
 if(!blobStore||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_MEDIA_BYTES)
  throw Error("invalid_trusted_media_downloader");
 async function importUrl(raw){
  const url=validateTrustedHttpsUrl(raw,{allowedHosts:HOSTS});
  const ip=await resolvePinnedPublicIp(url,{resolver});
  return new Promise((resolve,reject)=>{
   let settled=false;
   const settle=(err,result)=>{
    if(settled)return;settled=true;err?reject(err):resolve(result);
   };
   const req=requester(url,{method:"GET",timeout:60000,
    lookup:(_host,_options,cb)=>cb(null,ip.address,4)},response=>{
    const policy=classifyMediaDownloadResponse({statusCode:response.statusCode??502,
     contentType:response.headers["content-type"]??""});
    if(!policy.ok){response.resume();return settle(fail(policy.body.code,policy.status))}
    const size=Number(response.headers["content-length"]??0);
    if(size>maxBytes){response.resume();return settle(fail("media_download_too_large",413))}
    void (async()=>{
     const iterator=response[Symbol.asyncIterator]();
     let bytes=0,first=[];
     // Accumulate sufficient bytes for strict MIME inference when providers
     // answer application/octet-stream, without buffering the complete media.
     while(bytes<16){
      const chunk=await iterator.next();if(chunk.done)break;
      const value=Buffer.from(chunk.value);bytes+=value.length;
      if(bytes>maxBytes)throw fail("media_download_too_large",413);
      first.push(value);
     }
     const head=Buffer.concat(first).subarray(0,4096);
     const mime=policy.contentType==="application/octet-stream"?inferType(head):policy.contentType;
     if(!supported.has(mime))throw fail("media_download_mime_unsupported",415);
     async function* chunks(){
      for(const part of first)yield part;
      for await(const part of { [Symbol.asyncIterator]:()=>iterator }){
       bytes+=part.length;
       if(bytes>maxBytes)throw fail("media_download_too_large",413);
       yield part;
      }
     }
     const stored=await blobStore.put(chunks(),{mime});
     return stored;
    })().then(value=>settle(null,value),error=>{response.destroy();settle(error)});
   });
   req.on("timeout",()=>req.destroy(fail("media_download_timeout")));
   req.on("error",()=>settle(fail("media_download_unavailable")));
   req.end();
  });
 }
 return {importUrl};
}
