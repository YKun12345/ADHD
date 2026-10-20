"""Record continuous real mini-program interactions; no still-image slideshow."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('original_capture', ROOT / 'tools/record-competition-demo.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
WORK = ROOT / '.codex-tmp/competition-recording-smooth-20261019'
OUT = ROOT / 'docs/竞赛演示视频-2026-10-19/连续操作版'
WORK.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)


class Recorder:
    def __init__(self, camera, name):
        self.camera, self.name = camera, name
        self.path = WORK / (name + '.mp4')
        self.timestamps, self.hashes = [], []
        self.error = None
        self.success = False
        self.end = threading.Event()

    def start(self):
        width, height = self.camera.crop[2:]
        self.encoder_log = (WORK / (self.name + '-encoder.txt')).open('w', encoding='utf8')
        self.encoder = subprocess.Popen([base.FFMPEG, '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', f'{width}x{height}',
            '-framerate', '30', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(self.path)],
            stdin=subprocess.PIPE, stderr=self.encoder_log, stdout=subprocess.DEVNULL)
        self.began = time.monotonic()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        deadline = self.began
        try:
            while not self.end.is_set():
                if base.u32.IsIconic(self.camera.handle):
                    base.u32.ShowWindow(self.camera.handle, 4)
                    self.end.wait(.2)
                frame = self.camera.frame()
                self.timestamps.append(time.monotonic() - self.began)
                self.hashes.append(hashlib.blake2s(frame[::8, ::8].tobytes()).hexdigest())
                # Encode at source size first, keeping capture free of the
                # previous full-HD scaling workload. Every submitted frame is
                # freshly captured; no catch-up bursts of duplicate frames.
                self.encoder.stdin.write(frame.tobytes())
                deadline += 1 / 30
                self.end.wait(max(0, deadline - time.monotonic()))
        except Exception as exc:
            self.error = exc

    def stop(self):
        self.end.set(); self.thread.join(timeout=15)
        elapsed = time.monotonic() - self.began
        self.encoder.stdin.close(); result = self.encoder.wait(timeout=30)
        self.encoder_log.close()
        if self.error or result:
            raise RuntimeError(f'Continuous capture failed: {self.error or result}')
        gaps = np.diff(self.timestamps)
        receipt = {'file': self.path.name, 'frames': len(self.timestamps),
            'elapsed_seconds': elapsed, 'fresh_capture_fps': len(self.timestamps) / elapsed,
            'frame_gap_p95_ms': float(np.percentile(gaps, 95) * 1000),
            'frame_gap_max_ms': float(max(gaps) * 1000),
            'unique_sampled_frames': len(set(self.hashes)), 'desktop_capture_used': False,
            'continuous_capture': True, 'capture_crop': self.camera.crop,
            'journey_completed': self.success,
            'source_window_size': [self.camera.width, self.camera.height]}
        (WORK / (self.name + '-receipt.json')).write_text(json.dumps(receipt, indent=2), encoding='utf8')
        print(json.dumps(receipt), flush=True)
        if receipt['fresh_capture_fps'] < 27:
            raise RuntimeError('Actual capture rate was below 27 fps; do not deliver this take as smooth.')


class Journey(base.Native):
    def mark(self, name):
        print(json.dumps({'stage': name}), flush=True)

    def tap(self, selector):
        self.call('automation_element_action', '--action', 'tap', '--selector', selector,
            '--wait-for-selector', selector)
        time.sleep(.7)
        self.ready()

    def back(self):
        self.call('automation_navigate', '--action', 'navigateBack')
        time.sleep(.7)
        self.ready()

    def scroll_to(self, y, duration=1800):
        self.evaluate('function(v){wx.pageScrollTo({scrollTop:v[0],duration:v[1]});return true;}', [[y, duration]])
        time.sleep(duration / 1000 + .25)

    def navigate(self, name, query=''):
        self.evaluate('function(url){wx.navigateTo({url:url});return true;}', ['/pages/' + name + '/index' + query])
        time.sleep(.8); self.ready(name)

    def type_text(self, method, text, field=None):
        # Dispatch the page's actual input handler progressively, so the
        # recording includes typing/listening states and real entered text.
        self.evaluate('function(v){var p=getCurrentPages().pop(),i=0;return new Promise(function(done){var t=setInterval(function(){i+=1;var e={detail:{value:v[1].slice(0,i)}};if(v[2])e.currentTarget={dataset:{field:v[2]}};p[v[0]](e);if(i>=v[1].length){clearInterval(t);done(true)}},85)})}', [[method, text, field]])


def user(j):
    j.mark('user-home'); time.sleep(2)
    j.tap(".home-section[data-section='assessments']")
    j.tap(".actual-row[data-id='2']")
    j.mark('assessment'); j.scroll_to(1050); time.sleep(1.5)
    j.scroll_to(1500); time.sleep(1)
    j.method('openReports'); time.sleep(.8); j.ready()
    j.method('openReport', base.event(1)); j.ready()
    j.scroll_to(180); time.sleep(2.5)
    j.back(); j.navigate('patient-plan', '?patient_id=13&assessment_id=2')
    j.mark('plan'); j.scroll_to(220); time.sleep(2)
    j.method('openCycle', base.event(1)); time.sleep(.8); j.ready()
    j.scroll_to(770); j.mark('daily-record')
    j.type_text('onDailyInput', '【合成演示】今天分成小步骤完成记录，不知道的项目保持未知。', 'note')
    j.method('saveDaily'); j.ready(); time.sleep(1)
    j.scroll_to(1280); time.sleep(2)
    j.navigate('agent-chat', '?patient_id=13&assessment_id=2')
    j.mark('xingzai'); j.scroll_to(10000, 1400)
    j.type_text('onInput', '怎么按医生计划记录今天的情况？')
    j.tap('.send-button'); time.sleep(2); j.scroll_to(10000, 1800)
    j.tap('.pet-touch-button'); time.sleep(2)
    j.navigate('shared-messages', '?patient_id=13&relationship_id=2')
    j.scroll_to(10000, 2100); j.mark('user-message')
    j.type_text('onContentInput', '【合成演示】已查看医生计划，今天先从一项日常记录开始。')
    j.tap('.primary'); time.sleep(1)
    rects = j.rects('.message')
    if rects: j.scroll_to(max(0, int(rects[-1]['top'])-130))
    time.sleep(2)


def doctor(j):
    j.mark('doctor-home'); time.sleep(2)
    j.tap('#open-patients')
    j.tap(".patient-card[data-id='13']")
    j.mark('doctor-patient'); j.scroll_to(450); time.sleep(2)
    j.method('openAssessments'); time.sleep(.8); j.ready()
    j.method('openAssessment', base.event(2)); j.ready(); j.scroll_to(1100)
    j.method('openReview'); time.sleep(.8); j.ready()
    j.mark('original-review'); j.scroll_to(500); time.sleep(2)
    j.navigate('shared-messages', '?patient_id=13&relationship_id=2')
    j.scroll_to(10000, 2000)
    j.type_text('onContentInput', '【合成演示】已看到记录。先完成今天的一小步，有疑问可以继续在这里反馈。')
    j.tap('.primary'); time.sleep(1)
    rects = j.rects('.message')
    if rects: j.scroll_to(max(0, int(rects[-1]['top'])-130))
    time.sleep(3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--handle', required=True, type=int)
    parser.add_argument('--part', required=True, choices=['probe', 'user', 'doctor'])
    args = parser.parse_args()
    j = Journey()
    j.login('doctor' if args.part == 'doctor' else 'followup')
    c = base.WindowCamera(args.handle, [1042, 137, 544, 1174])
    r = Recorder(c, args.part + '-continuous')
    try:
        if args.part == 'probe':
            j.route('care-cycles', '?patient_id=13&cycle_id=2')
            r.start(); j.scroll_to(1300, 3500); time.sleep(.5); j.scroll_to(0, 3500)
        else:
            base.dismiss_intro(c)
            r.start()
            (user if args.part == 'user' else doctor)(j)
        r.success = True
    finally:
        if hasattr(r, 'encoder'):
            r.stop()
        c.close()


if __name__ == '__main__':
    main()
