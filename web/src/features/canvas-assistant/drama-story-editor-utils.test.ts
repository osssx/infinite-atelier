import {describe,expect,it} from "vitest";
import {applyStoryCandidate,createStoryTarget,storyAssistRequest,storyTargetForOperation,storyCandidateComparison} from "./drama-story-editor-utils";
describe("story AI edit target and acceptance",()=>{
 it("replaces only the original selection while preserving its neighbors",()=>{
  const story="开头\n她推开门\n结尾";
  const from=story.indexOf("她"),to=from+"她推开门".length;
  const target=createStoryTarget("selection",story,from,to);
  expect(applyStoryCandidate(story,target,"她缓缓推开沉重的门")).toBe("开头\n她缓缓推开沉重的门\n结尾");
  const request=storyAssistRequest(target,"保持悬疑");
  expect(request.selectedText).toBe("她推开门");
  expect(request.beforeText).toContain("开头");
  expect(request.afterText).toContain("结尾");
  expect(request.sourceText).toBe("");
 });
 it("refuses a stale baseline even when the same selection exists elsewhere",()=>{
  const target=createStoryTarget("selection","镜头A\n重复\n结尾",4,6);
  expect(()=>applyStoryCandidate("镜头A\n重复\n结尾！",target,"候选")).toThrow(/过期/);
  expect(()=>createStoryTarget("selection","无选区",2,2)).toThrow(/选中/);
 });
 it("continuation inserts after cursor or at end without deleting nearby text",()=>{
  const story="第一段\n第三段";
  const where=story.indexOf("第三段");
  const target=createStoryTarget("continue",story,where);
  const output=applyStoryCandidate(story,target,"第二段");
  expect(output).toBe("第一段\n\n第二段\n\n第三段");
  expect(applyStoryCandidate("尾声",createStoryTarget("continue","尾声"),"终章")).toBe("尾声\n\n终章");
 });
 it("full rewrite and polish replace complete story only after acceptance",()=>{
  const raw="原始文字";
  expect(applyStoryCandidate(raw,createStoryTarget("rewrite",raw),"新故事")).toBe("新故事");
  expect(applyStoryCandidate(raw,createStoryTarget("polish",raw),"润色后的故事")).toBe("润色后的故事");
  expect(()=>applyStoryCandidate(raw,createStoryTarget("rewrite",raw),"  ")).toThrow(/为空/);
 });
 it("maps explicit scopes to exact targets and a separate selected polish mode",()=>{
  const raw="开场\n旧段落\n结局";
  const scoped=storyTargetForOperation("polish",raw,{start:3,end:6},"end");
  expect(scoped.mode).toBe("selection-polish");
  expect(storyCandidateComparison(scoped)).toEqual({kind:"replace",original:"旧段落"});
  expect(storyAssistRequest(scoped,"")).toMatchObject({mode:"selection-polish",selectedText:"旧段落",sourceText:""});
  expect(applyStoryCandidate(raw,scoped,"新段落")).toBe("开场\n新段落\n结局");
  expect(storyTargetForOperation("continue",raw,{start:3,end:3},"cursor").start).toBe(3);
  expect(storyTargetForOperation("continue",raw,{start:3,end:6},"end").start).toBe(raw.length);
  expect(()=>storyTargetForOperation("continue",raw,null,"cursor")).toThrow(/定位/);
  expect(()=>storyAssistRequest(createStoryTarget("continue","    "),"")).toThrow(/起始/);
  expect(()=>storyAssistRequest(createStoryTarget("continue"," ".repeat(5000)+"结束",0),"")).toThrow(/附近/);
 });
 it("rejects overly long full stories and selections without truncating user's text",()=>{
  expect(()=>storyAssistRequest(createStoryTarget("rewrite","中文".repeat(5000)),"")).toThrow(/限制/);
  expect(()=>storyAssistRequest(createStoryTarget("selection","字".repeat(5000),0,5000),"")).toThrow(/选区过长/);
 });
});
