/** P4.1b: a strictly opt-in, single-Turn reference choice; no model calls here. */
export type AssistantCreativeKind="story"|"scene"|"style";
export type AssistantCreativeMaterial={
 kind:AssistantCreativeKind;
 title:string;
 sourceLabel:string;
 sourceRef:string;
 sourceDigest:string;
 excerpt:string;
 provenance:string;
};
const names:Record<AssistantCreativeKind,string>={story:"故事",scene:"场景",style:"美术风格"};
const genericTitles=new Set(["美术风格","视觉风格","故事梗概","故事设定","场景设定"]);

export function detectAssistantCreativeMaterialIntent(text:string,taskId?:string|null){
 const kinds:AssistantCreativeKind[]=[];
 if(/故事|剧情|剧本|世界观/.test(text))kinds.push("story");
 if(/场景|地点|环境设定/.test(text))kinds.push("scene");
 if(/美术风格|视觉风格|画风|美术规范/.test(text))kinds.push("style");
 return {kinds,shouldSelect:Boolean(taskId)&&kinds.length>0&&
  /(之前|此前|前面|先前|已有|原来|参考|沿用|根据|继续|保持|一致|既定)/.test(text)};
}
export function selectAssistantCreativeMaterialsForRequest(
 materials:AssistantCreativeMaterial[],kinds:AssistantCreativeKind[],text:string){
 const available=materials.filter(m=>kinds.includes(m.kind));
 if(!available.length)
  throw Error("当前 Task 没有找到本轮获授权的故事/场景/画风资料，请先选择对应节点或明确提供相关内容。");
 const selected=[...new Set(kinds)].flatMap(kind=>{
  const group=available.filter(m=>m.kind===kind);
  const named=group.filter(m=>m.title.length>3&&!genericTitles.has(m.title)&&text.includes(m.title));
  return named.length?named:group;
 });
 if(selected.length>4)
  throw Error("找到 "+selected.length+
   " 条创作资料，超过本轮可确认的 4 条。请指定具体场景或风格，或缩小画布选择范围。");
 return selected;
}
export function summarizeAssistantCreativeMaterials(materials:AssistantCreativeMaterial[]){
 return "本轮准备引用以下历史创作资料：\n"+
  materials.map(m=>"· "+names[m.kind]+"「"+m.title+"」 · "+m.sourceLabel+
   (m.provenance==="model_draft"?"（AI 草稿，尚未确认）":"")+
   "\n"+m.excerpt.slice(0,220)).join("\n")+
  "\n确认后资料才会进入当前模型请求；取消则不会外发。";
}
