/** A narrow completeness gate for explicitly requested populated creative text
 * nodes. This is a syntactic safeguard, NEVER a semantic quality score or
 * evidence that a character, scene or plot has been correctly interpreted.
 */
import {isCanvasEditInstruction,latestCanvasUserRequest} from "./assistant-action-intent.mjs";

const topic=/(?:角色卡|人物设定|角色设定|故事大纲|场景设定|分镜(?:提示词|脚本)?|剧本)/;
const creating=/(?:生成|创建|新建|添加|制作|编写|写入)/;
const blank=/(?:空白|空模板|留空|不填正文)/;
const negatedBlank=/(?:不要|不允许|禁止|拒绝|不是|非|避免|不需要)[^。！？;；\n]{0,16}(?:空白|空模板|留空|不填正文)/;
const emptyLabels=/(?:^|\n)\s*(?:[-*]\s*)?(?:姓名|角色名|身份\/职业|身份|外貌|性格|背景故事|目标与动机|标志性台词|角色定位|服饰|年龄)\s*[:：]\s*(?=\n|$)/g;

export function requiresPopulatedCreativeText(content){
 const request=latestCanvasUserRequest(content);
 if(!request||!isCanvasEditInstruction(request)||!creating.test(request)||
  !topic.test(request)||!/(?:文本节点|文字节点)/.test(request))return false;
 // An affirmative request for an empty shell must remain supported.
 // Negated blank templates ("不要空白") are still populated requests.
 return !blank.test(request)||negatedBlank.test(request);
}
export function isPopulatedCreativeBody(content){
 if(typeof content!=="string")return false;
 const value=content.trim();
 // Ignore headings, punctuation, template labels and numbers when checking
 // whether a concrete character/scene description was actually produced.
 const meaningful=value.replace(/[\s，。；：、,.;:!*#\-=\d\[\]()（）{}【】<>「」『』]/g,"");
 if(meaningful.length<18)return false;
 if((value.match(emptyLabels)??[]).length>=2)return false;
 if(/(?:待填写|待补充|待完善|请填写|在此填写|填入内容|placeholder|TBD|TODO)/i.test(value))return false;
 return true;
}
/** Validate only generated text nodes, never infer authority to modify existing nodes. */
export function hasPopulatedCreativeTextActions(actions){
 if(!Array.isArray(actions))return false;
 const written=actions.filter(action=>action?.type==="create_text"||
  action?.type==="create_node"&&action?.nodeType==="text");
 return written.length>0&&written.every(action=>isPopulatedCreativeBody(action.content));
}
