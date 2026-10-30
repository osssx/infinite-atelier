import {randomUUID} from "node:crypto";
import {existsSync,mkdirSync,readdirSync,lstatSync,statSync,realpathSync,readFileSync,writeFileSync,renameSync,rmSync} from "node:fs";
import {join,resolve,isAbsolute,dirname,sep} from "node:path";
import {homedir} from "node:os";
import {zipSync} from "fflate";
import {calculateNormalizedSkillHash,extractSkillFrontmatter,verifySkillPackageContent} from "./skill-package-integrity.mjs";

const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION=/^[a-f0-9]{12}$/;
const MAX_SIZE=5*1024*1024,MAX_FILES=100,MAX_SKILLS=100,MAX_TEXT=512*1024;
const validFile=p=>p.length>0&&p.length<=240&&!p.includes("\\")&&!p.startsWith("/")&&
  !/[\x00-\x1f\x7f<>:\"|?*]/.test(p)&&!p.split("/").some(s=>!s||s==="."||s===".."||s===".atelier"||
    /[. ]$/.test(s)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s));
function assertId(id){if(typeof id!=="string"||id.length>80||!ID.test(id))throw fail("skill_not_found",404)}
function safeJson(path){try{return JSON.parse(readFileSync(path,"utf8"))}catch(e){if(e.code==="ENOENT")return null;throw fail("skill_registry_corrupt",422)}}
function atomicJson(path,value){
  const tmp=path+"."+randomUUID()+".tmp";
  try{writeFileSync(tmp,JSON.stringify(value,null,2),{flag:"wx",mode:0o600});renameSync(tmp,path)}
  finally{if(existsSync(tmp))rmSync(tmp,{force:true})}
}
// Skill content is local/trusted: follow directory junctions and symbolic links,
// including resources outside the configured root. Only .atelier metadata is owned.
function followedStat(path,directory=false){
  const entry=lstatSync(path);
  const target=entry.isSymbolicLink()?statSync(path):entry;
  if(directory?!target.isDirectory():!target.isFile())throw fail("skill_path_unsafe",422);
  return target;
}
export function resolveSkillsDir(configured=process.env.ATELIER_SKILLS_DIR){
  const fallback=process.platform==="win32"
    ?join(process.env.LOCALAPPDATA||join(homedir(),"AppData","Local"),"InfiniteAtelier","skills")
    :join(process.env.XDG_DATA_HOME||join(homedir(),".local","share"),"InfiniteAtelier","skills");
  const path=configured??fallback;
  if(typeof path!=="string"||!isAbsolute(path))throw fail("skill_directory_must_be_absolute");
  return resolve(path);
}
export function createFileSkillRegistry({skillsDir=resolveSkillsDir(),scanAtStartup=true}={}){
  if(!isAbsolute(skillsDir))throw fail("skill_directory_must_be_absolute");
  const root=resolve(skillsDir),meta=join(root,".atelier"),versionsRoot=join(meta,"versions");
  // .atelier is private writable metadata; Skill sources and even the configured
  // root may be linked from other local directories, but metadata stays ordinary.
  function checkPath(path){
    let current=resolve(path);
    while(true){
      if(current!==meta&&!current.startsWith(meta+sep))throw fail("skill_path_unsafe",422);
      if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw fail("skill_path_unsafe",422);
      if(current===meta)break;
      current=dirname(current);
    }
  }
  mkdirSync(versionsRoot,{recursive:true,mode:0o700});
  checkPath(versionsRoot);
  followedStat(root,true);followedStat(meta,true);followedStat(versionsRoot,true);
  const stateFile=join(meta,"registry.json");
  checkPath(stateFile);
  let state=safeJson(stateFile)??{revision:1,entries:{}};
  if(!Number.isSafeInteger(state.revision)||state.revision<1||!state.entries||
     typeof state.entries!=="object"||Array.isArray(state.entries))throw fail("skill_registry_corrupt",422);
  function save(){state.revision++;atomicJson(stateFile,state)}
  function readTree(id){
    assertId(id);
    const base=join(root,id);followedStat(base,true);
    const files=new Map();let total=0;
    const ancestors=new Set();
    function walk(folder,prefix=""){
      // A junction/symlink may leave the root; detect cycles, not a root whitelist.
      const physical=realpathSync.native(folder);
      if(ancestors.has(physical))throw fail("skill_directory_cycle",422);
      ancestors.add(physical);
      try{
        for(const child of readdirSync(folder,{withFileTypes:true})){
          const path=prefix+child.name;
          if(!validFile(path))throw fail("skill_path_unsafe",422);
          const full=join(folder,child.name);
          const entry=lstatSync(full);
          const stat=entry.isSymbolicLink()?statSync(full):entry;
          if(stat.isDirectory()){walk(full,path+"/");continue}
          if(!stat.isFile())throw fail("skill_path_unsafe",422);
          if(files.size>=MAX_FILES||stat.size>MAX_SIZE||total+stat.size>MAX_SIZE)
            throw fail("skill_package_too_large",413);
          const content=readFileSync(full);
          if(total+content.length>MAX_SIZE)throw fail("skill_package_too_large",413);
          total+=content.length;files.set(path,content);
        }
      }finally{ancestors.delete(physical)}
    }
    walk(base);
    if(!files.has("SKILL.md"))throw fail("skill_missing_manifest",422);
    return files;
  }
  function toPackage(id,files,archive=null){
    if(files.get("SKILL.md").length>MAX_TEXT)throw fail("skill_package_too_large",413);
    const hash=calculateNormalizedSkillHash(files),skillMd=new TextDecoder("utf-8",{fatal:true}).decode(files.get("SKILL.md"));
    const {name,description}=extractSkillFrontmatter(skillMd);
    // Folder name is the stable id; SKILL.md name is the display title.
    const resources={},warnings=[],all=[...files.keys()];
    for(const path of all)if(/^references\/.+\.(?:md|txt|markdown)$/i.test(path)){
      if(files.get(path).length>MAX_TEXT)throw fail("skill_package_too_large",413);
      resources[path]=new TextDecoder("utf-8",{fatal:true}).decode(files.get(path));
    }
    if(all.some(p=>p.startsWith("scripts/")))warnings.push("Script files are inert and cannot be executed in V1");
    if(all.some(p=>p.startsWith("assets/")))warnings.push("Asset files are retained for export, but are not executable or model-readable in V1");
    const manifest={id,name,description,hash,version:hash.slice(0,12),
      resources:Object.keys(resources).sort(),warnings};
    const pkg={manifest,skillMd,resources,
      ...(archive?{sourceArchiveBase64:archive.toString("base64")}:{})};
    if(archive)verifySkillPackageContent(pkg,archive);
    else if(all.every(path=>path==="SKILL.md"||Object.hasOwn(resources,path)))verifySkillPackageContent(pkg,null);
    return pkg;
  }
  function versionFile(id,version){assertId(id);if(!VERSION.test(version))throw fail("skill_version_not_found",404);
    return join(versionsRoot,id,version+".json")}
  function snapshot(id,files,pkg){
    const dir=join(versionsRoot,id);mkdirSync(dir,{recursive:true,mode:0o700});checkPath(dir);
    const path=versionFile(id,pkg.manifest.version);
    const data={package:pkg,files:Object.fromEntries([...files].map(([k,v])=>[k,v.toString("base64")]))};
    if(existsSync(path)){
      const old=safeJson(path);
      if(!old||old.package?.manifest?.hash!==pkg.manifest.hash)throw fail("skill_version_conflict",409);
    }else atomicJson(path,data);
  }
  function load(id,version){
    const path=versionFile(id,version);checkPath(path);
    const saved=safeJson(path);
    if(!saved?.package||!saved.files||typeof saved.files!=="object")throw fail("skill_version_not_found",404);
    const files=new Map(Object.entries(saved.files).map(([k,v])=>[k,Buffer.from(v,"base64")]));
    const archive=saved.package.sourceArchiveBase64?Buffer.from(saved.package.sourceArchiveBase64,"base64"):null;
    const recomputed=toPackage(id,files,archive);
    if(JSON.stringify(recomputed)!==JSON.stringify(saved.package))throw fail("skill_package_integrity_failed",422);
    return saved.package;
  }
  function ensureRevision(expected){
    if(!Number.isSafeInteger(expected)||expected<1)throw fail("skill_revision_required");
    if(state.revision!==expected)throw fail("skill_revision_conflict",409);
  }
  function checkWorking(id,entry){
    try{const files=readTree(id);if(calculateNormalizedSkillHash(files)!==entry.workingHash)
      throw fail("skill_scan_required",409)}
    catch(e){if(e.code==="skill_scan_required")throw e;throw fail("skill_scan_required",409)}
  }
  function list(){return {revision:state.revision,skills:Object.entries(state.entries).filter(([,e])=>e.status!=="missing").map(([id,e])=>({
    id,name:e.name,description:e.description,enabled:e.enabled!==false && e.status==="ready",
    ...(e.scope?{scope:e.scope}:{}),activeVersion:e.activeVersion,versions:e.versions,
    updatedAt:e.updatedAt,status:e.status
  }))}}
  function scan(expectedRevision){
    if(expectedRevision!==undefined)ensureRevision(expectedRevision);
    const summary={added:0,updated:0,unchanged:0,missing:0,invalid:0,errors:[]};
    const before=JSON.stringify(state.entries),seen=new Set();
    for(const child of readdirSync(root,{withFileTypes:true})){
      const id=child.name;
      if(id===".atelier")continue;
      if(!ID.test(id)||id.length>80||!(child.isDirectory()||child.isSymbolicLink())){
        summary.invalid++;summary.errors.push({id,code:"skill_directory_invalid"});continue;
      }
      if(seen.size>=MAX_SKILLS){summary.invalid++;summary.errors.push({id,code:"skill_catalog_full"});continue}
      seen.add(id);
      try{
        const files=readTree(id),pkg=toPackage(id,files),hash=pkg.manifest.hash;
        const prior=state.entries[id];
        if(!prior?.versions?.includes(pkg.manifest.version)){
          const count=Object.values(state.entries).reduce((n,e)=>n+e.versions.length,0);
          if((prior?.versions.length??0)>=30||count>=500)throw fail("skill_versions_full",409);
        }
        if(!prior||prior.workingHash!==hash) snapshot(id,files,pkg);
        const changed=!prior||prior.workingHash!==hash||prior.status!=="ready";
        state.entries[id]={name:pkg.manifest.name,description:pkg.manifest.description,
          enabled:prior?.enabled??true,scope:prior?.scope??null,
          activeVersion:prior&&prior.workingHash===hash?prior.activeVersion:pkg.manifest.version,
          versions:[...new Set([...(prior?.versions??[]),pkg.manifest.version])],
          workingHash:hash,status:"ready",updatedAt:changed?new Date().toISOString():prior.updatedAt};
        summary[!prior?"added":changed?"updated":"unchanged"]++;
      }catch(e){
        summary.invalid++;summary.errors.push({id,code:e.code||"skill_scan_failed"});
        if(state.entries[id])state.entries[id].status="invalid";
      }
    }
    for(const [id,entry] of Object.entries(state.entries))if(!seen.has(id)&&entry.status!=="missing"){
      entry.status="missing";summary.missing++;
    }
    summary.total=seen.size;
    if(JSON.stringify(state.entries)!==before)save();
    return {...summary,revision:state.revision};
  }
  function authorized(db,{projectId,expectedRevision,skillIds,versionPins}){
    if(typeof projectId!=="string"||!Array.isArray(skillIds)||!skillIds.length||skillIds.length>MAX_SKILLS||
      !versionPins||typeof versionPins!=="object"||Array.isArray(versionPins)||
      Object.keys(versionPins).length!==skillIds.length)throw fail("skill_authorization_invalid");
    ensureRevision(expectedRevision);
    const project=db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(projectId);
    if(!project||project.deleted_at!==null)throw fail("skill_project_not_found",404);
    let size=0;const entries=[],unique=new Set();
    for(const id of skillIds){
      assertId(id);if(unique.has(id))throw fail("skill_authorization_invalid");unique.add(id);
      const entry=state.entries[id],version=versionPins[id];
      if(!entry||entry.status!=="ready"||!entry.enabled||
        entry.scope?.type==="project"&&entry.scope.projectId!==projectId||
        !entry.versions.includes(version)||!VERSION.test(version))throw fail("skill_authorization_changed",409);
      checkWorking(id,entry);
      const {manifest,skillMd,resources}=load(id,version);
      if(skillMd.length>24000||Object.keys(resources).length>99||
         Object.values(resources).some(s=>s.length>24000))throw fail("skill_snapshot_limit_exceeded",413);
      const item={id,version,hash:manifest.hash,name:manifest.name,description:manifest.description,skillMd,resources};
      size+=Buffer.byteLength(JSON.stringify(item));if(size>950000)throw fail("skill_snapshot_limit_exceeded",413);
      entries.push(item);
    }
    return {revision:state.revision,entries};
  }
  function update(id,body){
    assertId(id);ensureRevision(body.expectedRevision);
    const e=state.entries[id];if(!e)throw fail("skill_not_found",404);
    if(body.action==="enabled"){if(typeof body.enabled!=="boolean")throw fail("skill_update_invalid");e.enabled=body.enabled}
    else if(body.action==="scope"){
      const s=body.scope;if(!s||!["global","project"].includes(s.type)||s.type==="project"&&(!s.projectId||!/^[A-Za-z0-9_-]{1,128}$/.test(s.projectId)))throw fail("skill_update_invalid");
      e.scope=s.type==="global"?null:{type:"project",projectId:s.projectId};
    }else if(body.action==="activate"){if(!e.versions.includes(body.version))throw fail("skill_version_not_found",404);
      checkWorking(id,e);e.activeVersion=body.version;
    }else throw fail("skill_update_invalid");
    e.updatedAt=new Date().toISOString();save();
    return list().skills.find(x=>x.id===id);
  }
  function get(id,version){
    assertId(id);const e=state.entries[id];if(!e||e.status!=="ready")throw fail("skill_not_found",404);
    const selected=version??e.activeVersion;
    if(!e.versions.includes(selected))throw fail("skill_version_not_found",404);
    const pkg=load(id,selected);
    if(pkg.sourceArchiveBase64)return {package:pkg};
    const savedVersion=safeJson(versionFile(id,selected));
    const files=Object.fromEntries(Object.entries(savedVersion.files).map(([path,encoded])=>[path,Buffer.from(encoded,"base64")]));
    return {package:{...pkg,sourceArchiveBase64:Buffer.from(zipSync(files,{level:6})).toString("base64")}};
  }
  if(scanAtStartup)scan();
  return {root,list,scan,authorized,update,get,
    revision:()=>state.revision,assertCurrent:()=>{for(const [id,e] of Object.entries(state.entries))
      if(e.status==="ready"&&e.enabled)checkWorking(id,e)}};
}
