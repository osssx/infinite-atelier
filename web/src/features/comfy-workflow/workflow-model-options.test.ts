import {describe,expect,it,vi} from "vitest";
vi.mock("./preset-catalog",()=>({listComfyPresetCatalog:vi.fn()}));
import {listComfyPresetCatalog} from "./preset-catalog";
import {listComfyWorkflowModelOptionsByCapability} from "./workflow-model-options";
describe("workflow model options",()=>{
 it("offers only verified mediaUseCase capabilities, never output-type inference",async()=>{
  vi.mocked(listComfyPresetCatalog).mockResolvedValue([
   {id:"output-only",name:"Output only",templateId:"output-only",revision:"a".repeat(64),source:"user",kind:"base",workflowId:"x",mediaType:"image",mediaWorkflowEligible:false,status:"available"},
   {id:"image",name:"Image",templateId:"image",revision:"b".repeat(64),source:"user",kind:"base",workflowId:"y",mediaType:"image",mediaWorkflowEligible:true,status:"available"},
   {id:"broken",name:"Broken",templateId:"broken",revision:"c".repeat(64),source:"user",kind:"base",workflowId:"z",mediaType:"image",mediaWorkflowEligible:false,status:"missing"},
  ] as any);
  const options=await listComfyWorkflowModelOptionsByCapability();
  expect(options.image.map(x=>x.templateId)).toEqual(["image"]);
  expect(options.video).toEqual([]);
 });
});
