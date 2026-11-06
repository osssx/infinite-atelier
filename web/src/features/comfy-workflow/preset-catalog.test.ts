import {beforeEach,describe,expect,it,vi} from "vitest";

const userPresets=vi.hoisted(()=>new Map<string,any>());
const storedTemplates=vi.hoisted(()=>new Map<string,any>());
const deleted=vi.hoisted(()=>[] as string[]);
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",value?:any)=>{
 if(method==="GET")return {presets:[...userPresets.values()]};
 if(method==="PUT"){userPresets.set(value.id,structuredClone(value));return value}
 if(method==="DELETE"){const id=decodeURIComponent(path.split("/").pop()!);deleted.push(id);userPresets.delete(id);return {deleted:true}}
})}));
vi.mock("./template-registry",()=>({getComfyTemplate:async(id:string,revision:string)=>storedTemplates.get(id+"@"+revision)??null}));
import {deleteComfyPreset} from "./preset-registry";
import {listComfyPresetCatalog,loadComfyPresetCatalogTemplates} from "./preset-catalog";

describe("database-backed ComfyUI preset catalog",()=>{
 beforeEach(()=>{userPresets.clear();storedTemplates.clear();deleted.length=0;});
 it("starts empty and does not synthesize or install bundled presets",async()=>{
  expect(await listComfyPresetCatalog()).toEqual([]);
  expect(storedTemplates.size).toBe(0);
 });
 it("lists saved presets only and treats legacy builtin source rows as imports",async()=>{
  const a={id:"a",name:"A",templateId:"template-a",revision:"a".repeat(64),source:"user",workflowId:"flow-a"};
  const oldBuiltin={id:"legacy",name:"Previously builtin",templateId:"template-b",revision:"b".repeat(64),source:"builtin",workflowId:"flow-b"};
  userPresets.set(a.id,a);userPresets.set(oldBuiltin.id,oldBuiltin);
  storedTemplates.set(a.templateId+"@"+a.revision,{ports:[{direction:"source",valueKind:"IMAGE"}]});
  storedTemplates.set(oldBuiltin.templateId+"@"+oldBuiltin.revision,{ports:[{direction:"source",valueKind:"VIDEO"}]});
  const all=await listComfyPresetCatalog();
  expect(all).toHaveLength(2);
  expect(all.find(item=>item.id==="legacy")).toMatchObject({source:"import",mediaType:"video",status:"available"});
  expect(all.every(item=>!Object.hasOwn(item,"builtIn"))).toBe(true);
  await deleteComfyPreset("legacy");
  expect(deleted).toEqual(["legacy"]);
 });
 it("isolates missing or invalid stored versions without hiding other saved rows",async()=>{
  const good={id:"good",name:"Good",templateId:"g",revision:"1".repeat(64)};
  const bad={id:"bad",name:"Broken",templateId:"b",revision:"2".repeat(64)};
  const loaded=await loadComfyPresetCatalogTemplates([good,bad],async item=>{
   if(item.id==="bad")throw Error("invalid graph");
   return {id:"g",revision:good.revision,name:"Good",apiGraph:{},ports:[],requirements:{classTypes:[]}};
  });
  expect(Object.keys(loaded.templates)).toEqual(["g@"+good.revision]);
  expect(loaded.failures).toEqual([{presetId:"bad",name:"Broken",message:"invalid graph"}]);
 });
});
