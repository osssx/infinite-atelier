import type {SkillCatalogEntry,SkillPackage} from "./types";
type StoredPackage=Omit<SkillPackage,"sourceArchive">&{sourceArchiveBase64?:string};
const entries=new Map<string,SkillCatalogEntry>();
const versions=new Map<string,StoredPackage>();
let revision=1;
const clone=<T>(value:T):T=>structuredClone(value);
export function resetSkillTestApi(){entries.clear();versions.clear();revision=1;}

/** Test fixture: simulate a filesystem scan registering a Skill, not an HTTP import. */
export function seedSkillTestApi(pkg:StoredPackage):SkillCatalogEntry{
 const data=clone(pkg),m=data.manifest;
 const existing=entries.get(m.id);
 versions.set(m.id+":"+m.version,data);
 const entry:SkillCatalogEntry={
  id:m.id,name:m.name,description:m.description,enabled:existing?.enabled??true,
  ...(existing?.scope?{scope:clone(existing.scope)}:{}),
  activeVersion:m.version,versions:[...new Set([...(existing?.versions??[]),m.version])],
  updatedAt:new Date().toISOString()
 };
 entries.set(m.id,entry);revision++;
 return clone(entry);
}

/** In-memory HTTP test double for catalog reads and metadata PATCH only. */
export async function skillTestApi(path:string,method="GET",payload?:unknown):Promise<any>{
 if(path==="/api/v1/skills"&&method==="GET")
  return {revision,skills:clone([...entries.values()])};
 const body=payload as Record<string,any>|undefined;
 if(method==="POST"&&path==="/api/v1/skills/scan"){
  if(body?.expectedRevision!==revision)throw Object.assign(Error("skill_revision_conflict"),{code:"skill_revision_conflict",status:409});
  return {revision,total:entries.size,added:0,updated:0,unchanged:entries.size,missing:0,invalid:0,errors:[]};
 }
 const match=/^\/api\/v1\/skills\/([^/]+)(?:\/([^/]+))?$/.exec(path);
 if(!match)throw Error("unknown_skill_api");
 const id=decodeURIComponent(match[1]),version=match[2]&&decodeURIComponent(match[2]);
 if(method==="GET"&&version){
  const item=versions.get(id+":"+version);
  if(!item)throw Error("skill_version_not_found");
  return {package:clone(item)};
 }
 if(method!=="PATCH"||!body)throw Error("unknown_skill_api");
 if(body.expectedRevision!==revision)
  throw Object.assign(Error("skill_revision_conflict"),{code:"skill_revision_conflict",status:409});
 const item=entries.get(id);
 if(!item)throw Error("Skill does not exist");
 if(body.action==="enabled"){
  if(typeof body.enabled!=="boolean")throw Error("Invalid Skill enabled");
  item.enabled=body.enabled;
 }else if(body.action==="scope"){
  if(body.scope.type!=="global"&&
   (body.scope.type!=="project"||!body.scope.projectId||body.scope.projectId.length>256))
   throw Error("Invalid Skill project scope");
  if(body.scope.type==="global")delete item.scope;
  else item.scope=clone(body.scope);
 }else if(body.action==="activate"){
  if(!item.versions.includes(body.version))throw Error("Unknown Skill version");
  const pkg=versions.get(id+":"+body.version);
  if(!pkg)throw Error("Skill version content missing");
  item.activeVersion=body.version;
  item.name=pkg.manifest.name;item.description=pkg.manifest.description;
 }else throw Error("Invalid Skill action");
 item.updatedAt=new Date().toISOString();revision++;
 return {entry:clone(item)};
}