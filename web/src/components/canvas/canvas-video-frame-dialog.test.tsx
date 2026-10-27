import {createElement, type ComponentProps, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";

let sliderProps: Record<string,unknown> | null=null;
vi.mock("antd",()=>({
 App:{useApp:()=>({message:{error:vi.fn()}})},
 Modal:({children}:{children:ReactNode})=>createElement("section",null,children),
 Button:({children,disabled}:{children?:ReactNode,disabled?:boolean})=>createElement("button",{disabled},children),
 Slider:(props:Record<string,unknown>)=>{sliderProps=props;return createElement("div",{"data-testid":"video-frame-slider"});},
 InputNumber:()=>createElement("input",{"aria-label":"time"}),
 Spin:()=>null
}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@/services/file-storage",()=>({getMediaBlob:vi.fn()}));
vi.mock("@/lib/api-proxy",()=>({proxyApiUrl:(url:string)=>url}));

import {CanvasVideoFrameDialog} from "./canvas-video-frame-dialog";

const videoNode:CanvasNodeData={
 id:"video-test",type:"video",title:"Clip",position:{x:0,y:0},width:420,height:236,
 metadata:{content:"/api/v1/blobs/"+"a".repeat(64),status:"success"}
} as CanvasNodeData;

describe("video frame slider portal + seek boundary",()=>{
 it("never opens an AntD Slider tooltip/Portal when dragging",()=>{
  sliderProps=null;
  const props:ComponentProps<typeof CanvasVideoFrameDialog>={
   node:videoNode,open:true,onClose:vi.fn(),onCapture:vi.fn(async()=>{})
  };
  const html=renderToStaticMarkup(createElement(CanvasVideoFrameDialog,props));
  expect(html).toContain('data-testid="video-frame-slider"');
  expect(sliderProps).toMatchObject({
   tooltip:{open:false,formatter:null},min:0,step:0.01,
   disabled:true
  });
 });
 it("separates rapid pointer updates from the one committed video seek",()=>{
  sliderProps=null;
  renderToStaticMarkup(createElement(CanvasVideoFrameDialog,{
   node:videoNode,open:true,onClose:vi.fn(),onCapture:vi.fn(async()=>{})
  }));
  const props = (sliderProps || {}) as Record<string, unknown>;
  expect(typeof props.onChange).toBe("function");
  expect(typeof props.onChangeComplete).toBe("function");
  expect(props.onChange).not.toBe(props.onChangeComplete);
 });
});
