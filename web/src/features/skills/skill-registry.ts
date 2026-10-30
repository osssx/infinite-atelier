import {createZip} from "@/lib/zip";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {validateSkillPath} from "./skill-parser";
import type {SkillCatalogEntry,SkillPackage,SkillScope} from "./types";

/** The backend filesystem is the source of truth; browser storage is not a fallback. */
function decodeArchive(value:string):Blob{
 const binary=atob(value),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return new Blob([bytes],{type:"application/zip"});
}
const segment=(value:string)=>encodeURIComponent(value);
const resource=(id:string,version:string)=>"/api/v1/skills/"+segment(id)+"/"+segment(version);
let operation=Promise.resolve();
function serialize<T>(run:()=>Promise<T>):Promise<T>{
 const current=operation.then(run);
 operation=current.then(()=>undefined,()=>undefined);
 return current;
}
export const SKILL_REGISTRY_CHANNEL="infinite-atelier:skill-registry:v13";
export type SkillRegistrySnapshot={revision:number;skills:SkillCatalogEntry[]};
export type SkillScanResult={revision:number;total:number;added:number;updated:number;unchanged:number;missing:number;invalid:number;errors:{id:string;code:string}[]};
export async function getSkillStorageConfig():Promise<{storage:string;directory:string|null}>{
 return canvasApi("/api/v1/skills/config");
}
export async function scanSkillDirectory(expectedRevision:number):Promise<SkillScanResult>{
 const result=await canvasApi<SkillScanResult>("/api/v1/skills/scan","POST",{expectedRevision});
 announce();return result;
}
/** Best-effort UI notification; the backend filesystem is authoritative. */
function announce(){
 if(typeof BroadcastChannel==="undefined")return;
 try{
  const channel=new BroadcastChannel(SKILL_REGISTRY_CHANNEL);
  channel.postMessage({kind:"changed"});
  channel.close();
 }catch{/* session/focus revalidation is the fallback */}
}
export async function getSkillRegistrySnapshot():Promise<SkillRegistrySnapshot>{
 await operation;
 return canvasApi<SkillRegistrySnapshot>("/api/v1/skills");
}
export async function listSkills():Promise<SkillCatalogEntry[]>{
 return (await getSkillRegistrySnapshot()).skills;
}
async function revision():Promise<number>{
 const result=await canvasApi<{revision:number}>("/api/v1/skills");
 if(!Number.isSafeInteger(result.revision)||result.revision<1)throw Error("skill_revision_invalid");
 return result.revision;
}
export async function setSkillEnabled(id:string,enabled:boolean,expectedRevision?:number):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"enabled",enabled,expectedRevision:expectedRevision??await revision()});announce()});
}
export async function setSkillScope(id:string,scope:SkillScope,expectedRevision?:number):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"scope",scope,expectedRevision:expectedRevision??await revision()});announce()});
}
export async function activateSkillVersion(id:string,version:string,expectedRevision?:number):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"activate",version,expectedRevision:expectedRevision??await revision()});announce()});
}
export async function getSkillPackage(id:string,version?:string):Promise<SkillPackage|null>{
 const list=await listSkills();
 const item=list.find(entry=>entry.id===id);
 if(!item)return null;
 const selected=version??item.activeVersion;
 if(!item.versions.includes(selected))return null;
 const result=await canvasApi<{package:{
  manifest:SkillPackage["manifest"];skillMd:string;resources:Record<string,string>;
  sourceArchiveBase64?:string;
 }}>(resource(id,selected));
 const {sourceArchiveBase64,...pkg}=result.package;
 if(pkg.manifest.id!==id||pkg.manifest.version!==selected)
  throw Error("Skill package content mismatch");
 return {...pkg,...(sourceArchiveBase64?{sourceArchive:decodeArchive(sourceArchiveBase64)}:{})};
}
export async function readSkillResource(id:string,path:string,version?:string):Promise<string>{
 validateSkillPath(path);
 if(!/^references\/.+\.(?:md|txt|markdown)$/i.test(path))
  throw Error("Skill resource is not model-readable");
 const pkg=await getSkillPackage(id,version);
 if(!pkg)throw Error("Unknown Skill");
 if(!Object.hasOwn(pkg.resources,path))throw Error("Unknown Skill reference");
 return pkg.resources[path];
}
export async function exportSkill(id:string,version?:string):Promise<Blob>{
 const pkg=await getSkillPackage(id,version);
 if(!pkg)throw Error("Unknown Skill");
 if(pkg.sourceArchive)return pkg.sourceArchive;
 return createZip([{name:"SKILL.md",data:pkg.skillMd},
  ...Object.entries(pkg.resources).map(([name,data])=>({name,data}))]);
}
