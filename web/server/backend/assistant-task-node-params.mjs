/** Task canvas node parameters: server-side mirror of the supported plain
 * generator control subset. A persisted Comfy media binding wins over plain
 * channel settings; never silently write an ineffective parameter.
 */
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const own=(value,fields)=>Object.keys(value).every(key=>fields.includes(key));
const names=new Set(["model","generationMode","quality","size","count","reasoningEffort",
 "seconds","videoRatio","vquality","generateAudio","audioVoice","audioFormat","audioSpeed",
 "audioInstructions","textCount"]);
const modes=new Set(["text","image","video","audio"]);
const allowed={
 text:new Set(["model","reasoningEffort","textCount"]),
 image:new Set(["model","quality","size","count"]),
 video:new Set(["model","seconds","videoRatio","vquality","generateAudio"]),
 audio:new Set(["model","audioVoice","audioFormat","audioSpeed","audioInstructions"])
};
const oneOf=(v,...values)=>typeof v==="string"&&values.includes(v);
export function assertFrozenNodeParameterAction(action){
 if(!own(action,["type","nodeId","key","value"])||
  typeof action.nodeId!=="string"||!/^[A-Za-z0-9_:@./-]{1,256}$/.test(action.nodeId)||
  !names.has(action.key))throw fail("assistant_node_parameter_invalid",400);
 const v=action.value;
 const valid=(()=>{
  if(action.key==="model")return typeof v==="string"&&v.length>=1&&v.length<=128;
  if(action.key==="generationMode")return oneOf(v,"text","image","video","audio");
  if(action.key==="quality")return oneOf(v,"auto","low","medium","high");
  if(action.key==="size")return oneOf(v,"auto","1024x1024","1536x1024","1024x1536",
   "512x512","256x256","1792x1024","1024x1792");
  if(action.key==="count")return Number.isInteger(v)&&v>=1&&v<=10;
  if(action.key==="textCount")return Number.isInteger(v)&&v>=1&&v<=8;
  if(action.key==="reasoningEffort")return oneOf(v,"auto","low","medium","high","xhigh");
  if(action.key==="seconds")return Number.isInteger(v)&&v>=4&&v<=20;
  if(action.key==="videoRatio")return oneOf(v,"adaptive","16:9","9:16","1:1","4:3","3:4","21:9");
  if(action.key==="vquality")return oneOf(v,"480p","720p","1080p");
  if(action.key==="generateAudio")return typeof v==="boolean";
  if(action.key==="audioVoice")return typeof v==="string"&&/^[\w-]{1,64}$/.test(v);
  if(action.key==="audioFormat")return oneOf(v,"mp3","wav","flac");
  if(action.key==="audioSpeed")return typeof v==="number"&&Number.isFinite(v)&&v>=0.25&&v<=4;
  if(action.key==="audioInstructions")return typeof v==="string"&&v.length<=2000;
  return false;
 })();
 if(!valid)throw fail("assistant_node_parameter_invalid",400);
}
const nodeMode=node=>node.type==="config"?node.metadata?.generationMode??"image":node.type;
export function applyFrozenNodeParameterAction({document,action,resolve,config={}}){
 const index=document.nodes.findIndex(n=>n.id===resolve(action.nodeId));
 if(index<0)throw fail("assistant_canvas_target_invalid");
 const node=document.nodes[index],mode=nodeMode(node);
 if(!modes.has(mode))throw fail("assistant_node_parameter_not_applicable");
 if(action.key==="generationMode"){
  if(node.type!=="config")throw fail("assistant_node_parameter_not_applicable");
  document.nodes[index]={...node,metadata:{...node.metadata,generationMode:action.value}};
  return;
 }
 const metadata=node.metadata??{};
 if(metadata.comfyMediaPreset||metadata.comfyWorkflowSelections?.[mode]||
  (!metadata.model&&config.comfyWorkflowDefaults?.[mode]))
  throw fail("assistant_node_parameter_uses_workflow");
 if(!allowed[mode].has(action.key))throw fail("assistant_node_parameter_not_applicable");
 if(action.key==="model"){
  const models=(config.channels??[]).flatMap(channel=>(channel.models??[])
   .filter(model=>model.capability===mode).map(model=>channel.id+"::"+model.name.trim()));
  if(!models.includes(action.value))throw fail("assistant_node_model_unavailable");
 }
 const stored=["seconds","audioSpeed","generateAudio"].includes(action.key)?
  String(action.value):action.value;
 document.nodes[index]={...node,metadata:{...metadata,[action.key]:stored}};
}
