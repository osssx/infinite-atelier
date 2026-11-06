import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";

vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("lucide-react",()=>({
 Cpu:()=>createElement("i",{"data-icon":"cpu"}),
 Workflow:()=>createElement("i",{"data-icon":"workflow"}),
}));
vi.mock("@/components/ui/select",()=>({
 Select:({value,children}:{value:string;children:ReactNode})=>createElement("div",{"data-select-value":value},children),
 SelectContent:({children}:{children:ReactNode})=>createElement("div",null,children),
 SelectGroup:({children}:{children:ReactNode})=>createElement("section",null,children),
 SelectItem:({value,children}:{value:string;children:ReactNode})=>createElement("div",{"data-item-value":value},children),
 SelectLabel:({children}:{children:ReactNode})=>createElement("span",null,children),
 SelectTrigger:({children,title}:{children:ReactNode;title?:string})=>createElement("button",{title},children),
}));
vi.mock("@/lib/utils",()=>({cn:(...values:string[])=>values.join(" ")}));
vi.mock("@/stores/use-config-store",()=>({
 modelOptionLabel:(_config:unknown,model:string)=>model,
 modelOptionName:(model:string)=>model,
 selectableModelsByCapability:()=>["gpt-image-2"],
}));

import {ModelPicker,modelPickerSelection,modelPickerSelectValue} from "./model-picker";

const externalOptions=[{value:"krea@r1",label:"Krea image"}];
const config={channelMode:"api",models:["gpt-image-2"]} as never;
const render=(externalValue?:string)=>renderToStaticMarkup(createElement(ModelPicker,{
 config,value:"gpt-image-2",onChange:()=>{},capability:"image",
 externalOptions,externalValue,onExternalSelect:()=>{},
}));

describe("ModelPicker external workflow selection",()=>{
 it("controls the Select with the namespaced workflow option and shows its workflow icon",()=>{
  const html=render("krea@r1");
  expect(html).toContain('data-select-value="__atelier_external:krea@r1"');
  expect(html).toContain('data-item-value="__atelier_external:krea@r1"');
  expect(html).toContain('data-icon="workflow"');
  expect(html).toContain("Krea image");
 });
 it("falls back to the channel model when the external selection is cleared or stale",()=>{
  expect(modelPickerSelectValue("gpt-image-2",undefined,externalOptions)).toBe("gpt-image-2");
  expect(modelPickerSelectValue("gpt-image-2","deleted@r1",externalOptions)).toBe("gpt-image-2");
  expect(render("deleted@r1")).toContain('data-select-value="gpt-image-2"');
  expect(render()).toContain('src="/icons/openai.svg"');
  expect(render().match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0]).not.toContain('data-icon="workflow"');
 });
 it("dispatches only known workflow values as external selections",()=>{
  expect(modelPickerSelection("__atelier_external:krea@r1",externalOptions)).toEqual({kind:"external",value:"krea@r1"});
  expect(modelPickerSelection("gpt-image-2",externalOptions)).toEqual({kind:"channel",value:"gpt-image-2"});
  expect(modelPickerSelection("__atelier_external:deleted@r1",externalOptions)).toEqual({kind:"channel",value:"__atelier_external:deleted@r1"});
 });
});
