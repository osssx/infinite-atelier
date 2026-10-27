import {describe,expect,it} from "vitest";
import {formatComfyChoiceLines,parseComfyChoiceLines} from "./choice-options";

describe("editable Comfy literal candidate arrays",()=>{
 it("parses labels separately from native STRING values (including extra pipes)",()=>{
  expect(parseComfyChoiceLines("STRING","标准 | standard\n快速 | fast\n复杂 | a|b")).toEqual({
   ok:true,choices:[
    {label:"标准",value:"standard"},
    {label:"快速",value:"fast"},
    {label:"复杂",value:"a|b"},
   ]
  });
  const source=[{label:"低",value:"0.25"},{label:"高",value:"0.75"}];
  expect(parseComfyChoiceLines("STRING",formatComfyChoiceLines(source))).toEqual({ok:true,choices:source});
 });
 it("uses the entire line as both display label and actual value when no pipe exists",()=>{
  expect(parseComfyChoiceLines("STRING","  cinematic  \n写实 | realistic\n动漫")).toEqual({
   ok:true,choices:[
    {label:"cinematic",value:"cinematic"},
    {label:"写实",value:"realistic"},
    {label:"动漫",value:"动漫"}
   ]
  });
  expect(parseComfyChoiceLines("INT"," 8 \n标准 | 16\n32")).toEqual({
   ok:true,choices:[
    {label:"8",value:8},
    {label:"标准",value:16},
    {label:"32",value:32}
   ]
  });
  expect(parseComfyChoiceLines("FLOAT","0.25\n中 | 0.5\n-1.25e-3")).toEqual({
   ok:true,choices:[
    {label:"0.25",value:0.25},
    {label:"中",value:0.5},
    {label:"-1.25e-3",value:-0.00125}
   ]
  });
 });
 it("formats equal label/value choices without a separator and roundtrips typed numbers",()=>{
  const options=[{label:"8",value:8},{label:"标准",value:16},{label:"32",value:32}];
  expect(formatComfyChoiceLines(options)).toBe("8\n标准 | 16\n32");
  expect(parseComfyChoiceLines("INT",formatComfyChoiceLines(options))).toEqual({ok:true,choices:options});
  const texts=[{label:"cinematic",value:"cinematic"},{label:"写实",value:"realistic"}];
  expect(formatComfyChoiceLines(texts)).toBe("cinematic\n写实 | realistic");
  expect(parseComfyChoiceLines("STRING",formatComfyChoiceLines(texts))).toEqual({ok:true,choices:texts});
 });
 it("supports INT, FLOAT and negative/safe numeric values without string coercion",()=>{
  expect(parseComfyChoiceLines("INT","低 | -2\n高 | 10")).toEqual({ok:true,choices:[
   {label:"低",value:-2},{label:"高",value:10}
  ]});
  expect(parseComfyChoiceLines("FLOAT","低 | 0.125\n高 | 2.5e-3")).toEqual({ok:true,choices:[
   {label:"低",value:0.125},{label:"高",value:0.0025}
  ]});
  expect(parseComfyChoiceLines("INT","坏 | 1.2").ok).toBe(false);
  expect(parseComfyChoiceLines("INT","坏 | 9007199254740992").ok).toBe(false);
  expect(parseComfyChoiceLines("FLOAT","坏 | NaN").ok).toBe(false);
  expect(parseComfyChoiceLines("FLOAT","坏 | Infinity").ok).toBe(false);
 });
 it("validates line syntax, option limits and distinct actual values",()=>{
  for(const s of ["","abc","1.5"," | 1","A | 1\nB | 1","1\n另一个 | 1",Array.from({length:65},(_,i)=>"选项"+i+" | "+i).join("\n")]){
   expect(parseComfyChoiceLines("INT",s).ok).toBe(false);
  }
 });
});
