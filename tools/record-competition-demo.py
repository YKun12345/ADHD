"""Capture only the selected WeChat window's phone region, never the desktop."""
from __future__ import annotations
import argparse
import ctypes as ct
from ctypes import wintypes as wt
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import sys

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.codex-tmp/competition-recording-20261019'
OUT = ROOT / 'docs/竞赛演示视频-2026-10-19'
CLI = 'D:/微信开发者工具/微信web开发者工具/wechatide.cmd'
sys.path.insert(0, str(WORK / 'media-runtime'))
from imageio_ffmpeg import get_ffmpeg_exe
FFMPEG = get_ffmpeg_exe()
PROJECT = str(ROOT / 'miniprogram')
SOURCE = json.loads((ROOT / '.codex-tmp/main-examples/source.json').read_text(encoding='utf8'))
WORK.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
(OUT / '截图').mkdir(exist_ok=True)


def log(stage, **values):
    print(json.dumps({'stage': stage, **values}, ensure_ascii=False), flush=True)


class Native:
    def __init__(self):
        self.number = 0

    def call(self, tool, *args, payload=None):
        self.number += 1
        command = [CLI, '-c', 'codex', tool, '--project', PROJECT, *map(str, args)]
        if payload is not None:
            filename = WORK / f'args-{self.number}.json'
            filename.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf8')
            command += ['--args-file', str(filename)]
        # .cmd is interpreted by cmd.exe. Quote EVERY argument, including URLs
        # with '&'; list2cmdline alone does not quote such whitespace-free args.
        if any('"' in arg or '\n' in arg for arg in command):
            raise RuntimeError('Unexpected shell characters in a native tool argument.')
        quoted = ' '.join('"' + arg + '"' for arg in command)
        result = subprocess.run(quoted, shell=True, capture_output=True, encoding='utf8', timeout=50)
        raw = result.stdout
        if '{' not in raw:
            raise RuntimeError(f'{tool}: no structured result')
        value = json.loads(raw[raw.index('{'):])
        # Do not log input fields, credentials or complete clinical payloads.
        if not value.get('ok'):
            raise RuntimeError(f'{tool}: {value.get("message", "failed")}')
        value = value.get('result', {})
        if isinstance(value, dict) and value.get('success') is False:
            raise RuntimeError(f'{tool}: {value.get("error", "failed")}')
        while isinstance(value, dict) and 'result' in value:
            value = value['result']
        return value

    def evaluate(self, fn, args=None):
        return self.call('automation_evaluate', '--fn-source', fn, payload=args or [])

    def method(self, name, *args):
        return self.call('automation_page_action', '--action', 'callMethod', '--method', name, payload=list(args))

    def data(self, *keys):
        return self.evaluate('function(keys){var p=getCurrentPages().pop();var out={};keys.forEach(function(k){out[k]=p.data[k]});return out;}', [list(keys)])

    def route(self, name, query=''):
        self.call('automation_navigate', '--action', 'reLaunch', '--url', f'/pages/{name}/index' + query)
        time.sleep(1.2)
        self.ready(name)

    def ready(self, name='page'):
        state = self.data('loading', 'busy', 'errorText')
        if state.get('errorText') and name in {'doctor home', 'doctor-home'} and 'Audit storage' in state['errorText']:
            time.sleep(2)
            self.method('loadDashboard')
            # The native call dispatches async page handlers; wait for their
            # real HTTP completion before inspecting the resulting page state.
            time.sleep(7)
            state = self.data('loading', 'busy', 'errorText')
        for _ in range(8):
            if not state.get('loading') and not state.get('busy'):
                break
            time.sleep(1)
            state = self.data('loading', 'busy', 'errorText')
        if state.get('errorText'):
            raise RuntimeError(f'{name}: {state["errorText"]}')
        if state.get('loading') or state.get('busy'):
            raise RuntimeError(f'{name}: page is still loading')

    def scroll(self, top):
        self.evaluate('function(y){wx.pageScrollTo({scrollTop:y,duration:800});return true;}', [top])
        time.sleep(1)

    def rects(self, selector):
        return self.evaluate('function(s){return new Promise(function(resolve){wx.createSelectorQuery().selectAll(s).boundingClientRect(function(r){resolve(r)}).exec()})}', [selector])

    def login(self, key):
        account = SOURCE['accounts'][key]
        current = self.evaluate('function(k){var u=wx.getStorageSync(k);return {id:u&&u.id,role:u&&u.role};}', ['current_user'])
        if current.get('id') and current['id'] not in {item['user']['id'] for item in SOURCE['accounts'].values()}:
            raise RuntimeError('A non-example user is active; automatic recording will not replace that session.')
        if current.get('id') == account['user']['id']:
            self.dismiss_preference(account)
            self.route('doctor-home' if key == 'doctor' else 'home')
            self.evaluate('function(s){var c=getCurrentPages().pop().selectComponent(s);if(c&&c.data.visible){c.skip();return true}return false;}', ['onboarding-guide'])
            log('logged-in', synthetic_role=key, reused=True)
            return
        # Only synthetic sessions are switched. The initial environment had no
        # logged-in account; original unsent queues are not reset.
        self.evaluate('function(){wx.removeStorageSync(String.fromCharCode(97,99,99,101,115,115,95,116,111,107,101,110));wx.removeStorageSync(String.fromCharCode(99,117,114,114,101,110,116,95,117,115,101,114));return true;}')
        self.route('login')
        self.method('selectRole', {'currentTarget': {'dataset': {'role': account['role']}}})
        self.method('onIdentifierInput', {'detail': {'value': account['email']}})
        self.method('onPasswordInput', {'detail': {'value': account['password']}})
        self.method('handleLogin')
        route = ''
        for _ in range(6):
            time.sleep(2)
            current = self.call('automation_runtime_info', '--action', 'currentPage')
            route = current.get('currentPage', {}).get('path', '').lstrip('/')
            if route in ('pages/home/index', 'pages/doctor-home/index'):
                break
        if route not in ('pages/home/index', 'pages/doctor-home/index'):
            raise RuntimeError('The synthetic login did not reach its home page.')
        self.dismiss_preference(account)
        self.route('doctor-home' if key == 'doctor' else 'home')
        # Dismiss only the app's ordinary introductory overlay, if present.
        self.evaluate('function(s){var c=getCurrentPages().pop().selectComponent(s);if(c&&c.data.visible){c.skip();return true}return false;}', ['onboarding-guide'])
        log('logged-in', synthetic_role=key)

    def dismiss_preference(self, account):
        # The same local preference written by the app's Skip/Start buttons.
        # No business data, permissions, results or server responses are changed.
        key = f'guide_state_v3:{account["role"]}:{account["user"]["id"]}'
        self.evaluate('function(k){var s=wx.getStorageSync(k)||{};s.autoEnabled=false;s.onboardingVersion=3;s.pageVersions=s.pageVersions||{};wx.setStorageSync(k,s);return true;}', [key])


