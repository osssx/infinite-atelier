"""P3.4b real Chrome + live Fastify/SQLite/CAS performance baseline.
No fake DOM, no mocked API, no paid model; never uses the user's dataset.
Usage: python scripts/drama-p34b-chrome-perf.py [--output ABSOLUTE.json]
"""
from __future__ import annotations
import importlib.util
import json
import os
from collections import Counter
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/"scripts"/"p45f-chrome-browser-e2e.py"
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("p34b_chrome_cdp",BASE)
cdp=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=cdp
spec.loader.exec_module(cdp)
ChromeCDP=cdp.ChromeCDP
wait_for=cdp.wait_for
kill_tree=cdp.kill_tree

def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0))
        return sock.getsockname()[1]

def get_json(url):
    with urllib.request.urlopen(url,timeout=3) as response:
        return json.load(response)

def js(page,expression):
    return page.js(expression)

def start_probe(page,label):
    started=js(page, """(() => {
      if(window.__p34bPerf?.active)return false;
      const state={label:%s,active:true,deltas:[],longTasks:[],last:null,
        startedAt:performance.now(),startWall:Date.now()};
      try{state.observer=new PerformanceObserver(list=>{
        for(const entry of list.getEntries())state.longTasks.push(entry.duration);
      });state.observer.observe({entryTypes:['longtask']});}
      catch(e){state.longTaskUnsupported=String(e);}
      function frame(timestamp){
        if(!state.active)return;
        if(state.last!==null)state.deltas.push(timestamp-state.last);
        state.last=timestamp;
        requestAnimationFrame(frame);
      }
      window.__p34bPerf=state;
      requestAnimationFrame(frame);
      return true;
    })()"""%json.dumps(label))
    if not started:raise AssertionError("probe_already_running")

def stop_probe(page):
    return js(page,"""(() => {
      const s=window.__p34bPerf;
      if(!s||!s.active)return null;
      s.active=false;s.observer?.disconnect();
      const a=s.deltas.filter(x=>x>0).sort((x,y)=>x-y);
      const at=p=>a[Math.floor((a.length-1)*p)]||0;
      const duration=a.reduce((sum,v)=>sum+v,0);
      return {scenario:s.label,frames:a.length,durationMs:duration,
       fps:duration>0?a.length*1000/duration:0,p50Ms:at(.5),p95Ms:at(.95),
       p99Ms:at(.99),maxMs:a[a.length-1]||0,over33Ms:a.filter(x=>x>33.4).length,
       over50Ms:a.filter(x=>x>50).length,
       longTaskCount:s.longTasks.length,longTaskMaxMs:Math.max(0,...s.longTasks),
       longTaskUnsupported:s.longTaskUnsupported||null,
       wallElapsedMs:Date.now()-s.startWall};
    })()""")

def renderer_metrics(page):
    metrics=page.call("Performance.getMetrics",{}).get("metrics",[])
    names={"TaskDuration","ScriptDuration","LayoutDuration","RecalcStyleDuration","LayoutCount","RecalcStyleCount","Nodes","JSHeapUsedSize"}
    return {m["name"]:m["value"] for m in metrics if m.get("name") in names}

def heap(page):
    page.call("HeapProfiler.collectGarbage",{})
    metrics=page.call("Performance.getMetrics",{}).get("metrics",[])
    return next((m["value"] for m in metrics if m.get("name")=="JSHeapUsedSize"),None)

