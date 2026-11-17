import type {CanvasNodeData} from "@/types/canvas";

export const TEXT_VERSIONS_LIMIT=50;
export const CANVAS_DOCUMENT_LIMIT_BYTES=5*1024*1024;
export type TextVersion=NonNullable<CanvasNodeData["metadata"]>["textVersions"] extends (infer T)[]|undefined?T:never;
export function canSaveTextVersion(content:string,versions:TextVersion[]=[]){
 return Boolean(content.trim())&&versions[0]?.content!==content&&versions.length<TEXT_VERSIONS_LIMIT;
}
export function isValidTextRestore(content:string){return Boolean(content.trim());}
export function withTextVersions(node:CanvasNodeData,versions:TextVersion[],content=node.metadata?.content??""){
 return {...node,metadata:{...node.metadata,content,textVersions:versions}};
}
export function documentFitsCanvasLimit(document:unknown,reserveBytes=0){
 return new TextEncoder().encode(typeof document==="string"?document:JSON.stringify(document)).byteLength+reserveBytes<=CANVAS_DOCUMENT_LIMIT_BYTES;
}
export type RestoreDecision="noop"|"direct"|"confirm"|"backup-unavailable";
export function getTextRestoreDecision(current:string,target:string,versions:TextVersion[]):RestoreDecision{
 if(!isValidTextRestore(target)||current===target)return "noop";
 if(!current.trim()||versions.some(version=>version.content===current))return "direct";
 return versions.length>=TEXT_VERSIONS_LIMIT?"backup-unavailable":"confirm";
}
export function prepareTextRestore(current:string,target:TextVersion,versions:TextVersion[],mode:"direct"|"overwrite"|"backup",backup?:TextVersion):{content:string;versions:TextVersion[]}|null{
 if(!isValidTextRestore(target.content)||current===target.content)return null;
 if(mode==="backup"&&!current.trim())return null;
 if(mode==="backup"&&(versions.length>=TEXT_VERSIONS_LIMIT||!backup||backup.content!==current||backup.source!=="restore-backup"))return null;
 const next=mode==="backup"?[backup!,...versions]:versions;
 return {content:target.content,versions:next};
}
