const roleNames:Record<string,string>={first_frame:"首帧",last_frame:"尾帧",reference_image:"参考图",reference_video:"参考视频",reference_audio:"参考音频"};
const messages:Record<string,string>={
 media_mode_unavailable:"当前渠道不支持该输入模式，请更换渠道或模式。",
 media_input_count:"素材数量不符合当前模式要求，请检查参考素材。",
 media_input_format:"素材格式不受支持，请更换图片或工作流。",
 media_input_size:"素材大小未通过检查，请检查图片大小或工作流限制。",
 media_input_duration:"参考媒体时长不符合要求。",
 media_total_references:"参考素材数量超过限制，请减少素材或更换渠道。",
 media_input_unexpected:"存在当前模式不支持的素材，请检查输入模式。",
 media_reference_combination:"当前渠道不支持此素材组合，请调整输入模式。",
 media_reference_required:"请至少绑定一张参考图。",
 media_parameter_missing:"缺少必需生成参数，请检查生成设置或工作流。",
 media_parameter_invalid:"生成参数不符合限制，请检查时长、画幅及工作流参数。",
 project_revision_conflict:"项目内容已变化，请重新加载后重试。",
};
export function dramaVideoFeedback(error:unknown):string{
 const raw=error instanceof Error?error.message:typeof error==="string"?error:"";
 const codes=Object.keys(messages).filter(code=>raw.includes(code));
 if(codes.length)return codes.map(code=>messages[code]).join(" ");
 if(raw.includes("缺少所选角色/场景/关键道具"))return "缺少必需参考图，请在参考素材中核对。";
 if(raw==="模板不支持"||raw==="缺少首帧"||raw==="存在未保存修改或正在执行操作，请先完成当前操作。"||raw==="对应资产或造型已不存在，请先检查资产规划。")return raw;
 if(raw.includes("CAS"))return "参考素材尚未保存到本地或已失效，请重新选择图片。";
 if(raw.includes("端口绑定"))return "所选工作流未配置对应的图片输入，请检查工作流模板或更换渠道。";
 if(raw.includes("首帧和尾帧需要"))return "首帧和尾帧需要选择不同图片。";
 if(raw.includes("请选择")||raw.includes("请先")||raw.includes("不支持")||raw.includes("已变化")||raw.includes("人工修改")||raw.includes("缺少")||raw.includes("不可用")||raw.includes("已删除")||raw.includes("未配置")||raw.includes("必须")||raw.includes("未声明")||raw.includes("失败")||raw.includes("冲突")){
  // Only short, human-readable diagnostics; never expose internal identifiers,
  // transport URLs, serialized payloads or arbitrary provider error bodies.
  if(/^[\u3400-\u9fff][\u3400-\u9fff\s，。；：、？！（）()0-9 ·/A-Za-z+.-]{0,160}$/.test(raw)&&
   !/https?|[a-zA-Z0-9]{16,}|[a-f0-9]{8}-[a-f0-9]{4}|\b[a-z]+_[a-z0-9_]+\b/i.test(raw)){
    return raw.replace(/first_frame|last_frame|reference_image/g,role=>roleNames[role]??"参考素材");
  }
 }
 return "视频配置检查或保存未完成，请核对生成设置和参考素材后重试。";
}
