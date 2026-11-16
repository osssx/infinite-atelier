/** Versioned, declarative media capability contract shared by API models and Comfy revisions. */
export type MediaKind = "image" | "video" | "audio";
export type MediaModeId = "text_to_image" | "reference_edit" | "inpaint" | "text_to_video" | "first_frame" | "last_frame" | "first_last_frame" | "omni_reference" | "text_to_speech" | "voice_clone" | "text_to_music" | "text_to_sound";
export type MediaRole = "reference_image" | "source_image" | "mask" | "first_frame" | "last_frame" | "reference_video" | "reference_audio" | "voice_reference";
export type MediaInputRule = {role:MediaRole;kind:"image"|"video"|"audio"|"mask";minItems:number;maxItems:number;mimeTypes?:string[];maxBytes?:number;maxDurationSeconds?:number};
export type MediaParameterSpec = {id:string;mode:"fixed"|"adjustable";type:"number"|"string"|"boolean"|"enum";defaultValue?:string|number|boolean;fixedValue?:string|number|boolean;min?:number;max?:number;step?:number;values?:Array<string|number>};
export type MediaCapabilities = {schemaVersion:1;kind:MediaKind;modes:Array<{id:MediaModeId;enabled:boolean;inputs:MediaInputRule[];allowedReferenceCombinations?:Array<Array<"image"|"video"|"audio">>;maxTotalReferences?:number;parameters:MediaParameterSpec[];layout?:{format:"atelier_bbox_json_v1";delivery:"prompt_json"|"dedicated_input"}}> ;defaultMode?:MediaModeId};
export const MEDIA_MODES:Record<MediaKind,MediaModeId[]>={image:["text_to_image","reference_edit","inpaint"],video:["text_to_video","first_frame","last_frame","first_last_frame","omni_reference"],audio:["text_to_speech","voice_clone","text_to_music","text_to_sound"]};
export function isMediaCapabilities(value:unknown):value is MediaCapabilities{return validateMediaCapabilities(value);}
import {isMediaCapabilities as validateMediaCapabilities,resolveMediaCapabilities,validateMediaRequest,supportedMediaModes,supportedMediaParameters} from "../../shared/media-capabilities.mjs";
export {resolveMediaCapabilities,validateMediaRequest,supportedMediaModes,supportedMediaParameters};
