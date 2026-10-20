"""Loopback-only competition demo using the current, unmodified business API."""
from __future__ import annotations

import argparse
from html import escape
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests/web'))
from competition_demo_runtime import SERVICE, environment, fingerprint, prepare


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--port', type=int, default=8770)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Invalid loopback port.')
    store, meta = prepare(ROOT, args.runtime)
    os.environ.update(environment(ROOT, store, meta, os.environ))
    os.environ['BACKEND_CORS_ORIGINS'] = f'http://127.0.0.1:{args.port},http://localhost:{args.port}'
    baseline = store / 'original-files-before.json'
    if not baseline.exists():
        baseline.write_text(json.dumps({name: fingerprint(ROOT / name) for name in
            ('backend/app.db', 'backend/models/hgst_adhd_bundle.pt')}, indent=2), encoding='utf-8')

    # Import only after every writable path and external-service setting is isolated.
    from fastapi.responses import FileResponse, HTMLResponse, Response
    from fastapi.testclient import TestClient
    import uvicorn
    from backend.app.main import app
    from backend.app.core.config import settings
    from competition_fixture import provision
    from competition_imaging_fixture import provision_imaging

    @app.middleware('http')
    async def demo_same_origin_web(request, call_next):
        response = await call_next(request)
        # The production web clients support explicit API bases. Inject those
        # on this isolated service only, before their modules execute. Their
        # normal static-development fallback to :8000 must never cross stores.
        if (request.method == 'GET' and response.status_code == 200
                and request.url.path.startswith(('/doctor-web/', '/patient-web/'))
                and 'text/html' in response.headers.get('content-type', '')):
            body = b''.join([part async for part in response.body_iterator])
            config = (b"<script>window.SMARTBRAIN_API_BASE_URL=location.origin+'/api/v1';"
                      b"window.FINDVIZ_BASE_PATH=location.origin+'/findviz';</script>")
            body = body.replace(b'<head>', b'<head>' + config, 1)
            headers = {key: value for key, value in response.headers.items()
                       if key.lower() not in {'content-length', 'etag', 'last-modified'}}
            headers['cache-control'] = 'no-store'
            return Response(body, status_code=200, headers=headers)
        return response

    source_path = store / 'source.json'
    if source_path.is_file():
        source = json.loads(source_path.read_text(encoding='utf-8'))
        if source.get('synthetic_only') is not True:
            raise ValueError('Invalid synthetic seed receipts.')
    else:
        print('Preparing synthetic accounts and real API workflow...', flush=True)
        with TestClient(app) as client:
            source = provision(client, store, ROOT)
            source['imaging'] = provision_imaging(client,
                {'Authorization': 'Bearer ' + source['accounts']['doctor']['access_token']},
                {'Authorization': 'Bearer ' + source['accounts']['followup']['access_token']},
                source['scenarios']['followup']['patient_id'], store, ROOT)
        source_path.write_text(json.dumps(source, ensure_ascii=False, indent=2), encoding='utf-8')

    # Real event consumers must continue for new actions after provisioning.
    settings.CARE_WORKER_ENABLED = True
    settings.AGENT_WORKER_ENABLED = True
    os.environ.update(CARE_WORKER_ENABLED='true', AGENT_WORKER_ENABLED='true')
    origin = f'http://127.0.0.1:{args.port}'
    runtime_info = {**meta, 'port': args.port, 'url': origin + '/__synthetic__/competition',
                    'runtime': str(store), 'pid': os.getpid(), 'training_performed': False,
                    'external_ai_enabled': False}
    (store / 'running.json').write_text(json.dumps(runtime_info, ensure_ascii=False, indent=2), encoding='utf-8')

    @app.get('/api/v1/__synthetic__/competition-info', include_in_schema=False)
    def demo_info():
        return runtime_info

    assets = source['imaging']['assets']

    @app.get('/__synthetic__/assets/{kind}', include_in_schema=False)
    def synthetic_asset(kind: str):
        from fastapi import HTTPException
        if kind not in assets:
            raise HTTPException(404)
        path = Path(assets[kind]['path']).resolve()
        if not path.is_relative_to(store / 'synthetic-imaging') or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, filename=path.name)

    @app.get('/__synthetic__/competition', response_class=HTMLResponse, include_in_schema=False)
    def portal():
        rows = []
        roles = {'doctor': '医生：审核、发布意见与计划', 'review': '用户小禾：待审核与补问',
                 'followup': '用户小安：已发布意见、计划与随访'}
        for key, account in source['accounts'].items():
            rows.append('<tr><td>' + escape(roles[key]) + '</td><td>' + escape(account['email'])
                        + '</td><td><code>' + escape(account['password']) + '</code></td></tr>')
        review, followup = source['scenarios']['review'], source['scenarios']['followup']
        html = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>知行合医 · 竞赛演示</title>
