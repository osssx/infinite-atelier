import {describe,it,expect,vi,beforeEach} from "vitest";
import type {createSqliteComfyBridge} from "./sqlite-comfy-bridge";
const mocks=vi.hoisted(()=>({plan:vi.fn(),package:vi.fn()}));
vi.mock("@/features/skills/skill-auto",()=>({
 prepareAutomaticSkillCatalog:mocks.plan
}));
vi.mock("@/features/skills/skill-registry",()=>({
 getSkillPackage:mocks.package
}));
import {freezeSqliteSkillCatalog} from "./frozen-sqlite-skills";

const hash="b".repeat(64);
const pkg={
 manifest:{id:"camera-style",version:hash.slice(0,12),hash,name:"Camera Style",
  description:"Cinematic camera moves",resources:["references/camera.md"]},
 skillMd:"---\nname: camera-style\ndescription: Cine\n---\nUse a dolly zoom",
 resources:{"references/camera.md":"35mm lens."}
};
const uploaded=vi.fn(async(blob:Blob,mime:string)=>{
 const bytes=await blob.arrayBuffer();
 const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
  .map(value=>value.toString(16).padStart(2,"0")).join("");
 return {blobId:digest,sha256:digest,mimeType:mime,byteSize:blob.size,existing:false};
});
const bridge={uploadFrozenBlob:uploaded} as unknown as ReturnType<typeof createSqliteComfyBridge>;
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.plan.mockResolvedValue({
  catalogMessage:"Catalog: camera-style",
  snapshot:()=>({mode:"auto",skillIds:["camera-style"],
    versionPins:{"camera-style":hash.slice(0,12)},activatedSkillIds:[]})
 });
 mocks.package.mockResolvedValue(pkg);
});
describe("P5.4f immutable SQLite automatic Skill freeze",()=>{
 it("stores version-pinned instructions in CAS while returning only digest",async()=>{
  const result=await freezeSqliteSkillCatalog({mode:"auto",
   skillIds:["camera-style"]},"create shots","project-1",bridge);
  expect(result.catalogMessage).toBe("Catalog: camera-style");
  expect(result.catalog.blobId).toMatch(/^[a-f0-9]{64}$/);
  const [blob,mime]=uploaded.mock.calls[0] as [Blob,string];
  expect(mime).toBe("text/plain");
  const json=JSON.parse(await blob.text());
  expect(json.format).toBe("atelier-skill-snapshot-v1");
  expect(json.entries[0]).toMatchObject({
   id:"camera-style",version:hash.slice(0,12),
   skillMd:pkg.skillMd,resources:pkg.resources
  });
  expect(JSON.stringify(result)).not.toContain("35mm lens");
  expect(mocks.plan).toHaveBeenCalledWith({mode:"auto",
   skillIds:["camera-style"]},undefined,"create shots","project-1");
 });
 it("never uploads missing or tampered pinned Skill packages",async()=>{
  mocks.package.mockResolvedValueOnce(null);
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_package_invalid");
  mocks.package.mockResolvedValueOnce({...pkg,manifest:{...pkg.manifest,version:"wrong"}});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_package_invalid");
  expect(uploaded).not.toHaveBeenCalled();
 });
 it("refuses oversized or unsafe external paths before publishing CAS bytes",async()=>{
  mocks.package.mockResolvedValueOnce({...pkg,resources:{"../../private.txt":"secret"}});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow();
  mocks.package.mockResolvedValueOnce({...pkg,skillMd:"x".repeat(24001)});
  await expect(freezeSqliteSkillCatalog(undefined,"x","p",bridge))
   .rejects.toThrow("model_skill_package_invalid");
  expect(uploaded).not.toHaveBeenCalled();
 });
});
