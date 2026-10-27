import {getSkillRegistrySnapshot} from "@/features/skills/skill-registry";
import {prepareAutomaticSkillCatalog} from "@/features/skills/skill-auto";
import {validateSkillPath} from "@/features/skills/skill-parser";
import {canvasApi} from "./canvas-api";
import type {SkillBinding} from "@/features/skills/types";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";

export type FrozenSqliteSkillCatalog={blobId:string};
export type FrozenSqliteSkillSelection={catalog:FrozenSqliteSkillCatalog;catalogMessage:string};
const MAX_SKILLS=100,MAX_CATALOG_BYTES=1024*1024,MAX_SKILL_TEXT=24000;
type SkillEntry={id:string;version:string;hash:string;name:string;description:string;
 skillMd:string;resources:Record<string,string>};

/** Two fences: freeze the UI's catalog revision BEFORE planning, then ask the
 * trusted SQLite server to authorize ALL version pins and bodies in one read.
 * No untrusted browser-supplied instruction bytes are published as CAS.
 */
export async function freezeSqliteSkillCatalog(
 binding:SkillBinding|undefined,prompt:string,projectId:string,
 bridge:ReturnType<typeof createSqliteComfyBridge>
):Promise<FrozenSqliteSkillSelection>{
 const initial=await getSkillRegistrySnapshot();
 const plan=await prepareAutomaticSkillCatalog(binding,undefined,prompt,projectId);
 if(!plan)throw Error("没有可用于自动模式的已启用 Skill");
 const snapshot=plan.snapshot();
 if(!snapshot.skillIds.length||snapshot.skillIds.length>MAX_SKILLS)
  throw Error("model_skill_catalog_invalid");
 const authorized=await canvasApi<{revision:number;entries:SkillEntry[]}>(
  "/api/v1/skills/authorized-catalog","POST",{
   projectId,expectedRevision:initial.revision,skillIds:snapshot.skillIds,
   versionPins:snapshot.versionPins
  });
 if(authorized.revision!==initial.revision||
    !Array.isArray(authorized.entries)||authorized.entries.length!==snapshot.skillIds.length)
  throw Error("model_skill_authorization_invalid");
 const entries:SkillEntry[]=[];
 let total=0;
 for(let i=0;i<authorized.entries.length;i++){
  const entry=authorized.entries[i],id=snapshot.skillIds[i];
  if(!entry||entry.id!==id||entry.version!==snapshot.versionPins[id]||
     !/^[a-f0-9]{64}$/.test(entry.hash)||!entry.hash.startsWith(entry.version)||
     typeof entry.name!=="string"||typeof entry.description!=="string"||
     typeof entry.skillMd!=="string"||entry.skillMd.length>MAX_SKILL_TEXT||
     !entry.resources||typeof entry.resources!=="object"||Array.isArray(entry.resources))
   throw Error("model_skill_package_invalid");
  for(const [path,body] of Object.entries(entry.resources)){
   validateSkillPath(path);
   if(!/^references\/.+\.(?:md|txt|markdown)$/i.test(path)||
      typeof body!=="string"||body.length>MAX_SKILL_TEXT)
    throw Error("model_skill_resource_invalid");
  }
  total+=new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  if(total>MAX_CATALOG_BYTES)throw Error("自动 Skill 资源总大小超过 1 MiB");
  entries.push(entry);
 }
 const blob=new Blob([JSON.stringify({format:"atelier-skill-snapshot-v1",entries})],
  {type:"text/plain"});
 if(blob.size>MAX_CATALOG_BYTES)throw Error("自动 Skill 快照超过 1 MiB");
 const uploaded=await bridge.uploadFrozenBlob(blob,"text/plain");
 if(uploaded.mimeType!=="text/plain"||uploaded.sha256!==uploaded.blobId||
    !/^[a-f0-9]{64}$/.test(uploaded.blobId)||uploaded.byteSize!==blob.size)
  throw Error("model_skill_catalog_upload_invalid");
 return {catalog:{blobId:uploaded.blobId},catalogMessage:plan.catalogMessage};
}
