import {describe,it,expect,vi,beforeEach} from "vitest";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
const mocks=vi.hoisted(()=>({plan:vi.fn(),revision:vi.fn(),freeze:vi.fn()}));
vi.mock("@/features/skills/skill-auto",()=>({
 prepareAutomaticSkillCatalog:mocks.plan
}));
vi.mock("@/features/skills/skill-registry",()=>({
 getSkillRegistrySnapshot:mocks.revision
}));
vi.mock("./canvas-api",()=>({canvasApi:mocks.freeze}));
import {freezeSqliteSkillCatalog} from "./frozen-sqlite-skills";
const hash="b".repeat(64);
const authorizationId="11111111-1111-4111-a111-111111111111";
const bridge={uploadFrozenBlob:vi.fn()} as unknown as ReturnType<typeof createSqliteComfyBridge>;
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.revision.mockResolvedValue({revision:4,skills:[{id:"camera-style",enabled:true}]});
 mocks.plan.mockResolvedValue({
  catalogMessage:"Catalog: camera-style",
  snapshot:()=>({mode:"auto",skillIds:["camera-style"],
   versionPins:{"camera-style":hash.slice(0,12)},activatedSkillIds:[]})
 });
 mocks.freeze.mockResolvedValue({revision:4,blobId:hash,authorizationId});
});
describe("P5.4k trusted backend Skill freeze and one-use authorization",()=>{
 it("requests server-issued CAS and grant, never uploads browser-authored Skill bytes",async()=>{
  const result=await freezeSqliteSkillCatalog({mode:"auto",skillIds:["camera-style"]},
   "create shots","project-1",bridge);
  expect(result).toEqual({catalog:{blobId:hash},catalogMessage:"Catalog: camera-style",authorizationId});
  expect(mocks.freeze).toHaveBeenCalledWith("/api/v1/skills/freeze",
   "POST",{projectId:"project-1",expectedRevision:4,
    skillIds:["camera-style"],versionPins:{"camera-style":hash.slice(0,12)}});
  expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();
 });
 it("fails closed when another tab changes scope or disables a Skill",async()=>{
  const revoked=Object.assign(Error("skill_authorization_changed"),{code:"skill_authorization_changed"});
  mocks.freeze.mockRejectedValueOnce(revoked);
  await expect(freezeSqliteSkillCatalog(undefined,"x","project-1",bridge))
   .rejects.toMatchObject({code:"skill_authorization_changed"});
  mocks.freeze.mockRejectedValueOnce(
   Object.assign(Error("skill_revision_conflict"),{code:"skill_revision_conflict"}));
  await expect(freezeSqliteSkillCatalog(undefined,"x","project-1",bridge))
   .rejects.toThrow("skill_revision_conflict");
  expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();
 });
 it("refuses malformed server grant and CAS response",async()=>{
  mocks.freeze.mockResolvedValueOnce({revision:4,blobId:"not-sha",authorizationId});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_authorization_invalid");
  mocks.freeze.mockResolvedValueOnce({revision:5,blobId:hash,authorizationId});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_authorization_invalid");
  mocks.freeze.mockResolvedValueOnce({revision:4,blobId:hash,authorizationId:"bad"});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_authorization_invalid");
  expect(bridge.uploadFrozenBlob).not.toHaveBeenCalled();
 });
});
