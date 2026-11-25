import {describe,expect,it} from "vitest";
import {candidateRevision,hasEpisodeDetails,mergeCandidateRuns,type DramaRun} from "./drama-episode-candidate-state";
const episode={id:"episode",title:"一集",synopsis:"内容",events:[],ending:"结尾",sourceRefs:[]};
const detail=(revision:number,title:string):DramaRun=>({id:"run",episodeId:"*",status:"ready",candidate:{revision,episodes:[{...episode,title}]}});
const summary=(revision:number):DramaRun=>({id:"run",episodeId:"*",status:"ready",candidate:{revision,episodeCount:1,episodes:[]}});
describe("episode candidate detail version fence",()=>{
 it("reuses loaded detail only at the exact revision, never just the same count",()=>{
  const loaded=detail(2,"人工修改");
  expect(mergeCandidateRuns([loaded],[summary(2)])[0].candidate?.episodes?.[0].title).toBe("人工修改");
  expect(mergeCandidateRuns([loaded],[summary(1)])[0]).toEqual(loaded);
  expect(hasEpisodeDetails(mergeCandidateRuns([loaded],[summary(3)])[0])).toBe(false);
  expect(candidateRevision(mergeCandidateRuns([loaded],[summary(3)])[0])).toBe(3);
 });
 it("retains the editing snapshot against newer or removed results until the edit is resolved",()=>{
  const loaded=detail(2,"人工修改");
  expect(mergeCandidateRuns([loaded],[summary(3)],"run")).toEqual([loaded]);
  expect(mergeCandidateRuns([loaded],[],"run")).toEqual([loaded]);
  expect(mergeCandidateRuns([loaded],[])).toEqual([]);
  expect(mergeCandidateRuns([loaded],[{...summary(3),status:"discarded"}])).toEqual([]);
 });
 it("recognizes a legacy candidate as revision zero and leaves storyboard cache behavior intact",()=>{
  const legacy=detail(0,"旧数据");delete legacy.candidate!.revision;
  expect(candidateRevision(legacy)).toBe(0);
  expect(mergeCandidateRuns([legacy],[summary(0)])[0].candidate?.episodes).toEqual(legacy.candidate?.episodes);
  const run:DramaRun={id:"shot",episodeId:"ep",status:"ready",candidate:{shots:[{id:"s",description:"镜头"}]}};
  expect(mergeCandidateRuns([run],[{...run,candidate:{shots:[],shotCount:1}}])[0].candidate?.shots).toEqual(run.candidate?.shots);
 });
});
