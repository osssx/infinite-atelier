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
 it("reads fields by default, keeps each edit local, saves only on confirm and preserves theme",async()=>{
  const {container,changes}=await mount("ep-b");
  const fieldset=container.querySelector<HTMLElement>('[data-episode-editor-layout="expanded"]')!;
  const active=()=>[...container.querySelectorAll<HTMLElement>('[aria-label="剧集导航"] button')]
   .find(el=>el.getAttribute("aria-pressed")==="true");
  expect(active()?.textContent).toContain("出发");
  for(const key of ["title","duration","synopsis","events","ending"]){
   expect(container.querySelector(`[data-episode-editable-field="${key}"][data-episode-field-mode="reading"]`)).toBeTruthy();
  }
  expect(container.querySelector('textarea[aria-label="剧情梗概"]')).toBeNull();
  await click(container.querySelector('[aria-label="编辑剧情梗概"]'));
  await enter(container,'textarea[aria-label="剧情梗概"]',"出发时下雨");
  expect(changes).not.toHaveBeenCalled();
  expect(container.querySelector('[data-episode-readonly="synopsis"]')).toBeNull();
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(fieldset.style.color).toBe(canvasThemes.light.node.text);
  expect((container.querySelector('[aria-label="剧情梗概"]') as HTMLTextAreaElement).value).toBe("出发时下雨");
  await click(container.querySelector('[aria-label="剧情梗概操作"] button:first-child'));
  expect(changes).not.toHaveBeenCalled();
  expect(container.querySelector('[data-episode-readonly="synopsis"]')?.textContent).toBe("第二天出发");
  await click(container.querySelector('[aria-label="编辑剧情梗概"]'));
  await enter(container,'textarea[aria-label="剧情梗概"]',"出发时下雨");
  await click(container.querySelector('[aria-label="确认剧情梗概"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0]).toEqual(original[0]);
  expect(changes.mock.lastCall?.[0][1].synopsis).toBe("出发时下雨");
  expect(container.querySelector('[data-episode-readonly="synopsis"]')?.textContent).toBe("出发时下雨");
  await act(async()=>useThemeStore.setState({theme:"dark"}));
  expect(fieldset.style.color).toBe(canvasThemes.dark.node.text);
 });
 it("distinguishes read-only cards from editing surfaces and uses themed, aligned primary/secondary actions",async()=>{
  const {container,changes}=await mount("ep-a");
  const field=container.querySelector<HTMLElement>('[data-episode-editable-field="synopsis"]')!;
  const reading=field.querySelector<HTMLElement>('[data-episode-readonly="synopsis"]')!;
  expect(reading.style.background).toBe(canvasThemes.dark.toolbar.activeBg);
  expect(reading.classList.contains("border-l-2")).toBe(true);
  expect(reading.classList.contains("border")).toBe(false);
  expect(changes).not.toHaveBeenCalled();
  await click(field.querySelector('[aria-label="编辑剧情梗概"]'));
  const editing=field.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!;
  const footer=field.querySelector<HTMLElement>('[data-episode-edit-actions]')!;
  const cancel=footer.querySelector<HTMLButtonElement>('[data-episode-action="cancel"]')!;
  const confirm=footer.querySelector<HTMLButtonElement>('[data-episode-action="confirm"]')!;
  expect(field.style.background).toBe(canvasThemes.dark.node.fill);
  expect(editing.style.background).toBe(canvasThemes.dark.node.panel);
  expect(editing.style.background).not.toBe(reading.style.background);
  expect(field.classList.contains("rounded-xl")).toBe(true);
  expect(field.textContent).toContain("编辑中");
  expect(footer.classList.contains("justify-end")).toBe(true);
  expect(footer.classList.contains("border-t")).toBe(false);
  expect(footer.classList.contains("pt-1")).toBe(true);
  expect(cancel.classList.contains("min-h-7")).toBe(true);
  expect(cancel.classList.contains("min-w-[68px]")).toBe(true);
  expect(confirm.classList.contains("min-w-[68px]")).toBe(true);
  expect(cancel.style.background).toBe(canvasThemes.dark.node.panel);
  expect(confirm.style.background).toBe(canvasThemes.dark.node.text);
  expect(confirm.getAttribute("aria-label")).toBe("确认剧情梗概");
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(field.style.background).toBe(canvasThemes.light.node.fill);
  expect(editing.style.background).toBe(canvasThemes.light.node.panel);
  expect(cancel.style.background).toBe(canvasThemes.light.node.panel);
  expect(confirm.style.background).toBe(canvasThemes.light.node.text);
  await click(cancel);
  expect(field.querySelector<HTMLElement>('[data-episode-readonly="synopsis"]')?.style.background)
   .toBe(canvasThemes.light.toolbar.activeBg);
  expect(changes).not.toHaveBeenCalled();
  await act(async()=>useThemeStore.setState({theme:"dark"}));
 });
 it("uses the same themed reading and action styles for scene details",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] details')!;
  await click(scene.querySelector("summary"));
  const area=scene.querySelector<HTMLElement>('[data-episode-sequence-mode="reading"]')!;
  const readonly=area.querySelector<HTMLElement>('[data-episode-sequence-readonly]')!;
  expect(readonly.style.background).toBe(canvasThemes.dark.toolbar.activeBg);
  expect(readonly.classList.contains("border-l-2")).toBe(true);
  await click(scene.querySelector('[aria-label="编辑场次 1 详情"]'));
  expect(area.dataset.episodeSequenceMode).toBe("editing");
  expect(area.style.background).toBe(canvasThemes.dark.node.fill);
  const editInput=area.querySelector<HTMLInputElement>('[aria-label="场次 1 名称"]')!;
  expect(editInput.style.background).toBe(canvasThemes.dark.node.panel);
  const footer=area.querySelector<HTMLElement>('[data-episode-edit-actions]')!;
  expect(footer?.getAttribute("aria-label")).toBe("场次 1 详情操作");
  expect(footer.querySelector('[data-episode-action="cancel"]')?.textContent).toContain("取消");
  expect(footer.querySelector('[data-episode-action="confirm"]')?.textContent).toContain("确认");
  expect(footer.classList.contains("border-t")).toBe(false);
  expect(footer.querySelector<HTMLButtonElement>('[data-episode-action="cancel"]')?.classList.contains("min-h-7")).toBe(true);
  expect(footer.querySelector<HTMLButtonElement>('[data-episode-action="confirm"]')?.classList.contains("min-w-[68px]")).toBe(true);
  await click(footer.querySelector('[data-episode-action="cancel"]'));
  expect(area.dataset.episodeSequenceMode).toBe("reading");
  expect(changes).not.toHaveBeenCalled();
 });
 it("commits title and duration independently, rejects invalid duration, and cancels without a write",async()=>{
  const {container,changes}=await mount("ep-a");
  expect(container.querySelector('[aria-label="集标题"]')).toBeNull();
  expect(container.querySelector('[data-episode-readonly="title"]')?.textContent).toBe("相遇");
  expect(container.querySelector('[data-episode-readonly="duration"]')?.textContent).toBe("120");
  await click(container.querySelector('[aria-label="编辑集标题"]'));
  await click(container.querySelector('[aria-label="编辑目标时长（秒）"]'));
  await enter(container,'input[aria-label="集标题"]',"新的相遇");
  await enter(container,'input[aria-label="目标时长（秒）"]',"-5");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="确认目标时长（秒）"]')?.disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
  await click(container.querySelector('[aria-label="确认集标题"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].title).toBe("新的相遇");
  expect(changes.mock.lastCall?.[0][0].targetDurationSec).toBe(120);
  expect((container.querySelector('[aria-label="目标时长（秒）"]') as HTMLInputElement).value).toBe("-5");
  await click(container.querySelector('[aria-label="目标时长（秒）操作"] button:first-child'));
  expect(changes).toHaveBeenCalledTimes(1);
  await click(container.querySelector('[aria-label="编辑目标时长（秒）"]'));
  await enter(container,'input[aria-label="目标时长（秒）"]',"180.5");
  await click(container.querySelector('[aria-label="确认目标时长（秒）"]'));
  expect(changes).toHaveBeenCalledTimes(2);
  expect(changes.mock.lastCall?.[0][0].targetDurationSec).toBe(180.5);
  expect(changes.mock.lastCall?.[0][0].title).toBe("新的相遇");
 });
 it("commits event lines only on confirm and preserves stable event and scene references",async()=>{
  const {container,changes}=await mount("ep-a");
  const field=container.querySelector<HTMLElement>('[data-episode-editable-field="events"]')!;
  expect(field.dataset.episodeFieldMode).toBe("reading");
  expect(field.querySelectorAll('ol > li')).toHaveLength(2);
  await click(field.querySelector('[aria-label="编辑剧情事件（每行一条）"]'));
  await enter(container,'[aria-label="剧情事件"]',"兔子来了\n乌龟来了\n狐狸出现");
  expect(changes).not.toHaveBeenCalled();
  await click(field.querySelector('[aria-label="剧情事件（每行一条）操作"] button:first-child'));
  expect(changes).not.toHaveBeenCalled();
  expect(field.querySelectorAll('ol > li')).toHaveLength(2);
  await click(field.querySelector('[aria-label="编辑剧情事件（每行一条）"]'));
  await enter(container,'[aria-label="剧情事件"]',"兔子来了\n乌龟来了\n狐狸出现");
  await click(field.querySelector('[aria-label="确认剧情事件（每行一条）"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  const first=changes.mock.lastCall?.[0][0] as DramaEpisode;
  expect(first.events).toEqual(["兔子来了","乌龟来了","狐狸出现"]);
  expect(first.eventItems?.[0].id).toBe("event-1");
  expect(first.eventItems?.[1].id).toBe("event-2");
  expect(first.sequences?.[0].eventRefs).toEqual(["event-1"]);
  expect(first.sourceRefs).toEqual(["story-1"]);
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
  expect(field.querySelectorAll('ol > li')).toHaveLength(3);
 });
 it("keeps ending edits uncommitted until confirmation and clears them when switching episodes",async()=>{
  const {container,changes}=await mount("ep-a");
  await click(container.querySelector('[aria-label="编辑本集结尾"]'));
  await enter(container,'[aria-label="本集结尾"]',"全新的结尾");
  expect(changes).not.toHaveBeenCalled();
  await click(container.querySelector('[aria-label^="选择第 2 集"]'));
  expect(container.querySelector('[data-episode-readonly="ending"]')?.textContent).toBe("天黑");
  expect(container.querySelector('[aria-label="本集结尾"]')).toBeNull();
  await click(container.querySelector('[aria-label^="选择第 1 集"]'));
  expect(container.querySelector('[data-episode-readonly="ending"]')?.textContent).toBe("两人见面");
  expect(changes).not.toHaveBeenCalled();
  await click(container.querySelector('[aria-label="编辑本集结尾"]'));
  await enter(container,'[aria-label="本集结尾"]',"新的结尾");
  await click(container.querySelector('[aria-label="确认本集结尾"]'));
  expect(changes.mock.lastCall?.[0][0].ending).toBe("新的结尾");
 });
 it("stages scene name, paragraph refs, and event links together; cancel never writes",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] details')!;
  await click(scene.querySelector("summary"));
  await click(scene.querySelector('[aria-label="编辑场次 1 详情"]'));
  await enter(container,'[aria-label="场次 1 名称"]',"河畔");
  await enter(container,'[aria-label="场次 1 原文段落"]',"story-3\nstory-4");
  const boxes=[...scene.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes).toHaveLength(2);
  await act(async()=>{boxes[1].click();});
  expect(changes).not.toHaveBeenCalled();
  await click([...scene.querySelectorAll('[aria-label="场次 1 详情"] button')].find(button=>button.textContent?.trim()==="取消")??null);
  expect(changes).not.toHaveBeenCalled();
  expect(scene.querySelector('[data-episode-sequence-mode="reading"]')?.textContent).toContain("森林入口");
  await click(scene.querySelector('[aria-label="编辑场次 1 详情"]'));
  await enter(container,'[aria-label="场次 1 名称"]',"河畔");
  await enter(container,'[aria-label="场次 1 原文段落"]',"story-3\nstory-4");
  await act(async()=>{(scene.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!).click();});
  await click(scene.querySelector('[aria-label="确认场次 1 详情"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].sequences?.[0]).toMatchObject({
   id:"scene-1",title:"河畔",sourceRefs:["story-3","story-4"],eventRefs:["event-1","event-2"]
  });
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
 });
 it("keeps scene title, split, refs and add-scene actions accessible in a collapsed section",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] details')!;
  expect(scene.open).toBe(false);
  await click(scene.querySelector("summary"));
  expect(scene.open).toBe(true);
  expect(scene.querySelector('[data-episode-sequence-mode="reading"]')).toBeTruthy();
  expect(scene.querySelector('input[aria-label="场次 1 名称"]')).toBeNull();
  await click(scene.querySelector('[aria-label="编辑场次 1 详情"]'));
  await enter(container,'[aria-label="场次 1 名称"]',"新的森林入口");
  expect(changes).not.toHaveBeenCalled();
  await click(scene.querySelector('[aria-label="确认场次 1 详情"]'));
  expect(changes.mock.lastCall?.[0][0].sequences?.[0].title).toBe("新的森林入口");
  expect(changes.mock.lastCall?.[0][0].sequences?.[0].eventRefs).toEqual(["event-1"]);
  const split=[...scene.querySelectorAll("button")].find(el=>el.textContent?.includes("拆成两场"))!;
  await click(split);
  expect(changes.mock.lastCall?.[0][0].sequences?.length).toBe(2);
  const add=[...container.querySelectorAll('section[aria-label="场次规划"] button')].find(el=>el.textContent?.includes("添加场次"))!;
  await click(add);
  expect(changes.mock.lastCall?.[0][0].sequences?.length).toBe(3);
  expect(container.querySelector('[aria-label="剧集原文段落 ID"]')).toBeNull();
  expect(container.textContent).not.toContain("原文出处");
  expect(changes.mock.lastCall?.[0][0].sourceRefs).toEqual(["story-1"]);
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
 });
 it("adds an immediately expanded sequence with a stable unique ID and editable fields",async()=>{
  const {container,changes}=await mount("ep-a");
  const add=[...container.querySelectorAll<HTMLButtonElement>('section[aria-label="场次规划"] button')]
   .find(el=>el.textContent?.includes("添加场次"))!;
  await click(add);
  const current=changes.mock.lastCall?.[0][0]!;
  expect(current.sequences).toHaveLength(2);
  const added=current.sequences![1];
  expect(added.id).toMatch(/^sequence_[\w-]+$/);
  expect(added.id).not.toBe("scene-1");
  expect(added.title).toBe("新场次 2");
  expect(added.sourceRefs).toEqual([]);
  expect(added.eventRefs).toEqual([]);
  expect(current.sourceRefs).toEqual(["story-1"]);
  const last=container.querySelectorAll<HTMLDetailsElement>('section[aria-label="场次规划"] > details')[1]!;
  expect(last.open).toBe(true);
  expect(last.querySelector('[data-episode-sequence-mode="editing"]')).toBeTruthy();
  await enter(container,'[aria-label="场次 2 名称"]',"河边的约定");
  expect(changes.mock.lastCall?.[0][0].sequences?.[1].title).toBe("新场次 2");
  await click(last.querySelector('[aria-label="确认场次 2 详情"]'));
  expect(changes.mock.lastCall?.[0][0].sequences?.[1].title).toBe("河边的约定");
  expect(changes.mock.lastCall?.[0][0].sequences?.[0]).toEqual(original[0].sequences![0]);
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
 });
 it("requires themed confirmation before deleting, preserves event and story refs, and lets users cancel",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] > details')!;
  await click(scene.querySelector("summary"));
  const trigger=scene.querySelector<HTMLButtonElement>('button[aria-label^="删除场次 1"]')!;
  await click(trigger);
  const confirm=container.querySelector<HTMLElement>('[role="alertdialog"][aria-label="确认删除场次 1"]')!;
  expect(confirm).toBeTruthy();
  expect(confirm.textContent).toContain("1 项事件关联");
  expect(confirm.textContent).toContain("不会被自动修改");
  expect(changes).not.toHaveBeenCalled();
  await click([...confirm.querySelectorAll("button")].find(el=>el.textContent==="取消")!);
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  await click(trigger);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="确认删除场次 1"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  const [first,second]=changes.mock.lastCall![0];
  expect(first.sequences).toEqual([]);
  expect(first.sourceRefs).toEqual(["story-1"]);
  expect(first.events).toEqual(original[0].events);
  expect(first.eventItems).toEqual(original[0].eventItems);
  expect(second).toEqual(original[1]);
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
 });
 it("clears the delete confirmation when switching to another episode",async()=>{
  const {container,changes}=await mount("ep-a");
  const scene=container.querySelector<HTMLDetailsElement>('section[aria-label="场次规划"] > details')!;
  await click(scene.querySelector("summary"));
  await click(scene.querySelector<HTMLButtonElement>('button[aria-label^="删除场次 1"]'));
  expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
  await click(container.querySelector<HTMLButtonElement>('[aria-label^="选择第 2 集"]'));
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(changes).not.toHaveBeenCalled();
 });
});
