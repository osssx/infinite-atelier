import {Children,createElement,isValidElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";

function labelText(label:ReactNode):string{
 if(isValidElement<{children?:ReactNode}>(label))return Children.toArray(label.props.children).map(labelText).join("");
 return String(label??"");
}
vi.mock("antd",()=>({
 Select:({options=[],value,mode,placeholder,"data-comfy-mapping-key":mappingKey}:{options?:Array<{value:string;label:ReactNode;disabled?:boolean}>;value?:string|string[];mode?:string;placeholder?:string;"data-comfy-mapping-key"?:string})=>
  createElement("div",{"data-mock-select":JSON.stringify({options:options.map(option=>({value:option.value,label:labelText(option.label),disabled:!!option.disabled})),value,mode,placeholder,mappingKey})}),
 Checkbox:({checked}:{checked:boolean})=>createElement("input",{type:"checkbox",checked,readOnly:true}),
 Input:{TextArea:({value}:{value:string})=>createElement("textarea",{value,readOnly:true})},
 Button:({children}:{children:ReactNode})=>createElement("button",null,children),
}));

import {ComfyMediaUseCaseEditor} from "./comfy-media-use-case-editor";
import type {ComfyTemplatePayload} from "./template-schema";

const base:ComfyTemplatePayload={name:"Editor test",apiGraph:{generate:{class_type:"Generate",inputs:{}}},requirements:{classTypes:["Generate"]},ports:[
 {id:"quality",label:"Quality",direction:"target",valueKind:"STRING",choices:[{label:"Best",value:"best"}],
  inputBinding:{mode:"literal",targets:[{nodeId:"A",inputName:"quality"}]}},
 {id:"image-output",label:"Image",direction:"source",valueKind:"IMAGE",capture:{kind:"image",adapterId:"SaveImage"}},
],mediaUseCase:{channel:"image",primaryOutputKind:"image",promptPortId:"quality",slots:[],primaryOutputPortId:"image-output",
 settings:{imageQuality:{ports:["quality"]}}}};
const render=(template:ComfyTemplatePayload)=>renderToStaticMarkup(createElement(ComfyMediaUseCaseEditor,{template,onChange:()=>{}}));
function qualitySelectState(html:string){const matches=html.match(/data-mock-select=\"[^\"]*\"/g)??[];const states=matches.map(match=>{
 const encoded=match.slice("data-mock-select=\"".length,-1).replaceAll("&quot;","\"").replaceAll("&amp;","&").replaceAll("&#x27;","'").replaceAll("&lt;","<").replaceAll("&gt;",">");
 return JSON.parse(encoded) as {options:Array<{value:string;label:string;disabled:boolean}>;value?:string|string[];mode?:string;mappingKey?:string};
 });
 const state=states.find(item=>item.mappingKey==="imageQuality");if(!state)throw Error("missing imageQuality mapping Select");return state;}

describe("Comfy media mapping candidates follow the current template draft",()=>{
 it("updates option names and binding target details from changed literal scalar port data",()=>{
  const before=render(base);
  expect(qualitySelectState(before).options.find(option=>option.value==="quality")?.label).toContain("A.quality");
  const updated=structuredClone(base);
  updated.ports[0]={...updated.ports[0],label:"Quality control",choices:[{label:"Fast",value:"fast"}],
   inputBinding:{mode:"literal",targets:[{nodeId:"B",inputName:"steps"}]}};
  const after=render(updated);
  const options=qualitySelectState(after).options;
  expect(options.find(option=>option.value==="quality")?.label).toContain("Quality control · B.steps · STRING");
  expect(options.find(option=>option.value==="quality")?.label).not.toContain("A.quality");
  expect(after).toContain("Fast");expect(after).not.toContain("Best");
 });
 it("keeps an existing mapping visible but disabled when its port becomes ineligible or is deleted",()=>{
  const unbound=structuredClone(base);
  unbound.ports[0]={...unbound.ports[0],inputBinding:{mode:"literal",targets:[]}};
  let state=qualitySelectState(render(unbound));
  expect(state.options.find(option=>option.value==="quality")).toMatchObject({disabled:true,label:"Quality · STRING（当前不可映射）"});

  const changedBinding=structuredClone(base);
  changedBinding.ports[0]={...changedBinding.ports[0],valueKind:"IMAGE",
   inputBinding:{mode:"socket",replaceInternalLink:false,targets:[{nodeId:"B",inputName:"image"}]}};
  state=qualitySelectState(render(changedBinding));
  expect(state.value).toBe("quality");
  expect(state.options.find(option=>option.value==="quality")).toMatchObject({disabled:true,label:"Quality · B.image · IMAGE（当前不可映射）"});

  const deleted=structuredClone(base);deleted.ports=deleted.ports.filter(port=>port.id!=="quality");
  state=qualitySelectState(render(deleted));
  expect(state.value).toBe("quality");
  expect(state.options.find(option=>option.value==="quality")).toMatchObject({disabled:true,label:"端口已删除 · quality"});
 });
 it("leaves an explicitly configured common-value mapping intact when port choices change",()=>{
  const custom=structuredClone(base);
  custom.mediaUseCase!.settings!.imageQuality={ports:["quality"],values:[{label:"My custom",value:"mine"}]};
  custom.ports[0]={...custom.ports[0],choices:[{label:"Updated choice",value:"updated"}]};
  const html=render(custom);
  expect(html).toContain("My custom");
  expect(html).not.toContain("Updated choice");
 });
});
