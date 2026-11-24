// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import type {DramaAsset} from "./canvas-drama-pipeline";
import {DramaAssetFields} from "./drama-asset-fields";

const original:DramaAsset[]=[{
 id:"character-1",kind:"character",name:"主角",description:"原始描述",
 sourceRefs:["p3","p5"],aliases:["小主角"],variants:[]
}];
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;
 document.body.replaceChildren();
 vi.unstubAllGlobals();
});
async function mount(expanded:boolean){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const changes=vi.fn<(assets:DramaAsset[])=>void>();
 function Editor(){
  const [assets,setAssets]=useState<DramaAsset[]>(original);
  return <DramaAssetFields assets={assets} expanded={expanded} disabled={false}
   theme={canvasThemes.dark} onChange={next=>{changes(next);setAssets(next);}}/>;
 }
 await act(async()=>root.render(<Editor/>));
 return {container,changes};
}
describe("asset editor source references",()=>{
 it.each([false,true])("hides paragraph ID UI in expanded=%s without losing references on edit",async expanded=>{
  const {container,changes}=await mount(expanded);
  expect(container.textContent).not.toContain("原文段落 ID");
  expect(container.querySelectorAll("textarea")).toHaveLength(2); // description and aliases only
  const name=container.querySelector<HTMLInputElement>('input[value="主角"]');
  expect(name).toBeTruthy();
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(name,"新主角");
   name!.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall![0][0]).toMatchObject({
   name:"新主角",sourceRefs:["p3","p5"],aliases:["小主角"]
  });
 });
});
