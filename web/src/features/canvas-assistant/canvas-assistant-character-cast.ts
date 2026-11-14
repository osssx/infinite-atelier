export function parseAssistantCharacterCast(text:string){
 const cast=/(?:为|给)\s*(.+?)\s*(?:生成|创建|制作|添加).{0,30}角色卡/.exec(text);
 const names=(cast?.[1]??"").split(/[、，,]|\s+和\s*|\s+与\s*/).map(s=>s.trim()).filter(Boolean);
 if(names.length>5)throw Error("本轮最多支持五个角色，请缩减明确指定的角色名单。");
 const generic=names.length===0||names.some(s=>/每个|所有|全部|这些|上述|那些|哪些|哪个|角色们|^角色$/.test(s));
 return {names,generic};
}
