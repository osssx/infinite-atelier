export type ComfyMediaLoader = {classType:string;fileInput:string;mediaKind:"IMAGE"|"MASK"|"VIDEO"|"AUDIO";outputs:readonly {index:number;socketKind:string;semantic?:string}[]};
export function getComfyMediaLoader(classType:string,fileInput:string):ComfyMediaLoader|undefined;
export function resolveComfyMediaLoader(classType:string,fileInput:string,schema?:{input?:{required?:Record<string,unknown>;optional?:Record<string,unknown>};output?:string[]}):ComfyMediaLoader|undefined;
