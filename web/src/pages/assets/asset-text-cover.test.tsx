import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import {AssetTextCover,assetTextExcerpt} from "./asset-text-cover";

describe("text asset card cover",()=>{
 it("does not put an entire long text asset into the card DOM",()=>{
  const full="长文本。".repeat(5000);
  const excerpt=assetTextExcerpt(full);
  expect(excerpt).toHaveLength(181);
  expect(excerpt.endsWith("…")).toBe(true);
  expect(full).toHaveLength(20000);
  const html=renderToStaticMarkup(createElement(AssetTextCover,{content:full,placeholder:"暂无封面"}));
  expect(html).toContain(excerpt);
  expect(html).not.toContain(full);
 });
 it("has a bounded 4:3 cover with a clipped, absolutely positioned line-clamped preview",()=>{
  const html=renderToStaticMarkup(createElement(AssetTextCover,{content:"第一行\n第二行\n第三行",placeholder:"暂无封面"}));
  expect(html).toContain("aspect-[4/3]");
  expect(html).toContain("relative");
  expect(html).toContain("absolute inset-0");
  expect(html).toContain("overflow-hidden");
  expect(html).toContain("line-clamp-5");
  expect(html).toContain("whitespace-pre-wrap");
  expect(html).toContain("[overflow-wrap:anywhere]");
  expect(html).toContain("第一行\n第二行\n第三行");
 });
 it("handles a long unbroken string, emoji boundaries, and empty content",()=>{
  expect(assetTextExcerpt("X".repeat(600),80)).toBe("X".repeat(80)+"…");
  expect(assetTextExcerpt("🎨".repeat(100),3)).toBe("🎨🎨🎨…");
  expect(assetTextExcerpt("短文本")).toBe("短文本");
  const empty=renderToStaticMarkup(createElement(AssetTextCover,{content:"",placeholder:"暂无封面"}));
  expect(empty).toContain("暂无封面");
 });
});
