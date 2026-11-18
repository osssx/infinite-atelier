// @vitest-environment happy-dom
import {act,createElement,type ComponentProps} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import {canvasThemes} from "@/lib/canvas-theme";
import {defaultConfig} from "@/stores/use-config-store";
import {CanvasNodeType} from "@/types/canvas";

const themeRef=vi.hoisted(()=>({name:"light" as "light"|"dark"}));
vi.mock("@/stores/use-theme-store",()=>({
 useThemeStore:(selector:(state:{theme:"light"|"dark"})=>unknown)=>selector({theme:themeRef.name})
}));
vi.mock("antd",()=>({Modal:{confirm:vi.fn()}}));
vi.mock("streamdown",()=>({Streamdown:({children}:{children:unknown})=>children}));

import {CanvasAssistantPanel,canvasAssistantConfirmTheme,canvasAssistantErrorText} from "./canvas-assistant-panel";import {CanvasApiError} from "@/features/backend-sync/canvas-api";

const noop=()=>{};
const props:ComponentProps<typeof CanvasAssistantPanel>={
 projectId:"project-1",projectTitle:"短剧画布",open:true,onClose:noop,
 sessions:[],setSessions:noop,activeChatId:null,setActiveChatId:noop,
 selectedNodes:[{id:"text-1",title:"角色对白",type:CanvasNodeType.Text}],
 getContext:()=>({text:"画布上下文",references:[],truncated:false}),
 getWorkflowTemplates:async()=>({context:"",templates:new Map()}), onApplyActions:()=>({applied:0,refs:new Map<string,string>()}),
 onRunActions:async()=>({submitted:0,jobIds:[]}), config:defaultConfig,
};

describe("assistant error messages",()=>{
 it("explains empty, incomplete and invalid responses without showing raw response payloads",()=>{
  expect(canvasAssistantErrorText(new CanvasApiError("assistant_response_empty",502))).toContain("没有返回可显示的最终正文");
  expect(canvasAssistantErrorText(new CanvasApiError("assistant_response_incomplete",502))).toContain("未完成");
  expect(canvasAssistantErrorText(new CanvasApiError("assistant_response_invalid",502))).toContain("无法解析");
  expect(canvasAssistantErrorText(new CanvasApiError("assistant_upstream_rate_limited",502))).toContain("429");
   expect(canvasAssistantErrorText(new CanvasApiError("assistant_upstream_retry_exhausted",504))).toContain("重试 2 次");
   expect(canvasAssistantErrorText(new CanvasApiError("assistant_actions_missing",502))).toContain("画布仍未修改"); });
 it("P4.9a explains blank creative content failure without claiming canvas writes",()=>{
  const text=canvasAssistantErrorText(new CanvasApiError("assistant_creative_content_incomplete",502));
  expect(text).toContain("空白");
  expect(text).toContain("拒绝创建");
  expect(text).toContain("画布未因此修改");
 });
});

describe("canvas assistant confirm modal theme",()=>{
 it.each(["light","dark"] as const)("uses %s canvas palette on portaled modal",name=>{
  const theme=canvasAssistantConfirmTheme(name);
  expect(theme.className).toBe("canvas-assistant-confirm");
  expect(theme.rootClassName).toBe("canvas-assistant-confirm-root");
  const vars=theme.style as Record<string,string>;
  expect(vars["--assistant-confirm-surface"]).toBe(canvasThemes[name].node.panel);
  expect(vars["--assistant-confirm-text"]).toBe(canvasThemes[name].node.text);
  expect(vars["--assistant-confirm-border"]).toBe(canvasThemes[name].toolbar.border);
  expect(vars["--assistant-confirm-muted"]).toBe(canvasThemes[name].node.muted);
  expect(theme.styles.mask.backgroundColor).toBeTruthy();
 });
 it("keeps dark and light dialog tokens distinct",()=>{
  expect((canvasAssistantConfirmTheme("dark").style as Record<string,string>)["--assistant-confirm-surface"])
   .not.toBe((canvasAssistantConfirmTheme("light").style as Record<string,string>)["--assistant-confirm-surface"]);
 });
});

describe("canvas assistant visual shell",()=>{
 it.each(["light","dark"] as const)("inherits the %s canvas theme and preserves controls",name=>{
  themeRef.name=name;
  const markup=renderToStaticMarkup(createElement(CanvasAssistantPanel,props));
  expect(markup).toContain(`--assistant-panel:${canvasThemes[name].toolbar.panel}`);
  expect(markup).toContain(`--assistant-border:${canvasThemes[name].toolbar.border}`);
  expect(markup).toContain(`--assistant-text:${canvasThemes[name].node.text}`);
  expect(markup).toContain("canvas-assistant-shell");
  expect(markup).toContain("canvas-assistant-transcript");
  expect(markup).toContain("画布引用");
  expect(markup).toContain("历史会话");
  expect(markup).toContain("收起助手");
  expect(markup).toContain("向 AI 助手发送消息");
  expect(markup).toContain("默认自动匹配");
  expect(markup).not.toContain("canvas-assistant-skill-mode");
  expect(markup).not.toContain("Skill 模式");
  expect(markup).not.toContain("bg-indigo-600");
 });
 it("renders saved conversation using the canvas message style",()=>{
  themeRef.name="dark";
  const markup=renderToStaticMarkup(createElement(CanvasAssistantPanel,{
   ...props,activeChatId:"chat-1",
   sessions:[{id:"chat-1",title:"分镜讨论",createdAt:"2026-11-10",updatedAt:"2026-11-10",messages:[
    {id:"m1",role:"user",text:"分析梗概"},
    {id:"m2",role:"assistant",text:"建议强化转折",meta:"demo-model"}
   ]}]
  }));
  expect(markup).toContain("is-user");
  expect(markup).toContain("is-assistant");
  expect(markup).toContain("建议强化转折");
  expect(markup).toContain("复制回答");
 });
 it("does not render while closed",()=>{
  expect(renderToStaticMarkup(createElement(CanvasAssistantPanel,{...props,open:false}))).toBe("");
 });
 it("confirms a copied reply and resets its button",async()=>{
  const container=document.createElement("div");
  const root=createRoot(container);
  const writeText=vi.spyOn(navigator.clipboard,"writeText").mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  try{
   await act(async()=>root.render(createElement(CanvasAssistantPanel,{
    ...props,activeChatId:"chat-1",
    sessions:[{id:"chat-1",title:"分镜讨论",createdAt:"2026-11-10",updatedAt:"2026-11-10",messages:[
     {id:"m1",role:"assistant",text:"建议强化转折"},
    ]}],
   })));
   vi.useFakeTimers();
   const button=container.querySelector<HTMLButtonElement>('button[aria-label="复制回答"]')!;
   await act(async()=>button.click());
   expect(writeText).toHaveBeenCalledWith("建议强化转折");
   expect(button.textContent).toBe("已复制");
   act(()=>vi.advanceTimersByTime(2000));
   expect(button.textContent).toBe("复制");
   writeText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
   await act(async()=>button.click());
   expect(button.textContent).toBe("复制失败");
  }finally{
   await act(async()=>root.unmount());
   vi.useRealTimers();
   vi.unstubAllGlobals();
   writeText.mockRestore();
  }
 });
});
