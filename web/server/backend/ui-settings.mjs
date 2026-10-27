import {writeTransaction} from "./repository.mjs";

const names=new Set(["theme","model_config"]);
const allowedConfig=new Set(["channelMode","baseUrl","apiFormat","channels","model","imageModel","videoModel",
 "textModel","audioModel","audioVoice","audioFormat","audioSpeed","audioInstructions","videoSeconds",
 "videoMode","videoRatio","videoReturnLastFrame","vquality","videoGenerateAudio","videoWatermark",
 "systemPrompt","reasoningEffort","models","quality","size","background","count",
 "canvasImageCount","comfyInstanceId","comfyAutoDetect"]);
const allowedChannel=new Set(["id","name","baseUrl","apiFormat","models"]);
const allowedModel=new Set(["name","capability","videoPreset","videoCapabilities"]);
const allowedVideoCapabilities=new Set(["resolutions","durations","ratios","generateAudio","watermark","returnLastFrame"]);
const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function safeTree(value,depth=0){
 if(depth>7)throw fail("ui_setting_invalid");
 if(typeof value==="string"){if(value.length>20000)throw fail("ui_setting_invalid");return}
 if(typeof value==="number"){if(!Number.isFinite(value))throw fail("ui_setting_invalid");return}
 if(value===null||typeof value==="boolean")return;
 if(Array.isArray(value)){if(value.length>500)throw fail("ui_setting_invalid");
  for(const x of value)safeTree(x,depth+1);return}
 if(!object(value))throw fail("ui_setting_invalid");
 for(const [key,v] of Object.entries(value)){
  if(/(?:api.?key|authorization|password|secret|credential|access.?token|private.?key|script)/i.test(key))
   throw fail("ui_setting_secret_forbidden",422);
  safeTree(v,depth+1);
 }
}
function validate(name,value){
 if(name==="theme"){if(value!=="light"&&value!=="dark")throw fail("ui_setting_invalid");return JSON.stringify(value)}
 if(!object(value))throw fail("ui_setting_invalid");
 if(Object.keys(value).some(k=>!allowedConfig.has(k)))throw fail("ui_setting_invalid");
 if(value.baseUrl!==undefined){
  try{
   const url=new URL(value.baseUrl);
   if(!["http:","https:"].includes(url.protocol)||url.username||url.password||
    url.search||url.hash)throw Error("invalid");
  }catch{throw fail("ui_setting_invalid")}
 }
 if(value.channels!==undefined){
  if(!Array.isArray(value.channels)||value.channels.length>64)throw fail("ui_setting_invalid");
  for(const c of value.channels){
   if(!object(c)||Object.keys(c).some(k=>!allowedChannel.has(k))||
    typeof c.id!=="string"||typeof c.name!=="string"||typeof c.baseUrl!=="string"||
    !Array.isArray(c.models)||c.models.length>500)throw fail("ui_setting_invalid");   try{
    const url=new URL(c.baseUrl);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||
     url.search||url.hash)throw Error("invalid");
   }catch{throw fail("ui_setting_invalid")}

   for(const m of c.models){
    if(!object(m)||Object.keys(m).some(k=>!allowedModel.has(k))||
      typeof m.name!=="string"||typeof m.capability!=="string")throw fail("ui_setting_invalid");
    if(m.videoCapabilities!==undefined&&(!object(m.videoCapabilities)||
     Object.keys(m.videoCapabilities).some(k=>!allowedVideoCapabilities.has(k))))throw fail("ui_setting_invalid");
   }
  }
 }
 safeTree(value);
 const json=JSON.stringify(value);
 if(Buffer.byteLength(json,"utf8")>256*1024)throw fail("ui_setting_too_large",413);
 return json;
}
export function getUiSetting(db,name){
 if(!names.has(name))throw fail("ui_setting_not_found",404);
 const row=db.prepare("SELECT revision,value_json FROM ui_settings WHERE name=?").get(name);
 if(!row)throw Error("ui_setting_missing");
 return {revision:row.revision,value:JSON.parse(row.value_json)};
}
export function putUiSetting(db,name,{expectedRevision,value}={}){
 if(!names.has(name))throw fail("ui_setting_not_found",404);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fail("ui_setting_revision_required");
 return writeTransaction(db,()=>{
  const current=db.prepare("SELECT revision FROM ui_settings WHERE name=?").get(name);
  if(current?.revision!==expectedRevision)throw fail("ui_setting_revision_conflict",409);
  const json=validate(name,value);
  const result=db.prepare("UPDATE ui_settings SET value_json=?,revision=revision+1 WHERE name=? AND revision=?")
   .run(json,name,expectedRevision);
  if(result.changes!==1)throw fail("ui_setting_revision_conflict",409);
  return {revision:expectedRevision+1,value};
 });
}
