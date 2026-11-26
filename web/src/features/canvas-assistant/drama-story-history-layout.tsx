import {createContext,useCallback,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import type {CanvasTheme} from "@/lib/canvas-theme";

type StoryHistoryLayoutState={setReviewing:(active:boolean)=>void;wideReview:boolean};
export const DramaStoryHistoryLayoutContext=createContext<StoryHistoryLayoutState|null>(null);

/** Keep both panes mounted: changing the responsive view or reviewing a source
 * must not discard version selection or create another writable source controller. */
export function DramaStoryHistoryLayout({source,history,theme,locked}:{source:ReactNode;history:ReactNode;theme:CanvasTheme;locked:boolean}){
 const root=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null);
 const sourceScroll=useRef(0),restoreScroll=useRef(false);
 const [width,setWidth]=useState(0),[view,setView]=useState<"source"|"history">("source");
 const [reviewing,setReviewingState]=useState(false);
 const wide=width>=1100;
 useLayoutEffect(()=>{
  const element=root.current;if(!element)return;
  const measure=()=>setWidth(element.clientWidth);
  measure();
  if(typeof ResizeObserver!=="undefined"){
   const observer=new ResizeObserver(measure);observer.observe(element);return ()=>observer.disconnect();
  }
  window.addEventListener("resize",measure);return ()=>window.removeEventListener("resize",measure);
 },[]);
 const setReviewing=useCallback((active:boolean)=>{
  if(active){sourceScroll.current=scroll.current?.scrollTop??0;setView("source");}
  else restoreScroll.current=true;
  setReviewingState(active);
 },[]);
 useLayoutEffect(()=>{
  if(!reviewing&&restoreScroll.current&&scroll.current){scroll.current.scrollTop=sourceScroll.current;restoreScroll.current=false;}
 },[reviewing]);
 const showSource=reviewing||wide||view==="source",showHistory=!reviewing&&(wide||view==="history");
 return <div ref={root} data-drama-story-history-layout="" data-history-view={reviewing?"review":wide?"split":view}
  className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
  {!wide&&!reviewing&&<div role="group" aria-label="影响与历史视图" className="flex shrink-0 gap-1 rounded-lg border p-1" style={{borderColor:theme.node.stroke,background:theme.node.panel}}>
   {(["source","history"] as const).map(item=><button key={item} type="button" aria-pressed={view===item}
    disabled={locked} className="min-h-8 flex-1 rounded-md px-2 text-xs font-medium disabled:opacity-40"
    style={{background:view===item?theme.toolbar.activeBg:"transparent",color:view===item?theme.toolbar.activeText:theme.node.muted}}
    onClick={()=>setView(item)}>{item==="source"?"来源与影响":"历史版本"}</button>)}
  </div>}
  <div data-drama-history-layout="" className="grid min-h-0 min-w-0 flex-1 gap-3"
   style={{gridTemplateColumns:wide&&!reviewing?"clamp(360px,35%,440px) minmax(0,1fr)":"minmax(0,1fr)",gridTemplateRows:"minmax(0,1fr)"}}>
   <section aria-label="来源与下游影响面板" className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{display:showSource?undefined:"none"}}>
    {!reviewing&&<h3 className="mb-2 shrink-0 px-1 text-sm font-semibold">来源与下游影响</h3>}
    <div ref={scroll} data-drama-impact-scroll="" className={reviewing?"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden":"thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"}
     style={{scrollbarGutter:"auto"}}>
     <DramaStoryHistoryLayoutContext.Provider value={{setReviewing,wideReview:width>=740}}>{source}</DramaStoryHistoryLayoutContext.Provider>
    </div>
   </section>
   <section aria-label="历史版本面板" className="flex min-h-0 min-w-0 flex-col gap-2" style={{display:showHistory?undefined:"none"}}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
     <h3 className="text-sm font-semibold">历史版本</h3>
     <span className="text-[11px]" style={{color:theme.node.muted}}>可查看、保存或恢复创作内容快照</span>
    </div>
    <div data-drama-history-fill="" className="min-h-0 min-w-0 flex-1">{history}</div>
   </section>
  </div>
 </div>;
}
