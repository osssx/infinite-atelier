export type StoryAssistMode="continue"|"rewrite"|"polish"|"selection"|"selection-polish";
export type StoryAssistOperation="continue"|"rewrite"|"polish";
export type StoryContinuationScope="cursor"|"end";
export type StorySelection={start:number;end:number};
export type StoryCandidateTarget={
 mode:StoryAssistMode;baseline:string;start:number;end:number;
};
export const storyAssistLabels:Record<StoryAssistMode,string>={continue:"AI 续写",rewrite:"全文改写",polish:"全文润色",
 selection:"改写选中内容","selection-polish":"润色选中内容"};
const isSelection=(mode:StoryAssistMode)=>mode==="selection"||mode==="selection-polish";
export function createStoryTarget(mode:StoryAssistMode,baseline:string,start=baseline.length,end=start):StoryCandidateTarget{
 if(!Number.isInteger(start)||!Number.isInteger(end))throw Error("故事定位无效，请重新选择");
 const from=Math.max(0,Math.min(baseline.length,Math.min(start,end)));
 const to=Math.max(0,Math.min(baseline.length,Math.max(start,end)));
 if(isSelection(mode)&&from===to)throw Error("请先在故事正文中选中需要处理的片段");
 if(mode==="continue")return {mode,baseline,start:to,end:to};
 return {mode,baseline,start:isSelection(mode)?from:0,end:isSelection(mode)?to:baseline.length};
}
/** Explicit cursor scope uses the last textarea selection, including a collapsed caret. */
export function storyTargetForOperation(operation:StoryAssistOperation,baseline:string,selection:StorySelection|null,scope:StoryContinuationScope){
 if(operation==="continue"){
  if(scope==="cursor"&&!selection)throw Error("请先点击正文定位光标或选中片段");
  return createStoryTarget("continue",baseline,scope==="cursor"?selection!.end:baseline.length);
 }
 if(selection&&selection.start!==selection.end&&baseline.slice(selection.start,selection.end).trim()==="")
  throw Error("选区没有可处理的文字，请重新选择");
 return selection&&selection.start!==selection.end?
  createStoryTarget(operation==="polish"?"selection-polish":"selection",baseline,selection.start,selection.end):
  createStoryTarget(operation,baseline);
}
export function storyTargetLabel(target:StoryCandidateTarget,scope?:StoryContinuationScope){
 if(target.mode==="continue")return scope==="end"||scope===undefined&&target.start===target.baseline.length?
  "文末续写":`在第 ${target.start} 个字符后插入`;
 if(isSelection(target.mode))return `选区 · 第 ${target.start+1}–${target.end} 个字符（${target.end-target.start} 字符）`;
 return `全文 · ${target.baseline.length} 字符`;
}
/** Bounded context is enough to show insertion coordinates without copying the full story. */
export function storyCandidateComparison(target:StoryCandidateTarget){
 return target.mode==="continue"?{kind:"insert" as const,
  before:target.baseline.slice(Math.max(0,target.start-280),target.start),
  after:target.baseline.slice(target.end,target.end+280),
  truncatedBefore:target.start>280,truncatedAfter:target.baseline.length-target.end>280}:
  {kind:"replace" as const,original:target.baseline.slice(target.start,target.end)};
}
export function applyStoryCandidate(current:string,target:StoryCandidateTarget,candidate:string){
 if(current!==target.baseline)throw Error("故事正文已发生变化，候选已过期。请重新生成，避免覆盖当前修改");
 if(!candidate.trim())throw Error("AI 候选内容为空，无法采用");
 if(!Number.isInteger(target.start)||!Number.isInteger(target.end)||target.start<0||target.end>current.length||target.start>target.end)
  throw Error("候选定位已失效");
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
 const scoped=isSelection(mode);
 const selectedText=scoped?source.slice(target.start,target.end):"";
 const beforeText=scoped||mode==="continue"?source.slice(Math.max(0,target.start-1100),target.start):"";
 const afterText=scoped||mode==="continue"?source.slice(target.end,target.end+380):"";
 const sourceText=mode==="rewrite"||mode==="polish"?source:"";
 if(!source.trim())throw Error("请先输入故事起始文字");
 if(scoped&&!selectedText.trim())throw Error("请先在正文中选中需要处理的片段");
 if(mode==="continue"&&!beforeText.trim()&&!afterText.trim())throw Error("续写位置附近没有有效文字，请重新定位");
 if(byteSize(sourceText)>16000)throw Error("全文超出单次 AI 上下文限制，请先选取局部段落改写");
 if(byteSize(selectedText)>12000)throw Error("选区过长，请缩小改写范围");
 if(byteSize(instruction)>2500)throw Error("补充写作要求过长");
 return {mode,sourceText,selectedText,beforeText,afterText,instruction};
}
