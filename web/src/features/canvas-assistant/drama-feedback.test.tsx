// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import {DramaFeedbackNotices,DramaTaskStatus,useDramaFeedbackController,describeDramaFeedbackError,dramaRunStatus} from "./drama-feedback";

it("keeps errors until resolved, deduplicates polling notices, expires and caps transient notices",async()=>{
 vi.useFakeTimers();
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);
 let controller!:ReturnType<typeof useDramaFeedbackController>;
 function Host(){
  controller=useDramaFeedbackController();
  return <><DramaFeedbackNotices notices={controller.notices} clear={controller.clear} theme={canvasThemes.dark}/>
   {controller.context.task&&<DramaTaskStatus task={controller.context.task} theme={canvasThemes.dark}/>}</>;
 }
 try{
  await act(async()=>root.render(<Host/>));
  const api=controller.context.api;
  await act(async()=>{
   api.notify("poll","error","读取失败","technical");
   api.notify("poll","error","读取失败","technical");
   for(let i=0;i<4;i++)api.notify("success:"+i,"success","成功 "+i);
  });
  expect(div.querySelectorAll('[data-drama-feedback="error"]')).toHaveLength(1);
  expect(div.querySelectorAll('[data-drama-feedback="success"]')).toHaveLength(3);
  expect(div.textContent).not.toContain("成功 0");
  await act(async()=>vi.advanceTimersByTime(2001));
  expect(div.querySelector('[data-drama-feedback="success"]')).toBeNull();
  expect(div.querySelector('[data-drama-feedback="error"]')).toBeTruthy();
  await act(async()=>api.clear("poll"));
  expect(div.querySelector('[data-drama-feedback="error"]')).toBeNull();
  let task!:NonNullable<ReturnType<typeof api.beginTask>>;
  await act(async()=>{task=api.beginTask("正在生成分镜","第一集")!;task.phase("模型生成与校验")});
  expect(api.beginTask("重复生成")).toBeNull();
  expect(div.textContent).toContain("第一集 · 模型生成与校验");
  await act(async()=>vi.advanceTimersByTime(3000));
  expect(div.textContent).toContain("00:03");
  await act(async()=>task.end());
  expect(div.querySelector("[data-drama-task-status]")).toBeNull();
  await act(async()=>api.notify("last","info","离开"));
 }finally{
  await act(async()=>root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  div.remove();vi.useRealTimers();vi.unstubAllGlobals();
 }
});

it("maps known failures and leaves unknown diagnostics available",()=>{
 expect(describeDramaFeedbackError("drama_candidate_invalid","失败")).toMatchObject({title:expect.stringContaining("校验"),detail:"drama_candidate_invalid"});
 expect(describeDramaFeedbackError(new Error("unknown"),"生成失败")).toEqual({title:"生成失败",detail:"unknown"});
 expect(["running","ready","adopted","failed","cancelled","interrupted","unexpected"].map(dramaRunStatus)).toEqual(["生成中","待采用","已采用","生成失败","已取消","已中断","未知状态"]);
});
