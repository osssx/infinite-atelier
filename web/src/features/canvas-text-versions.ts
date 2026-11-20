import {readEpisodeDraft} from "../../server/canvas-text-content.mjs";
import {readStoryboardDraft} from "./canvas-assistant/canvas-drama-pipeline";
import type {CanvasNodeData} from "@/types/canvas";

export const TEXT_VERSIONS_LIMIT=50;
export const CANVAS_DOCUMENT_LIMIT_BYTES=5*1024*1024;
export type TextVersion=NonNullable<CanvasNodeData["metadata"]>["textVersions"] extends (infer T)[]|undefined?T:never;
export function canSaveTextVersion(content:string,versions:TextVersion[]=[]){
 return Boolean(content.trim())&&versions[0]?.content!==content&&versions.length<TEXT_VERSIONS_LIMIT;
}
export function isValidTextRestore(content:string){return Boolean(content.trim());}
export const isDramaVersionNode=(node:CanvasNodeData)=>node.type==="drama:episodes"||node.type==="drama:storyboard";
export const supportsTextVersions=(node:CanvasNodeData)=>node.type==="text"||isDramaVersionNode(node);
export function versionNodeContent(node:CanvasNodeData){
 const metadata=node.metadata;
 return isDramaVersionNode(node)?
  metadata?.dramaDraft||metadata?.dramaConfirmed||metadata?.content||"":metadata?.content??"";
}
export function canRestoreNodeVersion(node:CanvasNodeData,content:string){
 if(node.type==="drama:episodes")return Boolean(readEpisodeDraft(content)?.episodes.length);
 if(node.type==="drama:storyboard")return Boolean(readStoryboardDraft(content)?.shots.length);
 return isValidTextRestore(content);
}
export function withTextVersions(node:CanvasNodeData,versions:TextVersion[],content?:string){
 const patch=content===undefined?{}:isDramaVersionNode(node)?{dramaDraft:content}:{content};
 return {...node,metadata:{...node.metadata,...patch,textVersions:versions}};
}
export function prepareDramaConfirmation(node:CanvasNodeData,archive:{id:string;createdAt:string}){
 const readDraft=node.type==="drama:storyboard"?readStoryboardDraft:readEpisodeDraft;
 const stored=versionNodeContent(node);
 const draft=readDraft(stored);
 if(!isDramaVersionNode(node)||!draft||!canRestoreNodeVersion(node,stored))throw Error("drama_draft_invalid");
 const content=JSON.stringify(draft);
 const previous=node.metadata?.dramaConfirmed??"";
 const versions=node.metadata?.textVersions??[];
 const normalize=(value:string)=>JSON.stringify(readDraft(value)??value);
 const previousKey=normalize(previous);
 const shouldArchive=Boolean(previous.trim())&&previousKey!==content&&
  !versions.some(version=>normalize(version.content)===previousKey);
 if(shouldArchive&&versions.length>=TEXT_VERSIONS_LIMIT)throw Error("episode_history_full");
 const next=withTextVersions(node,shouldArchive?
  [{...archive,source:"confirmation",content:previous},...versions]:versions,content);
 return {...next,metadata:{...next.metadata,dramaConfirmed:content,dramaStage:node.type==="drama:storyboard"?"storyboard" as const:"episodes" as const}};
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
