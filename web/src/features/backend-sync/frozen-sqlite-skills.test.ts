import {describe,it,expect,vi,beforeEach} from "vitest";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
const mocks=vi.hoisted(()=>({plan:vi.fn(),revision:vi.fn(),authorized:vi.fn()}));
vi.mock("@/features/skills/skill-auto",()=>({
 prepareAutomaticSkillCatalog:mocks.plan
}));
vi.mock("@/features/skills/skill-registry",()=>({
 getSkillRegistrySnapshot:mocks.revision
}));
vi.mock("./canvas-api",()=>({canvasApi:mocks.authorized}));
import {freezeSqliteSkillCatalog} from "./frozen-sqlite-skills";
const hash="b".repeat(64);
const pkg={
 id:"camera-style",version:hash.slice(0,12),hash,name:"camera-style",
 description:"Cinematic camera moves",
 skillMd:"---\nname: camera-style\ndescription: Cine\n---\nUse a dolly zoom",
 resources:{"references/camera.md":"35mm lens."}
};
const uploaded=vi.fn(async(blob:Blob,mime:string)=>{
 const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))]
  .map(value=>value.toString(16).padStart(2,"0")).join("");
 return {blobId:digest,sha256:digest,mimeType:mime,byteSize:blob.size,existing:false};
});
const bridge={uploadFrozenBlob:uploaded} as unknown as ReturnType<typeof createSqliteComfyBridge>;
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.revision.mockResolvedValue({revision:4,skills:[{id:"camera-style",enabled:true}]});
 mocks.plan.mockResolvedValue({
  catalogMessage:"Catalog: camera-style",
  snapshot:()=>({mode:"auto",skillIds:["camera-style"],
   versionPins:{"camera-style":hash.slice(0,12)},activatedSkillIds:[]})
 });
 mocks.authorized.mockResolvedValue({revision:4,entries:[pkg]});
});
describe("P5.4j SQLite authorized and pinned Skill freeze",()=>{
 it("freezes only server authorized bytes and never embeds Skill content in the job",async()=>{
  const result=await freezeSqliteSkillCatalog({mode:"auto",skillIds:["camera-style"]},
   "create shots","project-1",bridge);
  expect(result.catalogMessage).toBe("Catalog: camera-style");
  expect(result.catalog.blobId).toMatch(/^[a-f0-9]{64}$/);
  expect(mocks.authorized).toHaveBeenCalledWith("/api/v1/skills/authorized-catalog",
   "POST",{projectId:"project-1",expectedRevision:4,
    skillIds:["camera-style"],versionPins:{"camera-style":hash.slice(0,12)}});
  const [blob,mime]=uploaded.mock.calls[0] as [Blob,string];
  expect(mime).toBe("text/plain");
  const json=JSON.parse(await blob.text());
  expect(json.format).toBe("atelier-skill-snapshot-v1");
  expect(json.entries[0]).toMatchObject({
   id:"camera-style",version:hash.slice(0,12),skillMd:pkg.skillMd,resources:pkg.resources
  });
  expect(JSON.stringify(result)).not.toContain("35mm lens.");
 });
 it("fails before upload when another tab disabled or rescoped a Skill",async()=>{
  const revoked=Object.assign(Error("skill_authorization_changed"),{code:"skill_authorization_changed"});
  mocks.authorized.mockRejectedValueOnce(revoked);
  await expect(freezeSqliteSkillCatalog(undefined,"x","project-1",bridge))
   .rejects.toMatchObject({code:"skill_authorization_changed"});
  mocks.authorized.mockRejectedValueOnce(
   Object.assign(Error("skill_revision_conflict"),{code:"skill_revision_conflict"}));
  await expect(freezeSqliteSkillCatalog(undefined,"x","project-1",bridge))
   .rejects.toThrow("skill_revision_conflict");
  expect(uploaded).not.toHaveBeenCalled();
 });
 it("rejects any malformed authorization output before publishing CAS",async()=>{
  mocks.authorized.mockResolvedValueOnce({revision:4,entries:[{...pkg,version:"wrong"}]});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_package_invalid");
  mocks.authorized.mockResolvedValueOnce({revision:5,entries:[pkg]});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_authorization_invalid");
  mocks.authorized.mockResolvedValueOnce({revision:4,entries:[{...pkg,resources:{"../../x.txt":"secret"}}]});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge)).rejects.toThrow();
  mocks.authorized.mockResolvedValueOnce({revision:4,entries:[{...pkg,skillMd:"x".repeat(24001)}]});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_package_invalid");
  expect(uploaded).not.toHaveBeenCalled();
 });
});