u32, gdi = ct.windll.user32, ct.windll.gdi32
u32.SetProcessDPIAware()


class Rect(ct.Structure):
    _fields_ = [('left', ct.c_long), ('top', ct.c_long), ('right', ct.c_long), ('bottom', ct.c_long)]


class BitmapHeader(ct.Structure):
    _fields_ = [('size', wt.DWORD), ('width', ct.c_long), ('height', ct.c_long),
        ('planes', wt.WORD), ('bits', wt.WORD), ('compression', wt.DWORD), ('image_size', wt.DWORD),
        ('x', ct.c_long), ('y', ct.c_long), ('used', wt.DWORD), ('important', wt.DWORD)]


class WindowCamera:
    def __init__(self, handle, crop):
        self.handle = handle
        title = ct.create_unicode_buffer(512)
        u32.GetWindowTextW(handle, title, 512)
        if not any(word in title.value for word in ('ADHD', 'miniprogram', '微信开发者工具')) and not (title.value.startswith('影像可视化') and '知行合' in title.value):
            raise RuntimeError('The selected capture window is not the intended project.')
        if u32.IsIconic(handle):
            u32.ShowWindow(handle, 9)
            time.sleep(.7)
        rect = Rect(); u32.GetWindowRect(handle, ct.byref(rect))
        self.width, self.height = rect.right - rect.left, rect.bottom - rect.top
        if crop[0] < 0 or crop[1] < 0 or crop[0]+crop[2] > self.width or crop[1]+crop[3] > self.height:
            raise RuntimeError('The phone capture boundary no longer fits the project window.')
        self.crop = crop
        self.recorder = None
        self.frames = 0
        self.error = None
        self.stop_event = threading.Event()
        u32.GetWindowDC.restype = wt.HDC
        gdi.CreateCompatibleDC.restype = wt.HDC
        gdi.CreateDIBSection.restype = wt.HBITMAP
        gdi.SelectObject.restype = wt.HANDLE
        gdi.CreateCompatibleDC.argtypes = [wt.HDC]
        gdi.CreateDIBSection.argtypes = [wt.HDC, ct.POINTER(BitmapHeader), wt.UINT, ct.POINTER(ct.c_void_p), wt.HANDLE, wt.DWORD]
        gdi.SelectObject.argtypes = [wt.HDC, wt.HANDLE]
        gdi.DeleteObject.argtypes = [wt.HANDLE]
        gdi.DeleteDC.argtypes = [wt.HDC]
        u32.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
        u32.PrintWindow.argtypes = [wt.HWND, wt.HDC, wt.UINT]
        self.screen_dc = u32.GetWindowDC(handle)
        self.memory_dc = gdi.CreateCompatibleDC(self.screen_dc)
        header = BitmapHeader(ct.sizeof(BitmapHeader), self.width, -self.height, 1, 32, 0, self.width*self.height*4, 0, 0, 0, 0)
        self.bits = ct.c_void_p()
        self.bitmap = gdi.CreateDIBSection(self.screen_dc, ct.byref(header), 0, ct.byref(self.bits), None, 0)
        if not self.bitmap or not self.bits:
            raise RuntimeError('Window-only frame capture could not be initialized.')
        self.previous = gdi.SelectObject(self.memory_dc, self.bitmap)
        self.lock = threading.Lock()

    def frame(self):
        with self.lock:
            rect = Rect(); u32.GetWindowRect(self.handle, ct.byref(rect))
            if (rect.right-rect.left, rect.bottom-rect.top) != (self.width, self.height):
                raise RuntimeError('The project window was resized; capture stopped to protect the crop boundary.')
            if not u32.PrintWindow(self.handle, self.memory_dc, 2):
                raise RuntimeError('Window capture failed; desktop capture is never used as a fallback.')
            array = np.ctypeslib.as_array((ct.c_ubyte * (self.width*self.height*4)).from_address(self.bits.value)).reshape(self.height, self.width, 4)
            x, y, width, height = self.crop
            return array[y:y+height, x:x+width].copy()

    def still(self, name):
        frame = self.frame()
        image = Image.fromarray(frame[:, :, [2, 1, 0]])
        image.save(OUT / '截图' / (name + '.png'))

    def start(self, name):
        path = WORK / (name + '.mp4')
        width, height = self.crop[2:]
        self.log_file = (WORK / (name + '-encoder.txt')).open('w', encoding='utf8')
        self.recorder = subprocess.Popen([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', f'{width}x{height}', '-framerate', '20', '-i', 'pipe:0',
            '-vf', 'scale=-2:1040,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xF2F6FA,setsar=1',
            '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
            '-movflags', '+faststart', str(path)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self.log_file)
        self.frames = 0; self.error = None; self.stop_event.clear()
        self.thread = threading.Thread(target=self._record, daemon=True); self.thread.start()
        log('recording', clip=name)
        return path

    def _record(self):
        began = time.monotonic()
        try:
            while not self.stop_event.is_set():
                frame = self.frame().tobytes()
                target = max(self.frames + 1, int((time.monotonic()-began)*20))
                while self.frames < target:
                    self.recorder.stdin.write(frame); self.frames += 1
                self.stop_event.wait(max(0, (self.frames/20) - (time.monotonic()-began)))
        except Exception as error:
            self.error = error

    def stop(self):
        self.stop_event.set(); self.thread.join(timeout=10)
        self.recorder.stdin.close(); code = self.recorder.wait(timeout=40); self.log_file.close()
        if self.error or code:
            raise RuntimeError(f'Window-only recording failed: {self.error or code}')
        log('clip-saved', frames=self.frames)

    def close(self):
        gdi.SelectObject(self.memory_dc, self.previous)
        gdi.DeleteObject(self.bitmap); gdi.DeleteDC(self.memory_dc); u32.ReleaseDC(self.handle, self.screen_dc)


def event(identifier):
    return {'currentTarget': {'dataset': {'id': identifier}}}


def clip(camera, name, duration=8, screenshot=None, scroll=None, api=None):
    camera.start(name)
    time.sleep(duration / 2)
    if scroll is not None:
        api.scroll(scroll)
    if screenshot:
        camera.still(screenshot)
    time.sleep(duration / 2)
    camera.stop()


def scroll_last_message(api):
    rects = api.rects('.message')
    if rects:
        api.scroll(max(0, int(rects[-1]['top']) - 110))


def dismiss_intro(camera):
    frame = camera.frame()
    if np.median(frame[300:900, 2:12, :3]) < 170 and np.mean(frame[350:750,70:450,:3]) > 200:
        # A real pointer click on the visible app introduction's Skip button.
        # The selected project must own the foreground before sending input.
        if u32.IsIconic(camera.handle):
            u32.ShowWindow(camera.handle, 9)
        u32.SetForegroundWindow(camera.handle)
        time.sleep(.5)
        u32.GetForegroundWindow.restype = wt.HWND
        if u32.GetForegroundWindow() != camera.handle:
            raise RuntimeError('The intended project did not gain focus; no pointer input sent.')
        bounds = Rect(); u32.GetWindowRect(camera.handle, ct.byref(bounds))
        x, y = camera.crop[:2]
        rgb = frame[:, :, [2, 1, 0]].astype(float)
        region = rgb[450:1100, 300:490]
        blue_rows = np.where(((region[:, :, 1]-region[:, :, 0] > 20) &
            (region[:, :, 2] > 100) & (region[:, :, 0] < 130)).mean(axis=1) > .7)[0]
        if not len(blue_rows):
            raise RuntimeError('The visible intro action could not be located safely.')
        action_y = 450 + int(np.median(blue_rows))
        u32.SetCursorPos(bounds.left+x+165, bounds.top+y+action_y)
        u32.mouse_event(2, 0, 0, 0, 0); time.sleep(.12); u32.mouse_event(4, 0, 0, 0, 0)
        time.sleep(2)
        if np.median(camera.frame()[300:900, 2:12, :3]) < 170:
            raise RuntimeError('The app introduction is still visible; home clip was not started.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--handle', type=int, required=True)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--part', choices=['home', 'user', 'doctor', 'followup'])
    args = parser.parse_args()
    camera = WindowCamera(args.handle, [1042, 137, 544, 1174])
    api = Native()
    try:
        if args.probe:
            camera.still('裁剪边界检查')
            camera.start('capture-probe'); time.sleep(2); camera.stop()
            log('probe-passed'); return
        followup = SOURCE['scenarios']['followup']
        pid, aid = followup['patient_id'], followup['assessment']['id']
        query = f'?patient_id={pid}&assessment_id={aid}'
        if args.part == 'home':
            api.login('followup'); api.ready('home'); dismiss_intro(camera)
            clip(camera, '10-user-home', 9, '01-用户首页')
        elif args.part == 'user':
            api.login('followup')
            api.ready('home')
            dismiss_intro(camera)
            clip(camera, '10-user-home', 9, '01-用户首页')
            api.route('assessments', query)
            api.method('openAssessment', event(aid)); api.ready('assessment')
            if not api.data('assessment').get('assessment'):
                raise RuntimeError('The real assessment detail is not open.')
            rects = api.rects('.assessment-page > .sheet')
            if len(rects) >= 4: api.scroll(max(0, int(rects[3]['top'])-90))
            clip(camera, '11-user-assessment', 12, '02-本轮评估', scroll=1700, api=api)
            api.route('agent-chat', query)
            api.method('onInput', {'detail': {'value': '医生发来的计划在哪里看？'}})
            clip(camera, '12-user-question', 4)
            api.method('send'); time.sleep(4); api.ready('agent question')
            api.scroll(10000)
            camera.start('13-xingzai-answer')
            api.method('touchXingzai'); time.sleep(3)
            camera.still('04-星仔问答')
            time.sleep(6); camera.stop()
            api.route('shared-messages', f'?patient_id={pid}&relationship_id={followup["relationship"]["id"]}')
            api.method('onContentInput', {'detail': {'value': '【合成演示】我已查看本轮评估，想确认接下来如何按计划记录。'}})
            api.scroll(10000); clip(camera, '14-user-message-form', 4)
            api.method('sendMessage'); api.ready('send message')
            scroll_last_message(api); clip(camera, '15-user-message-saved', 7)
        elif args.part == 'doctor':
            api.login('doctor')
            api.ready('doctor home'); dismiss_intro(camera)
            clip(camera, '20-doctor-home', 8, '05-医生工作台')
            api.route('doctor-patient', f'?patient_id={pid}'); clip(camera, '21-doctor-patient', 10, scroll=360, api=api)
            api.route('doctor-review', query); api.scroll(650); time.sleep(5); camera.still('06-医生原件核对')
            clip(camera, '22-doctor-originals', 12, '06-医生原件核对', scroll=1200, api=api)
            api.route('shared-messages', f'?patient_id={pid}&relationship_id={followup["relationship"]["id"]}')
            api.method('onContentInput', {'detail': {'value': '【合成演示】已看到反馈。请按实际日期记录，未知内容可以留空；我们会结合已保存材料继续核对。'}})
            api.scroll(10000); clip(camera, '23-doctor-reply-form', 4)
            api.method('sendMessage'); api.ready('doctor reply')
            scroll_last_message(api); clip(camera, '24-doctor-reply-saved', 8)
        elif args.part == 'followup':
            api.login('followup')
            api.route('care-reports', query)
            api.method('openReport', event(followup['report']['id']))
            api.ready('published report'); api.scroll(400)
            clip(camera, '40-published-opinion', 10, '07-医生已发布意见')
            api.route('patient-plan', query); api.scroll(360)
            clip(camera, '41-professional-plan', 10, '08-医生计划')
            api.route('care-cycles', f'?patient_id={pid}&cycle_id={followup["cycle"]["id"]}')
            rects = api.rects('.cycles-page > .sheet')
            if len(rects) >= 4: api.scroll(max(0,int(rects[3]['top'])-85))
            api.method('onDailyInput', {'currentTarget': {'dataset': {'field': 'note'}},
                'detail': {'value': '【合成演示】今天查看计划后记录一次日常观察，专注时长未知。'}})
            clip(camera, '42-dated-record-form', 5)
            api.method('saveDaily'); api.ready('daily record')
            api.scroll(1200); clip(camera, '43-dated-record-saved', 8)
            api.route('care-cycles', f'?patient_id={pid}&cycle_id={followup["historical_self_cycle"]["id"]}')
            api.scroll(650); clip(camera, '44-historical-records', 9, '03-日期记录与回顾')
            api.route('shared-messages', f'?patient_id={pid}&relationship_id={followup["relationship"]["id"]}')
            scroll_last_message(api); clip(camera, '45-patient-reads-reply', 8)
            api.route('imaging-reports', f'?patient_id={pid}'); api.scroll(500)
            clip(camera, '46-mini-imaging-report', 11, '10-小程序影像报告')
        else:
            raise RuntimeError('Select a recording part.')
    finally:
        if camera.recorder is not None and camera.recorder.poll() is None:
            camera.stop()
        camera.close()


if __name__ == '__main__':
    main()
