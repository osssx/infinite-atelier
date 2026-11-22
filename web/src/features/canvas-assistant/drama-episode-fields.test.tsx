// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {DramaEpisodeFields,type DramaEpisode} from "./drama-episode-fields";

const original:DramaEpisode[]=[
 {id:"ep-a",title:"相遇",synopsis:"森林第一天",events:["兔子来了","乌龟来了"],
  eventItems:[{id:"event-1",text:"兔子来了"},{id:"event-2",text:"乌龟来了"}],
  sourceRefs:["story-1"],ending:"两人见面",targetDurationSec:120,
  sequences:[{id:"scene-1",title:"森林入口",sourceRefs:["story-1"],eventRefs:["event-1"]}]},
 {id:"ep-b",title:"出发",synopsis:"第二天出发",events:["两人出发"],
  sourceRefs:["story-2"],ending:"天黑",sequences:[]}
];
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const x of roots)await act(async()=>x.unmount());roots.length=0;vi.unstubAllGlobals()});
async function mount(initialEpisodeId?:string){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const changes=vi.fn<(episodes:DramaEpisode[])=>void>();
 function Editor(){
  const [episodes,setEpisodes]=useState<DramaEpisode[]>(original);
  return <div style={{height:640,width:1100}}>
   <DramaEpisodeFields episodes={episodes} initialEpisodeId={initialEpisodeId}
    expanded disabled={false} onChange={next=>{changes(next);setEpisodes(next)}}/>
  </div>;
 }
 await act(async()=>root.render(<Editor/>));
 return {container,changes};
}
async function enter(container:HTMLElement,selector:string,value:string){
 const input=container.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;
 expect(input).toBeTruthy();
 await act(async()=>{
  const setter=Object.getOwnPropertyDescriptor(input.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!;
  setter.call(input,value);
  input.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
async function click(button:Element|null){
 expect(button).toBeTruthy();
 await act(async()=>{(button as HTMLElement).click();});
}
describe("maximized episode planning layout",()=>{
 it("isolates current episode editing, preserves other episode and updates theme without data loss",async()=>{
  const {container,changes}=await mount("ep-b");
  const fieldset=container.querySelector<HTMLElement>('[data-episode-editor-layout="expanded"]')!;
  const active=()=>[...container.querySelectorAll<HTMLElement>('[aria-label="剧集导航"] button')].find(el=>el.getAttribute("aria-pressed")==="true");
  expect(active()?.textContent).toContain("出发");
  expect(container.querySelector('[aria-label="当前剧集编辑区"]')).toBeTruthy();
  await enter(container,'[aria-label="剧情梗概"]',"出发时下雨");
  expect(changes).toHaveBeenCalled();
  expect(changes.mock.lastCall?.[0][0]).toEqual(original[0]);
  expect(changes.mock.lastCall?.[0][1].synopsis).toBe("出发时下雨");
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(fieldset.style.color).toBe(canvasThemes.light.node.text);
  expect((container.querySelector('[aria-label="剧情梗概"]') as HTMLTextAreaElement).value).toBe("出发时下雨");
  await act(async()=>useThemeStore.setState({theme:"dark"}));
  expect(fieldset.style.color).toBe(canvasThemes.dark.node.text);
 });
 it("keeps scene title, split, refs and add-scene actions accessible in a collapsed section",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] details')!;
  expect(scene.open).toBe(false);
  await click(scene.querySelector("summary"));
  expect(scene.open).toBe(true);
  await enter(container,'[aria-label="场次 1 名称"]',"新的森林入口");
  expect(changes.mock.lastCall?.[0][0].sequences?.[0].title).toBe("新的森林入口");
  expect(changes.mock.lastCall?.[0][0].sequences?.[0].eventRefs).toEqual(["event-1"]);
  const split=[...scene.querySelectorAll("button")].find(el=>el.textContent?.includes("拆成两场"))!;
  await click(split);
  expect(changes.mock.lastCall?.[0][0].sequences?.length).toBe(2);
  const add=[...container.querySelectorAll('section[aria-label="场次规划"] button')].find(el=>el.textContent?.includes("添加场次"))!;
  await click(add);
  expect(changes.mock.lastCall?.[0][0].sequences?.length).toBe(3);
  const source=container.querySelector<HTMLDetailsElement>('[aria-label="当前剧集编辑区"] > details:last-child');
  expect(source?.textContent).toContain("原文出处");
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
 });
});
