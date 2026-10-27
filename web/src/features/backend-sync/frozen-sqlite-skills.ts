import {getSkillRegistrySnapshot} from "@/features/skills/skill-registry";
import {prepareAutomaticSkillCatalog} from "@/features/skills/skill-auto";
import {canvasApi} from "./canvas-api";
import type {SkillBinding} from "@/features/skills/types";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";

export type FrozenSqliteSkillCatalog={blobId:string};
export type FrozenSqliteSkillSelection={
 catalog:FrozenSqliteSkillCatalog;catalogMessage:string;authorizationId:string
};
const MAX_SKILLS=100;

/** The trusted backend constructs CAS bytes and issues a one-time grant.
 * The browser cannot substitute its own Skill instructions after selection.
 */
export async function freezeSqliteSkillCatalog(
 binding:SkillBinding|undefined,prompt:string,projectId:string,
 _bridge:ReturnType<typeof createSqliteComfyBridge>
):Promise<FrozenSqliteSkillSelection>{
 const initial=await getSkillRegistrySnapshot();
 const plan=await prepareAutomaticSkillCatalog(binding,undefined,prompt,projectId);
 if(!plan)throw Error("没有可用于自动模式的已启用 Skill");
 const snapshot=plan.snapshot();
 if(!snapshot.skillIds.length||snapshot.skillIds.length>MAX_SKILLS)
  throw Error("model_skill_catalog_invalid");
 const frozen=await canvasApi<{revision:number;blobId:string;authorizationId:string}>(
  "/api/v1/skills/freeze","POST",{
   projectId,expectedRevision:initial.revision,skillIds:snapshot.skillIds,
   versionPins:snapshot.versionPins
  });
 if(frozen.revision!==initial.revision||
    !/^[a-f0-9]{64}$/.test(frozen.blobId)||
    !/^[0-9a-f-]{36}$/.test(frozen.authorizationId))
  throw Error("model_skill_authorization_invalid");
 return {catalog:{blobId:frozen.blobId},catalogMessage:plan.catalogMessage,
  authorizationId:frozen.authorizationId};
}
