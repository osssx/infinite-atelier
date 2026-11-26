// Canvas media kind describes the uploaded file, not the loader's tensor output.
const registry = [
 {classType:"LoadImage",fileInput:"image",mediaKind:"IMAGE",outputs:[{index:0,socketKind:"IMAGE"},{index:1,socketKind:"MASK"}]},
 {classType:"LoadImageMask",fileInput:"image",mediaKind:"MASK",outputs:[{index:0,socketKind:"MASK"}]},
 {classType:"LoadAudio",fileInput:"audio",mediaKind:"AUDIO",outputs:[{index:0,socketKind:"AUDIO"}]},
 {classType:"VHS_LoadVideo",fileInput:"video",mediaKind:"VIDEO",outputs:[{index:0,socketKind:"IMAGE",semantic:"video_frames"},{index:1,socketKind:"INT",semantic:"frame_count"},{index:2,socketKind:"AUDIO",semantic:"soundtrack"},{index:3,socketKind:"VHS_VIDEOINFO",semantic:"video_info"}]}
];
export function getComfyMediaLoader(classType,fileInput){
 return registry.find(loader=>loader.classType===classType&&loader.fileInput===fileInput);
}
/** With a live schema, verify the actual filename widget and output contract. */
export function resolveComfyMediaLoader(classType,fileInput,schema){
 const loader=getComfyMediaLoader(classType,fileInput);
 if(!loader)return undefined;
 if(schema===undefined)return loader;
 const declaration=schema.input?.required?.[fileInput]??schema.input?.optional?.[fileInput];
 if(!Array.isArray(declaration)||!(Array.isArray(declaration[0])||["STRING","COMBO"].includes(declaration[0])))return undefined;
 if(!Array.isArray(schema.output)||loader.outputs.some(output=>schema.output[output.index]!==output.socketKind))return undefined;
 return loader;
}
