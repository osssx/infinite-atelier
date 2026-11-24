"""P6 assets: real production SPA with disposable 200-node SQLite/CAS fixture."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("p34b",ROOT/"scripts/drama-p34b-chrome-perf.py")
perf=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=perf
spec.loader.exec_module(perf)

def run():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-p34b-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=perf.port(),perf.port(),perf.port()
    env=dict(os.environ,ATELIER_P34B_BROWSER_E2E="1",ATELIER_ASSET_P6_BROWSER_E2E="1",
        ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port))
    processes=[];logs=[];page=None
    passed=[]
    def launch(name,args):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        proc=subprocess.Popen(args,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
        processes.append(proc)
    def check(name,expr,timeout=20):
        perf.wait_for(lambda:page.js(expr),name,timeout)
        passed.append(name);print("P6_ASSET_BROWSER_ASSERT",name,flush=True)
    def click(selector):
        check("click "+selector,"""(()=>{const b=document.querySelector(%s);if(!b||b.disabled)return false;b.click();return true})()"""%json.dumps(selector,ensure_ascii=False))
    def button(label,scope):
        check("click "+label,"""(()=>{const b=[...(document.querySelector(%s)?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()===%s);if(!b||b.disabled)return false;b.click();return true})()"""%(json.dumps(scope),json.dumps(label,ensure_ascii=False)))
    portal='[data-creative-workspace-node-id="assets"]'
    card='[data-node-id="assets"] [data-drama-summary-kind="assets"]'
    def theme(appearance):
        current=page.js("document.querySelector("+json.dumps(card)+")?.dataset.dramaCardTheme")
        if current!=appearance:
            label="切换到浅色主题" if appearance=="light" else "切换到深色主题"
            english="Switch to light theme" if appearance=="light" else "Switch to dark theme"
            check("switch theme "+appearance,"""(()=>{const b=[...document.querySelectorAll('button')].find(x=>[%s,%s].includes(x.getAttribute('aria-label')));if(!b)return false;b.click();return true})()"""%(json.dumps(label,ensure_ascii=False),json.dumps(english)))
        check("card theme "+appearance,"document.querySelector("+json.dumps(card)+")?.dataset.dramaCardTheme==="+json.dumps(appearance))
    def open_workspace():
        click(card+' button[aria-label="打开资产规划完整编辑器"]')
        check("asset workspace mounted","!!document.querySelector("+json.dumps(portal+" [data-asset-workspace-fields]")+")")
    def close_workspace():
        click(".ant-modal-close")
        check("workspace unmounted","!document.querySelector("+json.dumps(portal)+")")
    try:
        launch("backend",["node","scripts/drama-p34b-browser-fixture.mjs"])
        fixture=perf.wait_for(lambda:json.loads((root/"p34b-fixture.json").read_text("utf-8")) if (root/"p34b-fixture.json").exists() else None,"fixture",45)
        front=f"http://127.0.0.1:{front_port}"
        launch("static",["node","scripts/drama-p34b-static-frontend.mjs","--port",str(front_port),"--backend",fixture["backendOrigin"],"--dist",str(ROOT/"dist")])
        perf.wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"frontend",30)
        launch("chrome",[str(perf.cdp.CHROME),"--headless=new","--no-first-run","--no-default-browser-check",
          f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}","--window-size=1720,1050","about:blank"])
        perf.wait_for(lambda:perf.get_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=perf.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":1720,"height":1050,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("asset card summary only","""(()=>{const c=document.querySelector(%s);return c?.textContent.includes('草案 50 项')&&!c.querySelector('textarea,[data-asset-workspace-fields]')})()"""%json.dumps(card),55)
        click(card+' button[aria-label="下一条摘要"]')
        check("asset card second entry","document.querySelector("+json.dumps(card)+")?.textContent.includes('道具 1')")
        for appearance in ("dark","light"):
            theme(appearance)
            open_workspace()
            check("theme and merged asset reference layout "+appearance,"""(()=>{const r=document.querySelector(%s);const panel=r?.querySelector('[aria-label="当前资产编辑区"]');const slot=panel?.querySelector('[data-asset-reference-slot="asset-1"]');const tabs=[...r.querySelectorAll('nav[aria-label="创作工作区功能"] button')].map(b=>b.textContent.trim());return r.dataset.dramaWorkspaceTheme===%s&&tabs.join('|')==='资产编辑|生成候选 · 12|影响与历史'&&panel?.textContent.includes('道具 1')&&!!slot&&getComputedStyle(panel).backgroundColor===getComputedStyle(r.querySelector('aside')).backgroundColor&&panel.clientHeight>0&&panel.scrollHeight>=panel.clientHeight&&!panel.querySelector('textarea')})()"""%(json.dumps(portal),json.dumps(appearance)))
            if appearance=="dark":close_workspace()
        click(portal+' button[aria-label="资产下一页"]')
        check("directory next page","document.querySelector("+json.dumps(portal+" aside")+")?.textContent.includes('2/5')")
        button("生成候选 · 12",portal)
        check("candidate list bounded and scrollable","""(()=>{const r=document.querySelector('[data-asset-candidate-scroll-region]');return r&&r.querySelectorAll('section').length===12&&r.scrollHeight>r.clientHeight&&getComputedStyle(r).overflowY==='auto'})()""")
        button("筛选项全部新增",portal)
        check("all twelve selected","document.querySelector('[data-asset-review-toolbar]')?.textContent.includes('待合入 12')")
        button("合入所选资产",portal)
        check("real atomic adoption locates new asset","""(()=>{const r=document.querySelector(%s);return r?.querySelector('[aria-label="当前资产编辑区"]')?.textContent.includes('待审核道具 0')&&r?.querySelector('aside')?.textContent.includes('6/7')})()"""%json.dumps(portal),35)
        click(portal+' button[aria-label="编辑资产描述"]')
        check("controlled edit","""(()=>{const t=document.querySelector(%s);if(!t)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'P6 浏览器 CAS 验收描述');t.dispatchEvent(new Event('input',{bubbles:true}));return true})()"""%json.dumps(portal+' textarea[aria-label="资产描述"]'))
        click(portal+' button[aria-label="确认资产描述"]')
        check("CAS edit saved","""(()=>{const r=document.querySelector(%s);return r?.querySelector('[data-asset-field="description"][data-asset-field-mode="reading"]')?.textContent.includes('P6 浏览器 CAS 验收描述')})()"""%json.dumps(portal),35)
        check("actual backend state verified","""(async()=>{const r=await fetch('/api/v1/projects/%s/drama-pipeline/payload?nodeId=assets');const d=await r.json();const a=JSON.parse(d.payload.dramaDraft);const c=JSON.parse(d.payload.dramaConfirmed);return r.ok&&a.assets.length===62&&c.assets.length===50&&a.assets.some(x=>x.name==='待审核道具 0'&&x.description==='P6 浏览器 CAS 验收描述')&&!d.payload.dramaAssetCandidate})()"""%fixture["projectId"])
        close_workspace()
        check("no asset editor in canvas","!document.querySelector("+json.dumps(card+" [data-asset-workspace-fields]")+")")
        assert not page.exceptions,page.exceptions
        print("P6_ASSET_BROWSER_REPORT",json.dumps({"passed":passed,"browserExceptions":page.exceptions,"isolation":"temporary SQLite/CAS, no online models"},ensure_ascii=False),flush=True)
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for proc in reversed(processes):
            try:perf.kill_tree(proc)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)

if __name__=="__main__":run()
