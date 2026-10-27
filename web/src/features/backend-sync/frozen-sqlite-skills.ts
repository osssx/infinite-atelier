import {getSkillPackage} from "@/features/skills/skill-registry";
import {prepareAutomaticSkillCatalog} from "@/features/skills/skill-auto";
import {validateSkillPath} from "@/features/skills/skill-parser";
import type {SkillBinding} from "@/features/skills/types";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";

export type FrozenSqliteSkillCatalog={blobId:string};
export type FrozenSqliteSkillSelection={catalog:FrozenSqliteSkillCatalog;catalogMessage:string};
const MAX_SKILLS=100,MAX_CATALOG_BYTES=1024*1024,MAX_SKILL_TEXT=24000;

/** Freeze the exact authorized, enabled and project-scoped IndexedDB packages
 * BEFORE the SQLite submit fence. The backend never executes imported code.
 * Only a SHA-256 CAS reference enters the immutable JobSnapshot.
 */
export async function freezeSqliteSkillCatalog(
 binding:SkillBinding|undefined,prompt:string,projectId:string,
 bridge:ReturnType<typeof createSqliteComfyBridge>
):Promise<FrozenSqliteSkillSelection>{
 const plan=await prepareAutomaticSkillCatalog(binding,undefined,prompt,projectId);
 if(!plan)throw Error("没有可用于自动模式的已启用 Skill");
 const snapshot=plan.snapshot();
 if(!snapshot.skillIds.length||snapshot.skillIds.length>MAX_SKILLS)
  throw Error("model_skill_catalog_invalid");
 const entries=[];
 let total=0;
 for(const id of snapshot.skillIds){
  const version=snapshot.versionPins[id];
  const pkg=await getSkillPackage(id,version);
  if(!pkg||pkg.manifest.version!==version||pkg.manifest.id!==id||
     !pkg.manifest.hash.startsWith(version)||pkg.skillMd.length>MAX_SKILL_TEXT)
   throw Error("model_skill_package_invalid");
  const resources:Record<string,string>={};
  for(const [path,body] of Object.entries(pkg.resources)){
   validateSkillPath(path);
   if(!/^references\/.+\.(?:md|txt|markdown)$/i.test(path)||
      typeof body!=="string"||body.length>MAX_SKILL_TEXT)
    throw Error("model_skill_resource_invalid");
   resources[path]=body;
  }
  const entry={
   id,version,hash:pkg.manifest.hash,name:pkg.manifest.name,
   description:pkg.manifest.description,skillMd:pkg.skillMd,resources
  };
  total+=new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  if(total>MAX_CATALOG_BYTES)throw Error("自动 Skill 资源总大小超过 1 MiB");
  entries.push(entry);
 }
 const blob=new Blob([JSON.stringify({format:"atelier-skill-snapshot-v1",entries})],{type:"text/plain"});
 if(blob.size>MAX_CATALOG_BYTES)throw Error("自动 Skill 快照超过 1 MiB");
 const uploaded=await bridge.uploadFrozenBlob(blob,"text/plain");
 if(uploaded.mimeType!=="text/plain"||uploaded.sha256!==uploaded.blobId||
    !/^[a-f0-9]{64}$/.test(uploaded.blobId)||uploaded.byteSize!==blob.size)
  throw Error("model_skill_catalog_upload_invalid");
 return {catalog:{blobId:uploaded.blobId},catalogMessage:plan.catalogMessage};
}
