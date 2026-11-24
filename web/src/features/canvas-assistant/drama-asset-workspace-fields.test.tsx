// @vitest-environment happy-dom
import {act,useState,type Dispatch,type SetStateAction} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import type {DramaAsset} from "./canvas-drama-pipeline";
import type {AssetEntryPatch} from "./drama-asset-entry-save";
import {DramaAssetWorkspaceFields} from "./drama-asset-workspace-fields";
const roots:Root[]=[];
const asset=(i:number):DramaAsset=>({id:"a"+i,kind:"character",name:"角色 "+i,description:"描述 "+i,sourceRefs:["p1"],aliases:["别名 "+i],variants:[{id:"v"+i,name:"造型 "+i,description:"造型描述"}]});
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
async function mount(initial:DramaAsset[],cas=false,usage:Record<string,string[]>={}){
 const div=document.createElement("div");document.body.append(div);const root=createRoot(div);roots.push(root);
 const pending=new Map<string,()=>Promise<void>>();
 const register=(key:string,save:(()=>Promise<void>)|null)=>{if(save)pending.set(key,save);else pending.delete(key);};
 let update:Dispatch<SetStateAction<DramaAsset[]>>=()=>{};
 const changes=vi.fn();
 const patch=vi.fn(async(base:DramaAsset,fields:AssetEntryPatch,variantId?:string)=>{
  update(current=>current.map(a=>a.id!==base.id?a:variantId?{...a,variants:a.variants?.map(v=>v.id===variantId?{...v,...fields}:v)}:{...a,...fields}));
 });
 function Editor(){const [assets,setAssets]=useState(initial);update=setAssets;return <DramaAssetWorkspaceFields assets={assets} theme={canvasThemes.dark} disabled={false}
  onChange={next=>{changes(next);setAssets(next)}} onPatchAsset={cas?patch:undefined} usage={usage} onPendingChange={register}
  renderReferences={(a,v)=><span data-reference={v??a.id}>参考图</span>}/>;}
 await act(async()=>root.render(<Editor/>));
 return {div,changes,patch,pending,update:async(fn:SetStateAction<DramaAsset[]>)=>{await act(async()=>update(fn))}};
}
const button=(div:HTMLElement,label:string)=>div.querySelector<HTMLButtonElement>('button[aria-label="'+label+'"]')!;
async function click(el:HTMLElement){expect(el).toBeTruthy();await act(async()=>el.click());}
async function input(el:HTMLInputElement|HTMLTextAreaElement,value:string){expect(el).toBeTruthy();await act(async()=>{
 const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));
});}
it("opens empty assets and adds a first entry with read-only fields",async()=>{
 const {div,changes}=await mount([]);
 expect(div.textContent).toContain("请选择或添加资产");
 await click(button(div,"添加资产"));
 expect(changes.mock.lastCall![0][0]).toMatchObject({kind:"character",sourceRefs:[],variants:[{name:"默认造型"}]});
 expect(div.querySelectorAll("textarea")).toHaveLength(0);
 expect(div.querySelector('[data-reference]')).toBeTruthy();
});
it("keeps consistent directory spacing and prevents list rows from shrinking in the scroll region",async()=>{
 const {div}=await mount(Array.from({length:10},(_,i)=>asset(i+1)));
 const list=div.querySelector<HTMLElement>("[data-asset-directory-list]")!;
 expect(list.classList.contains("flex-col")).toBe(true);
 expect(list.classList.contains("gap-1.5")).toBe(true);
 expect(list.classList.contains("overflow-y-auto")).toBe(true);
 expect(div.querySelector("aside")?.classList.contains("gap-3")).toBe(true);
 const rows=[...list.querySelectorAll("button")];
 expect(rows).toHaveLength(10);
 expect(rows.every(row=>row.classList.contains("shrink-0")&&row.classList.contains("min-h-9"))).toBe(true);
 await click(rows[1]);
 expect(rows[1].getAttribute("aria-pressed")).toBe("true");
});
it("pages and adds to the last page without showing stale directory data",async()=>{
 const {div,changes}=await mount(Array.from({length:11},(_,i)=>asset(i+1)));
 await click(button(div,"资产下一页"));
 expect(div.querySelector('aside')?.textContent).toContain("角色 11");
 await click(button(div,"添加资产"));
 expect(changes.mock.lastCall![0]).toHaveLength(12);
 expect(div.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("未命名角色");
 await input(div.querySelector<HTMLInputElement>('input[aria-label="搜索资产"]')!,"别名 4");
 expect(div.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("描述 4");
});
it("cancels staged edits, preserves IDs and uses CAS for asset and variant fields",async()=>{
 const base=asset(1);const {div,changes,patch,pending}=await mount([base],true,{"v1":["第一集"]});
 expect(button(div,"删除资产").disabled).toBe(true);
 expect(button(div,"删除变体").disabled).toBe(true);
 await click(button(div,"编辑资产描述"));
 await input(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="资产描述"]')!,"修改描述");
 expect(pending.size).toBe(1);expect(changes).not.toHaveBeenCalled();
 await click(div.querySelector<HTMLButtonElement>('[data-drama-action="cancel"]')!);
 expect(pending.size).toBe(0);expect(patch).not.toHaveBeenCalled();
 await click(button(div,"编辑名称"));
 await input(div.querySelector<HTMLInputElement>('input[aria-label="名称"]')!,"新名称");
 await click(button(div,"确认名称"));
 expect(patch).toHaveBeenCalledWith(base,{name:"新名称"},undefined);
 expect(changes).not.toHaveBeenCalled();
 await click(button(div,"编辑变体 1 描述"));
 await input(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="变体 1 描述"]')!,"新造型描述");
 await act(async()=>{await [...pending.values()][0]()});
 expect(patch).toHaveBeenLastCalledWith({...base,name:"新名称"},{description:"新造型描述"},"v1");
 expect(div.querySelector('[data-reference="v1"]')).toBeTruthy();
});
it("keeps unsaved edit on CAS failure without full draft overwrite",async()=>{
 const {div,changes,patch,pending}=await mount([asset(1)],true);
 patch.mockRejectedValueOnce(Error("drama_candidate_conflict"));
 await click(button(div,"编辑名称"));
 await input(div.querySelector<HTMLInputElement>('input[aria-label="名称"]')!,"新名称");
 await click(button(div,"确认名称"));
 expect(div.querySelector('[role="alert"]')?.textContent).toContain("drama_candidate_conflict");
 expect(div.querySelector<HTMLInputElement>('input[aria-label="名称"]')?.value).toBe("新名称");
 expect(pending.size).toBe(1);expect(changes).not.toHaveBeenCalled();
});
it("rejects a stale edit when another field is updated externally",async()=>{
 const {div,patch,changes,update}=await mount([asset(1)],true);
 await click(button(div,"编辑名称"));
 await input(div.querySelector<HTMLInputElement>('input[aria-label="名称"]')!,"本地改名");
 await update(current=>current.map(a=>({...a,description:"外部更新"})));
 expect(div.querySelector<HTMLInputElement>('input[aria-label="名称"]')?.value).toBe("本地改名");
 expect(button(div,"确认名称").disabled).toBe(true);
 expect(div.querySelector('[role="alert"]')?.textContent).toContain("内容已更新");
 expect(changes).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();
});
