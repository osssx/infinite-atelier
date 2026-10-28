import {describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";

vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
import {getPluginTemplates} from "./model-plugin";

describe("unified backend model script display names",()=>{
 it("uses user-facing capability names instead of exposing the storage engine",()=>{
  const templates=getPluginTemplates();
  expect(templates.image[0].label).toBe("安全文生图（Base64）");
  expect(templates.video[0].label).toBe("安全异步视频（提交/轮询）");
  expect(templates.audio[0].label).toBe("安全音频（JSON Base64）");
  expect(templates.text[0].label).toBe("安全文本（推荐）");
  expect(Object.values(templates).flat().map(item=>item.label).join(" ")).not.toMatch(/SQLite/i);
  const editor=readFileSync(new URL("../../components/layout/model-script-editor.tsx",import.meta.url),"utf8");
  expect(editor).not.toMatch(/SQLite/i);
 });
});
