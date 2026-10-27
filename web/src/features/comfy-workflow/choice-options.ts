import type {ComfyScalarChoice} from "./template-schema";
import {parseComfyScalarOverride, type ComfyScalarKind} from "./instance-parameters";

export type ComfyChoiceKind=Extract<ComfyScalarKind,"STRING"|"INT"|"FLOAT">;
export const formatComfyChoiceLines=(options:readonly ComfyScalarChoice[]) =>
    options.map(o=>o.label===String(o.value) ? o.label : o.label+" | "+String(o.value)).join("\n");

/** One line per option: either `value` or `display label | actual value`.
 * Without a separator the same text is used as its label and parsed value.
 * Numeric kinds are parsed once, not coerced at execution.
 */
export function parseComfyChoiceLines(kind:ComfyChoiceKind,text:string):
    {ok:true;choices:ComfyScalarChoice[]} | {ok:false;error:string} {
    const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!lines.length||lines.length>64)return {ok:false,error:"请设置 1–64 个候选项"};
    const choices:ComfyScalarChoice[]=[];
    const seen=new Set<string>();
    for(const [i,line] of lines.entries()){
        const sep=line.indexOf("|");
        const label=sep<0?line:line.slice(0,sep).trim();
        const raw=sep<0?line:line.slice(sep+1).trim();
        if(!label||label.length>90||label.includes("|"))return {ok:false,error:"第 "+(i+1)+" 行的显示名称必须为 1–90 字符，不能包含 |"};
        const parsed=parseComfyScalarOverride(kind,raw);
        if(!parsed.ok)return {ok:false,error:"第 "+(i+1)+" 行："+parsed.error};
        const value=parsed.value as string|number;
        const key=typeof value+":"+String(value);
        if(seen.has(key))return {ok:false,error:"候选项的实际值不能重复："+String(value)};
        seen.add(key);
        choices.push({label,value});
    }
    return {ok:true,choices};
}
