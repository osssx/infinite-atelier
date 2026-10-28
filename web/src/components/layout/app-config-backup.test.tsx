import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect,vi} from "vitest";
import zhCN from "@/i18n/locales/zh-CN";
import enUS from "@/i18n/locales/en-US";

vi.mock("@/i18n",()=>({default:{t:(key:string)=>key}}));
vi.mock("@/hooks/use-copy-text",()=>({useCopyText:()=>()=>{}}));
vi.mock("react-i18next",async (importOriginal)=>({
 ...(await importOriginal<typeof import("react-i18next")>()),
 useTranslation:()=>({t:(key:string)=>{
  if(key.startsWith("config.backup.")){
   const item=key.slice("config.backup.".length) as keyof typeof zhCN.config.backup;
   return zhCN.config.backup[item]??key;
  }
  return key;
 }}),
}));
import {ConfigBackupTab} from "./app-config-modal";

describe("authoritative backend backup settings",()=>{
 it("renders offline storage instructions, not the misleading legacy ZIP export/restore buttons",()=>{
  const html=renderToStaticMarkup(createElement(ConfigBackupTab));
  expect(html).toContain('data-backup-mode="offline-backend"');
  expect(html).toContain("后端数据备份与恢复");
  expect(html).toContain("ATELIER_DATA_DIR");
  expect(html).toContain("%LOCALAPPDATA%");
  expect(html).toContain("npm run backup:data -- create");
  expect(html).toContain("npm run backup:data -- verify");
  expect(html).toContain("复制命令示例");
  expect(html).not.toContain("导出备份</button>");
  expect(html).not.toContain("恢复备份</button>");
  expect(html).not.toContain("旧版浏览器 ZIP");
  expect(html).not.toContain('type="file"');
 });
 it("explains the manual stop / restore / activate flow accurately in both languages",()=>{
  for(const copy of [zhCN.config.backup,enUS.config.backup]){
   expect(copy.commands).toContain("npm run backup:data -- create");
   expect(copy.commands).toContain("npm run backup:data -- verify");
   expect(copy.steps).toMatch(/停止|Stop/);
   expect(copy.restoreNote).toContain("backup:data restore");
   expect(copy.restoreNote).toContain("backup:data activate");
   expect(copy.description).toMatch(/SQLite/);
  }
 });
});
