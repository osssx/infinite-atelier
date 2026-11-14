/** P4.3 explicit, single-kind structured text deliverable intent.
 * Never derive a user-confirmed requirement from a model response.
 */
export type AssistantStructuredTextKind="story"|"scene"|"storyboard";
export type AssistantStructuredTextDelivery={
 deliverableType:AssistantStructuredTextKind;title:string;ref:string;
 allowEmptyTemplate:boolean;minimumMeaningfulChars:number
};
export function detectAssistantStructuredTextDelivery(
 text:string,taskId:string|null|undefined,textOnly:boolean
):AssistantStructuredTextDelivery|null{
 if(!taskId||textOnly||typeof text!=="string"||text.length>8000)return null;
 if(/^(?:请问|如何|怎么|怎样|介绍|讨论|分析|解释|请查看|查看|查询|检查)/.test(text.trim()))return null;
 if(!/(?:生成|创建|编写|制作|添加|设计|写出|写一|撰写)/.test(text))return null;
 const storyboard=/(?:分镜提示词|分镜脚本|分镜文本|镜头提示词|镜头脚本|生成分镜|创建分镜|编写分镜|制作分镜)/.test(text);
 const mentionedScene=/(?:场景设定|场景美术规范|场景描述|场景卡|设计场景|生成场景|创建场景)/.test(text);
 const mentionedStory=/(?:故事大纲|故事梗概|故事文本|故事内容|剧情大纲|生成故事|编写故事|创作故事|写一篇故事)/.test(text);
 // "根据故事大纲生成分镜" references a source, not two deliverables.
 const sourceStory=/(?:根据|参考|基于)[^。]{0,50}(?:故事大纲|故事梗概|剧情大纲)[^。]{0,50}(?:生成|制作|编写|设计)[^。]{0,20}(?:分镜|场景)/.test(text);
 const sourceScene=/(?:根据|参考|基于)[^。]{0,40}(?:场景设定|场景描述)[^。]{0,40}(?:生成|制作|编写|设计)[^。]{0,20}分镜/.test(text);
 const story=mentionedStory&&!sourceStory,scene=mentionedScene&&!sourceScene;
 if(Number(storyboard)+Number(scene)+Number(story)!==1)return null;
 // Mixed graph editing and bulk node plans retain the existing Task executor.
 if(/(?:依次连线|连接到|连到|并连接|并连线|布局|排版|分组|再执行|并执行)/.test(text)||
  (storyboard&&/(?:每个|多个|几个|[两三四五六七八九十0-9]+(?:个|张|条))[^。]{0,20}(?:分镜|镜头)(?:文本|提示词)?节点/.test(text)))
  return null;
 // The automatic UI registers one canonical text target only. Never silently
 // collapse an explicit multi-node request into a single deliverable.
 if((scene&&/(?:每个|多个|几个|[两三四五六七八九十0-9]+(?:个|处|张))[^。]{0,20}场景/.test(text))||
  (story&&/(?:每篇|多篇|几篇|[两三四五六七八九十0-9]+篇)[^。]{0,20}故事/.test(text)))
  return null;
 const allowEmptyTemplate=/(?:空白|空模板|不填正文)/.test(text);
 if(storyboard)return {deliverableType:"storyboard",title:"分镜提示词",ref:"storyboard_1",
  allowEmptyTemplate,minimumMeaningfulChars:40};
 if(scene)return {deliverableType:"scene",title:"场景设定",ref:"scene_1",
  allowEmptyTemplate,minimumMeaningfulChars:35};
 return {deliverableType:"story",title:"故事大纲",ref:"story_1",
  allowEmptyTemplate,minimumMeaningfulChars:60};
}
