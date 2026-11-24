// @vitest-environment happy-dom
import {act,StrictMode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const mock=vi.hoisted(()=>({load:vi.fn<(_projectId:string,_nodeIds:string[])=>Promise<void>>() }));
vi.mock("@/stores/canvas/use-canvas-sqlite-store",()=>({ensureCreativeNodesLoaded:mock.load}));
import {LazyCreativeNode} from "./lazy-creative-node";

const roots:Root[]=[];
beforeEach(()=>{
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
    mock.load.mockReset();
});
afterEach(async()=>{
    for(const root of roots)await act(async()=>root.unmount());
    roots.length=0;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
async function mount(stage:"drama:source"|"drama:assets",strict=false){
    const container=document.createElement("div");
    document.body.append(container);
    const root=createRoot(container);
    roots.push(root);
    const node=<LazyCreativeNode projectId="project-1" nodeId={stage} stage={stage}/>;
    await act(async()=>{root.render(strict?<StrictMode>{node}</StrictMode>:node);});
    return container;
}
describe("creative node automatic hydration",()=>{
    it.each(["drama:source","drama:assets"] as const)("loads visible %s without opening confirmation",async stage=>{
        mock.load.mockResolvedValue(undefined);
        const container=await mount(stage);
        await act(async()=>{await Promise.resolve()});
        expect(mock.load).toHaveBeenCalledWith("project-1",[stage]);
        expect(container.textContent).not.toContain("打开创作内容");
        expect(container.querySelector("button")).toBeNull();
    });
    it("coalesces StrictMode hydration for the same node",async()=>{
        let resolve!:()=>void;
        mock.load.mockImplementation(()=>new Promise<void>(done=>{resolve=done;}));
        const container=await mount("drama:source",true);
        expect(container.querySelector('[role="status"]')?.textContent).toContain("正在读取创作内容");
        expect(mock.load).toHaveBeenCalledTimes(1);
        await act(async()=>resolve());
    });
    it("shows a retry only after load failure and retries on click",async()=>{
        mock.load.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue(undefined);
        const container=await mount("drama:assets");
        await act(async()=>{await Promise.resolve()});
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("读取失败");
        const retry=container.querySelector("button")!;
        expect(retry.textContent).toBe("重试加载");
        await act(async()=>{retry.click();await Promise.resolve()});
        expect(mock.load).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
});
