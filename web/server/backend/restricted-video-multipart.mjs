import {createHash} from "node:crypto";

const fail=code=>Object.assign(Error(code),{code,statusCode:422,confirmedNotAccepted:true});
const token=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const types={
 "video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm",
 "audio/wav":"wav","audio/mpeg":"mp3","audio/flac":"flac","audio/ogg":"ogg"
};
const limit={"video":12*1024*1024,"audio":6*1024*1024};
/** The script never supplies file contents, file names, local paths, URLs, or
 * headers. FormData is constructed solely by the trusted adapter after CAS
 * integrity verification. One request inherits the existing upload barrier.
 */
export function createRestrictedAssetMultipart({asset,options}={}){
 if(!asset||!["video","audio"].includes(asset.kind)||
    !Object.hasOwn(types,asset.mimeType)||typeof asset.sha256!=="string"||
    !/^[a-f0-9]{64}$/.test(asset.sha256)||
    typeof asset.dataUrl!=="string")
  throw fail("model_asset_multipart_source_invalid");
 if(!options||typeof options!=="object"||Array.isArray(options)||
    Object.keys(options).some(key=>!["fileField","fields"].includes(key)))
  throw fail("model_asset_multipart_options_invalid");
 const fileField=options.fileField??"file";
 if(typeof fileField!=="string"||!token.test(fileField))
  throw fail("model_asset_multipart_file_field_invalid");
 const fields=options.fields??{};
 if(!fields||typeof fields!=="object"||Array.isArray(fields)||
    Object.getPrototypeOf(fields)!==null&&Object.getPrototypeOf(fields)!==Object.prototype||
    Object.keys(fields).length>24)
  throw fail("model_asset_multipart_fields_invalid");
 let totalFields=0;
 const pairs=[];
 for(const [key,value] of Object.entries(fields)){
  if(!token.test(key)||key===fileField||
     !["string","number","boolean"].includes(typeof value)||
     typeof value==="number"&&!Number.isFinite(value))
   throw fail("model_asset_multipart_fields_invalid");
  const content=String(value);
  totalFields+=Buffer.byteLength(content,"utf8");
  if(content.length>1024||totalFields>8192||
     /^data:[^;]+;base64,/i.test(content)||
     /[\u0000-\u001f\u007f]/.test(content))
   throw fail("model_asset_multipart_fields_invalid");
  pairs.push([key,content]);
 }
 const prefix="data:"+asset.mimeType+";base64,";
 if(!asset.dataUrl.startsWith(prefix))throw fail("model_asset_multipart_source_invalid");
 const b64=asset.dataUrl.slice(prefix.length);
 if(!b64||b64.length>Math.ceil(limit[asset.kind]/3)*4+4||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
  throw fail("model_asset_multipart_source_invalid");
 const bytes=Buffer.from(b64,"base64");
 if(bytes.length<1||bytes.length>limit[asset.kind]||
    createHash("sha256").update(bytes).digest("hex")!==asset.sha256)
  throw fail("model_asset_multipart_integrity_invalid");
 const body=new FormData();
 for(const [key,value] of pairs)body.append(key,value);
 const filename="reference_"+asset.sha256.slice(0,16)+"."+types[asset.mimeType];
 body.append(fileField,new Blob([bytes],{type:asset.mimeType}),filename);
 return body;
}