<style>body{font:17px/1.75 "Microsoft YaHei",sans-serif;color:#243e4d;background:#f4f7fa;
max-width:1040px;margin:32px auto;padding:0 24px}section{background:white;padding:24px;margin:18px 0;border-radius:18px}
h1,h2{line-height:1.4}a{color:#356b80}table{border-collapse:collapse;width:100%}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}
code{font-size:16px;overflow-wrap:anywhere}.notice{background:#fff4d7;padding:14px;border-radius:12px}button{padding:9px 16px}</style>
</head><body><h1>知行合“医” · 独立演示入口</h1>
<p class="notice">本入口全部使用合成身份、合成作答及合成影像，仅供功能演示。真实服务与原数据库保持独立。
本机规则助手可用；未开启外部智能服务、真实微信投递及训练。</p>
<section><h2>1. 登录演示账号</h2><table><tr><th>用途</th><th>邮箱</th><th>密码（仅合成账号）</th></tr>ROWS</table>
<p><a href="/patient-web/login.html" target="_blank">打开用户网页登录</a>　
<a href="/doctor-web/login.html" target="_blank">打开医生网页登录</a></p>
<p>网页和小程序共用以上账号。小程序登录页 → 服务器设置 → 填写 <strong>ORIGIN</strong> 并确认；
角色选择“用户”或“医生”。恢复日常使用时将地址改回原服务。</p></section>
<section><h2>2. 顺着两组状态演示</h2>
<p><strong>小禾（档案 REVIEW_PID / 评估 REVIEW_AID）：</strong>已实际保存量表和六项认知提交，医生已发具体补问。
用户打开本轮评估并答复 → 医生读取原件与答复、保存审核、明确发布意见 → 发布计划 → 用户阅读收悉并记录。</p>
<p><strong>小安（档案 FOLLOWUP_PID / 评估 FOLLOWUP_AID）：</strong>已经通过真实接口完成以上闭环，适合直接取图。
专业计划从今天开始，已有今日记录；另有过去十四天的自主记录周期（七天有记录、七天缺失），不冒充专业计划执行。</p>
<p>星仔可问“练习完成为什么还不是正式完成”“现在我应该做什么”。普通帮助使用本机回答，
业务摘要从真实保存的评估读取；医生意见和计划仍由医生明确确认。</p></section>
<section><h2>3. 影像演示</h2><p>以医生账号登录后：
<a href="/doctor-web/doctor_visualization.html?patient_id=FOLLOWUP_PID" target="_blank">打开原始影像工作区</a>　
<a href="/doctor-web/doctor_imaging.html?patient_id=FOLLOWUP_PID" target="_blank">打开模型分析</a>。</p>
<p>上传以下两个 NIfTI 文件并点击“载入”，可进行切面与可视化交互；CSV 用于模型分析，二者独立生成。</p>
<p><a href="/__synthetic__/assets/nifti_functional">下载合成功能像</a>　
<a href="/__synthetic__/assets/nifti_anatomical">下载合成结构像</a>　
<a href="/__synthetic__/assets/timeseries_csv">下载合成 ROI 时间序列</a></p>
<p>已实际执行项目原有 HGST 权重推理并保存系统第1版、医生审核第2版。
小程序“影像报告”可读取。合成输入不用于证明诊断准确率或临床效果。</p></section>
<section><h2>4. 十张截图</h2><p>用户首页 → 本轮评估 → 日期记录回顾 → 星仔对话 → 医生工作台 → 医生原件核对 →
已发布意见 → 用户计划 → 网页影像可视化 → 小程序影像报告。</p>
<p>仅截真实业务画面，不截本入口的密码表。本入口只在本机开放。</p></section></body></html>'''
        for token, value in {'ROWS': ''.join(rows), 'ORIGIN': origin,
                'REVIEW_PID': str(review['patient_id']), 'REVIEW_AID': str(review['assessment']['id']),
                'FOLLOWUP_PID': str(followup['patient_id']), 'FOLLOWUP_AID': str(followup['assessment']['id'])}.items():
            html = html.replace(token, value)
        return HTMLResponse(html, headers={'Cache-Control': 'no-store'})

    print(json.dumps({'ready': True, **runtime_info}, ensure_ascii=False), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
