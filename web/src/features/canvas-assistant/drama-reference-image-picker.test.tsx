// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import {DramaReferenceImagePicker} from "./drama-reference-image-picker";
import {canvasApi} from "@/features/backend-sync/canvas-api";
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn()}));
const images=Array.from({length:31},(_,i)=>({key:"cas:"+i.toString(16).padStart(64,"0"),title:"图片 "+i}));
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.innerHTML="";vi.unstubAllGlobals();});
async function mount(projectId?:string){
 const el=document.createElement("div");document.body.append(el);
 const root=createRoot(el);roots.push(root);const onAdd=vi.fn();
 const render=async(theme:"light"|"dark"="light",disabled=false)=>{await act(async()=>root.render(
  <DramaReferenceImagePicker name="日常" images={[...images,images[2],{key:"invalid",title:"错误"}]} boundKeys={[images[0].key]}
   disabled={disabled} theme={canvasThemes[theme]} onAdd={onAdd} projectId={projectId}/>));};
 const click=async(label:string)=>{const b=[...el.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.getAttribute("aria-label")===label||b.textContent?.trim()===label)!;expect(b).toBeTruthy();await act(async()=>b.click());};
 await render();
 return {el,render,onAdd,click};
}
it("mounts only visible page previews on demand, filters already bound and duplicate keys, and confirms one image",async()=>{
 const {el,click,onAdd}=await mount();
 expect(el.querySelectorAll("img")).toHaveLength(0);
 await click("添加日常参考图");
 expect(el.querySelectorAll('button[aria-pressed]')).toHaveLength(24);
 expect(el.querySelector('img[alt="图片 0"]')).toBeNull();
 expect(el.querySelectorAll('img[alt="图片 2"]')).toHaveLength(1);
 expect(el.textContent).toContain("30 张可选图片");
 expect(el.querySelector("img")?.getAttribute("loading")).toBe("lazy");
 await click("图片下一页");
 expect(el.querySelectorAll('button[aria-pressed]')).toHaveLength(6);
 await click("选择图片 图片 30");
 expect(onAdd).not.toHaveBeenCalled();
 expect(el.querySelector('img[alt="图片 30"][loading="eager"]')).toBeTruthy();
 await click("添加参考图");
 expect(onAdd).toHaveBeenCalledExactlyOnceWith(images[30].key);
 expect(el.querySelectorAll("img")).toHaveLength(0);
});
it("sorts by persisted generation time before pagination, with stable undated fallback",async()=>{
 vi.mocked(canvasApi).mockResolvedValueOnce({images:[
  {blobId:images[2].key.slice(4),generatedAt:1000},
  {blobId:images[29].key.slice(4),generatedAt:3000},
  {blobId:images[27].key.slice(4),generatedAt:2000},
  {blobId:images[0].key.slice(4),generatedAt:4000}
 ]});
 const {el,click}=await mount("p1");
 expect(canvasApi).not.toHaveBeenCalled();
 await click("添加日常参考图");
 expect(canvasApi).toHaveBeenCalledWith("/api/v1/projects/p1/image-generation-times","GET",undefined,expect.any(AbortSignal));
 const titles=()=>[...el.querySelectorAll('button[aria-pressed]')].map(b=>b.getAttribute("aria-label"));
 expect(titles().slice(0,5)).toEqual(["选择图片 图片 29","选择图片 图片 27","选择图片 图片 2","选择图片 图片 1","选择图片 图片 3"]);
 expect(titles()).toHaveLength(24);
 await click("图片下一页");
 expect(titles()).toHaveLength(6);
});
it("searches, shows failed image fallback, supports cancellation and disables a stale open picker",async()=>{
 const {el,click,onAdd,render}=await mount();
 await click("添加日常参考图");
 const input=el.querySelector<HTMLInputElement>('input[aria-label="搜索画布图片"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"图片 29");input.dispatchEvent(new Event("input",{bubbles:true}));});
 expect(el.querySelectorAll('button[aria-pressed]')).toHaveLength(1);
 await act(async()=>el.querySelector("img")!.dispatchEvent(new Event("error")));
 expect(el.textContent).toContain("预览不可用");
 await click("选择图片 图片 29");
 await click("取消");
 expect(onAdd).not.toHaveBeenCalled();
 await click("添加日常参考图");
 await render("dark");
 expect(el.querySelector<HTMLElement>('[role="group"]')?.style.scrollbarColor).toContain(canvasThemes.dark.node.code.scrollbar);
 await click("选择图片 图片 1");
 await render("dark",true);
 expect(el.querySelector('input')).toBeNull();
 expect(onAdd).not.toHaveBeenCalled();
});
