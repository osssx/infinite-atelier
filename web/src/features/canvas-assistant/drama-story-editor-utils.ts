export type StoryAssistMode="continue"|"rewrite"|"polish"|"selection";
export type StoryCandidateTarget={
 mode:StoryAssistMode;baseline:string;start:number;end:number;
};
export function createStoryTarget(mode:StoryAssistMode,baseline:string,start=baseline.length,end=start):StoryCandidateTarget{
 const from=Math.max(0,Math.min(baseline.length,Math.min(start,end)));
 const to=Math.max(0,Math.min(baseline.length,Math.max(start,end)));
 if(mode==="selection"&&from===to)throw Error("请先在故事正文中选中需要改写的片段");
 if(mode==="continue")return {mode,baseline,start:to,end:to};
 return {mode,baseline,start:mode==="selection"?from:0,end:mode==="selection"?to:baseline.length};
}
export function applyStoryCandidate(current:string,target:StoryCandidateTarget,candidate:string){
 if(current!==target.baseline)throw Error("故事正文已发生变化，候选已过期。请重新生成，避免覆盖当前修改");
 if(!candidate.trim())throw Error("AI 候选内容为空，无法采用");
 if(target.start<0||target.end>current.length||target.start>target.end)throw Error("候选定位已失效");
 const replacement=candidate.replace(/^\n+|\n+$/g,"");
 if(target.mode==="continue"){
  const left=current.slice(0,target.start),right=current.slice(target.end);
  const before=!left||left.endsWith("\n\n")?"":left.endsWith("\n")?"\n":"\n\n";
  const after=!right||right.startsWith("\n\n")?"":right.startsWith("\n")?"\n":"\n\n";
  return left+before+replacement+after+right;
 }
 return current.slice(0,target.start)+replacement+current.slice(target.end);
}
export function storyAssistRequest(target:StoryCandidateTarget,instruction:string){
 const source=target.baseline;
 const byteSize=(value:string)=>new TextEncoder().encode(value).length;
 const mode=target.mode;
 const selectedText=mode==="selection"?source.slice(target.start,target.end):"";
 const beforeText=mode==="selection"||mode==="continue"?source.slice(Math.max(0,target.start-1100),target.start):"";
 const afterText=mode==="selection"||mode==="continue"?source.slice(target.end,target.end+380):"";
 const sourceText=mode==="rewrite"||mode==="polish"?source:"";
 if(byteSize(sourceText)>16000)throw Error("全文超出单次 AI 上下文限制，请先选取局部段落改写");
 if(byteSize(selectedText)>12000)throw Error("选区过长，请缩小改写范围");
 if(byteSize(instruction)>2500)throw Error("补充写作要求过长");
 return {mode,sourceText,selectedText,beforeText,afterText,instruction};
}
