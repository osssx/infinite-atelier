import {createInterface} from "node:readline";
import {readFileSync} from "node:fs";

const groups=new Map();
const turns=new Map();
// Optional JSON file keyed by "channelId/model"; prices use the same
// currency per million input tokens for both ordinary and cached input.
const prices=process.argv[2]?JSON.parse(readFileSync(process.argv[2],"utf8")):{};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const duration=value=>Number.isFinite(value)&&value>=0;
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let sample;
 try{sample=JSON.parse(line)}catch{continue}
 if(sample?.event!=="assistant_prompt_usage"&&sample?.event!=="assistant_prompt_turn_usage")continue;
 const {provider,channelId,model,mode,kind,stablePromptPrefix,batchHistory,plainCanvasChat,inputTokens,
  cachedInputTokens,firstTokenMs,elapsedMs}=sample;
 const cohort={provider,channelId,model,mode,stablePromptPrefix,batchHistory,plainCanvasChat};
 if(sample.event==="assistant_prompt_turn_usage"){
  const key=JSON.stringify(cohort);
  const group=turns.get(key)??{...cohort,turns:0,fullyReportedTurns:0,inputTokens:0};
  group.turns++;
  if(sample.posts>0&&sample.posts===sample.inputReports&&count(inputTokens)){
   group.fullyReportedTurns++;
   group.inputTokens+=inputTokens;
  }
  turns.set(key,group);
  continue;
 }
 const inputBand=!count(inputTokens)?"unknown":inputTokens<1024?"<1024":inputTokens<4096?"1024–4095":">=4096";
 const dimensions={...cohort,kind,inputBand};
 const key=JSON.stringify(dimensions);
 let group=groups.get(key);
 if(!group){
  group={...dimensions,calls:0,inputReports:0,totalInputTokens:0,cacheReports:0,
   measuredInputTokens:0,cachedInputTokens:0,firstTokenTimes:[],elapsedTimes:[]};
  groups.set(key,group);
 }
 group.calls++;
 if(count(inputTokens)){
  group.inputReports++;
  group.totalInputTokens+=inputTokens;
  if(count(cachedInputTokens)&&cachedInputTokens<=inputTokens){
   group.cacheReports++;
   group.measuredInputTokens+=inputTokens;
   group.cachedInputTokens+=cachedInputTokens;
  }
 }
 if(duration(firstTokenMs))group.firstTokenTimes.push(firstTokenMs);
 if(duration(elapsedMs))group.elapsedTimes.push(elapsedMs);
}
const percentile=(values,fraction)=>values.length?
 Math.round(values.sort((left,right)=>left-right)[Math.ceil(values.length*fraction)-1]):null;
for(const group of groups.values()){
 const {firstTokenTimes,elapsedTimes,...counts}=group;
 const price=prices[group.channelId+"/"+group.model];
 const measuredInputCost=group.cacheReports&&duration(price?.inputPerMillion)&&duration(price?.cachedInputPerMillion)?
  ((group.measuredInputTokens-group.cachedInputTokens)*price.inputPerMillion+
   group.cachedInputTokens*price.cachedInputPerMillion)/1e6:null;
 process.stdout.write(JSON.stringify({event:"assistant_prompt_usage_report",...counts,
  cacheUsageCoverage:group.cacheReports/group.calls,
  cachedInputShare:group.measuredInputTokens?group.cachedInputTokens/group.measuredInputTokens:null,
  measuredInputCost,
  meanInputTokensPerPost:group.inputReports?group.totalInputTokens/group.inputReports:null,
  firstTokenSamples:firstTokenTimes.length,firstTokenP50Ms:percentile(firstTokenTimes,.5),
  elapsedP50Ms:percentile(elapsedTimes,.5)
 })+"\n");
}
for(const group of turns.values()){
 process.stdout.write(JSON.stringify({event:"assistant_prompt_turn_report",...group,
  meanInputTokensPerTurn:group.fullyReportedTurns?group.inputTokens/group.fullyReportedTurns:null
 })+"\n");
}
