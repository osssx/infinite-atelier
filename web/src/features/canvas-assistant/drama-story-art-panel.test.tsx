// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
import {DramaStoryArtPanel} from "./drama-story-art-panel";
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
const initial={id:"story",type:"drama:source",title:"故事",position:{x:0,y:0},width:300,height:300,
 metadata:{dramaDraft:"正文",videoRatio:"16:9",dramaFilmStyle:"水彩",dramaArtDirection:{palette:"绿",lighting:"柔光",characterDesign:"猫",anchors:"尾巴"}}} as CanvasNodeData;
async function mount(persist:()=>Promise<void>=async()=>{}){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const patch=vi.fn();const pending=new Map<string,()=>Promise<void>>();
 let update:(meta:Partial<CanvasNodeMetadata>)=>void=()=>{};
 const register=(id:string,save:(()=>Promise<void>)|null)=>{if(save)pending.set(id,save);else pending.delete(id);};
 function View(){
  const [node,setNode]=useState(initial);
  update=meta=>setNode(old=>({...old,metadata:{...old.metadata,...meta}}));
  return <DramaStoryArtPanel node={node} onPendingChange={register}
   onChange={async value=>{await persist();patch(value);update(value);}}/>;
 }
 await act(async()=>root.render(<View/>));
 return {container,patch,pending,update:async(meta:Partial<CanvasNodeMetadata>)=>{await act(async()=>update(meta));}};
}
const click=async(el:Element|null|undefined)=>{expect(el).toBeTruthy();await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});};
const write=async(el:HTMLTextAreaElement,text:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,text);el.dispatchEvent(new Event("input",{bubbles:true}));});};
it("keeps settings read-only, changes only one field, and cancels without saving",async()=>{
 const {container,patch,pending}=await mount();
 expect(container.querySelector("select,textarea,input")).toBeNull();
 expect(container.querySelector("[data-story-art-panel]")).toBeNull();
 expect(container.querySelector("[data-story-art-summary]")?.textContent).toContain("16:9 · 水彩 · 美术指导 4/4");
 await click(container.querySelector('[aria-label="展开美术设定"]'));
 expect(container.querySelector("select,textarea,input")).toBeNull();
 await click(container.querySelector('[aria-label="编辑视频比例"]'));
 const select=container.querySelector("select")!;
 expect(select.value).toBe("16:9");
 await act(async()=>{select.value="9:16";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(pending.size).toBe(1);expect(patch).not.toHaveBeenCalled();
 await click(container.querySelector('[aria-label="保存视频比例"]'));
 expect(patch).toHaveBeenCalledWith({videoRatio:"9:16"});
 expect(pending.size).toBe(0);expect(container.querySelector("select")).toBeNull();
 await click(container.querySelector('[aria-label="编辑影片风格"]'));
 await write(container.querySelector("textarea")!,"新风格");
 // Collapsing must not destroy a registered unsaved field.
 expect(container.querySelector<HTMLButtonElement>("[data-story-art-toggle]")?.disabled).toBe(true);
 expect(container.querySelector("textarea")?.value).toBe("新风格");expect(pending.size).toBe(1);
 await click(container.querySelector('[data-drama-action="cancel"]'));
 expect(patch).toHaveBeenCalledTimes(1);expect(pending.size).toBe(0);
 await click(container.querySelector('[aria-label="收起美术设定"]'));
 expect(container.querySelector("[data-story-art-panel]")).toBeNull();
 expect(container.querySelector("[data-story-art-summary]")?.textContent).toContain("9:16 · 水彩");
});
it("merges a nested edit with the latest other fields and preserves the draft on failure",async()=>{
 const persist=vi.fn<()=>Promise<void>>().mockRejectedValueOnce(Error("持久化失败")).mockResolvedValueOnce();
 const {container,patch,pending,update}=await mount(persist);
 await click(container.querySelector('[aria-label="展开美术设定"]'));
 await click(container.querySelector('[aria-label="编辑色彩方案"]'));
 await write(container.querySelector("textarea")!,"蓝");
 await update({dramaArtDirection:{...initial.metadata!.dramaArtDirection!,lighting:"最新光影"}});
 await click(container.querySelector('[aria-label="保存色彩方案"]'));
 expect(container.textContent).toContain("持久化失败");expect(container.querySelector("textarea")?.value).toBe("蓝");
 expect(pending.size).toBe(1);expect(patch).not.toHaveBeenCalled();
 await act(async()=>{await [...pending.values()][0]();});
 expect(patch).toHaveBeenCalledWith({dramaArtDirection:{palette:"蓝",lighting:"最新光影",characterDesign:"猫",anchors:"尾巴"}});
 expect(pending.size).toBe(0);expect(container.querySelector("textarea")).toBeNull();
});
it("rejects a concurrent change to the field being edited",async()=>{
 const {container,patch,update}=await mount();
 await click(container.querySelector('[aria-label="展开美术设定"]'));
 await click(container.querySelector('[aria-label="编辑影片风格"]'));
 await write(container.querySelector("textarea")!,"我的风格");
 await update({dramaFilmStyle:"外部风格"});
 expect(container.querySelector<HTMLButtonElement>('[aria-label="保存影片风格"]')?.disabled).toBe(true);
 expect(container.textContent).toContain("字段已更新");expect(patch).not.toHaveBeenCalled();
});
