"""Human-readable entry for the disposable local research server only."""
import hashlib
from fastapi import HTTPException
from fastapi.responses import HTMLResponse

MARKER = 'synthetic-federated-preview/v1'
HEADER = 'w11-local-synthetic-only'


def install(app, root, runtime, make_source):
    from backend.app.core.config import settings
    assert settings.APP_ENV == 'test'
    assert runtime.resolve().is_relative_to((root / '.codex-tmp').resolve())
    project_key = hashlib.sha256(str(root.resolve()).casefold().encode()).hexdigest()

    def mode():
        return {'service': MARKER, 'synthetic_only': True, 'training_enabled': bool(settings.FEDERATED_WORKER_ENABLED or getattr(app.state, 'federated_worker', None)),
                'project_key': project_key, 'store_id': runtime.name}

    def preview_only():
        if settings.FEDERATED_WORKER_ENABLED or getattr(app.state, 'federated_worker', None) is not None:
            raise HTTPException(409, '此入口只供不训练体验；当前执行器已开启，请关闭后再进入。')

    @app.get('/api/v1/__synthetic__/research-preview-mode')
    def preview_mode():
        return mode()

    @app.get('/__synthetic__/research-preview', response_class=HTMLResponse)
    def entry():
        preview_only()
        return HTMLResponse(ENTRY, headers={'Cache-Control': 'no-store'})

    @app.post('/api/v1/__synthetic__/research-preview-enter')
    def enter():
        preview_only()
        source = make_source(x_synthetic_test=HEADER)
        preview_only()
        if source.get('synthetic_only') is not True:
            raise HTTPException(409, '拒绝非合成体验身份。')
        return {**source, 'training_enabled': False}

    @app.get('/__synthetic__/research-workbench', response_class=HTMLResponse)
    def workbench():
        preview_only()
        html = (root / 'doctor-web/federated_workbench.html').read_text(encoding='utf8')
        html = html.replace('<head>', '<head><base href="/doctor-web/">'
            '<script>window.SMARTBRAIN_API_BASE_URL=location.origin+"/api/v1";</script>', 1)
        html = html.replace('href="doctor_patients.html"', 'href="/__synthetic__/research-preview"', 1)
        html = html.replace('<h1>', '<aside style="padding:16px;background:#e8f4ef;border-radius:12px">'
            '本机合成体验 · 训练执行器关闭。可创建、预检和停止未运行实验。'
            '<button id="previewHeartbeats" type="button">刷新三个节点在线状态</button>'
            '<span id="previewHeartbeatStatus" role="status"></span></aside><h1>', 1)
        html = html.replace('</body>', HEARTBEATS + '</body>', 1)
        return HTMLResponse(html, headers={'Cache-Control': 'no-store'})


ENTRY = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>合成研究体验</title>
<style>body{font:17px/1.7 system-ui;color:#294459;background:#f3f7fb;max-width:700px;margin:8vh auto;padding:24px}main{background:white;padding:32px;border-radius:20px}button{padding:14px 20px;border:0;border-radius:12px;background:#467c8d;color:white;font:inherit;cursor:pointer}button:disabled{opacity:.5}#status{min-height:3em}</style>
<main><h1>合成联邦研究体验</h1><p>使用临时合成身份、三个合成机构和已有合成资料，进入实际研究工作台。</p>
<p>可以查看项目和节点，创建实验、检查运行条件、查看预算，以及停止未启动的实验。</p>
<p><strong>此入口保持训练关闭。</strong>不会替换原HGST模型，不连接真实患者数据库。</p>
<button id="enter">进入合成研究工作台</button><p id="status" role="status"></p></main>
<script>
const button=document.querySelector('#enter'),status=document.querySelector('#status');
button.onclick=async()=>{button.disabled=true;status.textContent='正在连接合成研究环境；首次建立三节点合成资料可能需要稍等。';try{
 const response=await fetch('/api/v1/__synthetic__/research-preview-enter',{method:'POST'}),source=await response.json();
 if(!response.ok||source.synthetic_only!==true||source.training_enabled!==false||!source.researcher?.access_token||source.researcher.user?.role!=='researcher')throw Error(source.detail||'合成体验状态未通过核对。');
 localStorage.setItem('smartbrain_token',source.researcher.access_token);localStorage.setItem('smartbrain_user',JSON.stringify(source.researcher.user));
 location.assign('/__synthetic__/research-workbench');
}catch(error){status.textContent='未能进入：'+error.message;button.disabled=false;}};
</script></html>'''

HEARTBEATS = '''<script>(()=>{
 const button=document.querySelector('#previewHeartbeats'),status=document.querySelector('#previewHeartbeatStatus'),guard=window.SessionGuard,session=guard.captureSession();let active=true;
 const stop=()=>{active=false;button.disabled=true;status.textContent='';};window.addEventListener('pagehide',stop);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});guard.onInvalidated(stop);
 button.onclick=async()=>{if(!active)return;guard.assertCurrentSession(session);
 if(document.querySelector('#clinicalShell').hasAttribute('aria-busy')||document.querySelector('#clinicalPending').textContent.trim()){status.textContent='请先完成当前操作或核对待确认原件。';return;}
 button.disabled=true;status.textContent='正在核对各节点的原签名心跳…';try{
  const response=await fetch('/api/v1/__synthetic__/federated-heartbeats',{method:'POST',headers:{'X-Synthetic-Test':'w11-local-synthetic-only'}}),result=await response.json();
  guard.assertCurrentSession(session);if(!active)return;
  if(!response.ok||result.signed_heartbeats!==3)throw Error(result.detail||'尚未取得三个节点的确认。');
  status.textContent='三个节点已返回有效签名，正在重新读取实际状态。';button.disabled=false;document.querySelector('#clinicalRefresh').click();
 }catch(error){if(active)status.textContent='刷新未确认：'+error.message;}finally{if(active)button.disabled=false;}};
})();</script>'''
