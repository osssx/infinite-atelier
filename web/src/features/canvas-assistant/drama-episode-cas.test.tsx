// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {DramaEpisode} from "./drama-episode-fields";

const api=vi.hoisted(()=>({get:vi.fn(),data:[] as DramaEpisode[],digest:"b".repeat(64)}));
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:(...args:unknown[])=>api.get(...args)}));
import {DramaEpisodeFields} from "./drama-episode-fields";
const first:DramaEpisode={id:"ep-1",title:"森林相遇",synopsis:"开头",ending:"收尾",
 events:["兔子出现","小龟说话"],eventItems:[{id:"evt-1",text:"兔子出现"},{id:"evt-2",text:"小龟说话"}],
 targetDurationSec:120,sourceRefs:["source-1"],
 sequences:[{id:"seq-1",title:"森林入口",sourceRefs:["source-1"],eventRefs:["evt-1"]}]};
const second:DramaEpisode={id:"ep-2",title:"第二集",synopsis:"旅程",ending:"傍晚",events:[],
 sourceRefs:[],sequences:[]};
const roots:Root[]=[];
beforeEach(()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 api.data=[first,second].map(item=>structuredClone(item));
 api.get.mockReset();
 api.get.mockImplementation(async(path:string)=>{
  const url=new URL(path,"http://local");
  expect(url.searchParams.get("draft")).toBe("true");
  if(url.searchParams.has("entryId")){
   const id=url.searchParams.get("entryId");
   const episode=api.data.find(item=>item.id===id);
   return {total:episode?1:0,entries:episode?[structuredClone(episode)]:[],
    entryDigests:episode?[{id,digest:api.digest}]:[]};
  }
  const offset=Number(url.searchParams.get("offset")??0);
  const limit=Number(url.searchParams.get("limit")??10);
  return {total:api.data.length,entries:api.data.slice(offset,offset+limit).map(item=>structuredClone(item))};
 });
});
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;vi.unstubAllGlobals();document.body.replaceChildren();
});
async function mount({initial=api.data,initialEpisodeId="ep-1",reject=false,withWait=false}:{
 initial?:DramaEpisode[];initialEpisodeId?:string;reject?:boolean;withWait?:boolean
}={}){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const full=vi.fn<(episodes:DramaEpisode[])=>void>();
 const patch=vi.fn<(id:string,digest:string,changes:{title?:string;synopsis?:string;ending?:string},sequenceId?:string)=>Promise<void>>(
  async()=>{if(reject)throw Error("drama_candidate_conflict");});
 let updateLocal:(values:DramaEpisode[])=>void=()=>{};
 let latest=initial;
 const wait=vi.fn(async()=>{api.data=latest.map(item=>structuredClone(item));});
 function View(){
  const [episodes,setEpisodes]=useState(initial);
  updateLocal=setEpisodes;
  return <DramaEpisodeFields episodes={episodes} initialEpisodeId={initialEpisodeId} expanded disabled={false}
   projectId="project-1" nodeId="episodes-1"
   onPatchEpisode={async(id,digest,changes,sequenceId)=>{
    await patch(id,digest,changes,sequenceId);
    const next=api.data.map(episode=>{
     if(episode.id!==id)return episode;
     return sequenceId?{...episode,sequences:episode.sequences?.map(seq=>
      seq.id===sequenceId?{...seq,...changes}:seq)}:{...episode,...changes};
    });
    api.data=next;
    latest=next;
    setEpisodes(next);
   }}
   onReloadEpisode={async()=>{latest=api.data.map(item=>structuredClone(item));setEpisodes(latest);}}
   onWaitForDraftSave={withWait?wait:undefined}
   onChange={next=>{latest=next;full(next);setEpisodes(next);}}/>;
 }
 await act(async()=>{root.render(<View/>);await Promise.resolve();});
 return {container,full,patch,wait,updateLocal:async(next:DramaEpisode[])=>act(async()=>updateLocal(next))};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();
 await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function textInput(el:HTMLInputElement|HTMLTextAreaElement,value:string){
 await act(async()=>{
  const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
it("migrates a legacy draft only after matching the server, flushes once and refreshes the CAS digest",async()=>{
 const legacy={...first,eventItems:undefined,sequences:[{...first.sequences![0],eventRefs:["兔子出现"]}]};
 api.data=[legacy,second];
 const {container,full,patch,wait}=await mount({withWait:true});
 expect(full).toHaveBeenCalledTimes(1);
 expect(wait).toHaveBeenCalledTimes(1);
 const normalized=full.mock.lastCall![0][0];
 expect(normalized.eventItems).toHaveLength(2);
 expect(normalized.sequences?.[0].eventRefs).toEqual([normalized.eventItems![0].id]);
 expect(api.data[0]).toEqual(normalized);
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("精确保存");
 await click(container.querySelector('[aria-label="编辑集标题"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="集标题"]')!,"新标题");
 await click(container.querySelector('[aria-label="确认集标题"]'));
 expect(patch).toHaveBeenCalledWith("ep-1",api.digest,{title:"新标题"},undefined);
 expect(api.data[0].eventItems).toEqual(normalized.eventItems);
 expect(full).toHaveBeenCalledTimes(1);
});
it("never migrates a stale legacy draft over changed server data",async()=>{
 const legacy={...first,eventItems:undefined};
 api.data=[{...legacy,title:"远端更新"},second];
 const {container,full,wait,patch}=await mount({initial:[legacy,second],withWait:true});
 expect(full).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("服务器剧集内容已更新");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="编辑剧情事件（每行一条）"]')?.disabled).toBe(true);
});
it("patches only the current episode title with expectedDigest and preserves other episodes",async()=>{
 const {container,patch,full}=await mount();
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("精确保存");
 await click(container.querySelector('[aria-label="编辑集标题"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="集标题"]')!,"新的森林相遇");
 await click(container.querySelector('[aria-label="确认集标题"]'));
 expect(patch).toHaveBeenCalledWith("ep-1",api.digest,{title:"新的森林相遇"},undefined);
 expect(full).not.toHaveBeenCalled();
 expect(container.querySelector('[data-episode-readonly="title"]')?.textContent).toBe("新的森林相遇");
 expect(api.data[1].title).toBe("第二集");
});
it("saves synopsis and ending separately, but duration/events remain structural draft operations",async()=>{
 const {container,patch,full}=await mount();
 await click(container.querySelector('[aria-label="编辑剧情梗概"]'));
 await textInput(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!,"新梗概");
 await click(container.querySelector('[aria-label="确认剧情梗概"]'));
 expect(patch).toHaveBeenLastCalledWith("ep-1",api.digest,{synopsis:"新梗概"},undefined);
 await click(container.querySelector('[aria-label="编辑本集结尾"]'));
 await textInput(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="本集结尾"]')!,"新结尾");
 await click(container.querySelector('[aria-label="确认本集结尾"]'));
 expect(patch).toHaveBeenLastCalledWith("ep-1",api.digest,{ending:"新结尾"},undefined);
 await click(container.querySelector('[aria-label="编辑目标时长（秒）"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="目标时长（秒）"]')!,"240");
 await click(container.querySelector('[aria-label="确认目标时长（秒）"]'));
 expect(full).toHaveBeenCalledTimes(1);
 expect(full.mock.lastCall![0][0].targetDurationSec).toBe(240);
 expect(patch).toHaveBeenCalledTimes(2);
});
it("updates only a scene title by nested CAS, but keeps reference edits on structural path",async()=>{
 const {container,patch,full}=await mount();
 await click(container.querySelector('section[aria-label="场次规划"] details > summary'));
 await click(container.querySelector('[aria-label="编辑场次 1 详情"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="场次 1 名称"]')!,"新的森林入口");
 await click(container.querySelector('[aria-label="确认场次 1 详情"]'));
 expect(patch).toHaveBeenLastCalledWith("ep-1",api.digest,{title:"新的森林入口"},"seq-1");
 expect(full).not.toHaveBeenCalled();
 await click(container.querySelector('[aria-label="编辑场次 1 详情"]'));
 await textInput(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="场次 1 原文段落"]')!,"source-2");
 await click(container.querySelector('[aria-label="确认场次 1 详情"]'));
 expect(full).toHaveBeenCalledTimes(1);
 expect(full.mock.lastCall![0][0].sequences?.[0]?.sourceRefs).toEqual(["source-2"]);
 expect(patch).toHaveBeenCalledTimes(1);
});
it("keeps the editor open and preserves text after a conflicting CAS, supports reload",async()=>{
 const {container,patch,full}=await mount({reject:true});
 await click(container.querySelector('[aria-label="编辑集标题"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="集标题"]')!,"我的草案");
 await click(container.querySelector('[aria-label="确认集标题"]'));
 expect(patch).toHaveBeenCalledTimes(1);
 expect(container.querySelector<HTMLInputElement>('input[aria-label="集标题"]')?.value).toBe("我的草案");
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("冲突");
 expect(full).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(button=>button.textContent?.includes("重新加载剧集内容")));
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("精确保存");
});
it("blocks stale remote episode edits until explicitly reloading their current data",async()=>{
 api.data=[{...first,title:"远端更新"},second];
 const {container,patch}=await mount({initial:[first,second]});
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("服务器剧集内容已更新");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="编辑集标题"]')?.disabled).toBe(true);
 await click([...container.querySelectorAll("button")].find(button=>button.textContent?.includes("重新加载剧集内容")));
 expect(container.querySelector('[data-episode-readonly="title"]')?.textContent).toBe("远端更新");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="编辑集标题"]')?.disabled).toBe(false);
 expect(patch).not.toHaveBeenCalled();
});
it("flushes an episode structural edit before accepting its next single-entry CAS update",async()=>{
 const {container,patch,full,wait}=await mount({withWait:true});
 await click(container.querySelector('[aria-label="编辑目标时长（秒）"]'));
 await textInput(container.querySelector<HTMLInputElement>('input[aria-label="目标时长（秒）"]')!,"210");
 await click(container.querySelector('[aria-label="确认目标时长（秒）"]'));
 expect(full).toHaveBeenCalledTimes(1);
 expect(wait).toHaveBeenCalledTimes(1);
 expect(container.querySelector('[aria-label="当前剧集 CAS 状态"]')?.textContent).toContain("精确保存");
 await click(container.querySelector('[aria-label="编辑剧情梗概"]'));
 await textInput(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧情梗概"]')!,"新的剧情");
 await click(container.querySelector('[aria-label="确认剧情梗概"]'));
 expect(patch).toHaveBeenCalledWith("ep-1",api.digest,{synopsis:"新的剧情"},undefined);
 expect(full).toHaveBeenCalledTimes(1);
 expect(api.data[0].targetDurationSec).toBe(210);
 expect(api.data[0].synopsis).toBe("新的剧情");
});
it("keeps a newly added scene title on the structural draft path until its first save",async()=>{
 const {container,patch,full,wait}=await mount({withWait:true});
 await click([...container.querySelectorAll<HTMLButtonElement>('section[aria-label="场次规划"] button')]
  .find(el=>el.textContent?.includes("添加场次")));
 expect(full).toHaveBeenCalledTimes(1);
 expect(wait).toHaveBeenCalledTimes(1);
 const newId=full.mock.lastCall![0][0].sequences?.at(-1)?.id;
 expect(newId).toMatch(/^sequence_/);
 const scenes=container.querySelectorAll<HTMLDetailsElement>('section[aria-label="场次规划"] > details');
 const added=scenes[scenes.length-1];
 expect(added.querySelector('[data-episode-sequence-mode="editing"]')).toBeTruthy();
 await textInput(added.querySelector<HTMLInputElement>('input[aria-label^="场次"][aria-label$="名称"]')!,"下一场");
 await click(added.querySelector('[data-episode-action="confirm"]'));
 expect(full).toHaveBeenCalledTimes(2);
 expect(full.mock.lastCall![0][0].sequences?.at(-1)?.title).toBe("下一场");
 expect(patch).not.toHaveBeenCalled();
});
it("paginates 25 episodes with correct focus and never hides locally changed entries behind a stale server page",async()=>{
 const many=Array.from({length:25},(_,index)=>({...first,id:"ep-"+(index+1),
  title:"第 "+(index+1)+" 集",synopsis:"剧情 "+(index+1)}));
 api.data=many.map(item=>structuredClone(item));
 const {container,updateLocal}=await mount({initial:many,initialEpisodeId:"ep-17"});
 const nav=container.querySelector('[aria-label="剧集导航"]')!;
 expect(nav.querySelectorAll('button[aria-label^="选择第"]')).toHaveLength(10);
 expect(container.querySelector('[data-episode-scoped-directory]')?.textContent).toContain("11–20 / 25");
 expect(nav.querySelector('button[aria-label^="选择第 17 集"]')?.getAttribute("aria-pressed")).toBe("true");
 await updateLocal(many.map(item=>item.id==="ep-17"?{...item,title:"本地未保存的新标题"}:item));
 expect(nav.querySelector('button[aria-label^="选择第 17 集"]')?.textContent).toContain("本地未保存的新标题");
 await click([...container.querySelectorAll('[data-episode-scoped-directory] button')]
  .find(el=>el.textContent==="下一页"));
 expect(nav.querySelectorAll('button[aria-label^="选择第"]')).toHaveLength(5);
 expect(container.querySelector('[data-episode-scoped-directory]')?.textContent).toContain("21–25 / 25");
 // Simulate a new locally generated episode that has not reached the indexed page yet.
 await updateLocal([...many,{...first,id:"ep-26",title:"新加入的第 26 集"}]);
 expect(container.querySelector('[data-episode-scoped-directory]')?.textContent).toContain("21–26 / 26");
 expect(nav.querySelectorAll('button[aria-label^="选择第"]')).toHaveLength(6);
 expect(nav.querySelector('button[aria-label^="选择第 26 集"]')?.textContent).toContain("新加入的第 26 集");
});
