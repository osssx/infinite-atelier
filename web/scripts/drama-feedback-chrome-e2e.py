"""Actual Chrome feedback smoke using the isolated P1 fixture (deterministic model, no paid calls).
Checks current workspace entry points rather than historical inline editor selectors.
"""
import importlib.util
import json
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
spec=importlib.util.spec_from_file_location("drama_p1",ROOT/"scripts/drama-p1-chrome-e2e.py")
p1=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=p1
spec.loader.exec_module(p1)

def run():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-drama-p1-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=p1.port(),p1.port(),p1.port()
    env=dict(os.environ,ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port),
             ATELIER_DRAMA_P1_BROWSER_E2E="1",ATELIER_DRAMA_FEEDBACK_E2E="1")
    processes=[];logs=[];page=None;passed=[]
    def launch(name,args,e=env):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        p=subprocess.Popen(args,cwd=ROOT,env=e,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
        processes.append(p)
    def check(name,expr,timeout=20):
        value=p1.wait_for(lambda:page.js(expr),name,timeout)
        passed.append(name);print("FEEDBACK_BROWSER_ASSERT",name,flush=True);return value
    def click(label,scope):
        check("click "+label,"(()=>{const b=[...(document.querySelector(%s)?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()===%s&&!b.disabled&&b.getClientRects().length);if(!b)return false;b.click();return true})()"%(json.dumps(scope),json.dumps(label,ensure_ascii=False)))
    def close(portal):
        check("close workspace","(()=>{const b=document.querySelector('.ant-modal-close');if(!b||b.disabled)return false;b.click();return true})()")
        check("workspace and feedback unmounted","!document.querySelector("+json.dumps(portal)+")&&!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
    try:
        launch("backend",["node","scripts/drama-p1-browser-fixture.mjs"])
        fixture=p1.wait_for(lambda:json.loads((root/"p1-fixture.json").read_text("utf-8")) if (root/"p1-fixture.json").exists() else None,"fixture",45)
        front=f"http://127.0.0.1:{front_port}"
        launch("vite",["node","node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",str(front_port),"--strictPort"],dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        p1.wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"frontend",45)
        launch("chrome",[str(p1.cdp.CHROME),"--headless=new","--no-first-run","--no-default-browser-check",f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}","--window-size=1720,1050","about:blank"])
        p1.wait_for(lambda:p1.http_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=p1.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":1720,"height":1050,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("canvas ready","document.querySelectorAll('[data-drama-summary-kind]').length>=3",65)
        for node,label,appearance in (("assets","资产","dark"),("episodes","剧集","light"),("board","分镜","dark")):
            card='[data-node-id="'+node+'"]'
            portal='[data-creative-workspace-node-id="'+node+'"]'
            current=page.js("document.querySelector("+json.dumps(card+" [data-drama-summary-kind]")+")?.dataset.dramaCardTheme")
            if current!=appearance:
                theme="切换到浅色主题" if appearance=="light" else "切换到深色主题"
                check("switch theme "+appearance,"(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===%s);if(!b)return false;b.click();return true})()"%json.dumps(theme,ensure_ascii=False))
            click("打开完整编辑器 ↗",card)
            check("workspace "+node+" "+appearance,"document.querySelector("+json.dumps(portal)+")?.dataset.dramaWorkspaceTheme==="+json.dumps(appearance))
            check("no inherited feedback "+node,"!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
            if node=="board":
                check("select second episode","(()=>{const s=document.querySelector("+json.dumps(portal+' select[aria-label="选择分镜剧集"]',ensure_ascii=False)+");if(!s||s.disabled||!Array.from(s.options).some(o=>o.value==='ep-two'))return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'ep-two');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            click("生成"+label+"候选",portal)
            check("running task "+node,"!!document.querySelector('[data-drama-task-status]')")
            check("success toast themed "+node,"""(()=>{const r=document.querySelector(%s),t=r?.querySelector('[data-drama-feedback="success"]'),layer=r?.querySelector('[data-drama-feedback-toasts]');if(!t||!layer)return false;const a=r.getBoundingClientRect(),b=t.getBoundingClientRect();return b.width>0&&b.right<=a.right&&b.left>=a.left&&b.top>=a.top&&b.bottom<=a.bottom&&getComputedStyle(layer).position==='absolute'&&getComputedStyle(t).backgroundColor===getComputedStyle(r.querySelector('[data-drama-workspace-content]')).backgroundColor})()"""%json.dumps(portal),30)
            check("automatic candidate tab "+node,"""(()=>{const r=document.querySelector(%s);return [...(r?.querySelectorAll('nav button[aria-pressed="true"]')||[])].some(b=>b.textContent.trim().startsWith('生成候选'))&&!document.querySelector('[data-drama-task-status]')})()"""%json.dumps(portal))
            if node=="assets":
                check("asset candidate visible","document.querySelector("+json.dumps(portal+" [data-asset-candidate-review]")+")?.textContent.includes('验收道具')")
            else:
                check("newest run automatically expanded "+node,"""(()=>{const r=document.querySelector(%s),d=r?.querySelector('[data-drama-run-scroll-region] > details[open]');return d?.querySelector('summary')?.textContent.includes('待采用')&&d.textContent.includes(%s)})()"""%(json.dumps(portal),json.dumps("验收候选" if node=="episodes" else "浏览器实际触发",ensure_ascii=False)))
            close(portal)
        before=len([r for r in page.network_requests if "/drama-pipeline/runs" in r.get("path","")])
        time.sleep(3.4)
        after=len([r for r in page.network_requests if "/drama-pipeline/runs" in r.get("path","")])
        assert after==before,("polling after close",before,after)
        passed.append("no run polling after close")
        assert not page.exceptions,page.exceptions
        print("FEEDBACK_BROWSER_REPORT",json.dumps({"assertions":passed,"browserExceptions":page.exceptions,"providerPosts":0},ensure_ascii=False),flush=True)
    except Exception:
        if page:
            try:print("FEEDBACK_BROWSER_DIAGNOSTIC",page.text()[-2500:],flush=True)
            except Exception:pass
        for log in logs:
            try:log.flush();print(Path(log.name).name,Path(log.name).read_text("utf-8",errors="replace")[-1200:],flush=True)
            except Exception:pass
        raise
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for p in reversed(processes):
            try:p1.kill_tree(p)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)

if __name__=="__main__":run()
