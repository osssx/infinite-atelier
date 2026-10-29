import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {captureCanvasTextEditContext,insertCanvasClipboardText,isNativeTextEditorTarget} from "./canvas-text-context-menu";

class FakeElement {
    editable=false;
    closest(selector:string): FakeElement|null {
        if(selector==="input,textarea")return this instanceof FakeInput || this instanceof FakeTextarea?this:null;
        if(selector.includes("input,textarea,select"))return this instanceof FakeInput||this instanceof FakeTextarea||this.editable?this:null;
        return null;
    }
}
class FakeInput extends FakeElement {
    private text="";
    type="text";
    disabled=false;
    readOnly=false;
    isConnected=true;
    selectionStart:number|null=0;
    selectionEnd:number|null=0;
    focused=false;
    events:Event[]=[];
    get value(){return this.text;}
    set value(value:string){this.text=value;}
    focus(){this.focused=true;}
    setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}
    dispatchEvent(event:Event){this.events.push(event);return true;}
}
class FakeTextarea extends FakeInput {}
Object.defineProperty(FakeTextarea.prototype,"value",Object.getOwnPropertyDescriptor(FakeInput.prototype,"value")!);

vi.mock("@/stores/use-theme-store",()=>({
    useThemeStore:(select:(state:{theme:"light"})=>unknown)=>select({theme:"light"}),
}));
vi.mock("react-i18next",()=>({
    useTranslation:()=>({t:(key:string)=>({
        "canvas.controls.copyText":"复制文本",
        "canvas.controls.pasteText":"粘贴文本",
        "canvas.controls.duplicate":"复制节点",
        "canvas.controls.delete":"删除节点",
        "canvas.controls.disconnect":"断开连接",
    } as Record<string,string>)[key]??key}),
}));
import {CanvasNodeContextMenu} from "@/components/canvas/canvas-context-menu";
import type {ContextMenuState} from "@/types/canvas";

beforeEach(()=>{
    vi.stubGlobal("Element",FakeElement);
    vi.stubGlobal("HTMLInputElement",FakeInput);
    vi.stubGlobal("HTMLTextAreaElement",FakeTextarea);
    vi.stubGlobal("InputEvent",undefined);
});
afterEach(()=>vi.unstubAllGlobals());

describe("canvas text context menu",()=>{
    it("recognizes plain inputs/textarea without stealing native menus for unsupported/rich editors",()=>{
        const input=new FakeInput();input.value="hello world";
        input.selectionStart=6;input.selectionEnd=11;
        const captured=captureCanvasTextEditContext(input as unknown as EventTarget);
        expect(captured).toMatchObject({start:6,end:11,copyValue:"world"});
        expect(isNativeTextEditorTarget(input as unknown as EventTarget)).toBe(true);
        input.selectionEnd=6;
        expect(captureCanvasTextEditContext(input as unknown as EventTarget)?.copyValue).toBe("hello world");
        input.type="password";
        expect(captureCanvasTextEditContext(input as unknown as EventTarget)).toBeNull();
        input.type="number";
        expect(captureCanvasTextEditContext(input as unknown as EventTarget)).toBeNull();
        const textarea=new FakeTextarea();textarea.value="notes";
        expect(captureCanvasTextEditContext(textarea as unknown as EventTarget)?.copyValue).toBe("notes");
        const rich=new FakeElement();rich.editable=true;
        expect(isNativeTextEditorTarget(rich as unknown as EventTarget)).toBe(true);
        expect(captureCanvasTextEditContext(rich as unknown as EventTarget)).toBeNull();
        const background=new FakeElement();
        expect(isNativeTextEditorTarget(background as unknown as EventTarget)).toBe(false);
        expect(captureCanvasTextEditContext(background as unknown as EventTarget)).toBeNull();
    });
    it("pastes into selected text using native setter and emits bubbling input for React",()=>{
        const input=new FakeTextarea();input.value="abc 123 xyz";input.selectionStart=4;input.selectionEnd=7;
        const editor=captureCanvasTextEditContext(input as unknown as EventTarget)!;
        expect(insertCanvasClipboardText(editor,"hello")).toBe(true);
        expect(input.value).toBe("abc hello xyz");
        expect([input.selectionStart,input.selectionEnd]).toEqual([9,9]);
        expect(input.focused).toBe(true);
        expect(input.events).toHaveLength(1);
        expect(input.events[0].type).toBe("input");
        expect(input.events[0].bubbles).toBe(true);
    });
    it("refuses to overwrite readonly/disabled/detached text inputs",()=>{
        const input=new FakeInput();input.value="protect";
        const editor=captureCanvasTextEditContext(input as unknown as EventTarget)!;
        input.readOnly=true;
        expect(insertCanvasClipboardText(editor,"overwrite")).toBe(false);
        input.readOnly=false;input.isConnected=false;
        expect(insertCanvasClipboardText(editor,"overwrite")).toBe(false);
        input.isConnected=true;input.disabled=true;
        expect(insertCanvasClipboardText(editor,"overwrite")).toBe(false);
        expect(input.value).toBe("protect");
        expect(input.events).toHaveLength(0);
    });
    it("renders text actions only for editable inputs and preserves node/connection menus",()=>{
        const input=new FakeInput();input.value="selection";
        const menu:ContextMenuState={type:"text",x:8,y:10,
            editor:captureCanvasTextEditContext(input as unknown as EventTarget)!};
        const render=(state:ContextMenuState)=>renderToStaticMarkup(createElement(CanvasNodeContextMenu,{
            menu:state,onClose:()=>{},onDuplicate:()=>{},onDelete:()=>{},onCopyText:()=>{},onPasteText:()=>{}
        }));
        const text=render(menu);
        expect(text).toContain("复制文本");expect(text).toContain("粘贴文本");
        expect(text).not.toContain("复制节点");expect(text).not.toContain("删除节点");
        input.readOnly=true;
        expect(render(menu)).toContain('disabled=""');
        const node=render({type:"node",x:8,y:10,nodeId:"n"});
        expect(node).toContain("复制节点");expect(node).toContain("删除节点");
        expect(node).not.toContain("粘贴文本");
        const connection=render({type:"connection",x:8,y:10,connectionId:"c"});
        expect(connection).toContain("断开连接");
        expect(connection).not.toContain("复制节点");
    });
});
