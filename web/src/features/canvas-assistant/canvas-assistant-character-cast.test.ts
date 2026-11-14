import {describe,it,expect} from "vitest";
import {parseAssistantCharacterCast} from "./canvas-assistant-character-cast";

describe("character cast requests",()=>{
 it("rejects an explicit oversized cast before historical discovery",()=>{
  expect(()=>parseAssistantCharacterCast("为小兔、兔妈妈、小龟、兔爷爷、兔老师、熊同学生成角色卡"))
   .toThrow("最多支持五个角色");
 });
 it.each(["哪些角色","哪个角色","每个角色"])("discovers names for %s instead of freezing the phrase",phrase=>{
  expect(parseAssistantCharacterCast(`为${phrase}生成角色卡？`).generic).toBe(true);
 });
 it("preserves explicitly named characters",()=>{
  expect(parseAssistantCharacterCast("为小兔、兔妈妈、小龟生成角色卡"))
   .toEqual({names:["小兔","兔妈妈","小龟"],generic:false});
 });
});
