"""S5 real-browser A/B and long-story pressure. Disposable fixture; no external generation.
Use the same fixture with its matching historical or current backend + production build.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("story_s5_perf",ROOT/"scripts/drama-p34b-chrome-perf.py")
perf=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=perf
spec.loader.exec_module(perf)
q=lambda value:json.dumps(value,ensure_ascii=False)
# Optional diagnostic only, not enabled during measured frame rounds. React
# production Fiber PerformedWork + changed fiber identity is a committed-work
# proxy, not an exact count of interrupted renders. Both versions share React.
FIBER_PROBE="""(() => {
 const probe={active:false,root:null,seen:new Map(),commits:0,storyCommits:0,storyWork:0};
 function stories(root){
  const result=new Map(),stack=[root];
  while(stack.length){const f=stack.pop();if(!f)continue;
   const p=f.memoizedProps;
   if((f.tag===0||f.tag===15)&&p?.node?.type==='drama:source'&&typeof p.onOpenEditor==='function')
    result.set(p.node.id,f);
   if(f.sibling)stack.push(f.sibling);if(f.child)stack.push(f.child);
  }return result;
 }
 probe.start=()=>{probe.seen=stories(probe.root);probe.commits=0;probe.storyCommits=0;probe.storyWork=0;probe.active=true;};
 probe.stop=()=>{probe.active=false;return {commits:probe.commits,storyCommits:probe.storyCommits,storyWork:probe.storyWork,visibleStoryFibers:probe.seen.size,hookObserved:!!probe.root};};
 window.__storyS5FiberProbe=probe;
 window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,checkDCE:()=>{},onCommitFiberUnmount:()=>{},
  onCommitFiberRoot(_id,root){
   probe.root=root.current;
   if(!probe.active)return;
   probe.commits++;
   const next=stories(root.current);let performed=0;
   for(const [id,f] of next)if(f!==probe.seen.get(id)&&(!probe.seen.has(id)||(f.flags&1)))performed++;
   if(performed){probe.storyCommits++;probe.storyWork+=performed;}
   probe.seen=next;
  }};
})()"""

def run(frontend_root,previous,rounds,gpu,output):
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-story-s5-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=perf.port(),perf.port(),perf.port()
    env=dict(os.environ,ATELIER_STORY_S5_BROWSER_E2E="1",ATELIER_P34B_BROWSER_E2E="1",ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port))
    processes=[];logs=[];page=None;passed=[]
    report={"label":"pre-S1" if previous else "current","fixture":{},"measurements":[],"checks":passed,
      "isolation":"temporary SQLite/CAS + Chrome; no external model/Comfy calls"}
    def launch(name,args,cwd=ROOT):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        processes.append(subprocess.Popen(args,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT))
        return processes[-1]
    def check(name,expr,timeout=25):
        perf.wait_for(lambda:page.js(expr),name,timeout);passed.append(name);print("STORY_S5_ASSERT",name,flush=True)
    def click(selector):
        check("click "+selector,"(()=>{const b=document.querySelector("+q(selector)+");if(!b||b.disabled)return false;b.click();return true})()")
    def button(portal,label):
        check("click "+label,"(()=>{const b=[...(document.querySelector("+q(portal)+")?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()==="+q(label)+");if(!b||b.disabled)return false;b.click();return true})()")
    def requests_since(index):
        # Flush Network events before reading the captured request list.
        page.js("true")
        return [{"method":e["method"],"path":e["path"]} for e in page.network_requests[index:]]
    def story_requests(requests):
        return [e for e in requests if "/drama-pipeline/payload" in e["path"] or "/text-versions" in e["path"] or "/story-edit" in e["path"]]
    def write_requests(requests):
        return [e for e in requests if e["method"] in ("POST","PATCH","DELETE","PUT") and
           (e["method"]!="PATCH" or "/viewport" not in e["path"])]
    def card_info():
        return page.js("""(() => {
         const cards=[...document.querySelectorAll('[data-story-inline-summary]')];
         const roots=cards.map(c=>c.closest('[data-node-id]'));
         return {visibleStoryCards:cards.length,visibleNodes:document.querySelectorAll('[data-node-id]').length,
          storyDomElements:roots.reduce((n,r)=>n+r.querySelectorAll('*').length,0),
          storyFormControls:roots.reduce((n,r)=>n+r.querySelectorAll('input,select,textarea,details').length,0),
          cardTextChars:cards.reduce((n,c)=>n+c.textContent.length,0),
          previewById:Object.fromEntries(cards.map(c=>[c.closest('[data-node-id]').dataset.nodeId,c.textContent]))};
        })()""")
    def center():
        return page.js("""(() => {
          const canvas=document.querySelector('[data-story-inline-summary]')?.closest('div.relative.h-full.w-full.select-none.overflow-hidden');
          const r=canvas?.getBoundingClientRect();if(!r||r.width<400)return null;
          for(const dy of [12,18,25,35,50,115,170,235,310,395,470,530,620,720,850]){
           for(const frac of [.5,.6,.7,.4,.8,.3,.2,.9,.1,.95,.05]){
            const x=Math.round(r.left+r.width*frac),y=Math.round(r.top+dy);
            if(y>=r.bottom-75||x>=innerWidth||y>=innerHeight)continue;
            const el=document.elementFromPoint(x,y);
            if(el&&canvas.contains(el)&&!el.closest('[data-node-id],[data-connection-id],button,input,select,textarea,[data-canvas-no-zoom],.ant-modal'))
              return {x,y,target:el.tagName};
           }
          }return null;
        })()""")
    def gesture(kind):
        anchor=perf.wait_for(center,"story canvas empty gesture anchor",10)
        x,y=anchor["x"],anchor["y"]
        if kind=="pan":
            page.call("Input.dispatchMouseEvent",{"type":"mousePressed","x":x,"y":y,"button":"middle","buttons":4,"clickCount":1})
            for i in range(72):
                page.call("Input.dispatchMouseEvent",{"type":"mouseMoved","x":x+round(90*math.sin(i*2*math.pi/71)),
                 "y":y+round(40*math.sin(i*2*math.pi/71)),"button":"middle","buttons":4})
                time.sleep(.013)
            page.call("Input.dispatchMouseEvent",{"type":"mouseReleased","x":x,"y":y,"button":"middle","buttons":0,"clickCount":1})
        else:
            for i in range(60):
                page.call("Input.dispatchMouseEvent",{"type":"mouseWheel","x":x,"y":y,"deltaX":0,
                  "deltaY":-14 if i%20<10 else 14,"modifiers":0})
                time.sleep(.015)
        time.sleep(.25)
    def geometry():
        return page.js("(()=>{const r=document.querySelector('[data-node-id=story-0]')?.getBoundingClientRect();return r?[r.x,r.y,r.width]:null})()")
    def measure(kind,index):
        before=perf.renderer_metrics(page);net=len(page.network_requests)
        page.js("""(() => {
          const canvas=document.querySelector('[data-story-inline-summary]')?.closest('div.relative.h-full.w-full.select-none.overflow-hidden');
          const world=canvas?.querySelector(':scope > .absolute.origin-top-left');
          if(!world)throw Error('canvas_world_missing');
          const states=new Set([world.style.transform]);
          const observer=new MutationObserver(()=>states.add(world.style.transform));
          observer.observe(world,{attributes:true,attributeFilter:['style']});
          window.__storyS5Transforms={states,observer};
        })()""")
        perf.start_probe(page,kind+"-"+str(index))
        gesture(kind)
        m=perf.stop_probe(page);after=perf.renderer_metrics(page)
        transforms=page.js("""(()=>{const {states,observer}=window.__storyS5Transforms;observer.disconnect();
          return [...states];})()""")
        matrices=page.js("("+q(transforms)+").map(s=>{const m=new DOMMatrix(s);return [m.e,m.f,m.a]})")
        spread=[max(v[i] for v in matrices)-min(v[i] for v in matrices) for i in range(3)]
        assert len(transforms)>=3 and (max(spread[:2])>10 if kind=="pan" else spread[2]>.05),("gesture_not_applied",kind,transforms)
        m["verifiedTransformSpread"]=spread
        m["distinctTransforms"]=len(transforms)
        assert m["frames"]>=20,m
        m["engineMetricsDelta"]={key:round(after[key]-value,5) for key,value in before.items() if key in after and key!="JSHeapUsedSize"}
        m["storyApiRequests"]=len(story_requests(requests_since(net)))
        m["strictPass"]=m["fps"]>=58 and m["p95Ms"]<=18 and m["p99Ms"]<=33.4 and m["longTaskCount"]==0
        report["measurements"].append(m)
        print("STORY_S5_ROUND",q(m),flush=True)
    try:
        backend=launch("backend",["node","scripts/drama-story-s5-browser-fixture.mjs"],frontend_root)
        deadline=time.monotonic()+60
        fixture_path=root/"story-s5-fixture.json"
        while not fixture_path.exists() and time.monotonic()<deadline:
            if backend.poll() is not None:raise AssertionError("fixture_exited:"+str(backend.returncode))
            time.sleep(.2)
        assert fixture_path.exists(),"fixture_start_timeout"
        fixture=json.loads(fixture_path.read_text("utf-8"))
        assert fixture["nodes"]==200 and len(fixture["storySamples"])==24
        samples={s["id"]:s for s in fixture["storySamples"]}
        report["fixture"]={"nodes":200,"stories":24,"links":fixture["connections"],
          "sampleBytes":[samples["story-0"]["bytes"],samples["story-1"]["bytes"]],
          "totalStoryBytes":sum(s["bytes"] for s in samples.values()),"hydratedDocumentBytes":fixture["hydratedDocumentBytes"]}
        front=f"http://127.0.0.1:{front_port}"
        dist=frontend_root/"dist"
        assert (dist/"index.html").exists(),"production_build_required"
        frontend=launch("static",["node",str(ROOT/"scripts/drama-p34b-static-frontend.mjs"),"--port",str(front_port),"--backend",fixture["backendOrigin"],"--dist",str(dist)])
        deadline=time.monotonic()+35
        while True:
            if frontend.poll() is not None:raise AssertionError("frontend_exited:"+str(frontend.returncode))
            try:
                if urllib.request.urlopen(front,timeout=2).status==200:break
            except OSError:pass
            if time.monotonic()>deadline:raise AssertionError("frontend_start_timeout")
            time.sleep(.2)
        launch("chrome",[str(perf.cdp.CHROME),"--headless=new",*([] if gpu else ["--disable-gpu"]),
          "--enable-precise-memory-info","--no-default-browser-check","--no-first-run",
          f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}",
          "--window-size=2048,1152","about:blank"])
        chrome=perf.wait_for(lambda:perf.get_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=perf.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":2048,"height":1152,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Performance.enable",{});page.call("HeapProfiler.enable",{})
        page.call("Page.addScriptToEvaluateOnNewDocument",{"source":FIBER_PROBE})
        perf.start_probe(page,"blank");time.sleep(2.4);report["blank"]=perf.stop_probe(page)
        load_started=time.monotonic()
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("visible story summary cards","document.querySelectorAll('[data-story-inline-summary]').length>=4",65)
        report["initialMountMs"]=round((time.monotonic()-load_started)*1000,1)
        time.sleep(1.0)
        info=card_info()
        report["cards"]={key:v for key,v in info.items() if key!="previewById"}
        report["cards"]["correctPreviewCount"]=sum(samples[id]["preview"][:60] in text for id,text in info["previewById"].items() if id in samples)
        report["networkAtMount"]=requests_since(0)
        report["environment"]={"chrome":chrome.get("Browser"),**perf.screenshot_metadata(page)}
        report["heapAfterLoad"]=perf.heap(page)
        # Real compact HTTP projection, charged separately from app-generated requests.
        report["compact"]=page.js("""(async()=>{const start=performance.now();const r=await fetch('/api/v1/projects/"""+fixture["projectId"]+"""?creative=summary');
         const body=await r.text(),d=JSON.parse(body),stories=d.document.nodes.filter(n=>n.type==='drama:source');
         return {ok:r.ok,bytes:new TextEncoder().encode(body).length,latencyMs:performance.now()-start,nodes:d.document.nodes.length,
           stories:stories.length,projections:stories.filter(n=>n.metadata.dramaStorySummary).length,
           projectedChars:stories.reduce((a,n)=>a+(n.metadata.dramaStorySummary?.preview?.length||0),0),
           storiesWithInlineBodies:stories.filter(n=>n.metadata.dramaDraft!==undefined||n.metadata.dramaConfirmed!==undefined).length};
         })()""")
        assert report["compact"]["ok"] and report["compact"]["nodes"]==200 and report["compact"]["stories"]==24,report["compact"]
        assert not story_requests(report["networkAtMount"]),report["networkAtMount"]
        if not previous:
            assert report["compact"]["projections"]==24 and report["compact"]["storiesWithInlineBodies"]==0
            assert report["cards"]["storyFormControls"]==0
            assert report["cards"]["correctPreviewCount"]==report["cards"]["visibleStoryCards"]
            assert report["compact"]["projectedChars"]<=24*360
        # A/B uses matching real browser/viewport/fixture and three repeated gestures.
        net=len(page.network_requests);before_geometry=geometry()
        for kind in ("pan","zoom"):
            for i in range(1,rounds+1):measure(kind,i)
        report["gestureNetwork"]=requests_since(net)
        assert not story_requests(report["gestureNetwork"]),report["gestureNetwork"]
        report["geometry"]={"before":before_geometry,"after":geometry()}
        # Separate committed-work diagnostic: no influence on the frame samples above.
        page.js("window.__storyS5FiberProbe.start()")
        gesture("pan");gesture("zoom")
        report["committedWorkDiagnostic"]=page.js("window.__storyS5FiberProbe.stop()")
        assert report["committedWorkDiagnostic"]["hookObserved"],report["committedWorkDiagnostic"]
        report["heapAfterGestures"]=perf.heap(page)
        report["finalVisibleCards"]=card_info()["visibleStoryCards"]
        assert not page.js("!!document.querySelector('[data-creative-workspace-node-id]')")
        if not previous:
            # New route to known canvas position, no old viewport or stale editor state.
            page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
            check("fresh canvas stories","!!document.querySelector('[data-node-id=story-0] [data-story-inline-summary]')",60)
            def open_story(id):
                portal='[data-creative-workspace-node-id="'+id+'"]'
                field=portal+" [data-story-textarea]"
                before=len(page.network_requests);start=time.monotonic()
                click('[data-node-id="'+id+'"] [data-story-inline-summary]')
                check("full "+id+" body, read only and lazy AI/history",
                    "(()=>{const p=document.querySelector("+q(portal)+"),e=p?.querySelector('[data-story-textarea]');return e?.readOnly&&e.value.length==="+str(samples[id]["characters"])+"&&e.value.startsWith("+q(samples[id]["preview"][:60])+")&&!p.querySelector('[aria-label=\"故事 AI 创作\"],[data-story-history-summary]')})()")
                return portal,field,{"node":id,"openMs":round((time.monotonic()-start)*1000,1),"requests":requests_since(before)}
            portal,field,reading=open_story("story-0")
            report["workspace10KB"]=reading
            click(".ant-modal-close");check("10KB workspace unmounted","!document.querySelector("+q(portal)+")")
            portal,field,reading=open_story("story-1")
            report["workspace100KB"]=reading
            payload_gets=[e for e in story_requests(reading["requests"]) if "/payload" in e["path"]]
            assert len(payload_gets)<=1 and all(e["method"]=="GET" and "nodeId=story-1" in e["path"] for e in payload_gets),payload_gets
            # Short edits with the actual Chrome keyboard never persist until Ctrl+S.
            click(portal+' [aria-label="编辑故事正文"]')
            page.js("document.querySelector("+q(field)+").focus();document.querySelector("+q(field)+").setSelectionRange("+str(samples["story-1"]["characters"])+","+str(samples["story-1"]["characters"])+")")
            before=len(page.network_requests)
            for _ in range(12):
                page.call("Input.insertText",{"text":"续"})
                time.sleep(.035)
            check("100KB draft changed locally","document.querySelector("+q(field)+").value.endsWith('续'.repeat(12))&&!!document.querySelector('[data-drama-pending-status]')")
            time.sleep(1.4)
            report["typingNetwork"]=requests_since(before)
            assert not write_requests(report["typingNetwork"]),report["typingNetwork"]
            before=len(page.network_requests)
            page.call("Input.dispatchKeyEvent",{"type":"keyDown","key":"s","code":"KeyS","modifiers":2,"windowsVirtualKeyCode":83})
            page.call("Input.dispatchKeyEvent",{"type":"keyUp","key":"s","code":"KeyS","modifiers":2,"windowsVirtualKeyCode":83})
            check("Ctrl+S saves long draft","document.querySelector("+q(field)+").readOnly&&!document.querySelector('[data-drama-pending-status]')")
            report["saveNetwork"]=requests_since(before)
            assert write_requests(report["saveNetwork"]),report["saveNetwork"]
            saved=page.js("""(async()=>{const r=await fetch('/api/v1/projects/"""+fixture["projectId"]+"""/drama-pipeline/payload?nodeId=story-1');const d=(await r.json()).payload;return {draft:d.dramaDraft.length,confirmed:d.dramaConfirmed.length,ends:d.dramaDraft.endsWith('续'.repeat(12))};})()""")
            assert saved=={"draft":samples["story-1"]["characters"]+12,"confirmed":samples["story-1"]["characters"],"ends":True},saved
            report["saveState"]=saved
            # Narrow, high-DPR reading and AI/History, with actual content size.
            page.call("Emulation.setDeviceMetricsOverride",{"width":800,"height":650,"deviceScaleFactor":1.5,"mobile":False})
            check("narrow workspace fits viewport","(()=>{const p=document.querySelector("+q(portal)+"),r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&p.clientWidth>250})()")
            button(portal,"AI 创作");button(portal,"改写")
            check("full 100KB rewrite is blocked before model calls","(()=>{const p=document.querySelector("+q(portal)+"),a=p.querySelector('[aria-label=\"故事 AI 创作\"]');return a?.textContent.includes('全文超出单次 AI 上下文限制')&&[...a.querySelectorAll('button')].find(b=>b.textContent==='生成候选')?.disabled&&a.scrollWidth<=a.clientWidth+2})()")
            # A manual selection is valid for local processing, without issuing a request.
            page.js("(()=>{const e=document.querySelector("+q(field)+");e.focus();e.setSelectionRange(0,40);e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true})()")
            check("bounded selection remains usable on 100KB story","(()=>{const a=document.querySelector('[aria-label=\"故事 AI 创作\"]');return a?.querySelector('[data-story-ai-scope]').textContent.includes('选区')&&![...a.querySelectorAll('button')].find(b=>b.textContent==='生成候选')?.disabled})()")
            button(portal,"收起 AI 创作")
            check("AI panel unmounted","!document.querySelector('[aria-label=\"故事 AI 创作\"]')")
            before=len(page.network_requests);button(portal,"影响与历史")
            check("history loaded lazily at high DPR","!!document.querySelector('[data-story-history-summary]')&&!!document.querySelector('[data-canvas-text-versions-inline]')")
            check("confirmed paragraphs collapsed by default","!document.querySelector('[data-story-history-summary] ol')")
            click(portal+" [data-story-paragraph-toggle]")
            check("history mounts first 30 paragraphs only","document.querySelectorAll('[data-story-history-summary] ol li').length===30")
            button(portal,"查看更多（30/"+str(samples["story-1"]["paragraphs"])+"）")
            check("history loads next 30 paragraphs only","document.querySelectorAll('[data-story-history-summary] ol li').length===60")
            report["narrowSourceLayout"]=page.js("""(()=>{const r=document.querySelector('[data-drama-history-layout]'),l=r.querySelector('[data-drama-impact-scroll]');return {layoutWidth:r.getBoundingClientRect().width,sourceWidth:l.getBoundingClientRect().width,sourceClientWidth:l.clientWidth,sourceScrollWidth:l.scrollWidth,sourceHeight:l.clientHeight,sourceScrollHeight:l.scrollHeight}})()""")
            print("STORY_S5_NARROW_SOURCE",q(report["narrowSourceLayout"]),flush=True)
            # clientWidth excludes a vertical scrollbar; compare the actual outer
            # boxes instead, then separately check for horizontal content overflow.
            check("narrow source scroll region uses the available content area","(()=>{const r=document.querySelector('[data-drama-history-layout]'),l=r.querySelector('[data-drama-impact-scroll]');return r.scrollWidth<=r.clientWidth+2&&l.scrollHeight>l.clientHeight&&Math.abs(l.getBoundingClientRect().width-r.getBoundingClientRect().width)<=2&&l.scrollWidth<=l.clientWidth+2})()")
            button(portal,"历史版本")
            check("narrow history version panel occupies full height and width","(()=>{const r=document.querySelector('[data-drama-history-layout]'),h=r.querySelector('[data-drama-history-fill]');return h.clientWidth>=r.clientWidth-2&&h.clientHeight>200})()")
            check("saved long history preview loads","!!document.querySelector('[data-canvas-text-versions-inline] pre')")
            report["narrowHistoryLayout"]=page.js("""(() => {
              const root=document.querySelector('[data-canvas-text-versions-inline]'),pre=root.querySelector('pre');
              const list=root.querySelector('[aria-label="已保存版本"]'),restore=root.querySelector('[aria-label="恢复为草案"]');
              restore.scrollIntoView({block:'nearest'});
              const r=restore.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
              return {previewHeight:pre.parentElement.clientHeight,listHeight:list.clientHeight,
                restoreHeight:r.height,restoreReachable:!!hit&&restore.contains(hit),
                restoreEnabled:!restore.disabled};
            })()""")
            print("STORY_S5_NARROW_HISTORY",q(report["narrowHistoryLayout"]),flush=True)
            assert report["narrowHistoryLayout"]["previewHeight"]>=32 and report["narrowHistoryLayout"]["listHeight"]>=24 and report["narrowHistoryLayout"]["restoreReachable"] and report["narrowHistoryLayout"]["restoreEnabled"],report["narrowHistoryLayout"]
            report["historyNetwork"]=requests_since(before)
            button(portal,"故事正文")
            check("history and AI unmounted on return","!document.querySelector('[data-story-history-summary],[data-canvas-text-versions-inline],[aria-label=\"故事 AI 创作\"]')")
            click(".ant-modal-close");check("100KB workspace unmounted","!document.querySelector("+q(portal)+")")
            # Return to a larger viewport and switch the actual theme control.
            page.call("Emulation.setDeviceMetricsOverride",{"width":1440,"height":900,"deviceScaleFactor":1.25,"mobile":False})
            check("toggle alternative canvas theme","(()=>{const b=[...document.querySelectorAll('button')].find(x=>['切换到浅色主题','切换到深色主题','Switch to light theme','Switch to dark theme'].includes(x.getAttribute('aria-label')));if(!b)return false;b.click();return true})()")
            click('[data-node-id=story-1] [data-story-inline-summary]')
            check("saved 100KB body reopened after theme change","document.querySelector("+q(field)+")?.readOnly&&document.querySelector("+q(field)+")?.value.endsWith('续'.repeat(12))")
            report["secondTheme"]=page.js("document.querySelector("+q(portal)+").dataset.dramaWorkspaceTheme")
            click(".ant-modal-close");check("second-theme workspace closed","!document.querySelector("+q(portal)+")")
            report["heapAfterWorkspace"]=perf.heap(page)
        report["browserExceptions"]=page.exceptions
        assert not page.exceptions,page.exceptions
        report["strictGesturePass"]=all(m["strictPass"] for m in report["measurements"])
        report["allApiRequests"]=len(requests_since(0))
        assert not any("/story-edit" in r["path"] or "enqueue" in r["path"] or "/jobs" in r["path"] and r["method"]=="POST" for r in requests_since(0))
        if output:output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        print("STORY_S5_REPORT",q(report),flush=True)
        return report
    except Exception:
        for log in logs:log.flush()
        for filename in ("backend.log","static.log","chrome.log"):
            file=root/filename
            if file.exists(): print(filename,file.read_text("utf-8",errors="replace")[-3000:],flush=True)
        if page:
            try:print("S5_DIAGNOSTIC",page.js("document.body.innerText.slice(-3000)"),flush=True)
            except Exception:pass
        raise
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for proc in reversed(processes):
            try:perf.kill_tree(proc)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--frontend-root",type=Path,default=ROOT)
    parser.add_argument("--previous",action="store_true",help="measure pre-S1 canvas only")
    parser.add_argument("--gpu",action="store_true")
    parser.add_argument("--enforce-targets",action="store_true",help="fail if any measured gesture misses the strict targets")
    parser.add_argument("--rounds",type=int,default=3,choices=range(3,13))
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    if args.output and not args.output.is_absolute():raise SystemExit("output_path_must_be_absolute")
    report=run(args.frontend_root.resolve(),args.previous,args.rounds,args.gpu,args.output)
    if args.enforce_targets and not report["strictGesturePass"]:raise SystemExit("S5 strict gesture targets not met")
