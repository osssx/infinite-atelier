import {unzipSync} from "fflate";
import {listSkillRegistry,getSkillRegistryPackage} from "./sqlite-skill-registry.mjs";

const fail=(code,statusCode)=>Object.assign(Error(code),{code,statusCode});
/** Shared legacy/Task validation. Packages remain pinned to their immutable
 * manifest hash; a Task cannot silently switch to the latest installed Skill.
 */
export function resolveAuthorizedSkillScript(db,skillRegistry,{
 skill_id,version,project_id,script_path,entry_id
}){
 if(Boolean(script_path)===Boolean(entry_id))throw fail("skill_script_arguments_invalid",400);
 const project=db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(project_id);
 if(!project||project.deleted_at!==null)throw fail("skill_project_not_found",404);
 const catalog=skillRegistry?skillRegistry.list():listSkillRegistry(db);
 const selected=catalog.skills.find(item=>item.id===skill_id);
 if(!selected||!selected.enabled||!selected.versions.includes(version)||
   selected.scope?.type==="project"&&selected.scope.projectId!==project_id)
  throw fail("skill_authorization_changed",409);
 const loaded=skillRegistry?skillRegistry.get(skill_id,version):getSkillRegistryPackage(db,skill_id,version);
 const pkg=loaded.package;
 if(pkg.manifest.hash.slice(0,12)!==version||!pkg.sourceArchiveBase64)
  throw fail("skill_package_integrity_failed",422);
 let packed;try{packed=unzipSync(Buffer.from(pkg.sourceArchiveBase64,"base64"))}
 catch{throw fail("skill_package_integrity_failed",422)}
 const packageFiles={},scripts={};
 for(const [path,bytes] of Object.entries(packed)){
  packageFiles[path]=Buffer.from(bytes).toString("base64");
  if(path.startsWith("scripts/"))try{
   scripts[path]=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  }catch{/* Binary files are not executable scripts. */}
 }
 let selectedPath=script_path;
 if(entry_id){
  let entries={};
  if(packageFiles["execution.json"])try{
   entries=JSON.parse(Buffer.from(packageFiles["execution.json"],"base64").toString("utf8")).entries??{};
  }catch{throw fail("model_skill_execution_manifest_invalid",422)}
  selectedPath=entries[entry_id];
 }
 if(typeof selectedPath!=="string"||!Object.hasOwn(scripts,selectedPath))
  throw fail("skill_script_not_authorized",403);
 return {skillId:skill_id,version,scriptPath:selectedPath,source:scripts[selectedPath],packageFiles};
}