def scope_click(page,stage,label):
    return bool(js(page,"""(() => {
      const root=document.querySelector('[data-node-id=%s]');
      const section=root?.querySelector('[aria-label=%s]');
      const button=section?.querySelector('button[aria-expanded]');
      if(!button)return false;
      if(button.getAttribute('aria-expanded')==='false')button.click();
      return true;
    })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False))))

def sample_center(page):
    return js(page,"""(() => {
      const root=document.querySelector('[data-node-id="board"]');
      const container=root?.closest('div.relative.h-full.w-full.select-none.overflow-hidden');
      const r=container?.getBoundingClientRect();
      if(!r)return null;
      return {x:Math.round(r.left+r.width*.6),y:Math.round(r.top+r.height*.57),
       width:r.width,height:r.height,
       renderedNodes:document.querySelectorAll('[data-node-id]').length};
    })()""")

def screenshot_metadata(page):
    return js(page,"""(() => ({
      width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
      visibility:document.visibilityState,hardwareConcurrency:navigator.hardwareConcurrency,
      ua:navigator.userAgent,heap:performance.memory?.usedJSHeapSize??null,
      board:!!document.querySelector('[data-node-id="board"]'),
      renderedNodes:document.querySelectorAll('[data-node-id]').length,
      canvases:document.querySelectorAll('canvas').length,
      glRenderer:(()=>{const gl=document.createElement('canvas').getContext('webgl');
        if(!gl)return 'webgl-unavailable';
        const info=gl.getExtension('WEBGL_debug_renderer_info');
        return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);})()
    }))()""")

def run_workspace_tab_pressure(page):
    """Three real tab mounts against isolated workbench data; no generation posts."""
    def click(label,selector):
        return bool(js(page,"""(() => {
           const root=document.querySelector(%s);
           const button=[...(root?.querySelectorAll('button')||[])].find(b=>
             (b.textContent||'').trim()===%s);
           if(!button||button.disabled)return false;
           button.click();return true;
        })()"""%(json.dumps(selector),json.dumps(label,ensure_ascii=False))))
    card='[data-node-id="board"] [aria-label="分镜配置摘要"]'
    portal='[data-creative-workspace-node-id="board"]'
    before=len(page.network_requests)
    start=time.monotonic()
    assert wait_for(lambda:click("打开完整编辑器 ↗",card),
                    "open storyboard workspace",20)
    wait_for(lambda:bool(js(page,"!!document.querySelector("+json.dumps(portal)+")")),
             "storyboard workspace mounted",45)
    results=[{"tab":"editor","latencyMs":round((time.monotonic()-start)*1000,1)}]
    for label,name in (("视频配置","video"),("生成候选","runs"),("影响与历史","history")):
        start=time.monotonic()
        assert wait_for(lambda:click(label,portal),"open "+name+" tab",20)
        wait_for(lambda:bool(js(page,"""(() => {
            const root=document.querySelector(%s);
            const active=[...(root?.querySelectorAll('nav button')||[])].find(b=>
                b.getAttribute('aria-pressed')==='true');
            return (active?.textContent||'').trim()===%s;
        })()"""%(json.dumps(portal),json.dumps(label,ensure_ascii=False)))),name+" tab settled",20)
        time.sleep(.18)
        results.append({"tab":name,"latencyMs":round((time.monotonic()-start)*1000,1),
                        "domNodes":js(page,"document.querySelectorAll('*').length")})
    runs_open=len([item for item in page.network_requests if "/drama-pipeline/runs" in item.get("path","")])
    js(page,"document.querySelector('.ant-modal-close')?.click();true")
    wait_for(lambda:not js(page,"!!document.querySelector("+json.dumps(portal)+")"),
             "storyboard workspace closed",25)
    time.sleep(3.3)
    runs_closed=len([item for item in page.network_requests if "/drama-pipeline/runs" in item.get("path","")])
    assert runs_open==runs_closed,("runs_polling_leaked_after_close",runs_open,runs_closed)
    writes=[item for item in page.network_requests[before:] if item.get("method") in ("POST","PATCH","DELETE")]
    assert not writes,("workspace_tabs_unexpected_write",writes)
    return {"scenarios":results,"runsRequestsAfterClose":runs_closed-runs_open,
        "apiRequests":len(page.network_requests)-before,
        "closedEditorUnmounted":True,"afterCloseHeapBytes":heap(page)}

def run(output=None,gpu=False,mode="development",frontend_root=ROOT,rounds=3,cpu_profile=False,label="current",workspace_tabs=False):
    if not cdp.CHROME.exists():raise AssertionError("Chrome not installed:"+str(cdp.CHROME))
    if mode not in ("development","production") or rounds<3 or rounds>12:raise ValueError("invalid p34b measurement configuration")
    frontend_root=Path(frontend_root).resolve()
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-p34b-browser-"))
    chrome_profile=root.parent/(root.name+"-chrome-profile")
    backend_port,vite_port,chrome_port=port(),port(),port()
    assert len({backend_port,vite_port,chrome_port})==3
    env=dict(os.environ,ATELIER_P34B_BROWSER_E2E="1",
             ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port))
    processes=[]
    logs=[]
    page=None
    report={"schemaVersion":2,"stage":"P3.4b5","label":label,"mode":mode,"rounds":rounds,
            "frontendRoot":str(frontend_root),"fixture":None,"environment":None,
            "scenarios":[],"scopes":[],"memory":{},"network":{},"strictTargets":
            {"fpsMin":58,"p95MaxMs":18,"p99MaxMs":33.4,"longTaskMax":0},
            "caveat":"Headless Chrome baseline: compare its WebGL renderer and blank-page cadence before extrapolating to desktop GPU."}
    def launch(name,argv,environment,cwd=ROOT):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace")
        logs.append(log)
        proc=subprocess.Popen(argv,cwd=cwd,env=environment,stdin=subprocess.DEVNULL,
                              stdout=log,stderr=subprocess.STDOUT)
        processes.append(proc)
        return proc
    try:
        launch("backend",["node","scripts/drama-p34b-browser-fixture.mjs"],env)
        fixture=wait_for(lambda:json.loads((root/"p34b-fixture.json").read_text("utf-8"))
                          if (root/"p34b-fixture.json").exists() else None,"p34b fixture backend",60)
        report["fixture"]=fixture
        assert fixture["nodes"]==200 and fixture["shots"]==100 and fixture["assets"]==50
        wait_for(lambda:urllib.request.urlopen(fixture["backendOrigin"]+"/health",timeout=2).status==200,
                 "backend health",20)
        front=f"http://127.0.0.1:{vite_port}"
        if mode=="development":
            launch("vite",["node",str(ROOT/"node_modules/vite/bin/vite.js"),
              "--host","127.0.0.1","--port",str(vite_port),"--strictPort"],
              dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]),cwd=frontend_root)
        else:
            dist=frontend_root/"dist"
            if not (dist/"index.html").exists():raise AssertionError("production_build_required:"+str(dist))
            launch("static",["node",str(ROOT/"scripts/drama-p34b-static-frontend.mjs"),
              "--port",str(vite_port),"--backend",fixture["backendOrigin"],"--dist",str(dist)],env)
        wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"vite ready",60)
        launch("chrome",[str(cdp.CHROME),"--headless=new",*([] if gpu else ["--disable-gpu"]),
         "--enable-precise-memory-info","--no-default-browser-check","--no-first-run",
         f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
         f"--user-data-dir={chrome_profile}","--window-size=2048,1152","about:blank"],env)
        chrome_version=wait_for(lambda:get_json(f"http://127.0.0.1:{chrome_port}/json/version"),
                                 "chrome CDP",35)
        page=ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",
         {"width":2048,"height":1152,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Performance.enable",{})
        page.call("HeapProfiler.enable",{})
        # Blank-page cadence is diagnostic ONLY. Never normalize app pass/fail.
        start_probe(page,"blank")
        time.sleep(3.3)
        idle=stop_probe(page)
        report["blankBaseline"]=idle
        path=front+"/canvas/"+fixture["projectId"]
        page.call("Page.navigate",{"url":path})
        wait_for(lambda:js(page,"document.readyState")=="complete","Chrome page loaded",50)
        wait_for(lambda:js(page,"document.querySelector('[data-node-id=board]')!==null"),
                 "real canvas board mounted",65)
        loaded=js(page,"""(async()=>{const r=await fetch('/api/v1/projects/p34b-browser-200?creative=summary');
          const d=await r.json();return {
          ok:r.ok,status:r.status,nodes:d.document?.nodes?.length,
          hasBoard:d.document?.nodes?.some(n=>n.id==='board'),
          hasCreativeInlineBodies:d.document?.nodes?.some(n=>['assets','episodes','board'].includes(n.id)&&
            (Object.hasOwn(n.metadata||{},'dramaDraft')||Object.hasOwn(n.metadata||{},'dramaConfirmed'))),
          hasCreativePointers:d.document?.nodes?.filter(n=>['assets','episodes','board'].includes(n.id)&&
            n.metadata?.creativePayloadRef).length,
          payloadBytes:JSON.stringify(d).length};})()""")
        assert loaded["ok"] and loaded["nodes"]==200 and loaded["hasBoard"],loaded
        assert loaded["hasCreativePointers"]==3 and loaded["hasCreativeInlineBodies"] is False,loaded
        report["projectLoad"]=loaded
        report["environment"]={"chrome":chrome_version.get("Browser"),**screenshot_metadata(page),
          "launchFlags":["--headless=new",*([] if gpu else ["--disable-gpu"]),"--enable-precise-memory-info"],
          "viewportCss":{"width":2048,"height":1152},"targetDPR":1.25}
        assert report["environment"]["dpr"]==1.25,report["environment"]
        report["memory"]["afterLoadHeapBytes"]=heap(page)
        # P3.3 lazy nodes: browsing one page must issue scoped backend requests.
        for stage,count,label in (("assets",50,"资产"),("episodes",4,"剧集")):
            began=time.monotonic()
            if stage=="episodes":
                # P3.4b2: the episode card is now a scoped summary, not a
                # mounted editor or a manually opened scope browser.
                wait_for(lambda:bool(js(page,"""(() => {
                  const card=document.querySelector('[data-node-id=episodes] [aria-label="剧集规划摘要"]');
                  return card&&(card.textContent||'').includes('已规划 4 集') &&
                      !card.querySelector('textarea');
                })()""")),"lightweight episodes summary",40)
            else:
                wait_for(lambda:scope_click(page,stage,label),"open "+label+" scope",40)
                wait_for(lambda:bool(js(page,"""(() => {
                  const el=document.querySelector('[data-node-id=%s] [aria-label=%s]');
                  return el&&(el.textContent||'').includes(%s);
                })()"""%(json.dumps(stage),
                    json.dumps(label+"独立存储分页浏览",ensure_ascii=False),
                    json.dumps(label+"共 "+str(count)+" 项",ensure_ascii=False)))),
                    label+" backend paged scope",35)
            elapsed=(time.monotonic()-began)*1000
            scoped=[req for req in page.network_requests if
               "/drama-pipeline/revision-scope" in req.get("path","") and "nodeId="+stage in req.get("path","")]
            assert scoped and all(req["method"]=="GET" for req in scoped),scoped
            # Authenticated real HTTP fetch checks the bounded payload size.
            api=js(page,"""(async()=>{const r=await fetch(%s);
             const body=await r.text();const d=JSON.parse(body);return {
               ok:r.ok,bytes:new Blob([body]).size,entries:d.entries.length,total:d.total,
               hasWholeDraft:body.includes('dramaDraft')};})()"""%json.dumps(
              f"/api/v1/projects/{fixture['projectId']}/drama-pipeline/revision-scope?nodeId={stage}&draft=false&offset=0&limit=10"))
            assert api["ok"] and api["total"]==count and api["entries"]<=10 and not api["hasWholeDraft"],api
            report["scopes"].append({"stage":stage,"uiVisibleMs":elapsed,"requests":len(scoped),**api})
        # Change to the next asset page using real React UI.
        advance=js(page,"""(() => {
          const s=document.querySelector('[data-node-id=assets] [aria-label="资产独立存储分页浏览"]');
          const b=[...(s?.querySelectorAll('button')||[])].find(x=>(x.textContent||'').trim()==='下一页');
          if(!b||b.disabled)return false;
          b.click();return true;
        })()""")
        assert advance,"asset next-page button missing"
        wait_for(lambda:bool(js(page,"""(() => {
          const s=document.querySelector('[data-node-id=assets] [aria-label="资产独立存储分页浏览"]');
          return (s?.textContent||'').includes('11–20') && (s?.textContent||'').includes('道具 10');
        })()""")),"asset page 11–20",30)
        assert any("offset=10" in req.get("path","") for req in page.network_requests),"asset page did not request paged offset"
        report["memory"]["afterScopeHeapBytes"]=heap(page)
        # P3.4b2: selection lives in a fixed-height summary card. Full
        # storyboard editing, runs and video Config must remain unmounted.
        wait_for(lambda:bool(js(page,"""(() => {
          const root=document.querySelector('[data-node-id=board] [aria-label="分镜配置摘要"]');
          return root && !!root.querySelector('select[aria-label="摘要选择剧集"]') &&
              !root.querySelector('textarea');
        })()""")),"P3.4b2 scoped storyboard summary",40)
        assert not js(page,"""document.querySelector('[data-creative-workspace-node-id]')!==null"""),"full editor unexpectedly mounted"
        board_state=js(page,"""(() => {
          const b=document.querySelector('[data-node-id=board]');
          const selects=[...(b?.querySelectorAll('select')||[])];
          return selects.map(s=>({label:s.getAttribute('aria-label'),options:s.options.length,
            values:[...s.options].map(o=>o.value).slice(0,5)}));
        })()""")
        report["boardSelectors"]=board_state
        # Repeat real episode navigation while the board remains visible; heap measured after GC.
        for i in range(15):
            js(page,"""(() => {
              const select=document.querySelector('[data-node-id=board] select[aria-label="摘要选择剧集"]');
              if(select&&select.options.length>1){
                const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
                set.call(select,select.options[(%d+1)%%select.options.length].value);
                select.dispatchEvent(new Event('change',{bubbles:true}));
              }
            })()"""%i)
            time.sleep(.07)
        time.sleep(.65)
        report["memory"]["afterRepeatedScopesHeapBytes"]=heap(page)
        selected=js(page,"""(() => {
          const select=document.querySelector('[data-node-id=board] select[aria-label="摘要选择剧集"]');
          return {value:select?.value??null,options:select?.options.length??0};
        })()""")
        assert selected["options"]==4 and selected["value"] in ("ep-0","ep-1","ep-2","ep-3"),selected
        report["storyboardEpisodeSwitch"]=selected
        report["memory"]["beforeGesturesHeapBytes"]=heap(page)
        center=sample_center(page)
        assert center and center["width"]>200 and center["renderedNodes"]>=3,center
        # Real CDP hardware-style input, not synthetic DOM dispatch or direct transform.
        if cpu_profile:
            page.call("Profiler.enable",{})
            page.call("Profiler.start",{})
        for kind in ("pan","zoom"):
            for round_id in range(1,rounds+1):
                cpu_before=renderer_metrics(page)
                start_probe(page,kind+"-"+str(round_id))
                x,y=center["x"],center["y"]
                if kind=="pan":
                    page.call("Input.dispatchMouseEvent",{"type":"mousePressed","x":x,"y":y,
                      "button":"middle","buttons":4,"clickCount":1})
                    for i in range(72):
                        dx=round(110*__import__("math").sin(i/12))
                        dy=round(68*__import__("math").cos(i/15))
                        page.call("Input.dispatchMouseEvent",{"type":"mouseMoved",
                          "x":x+dx,"y":y+dy,"button":"middle","buttons":4})
                        time.sleep(.013)
                    page.call("Input.dispatchMouseEvent",{"type":"mouseReleased",
                      "x":x,"y":y,"button":"middle","buttons":0,"clickCount":1})
                else:
                    for i in range(65):
                        page.call("Input.dispatchMouseEvent",{"type":"mouseWheel","x":x,
                          "y":y,"deltaX":0,"deltaY":-14 if i%20<10 else 14,
                          "modifiers":0})
                        time.sleep(.015)
                time.sleep(.22)
                measure=stop_probe(page)
                cpu_after=renderer_metrics(page)
                measure["engineMetricsDelta"]={key:round(cpu_after.get(key,0)-before,5)
                  for key,before in cpu_before.items() if key in cpu_after and key!="JSHeapUsedSize"}
                if not measure or measure["frames"]<20:raise AssertionError("not enough visible frames:"+str(measure))
                target=report["strictTargets"]
                measure["strictPass"]=(measure["fps"]>=target["fpsMin"] and
                    measure["p95Ms"]<=target["p95MaxMs"] and
                    measure["p99Ms"]<=target["p99MaxMs"] and
                    measure["longTaskCount"]==0)
                report["scenarios"].append(measure)
                print("P34B_BROWSER_ROUND",json.dumps(measure,ensure_ascii=False),flush=True)
        if cpu_profile:
            sampling=page.call("Profiler.stop",{}).get("profile",{})
            nodes={n["id"]:n.get("callFrame",{}) for n in sampling.get("nodes",[])}
            sample_counts=Counter(sampling.get("samples",[]))
            ranked=[]
            for node_id,count in sample_counts.most_common(22):
                frame=nodes.get(node_id,{})
                ranked.append({"samples":count,"function":frame.get("functionName"),
                    "url":frame.get("url"),"line":frame.get("lineNumber")})
            report["cpuProfile"]={"samples":sum(sample_counts.values()),"topSelfSamples":ranked}
            page.call("Profiler.disable",{})
        report["memory"]["afterGesturesHeapBytes"]=heap(page)
        report["memory"]["growthAfterGCBytes"]=report["memory"]["afterGesturesHeapBytes"]-report["memory"]["afterLoadHeapBytes"]
        report["environment"]["finalVisibleDomNodes"]=js(page,"document.querySelectorAll('[data-node-id]').length")
        report["network"]={"totalApiRequests":len(page.network_requests),
          "scopedRequests":len([x for x in page.network_requests if "revision-scope" in x.get("path","")]),
          "writeRequests":[x for x in page.network_requests if x.get("method") in ("POST","PATCH","DELETE")],
          "browserExceptions":page.exceptions}
        assert not any("enqueue" in x.get("path","") or "/jobs" in x.get("path","")
          for x in report["network"]["writeRequests"]),report["network"]
        if workspace_tabs:
            report["workspaceTabs"]=run_workspace_tab_pressure(page)
            print("P34B_WORKSPACE_TAB_PRESSURE",json.dumps(report["workspaceTabs"],ensure_ascii=False),flush=True)
        report["strictPass"]=all(x["strictPass"] for x in report["scenarios"])
        report["roundsPerGesture"]=rounds
        report["result"]="pass" if report["strictPass"] else "below-target"
        report["isolation"]="Temporary SQLite + CAS, temporary Chrome profile, no configured model, no ComfyUI calls."
        if output:
            output.parent.mkdir(parents=True,exist_ok=True)
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        print("P34B_REAL_CHROME_PERF_REPORT",json.dumps(report,ensure_ascii=False),flush=True)
        return report
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for proc in reversed(processes):
            try:kill_tree(proc)
            except Exception:pass
        for log in logs:
            try:log.close()
            except Exception:pass
        import shutil
        shutil.rmtree(root,ignore_errors=True)
        shutil.rmtree(chrome_profile,ignore_errors=True)

if __name__=="__main__":
    import argparse
    parser=argparse.ArgumentParser(description="P3.4b5 isolated real Chrome benchmark")
    parser.add_argument("--output",type=Path)
    parser.add_argument("--gpu",action="store_true")
    parser.add_argument("--enforce-targets",action="store_true")
    parser.add_argument("--mode",choices=["development","production"],default="development")
    parser.add_argument("--frontend-root",type=Path,default=ROOT)
    parser.add_argument("--rounds",type=int,default=3)
    parser.add_argument("--cpu-profile",action="store_true")
    parser.add_argument("--workspace-tabs",action="store_true")
    parser.add_argument("--label",default="current")
    args=parser.parse_args()
    if args.output and not args.output.is_absolute():raise SystemExit("output_path_must_be_absolute")
    measured=run(args.output,gpu=args.gpu,mode=args.mode,frontend_root=args.frontend_root,
                 rounds=args.rounds,cpu_profile=args.cpu_profile,label=args.label,workspace_tabs=args.workspace_tabs)
    if args.enforce_targets and not measured["strictPass"]:
        raise SystemExit("P34B_STRICT_PERFORMANCE_BELOW_TARGET")
