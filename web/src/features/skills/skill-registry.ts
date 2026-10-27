import {createZip} from "@/lib/zip";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {validateSkillPath} from "./skill-parser";
import type {SkillCatalogEntry,SkillPackage,SkillScope} from "./types";

/** v13: SQLite is authoritative; deliberately never read or erase the old
 * IndexedDB skill_packages database. A failed backend request fails closed.
 */
function decodeArchive(value:string):Blob{
 const binary=atob(value),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return new Blob([bytes],{type:"application/zip"});
}
async function encodeArchive(value:Blob):Promise<string>{
 if(value.size>5*1024*1024)throw Error("Skill archive too large");
 const bytes=new Uint8Array(await value.arrayBuffer()),parts:string[]=[];
 for(let i=0;i<bytes.length;i+=32768)
  parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
 return btoa(parts.join(""));
}
const segment=(value:string)=>encodeURIComponent(value);
const resource=(id:string,version:string)=>"/api/v1/skills/"+segment(id)+"/"+segment(version);
let operation=Promise.resolve();
function serialize<T>(run:()=>Promise<T>):Promise<T>{
 const current=operation.then(run);
 operation=current.then(()=>undefined,()=>undefined);
 return current;
}
export async function listSkills():Promise<SkillCatalogEntry[]>{
 await operation;
 const result=await canvasApi<{revision:number;skills:SkillCatalogEntry[]}>("/api/v1/skills");
 return result.skills;
}
async function revision():Promise<number>{
 const result=await canvasApi<{revision:number}>("/api/v1/skills");
 if(!Number.isSafeInteger(result.revision)||result.revision<1)throw Error("skill_revision_invalid");
 return result.revision;
}
export async function registerSkill(pkg:SkillPackage):Promise<SkillCatalogEntry>{
 return serialize(async()=>{
  const {sourceArchive,...rest}=pkg;
  const body={...rest,...(sourceArchive?{sourceArchiveBase64:await encodeArchive(sourceArchive)}:{})};
  const result=await canvasApi<{entry:SkillCatalogEntry}>("/api/v1/skills","POST",{expectedRevision:await revision(),package:body});
  return result.entry;
 });
}
export async function setSkillEnabled(id:string,enabled:boolean):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"enabled",enabled,expectedRevision:await revision()})});
}
export async function setSkillScope(id:string,scope:SkillScope):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"scope",scope,expectedRevision:await revision()})});
}
export async function activateSkillVersion(id:string,version:string):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"PATCH",{action:"activate",version,expectedRevision:await revision()})});
}
export async function removeSkill(id:string):Promise<void>{
 await serialize(async()=>{await canvasApi("/api/v1/skills/"+segment(id),"DELETE",{expectedRevision:await revision()})});
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
export type SkillBackupSnapshot={catalog:SkillCatalogEntry[];packages:SkillPackage[]};
/** Logical read-only inspection. The supported portable backup is backup:data. */
export async function snapshotSkills():Promise<SkillBackupSnapshot>{
 const catalog=await listSkills(),packages:SkillPackage[]=[];
 for(const entry of catalog)for(const version of entry.versions){
  const pkg=await getSkillPackage(entry.id,version);
  if(!pkg)throw Error("Skill package unavailable during snapshot");
  packages.push(pkg);
 }
 return {catalog,packages};
}
/** Full Skill rollback is performed only through SQLite cold-backup restore.
 * Never let a legacy browser ZIP overwrite the authoritative registry.
 */
export async function restoreSkillSnapshot(_snapshot:SkillBackupSnapshot):Promise<never>{
 throw Error("SQLite Skill 注册表不支持旧浏览器快照覆盖；请使用 backup:data 恢复完整数据库");
}
