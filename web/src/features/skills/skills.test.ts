import {beforeEach,describe,expect,it,vi} from "vitest";
import {unzipSync} from "fflate";
import {parseSkillMd,validateSkillPath} from "./skill-parser";
import {resetSkillTestApi,seedSkillTestApi} from "./skill-registry-test-api";
import {activateSkillVersion,exportSkill,getSkillPackage,listSkills,readSkillResource,setSkillEnabled} from "./skill-registry";
import type {SkillPackage} from "./types";

vi.mock("@/features/backend-sync/canvas-api",async()=>{
 const {skillTestApi}=await import("./skill-registry-test-api");
 return {canvasApi:skillTestApi};
});
const makePackage=(version:string,description="Create structured storyboards"):SkillPackage=>({
 manifest:{
  id:"storyboard-prompt",name:"storyboard-prompt",description,version,
  hash:version+"a".repeat(52),resources:["references/shots.md"],warnings:[]
 },
 skillMd:["---","name: storyboard-prompt","description: "+description,"---","# Steps","Break a scene into shots.",""].join("\n"),
 resources:{"references/shots.md":"# Shot rules\nUse wide shots first."}
});
beforeEach(()=>resetSkillTestApi());

describe("Filesystem-managed Skill catalog",()=>{
 it("reads scanned versions and supports activation and enabled state without import/delete",async()=>{
  const first=seedSkillTestApi(makePackage("111111111111"));
  seedSkillTestApi(makePackage("222222222222","Updated storyboard"));
  expect((await listSkills())[0].versions).toEqual(["111111111111","222222222222"]);
  await activateSkillVersion(first.id,first.activeVersion);
  expect((await getSkillPackage(first.id))?.manifest.description).toBe("Create structured storyboards");
  await setSkillEnabled(first.id,false);
  expect((await listSkills())[0].enabled).toBe(false);
 });
 it("reads references and exports a scanned package without modifying filesystem Skills",async()=>{
  const pkg=makePackage("111111111111");
  seedSkillTestApi(pkg);
  expect(await readSkillResource(pkg.manifest.id,"references/shots.md")).toContain("wide shots");
  await expect(readSkillResource(pkg.manifest.id,"scripts/helper.py")).rejects.toThrow(/not model-readable/);
  await expect(readSkillResource(pkg.manifest.id,"references/../scripts/helper.py")).rejects.toThrow(/traversal/);
  const archive=unzipSync(new Uint8Array(await (await exportSkill(pkg.manifest.id)).arrayBuffer()));
  expect(new TextDecoder().decode(archive["SKILL.md"])).toBe(pkg.skillMd);
  expect(new TextDecoder().decode(archive["references/shots.md"])).toBe(pkg.resources["references/shots.md"]);
 });
 it("validates Skill markdown and rejects invalid paths",()=>{
  expect(()=>parseSkillMd("---\nname: Bad_Name\ndescription: valid\n---\n# Text")).toThrow(/name/);
  expect(()=>parseSkillMd("---\nname: valid\ndescription: desc\nname: duplicate\n---\n# Text")).toThrow(/Duplicate/);
  expect(()=>parseSkillMd("---\nname: valid\n---\n# Text")).toThrow(/description/);
  expect(()=>validateSkillPath("../secrets.txt")).toThrow(/traversal/);
  expect(()=>validateSkillPath("C:\\windows\\a")).toThrow(/path/);
  expect(()=>validateSkillPath("https://example.com/x")).toThrow(/path/);
 });
 it("accepts Agent Skills metadata and folded descriptions",()=>{
  const md=["---","name: scene-writer","description: A scene workflow","metadata:","  author: Studio",
   "allowed-tools: Bash","---","# Workflow"].join("\n");
  expect(parseSkillMd(md).name).toBe("scene-writer");
  expect(parseSkillMd("---\nname: scene-writer\ndescription: >\n  Generates shots\n  from scenes\n---\n# Task").description)
   .toBe("Generates shots from scenes");
 });
});