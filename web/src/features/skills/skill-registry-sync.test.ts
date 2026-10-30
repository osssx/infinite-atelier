import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
vi.mock("@/features/backend-sync/canvas-api",async()=>{
 const {skillTestApi}=await import("./skill-registry-test-api");
 return {canvasApi:skillTestApi};
});
import {resetSkillTestApi,seedSkillTestApi,skillTestApi} from "./skill-registry-test-api";
import {SKILL_REGISTRY_CHANNEL,getSkillRegistrySnapshot,setSkillScope} from "./skill-registry";
import {useSkillStore} from "@/stores/use-skill-store";
import type {SkillPackage} from "./types";

const version="a".repeat(12);
const pkg:SkillPackage={
 manifest:{id:"storyboard",name:"storyboard",description:"Storyboard",
  version,hash:"a".repeat(64),warnings:[],resources:[]},
 skillMd:"---\nname: storyboard\ndescription: Storyboard\n---\nText",
 resources:{}
};
class FakeChannel{
 static sent:Array<{name:string;message:unknown}>=[];
 closed=false;
 constructor(public name:string){}
 postMessage(message:unknown){FakeChannel.sent.push({name:this.name,message})}
 close(){this.closed=true}
}
beforeEach(()=>{
 resetSkillTestApi();
 useSkillStore.setState({catalog:[],catalogRevision:0,loaded:false,busy:false});
 FakeChannel.sent=[];
 vi.stubGlobal("BroadcastChannel",FakeChannel);
});
afterEach(()=>vi.unstubAllGlobals());

describe("P5.4i cross-tab revision and notification",()=>{
 it("announces only successful mutations and exposes fresh authoritative revision",async()=>{
  const initial=await getSkillRegistrySnapshot();
  expect(initial.revision).toBe(1);
  const saved=seedSkillTestApi(pkg);
  expect(saved.id).toBe("storyboard");
  const after=await getSkillRegistrySnapshot();
  expect(after.revision).toBe(2);
  expect(FakeChannel.sent).toEqual([]);
  await expect(setSkillScope("storyboard",{type:"project",projectId:"p1"},1))
   .rejects.toMatchObject({code:"skill_revision_conflict"});
  expect(FakeChannel.sent).toHaveLength(0); // rejected mutation does not notify
 });
 it("store refuses to mutate stale UI revisions, then refreshes latest value",async()=>{
  seedSkillTestApi(pkg);
  await useSkillStore.getState().refresh();
  expect(useSkillStore.getState().catalogRevision).toBe(2);
  expect(useSkillStore.getState().catalog[0].enabled).toBe(true);
  await skillTestApi("/api/v1/skills/storyboard","PATCH",{
   action:"enabled",enabled:false,expectedRevision:2
  }); // a second tab updates the server while first tab still shows revision 2
  await expect(useSkillStore.getState().toggle("storyboard",true))
   .rejects.toThrow("Skills 已在其他标签页发生修改");
  const current=useSkillStore.getState();
  expect(current.catalogRevision).toBe(3);
  expect(current.catalog[0].enabled).toBe(false);
  expect(current.busy).toBe(false);
  expect(FakeChannel.sent).toHaveLength(0); // no broadcast after rejected write
  await current.toggle("storyboard",true);
  expect(useSkillStore.getState().catalogRevision).toBe(4);
  expect(useSkillStore.getState().catalog[0].enabled).toBe(true);
  expect(FakeChannel.sent).toHaveLength(1);
   expect(FakeChannel.sent[0]).toEqual({name:SKILL_REGISTRY_CHANNEL,message:{kind:"changed"}});
 });
});
