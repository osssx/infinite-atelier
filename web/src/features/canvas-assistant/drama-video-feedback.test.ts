import {expect,it} from "vitest";
import {dramaVideoFeedback} from "./drama-video-feedback";
it("translates media errors and never renders identifiers or arbitrary provider payloads",()=>{
 expect(dramaVideoFeedback("工作流输入预检失败 media_input_count · first_frame")).toContain("素材数量");
 expect(dramaVideoFeedback("视频输入预检失败 media_parameter_invalid")).toContain("时长、画幅");
 expect(dramaVideoFeedback("缺少所选角色/场景/关键道具的参考图：asset_dd5439d1-c011-46e9-8441-07d6aade8fa0")).toBe("缺少必需参考图，请在参考素材中核对。");
 for(const raw of ["失败：asset_dd5439d1-c011-46e9-8441-07d6aade8fa0","失败：cas:"+"a".repeat(64),"失败 https://private.example/api?key=secret","raw_provider_code"]){
  const text=dramaVideoFeedback(raw);
  expect(text).not.toMatch(/asset_|cas:|private|provider|secret/);
 }
});
