import {beforeEach,describe,expect,it,vi} from "vitest";
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0}));
vi.mock("react",async importOriginal=>({...await importOriginal<typeof import("react")>(),
 useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=initial;
  return [hooks.values[index],(value:unknown)=>{hooks.values[index]=value;}];},
 useRef:()=>({current:false}),useEffect:()=>{},
}));
import {ComfyMediaNumericInput} from "./comfy-media-settings-control";
describe("workflow numeric parameter editing",()=>{
 beforeEach(()=>{hooks.values=[];hooks.cursor=0;});
 it.each(["INT","FLOAT"] as const)("allows clearing and replacing %s values",kind=>{
  const onChange=vi.fn();
  const render=()=>{hooks.cursor=0;return ComfyMediaNumericInput({kind,value:12,onChange}).props.children[0];};
  render().props.onChange({target:{value:""}});
  expect(render().props.value).toBe("");expect(onChange).not.toHaveBeenCalled();
  render().props.onChange({target:{value:"0"}});
  expect(render().props.value).toBe("0");expect(onChange).toHaveBeenLastCalledWith(0);
 });
 it("preserves fractional drafts and rejects invalid numbers",()=>{
  const onChange=vi.fn();
  const render=()=>{hooks.cursor=0;return ComfyMediaNumericInput({kind:"FLOAT",value:1,onChange}).props.children[0];};
  render().props.onChange({target:{value:"0."}});expect(render().props.value).toBe("0.");
  render().props.onChange({target:{value:"0.25"}});expect(onChange).toHaveBeenLastCalledWith(0.25);
  onChange.mockClear();render().props.onChange({target:{value:"-"}});
  expect(render().props.value).toBe("-");expect(onChange).not.toHaveBeenCalled();
  render().props.onBlur();expect(render().props.value).toBe("1");
 });
});
