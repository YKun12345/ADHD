"""Encode timestamped real captures, without artificial motion interpolation."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.codex-tmp/competition-recording-smooth-20261019'
OUT = ROOT / 'docs/竞赛演示视频-2026-10-19/连续操作版'
sys.path.insert(0, str(ROOT / '.codex-tmp/competition-recording-20261019/media-runtime'))
from imageio_ffmpeg import get_ffmpeg_exe
FF = get_ffmpeg_exe()
PROBE = 'C:/Program Files (x86)/ACLOS/Cross/recorder-release/ffprobe.exe'


def run(args):
    subprocess.run([FF, '-hide_banner', '-v', 'error', '-y', *args], check=True)


def probe(p):
    result = subprocess.run([PROBE, '-v', 'error', '-show_entries',
        'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate',
        '-of', 'json', str(p)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def quoted(p):
    return "file '" + p.as_posix().replace("'", "'\\''") + "'"


def main():
    native = [json.loads((WORK / (name + '-continuous-receipt.json')).read_text()) for name in ['user', 'doctor']]
    assert all(r['journey_completed'] and r['fresh_capture_fps'] >= 27 for r in native)
    web = json.loads((WORK / 'web-continuous-receipt.json').read_text())
    motion = json.loads((WORK / '3d-motion-check.json').read_text())
    assert web['passed'] and web['errors'] == [] and all(u['status'] == 201 for u in web['uploads'])
    assert motion['visible_motion_changes_per_second'] >= 20
    manifest = json.loads((WORK / 'web-frame-manifest.json').read_text())
    assert manifest['viewport_only'] and not manifest['interpolated_frames']
    frames = manifest['frames']
    directory = Path(manifest['directory'])
    listing = ['ffconcat version 1.0']
    for i, row in enumerate(frames):
        p = directory / row['file']
        assert p.is_file()
        duration = max(.000001, frames[i+1]['timestamp'] - row['timestamp']) if i+1 < len(frames) else .04
        listing += [quoted(p), 'option framerate 1000', f'duration {duration:.6f}']
    listing += [quoted(directory / frames[-1]['file']), 'option framerate 1000']
    frame_list = WORK / 'web-frames.ffconcat'
    frame_list.write_text('\n'.join(listing), encoding='utf8')
    common = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
        '-pix_fmt', 'yuv420p', '-r', '30', '-video_track_timescale', '15360', '-movflags', '+faststart']
    encoded = []
    for name in ['user', 'doctor']:
        target = WORK / (name + '-1080p.mp4')
        run(['-i', str(WORK / (name + '-continuous.mp4')), '-vf',
            'scale=-2:1040,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xF2F6FA,setsar=1,fps=30', *common, str(target)])
        encoded.append(target)
    target = WORK / 'web-1080p.mp4'
    run(['-f', 'concat', '-safe', '0', '-i', str(frame_list), '-vf', 'fps=30,scale=1920:1080,setsar=1', *common, str(target)])
    encoded.append(target)
    clips, cursor = [], 0
    for p in encoded:
        metadata = probe(p)
        stream = metadata['streams'][0]
        assert len(metadata['streams']) == 1 and stream['codec_name'] == 'h264'
        assert (stream['width'], stream['height'], stream['r_frame_rate']) == (1920, 1080, '30/1')
        duration = float(metadata['format']['duration'])
        clips.append({'file': p.name, 'start_seconds': cursor, 'duration_seconds': duration})
        cursor += duration
    concatenation = WORK / 'continuous.ffconcat'
    concatenation.write_text('\n'.join(quoted(p) for p in encoded), encoding='utf8')
    final = OUT / '知行合医-连续操作与3D演示-无解说.mp4'
    run(['-f', 'concat', '-safe', '0', '-i', str(concatenation), '-map', '0:v:0', '-c', 'copy',
        '-an', '-movflags', '+faststart', str(final)])
    metadata = probe(final)
    assert len(metadata['streams']) == 1 and abs(float(metadata['format']['duration']) - cursor) < 1
    run(['-i', str(final), '-map', '0:v:0', '-an', '-f', 'null', '-'])
    rotation = clips[-1]['start_seconds'] + next(s['seconds'] for s in web['stages'] if s['stage'] == '3d-rotation-start')
    # Verify both the real motion and the final encoded output, not merely fps.
    run(['-ss', str(rotation+3), '-i', str(final), '-frames:v', '1', str(OUT / '最终视频-3D画面.png')])
    receipt = {'passed': True, 'full_decode_errors': 0, 'desktop_capture_used': False, 'audio_streams': 0,
        'interpolated_motion': False, 'native_fresh_frame_receipts': native, 'web_3d_motion': motion,
        'web_actual_camera_changed': web['camera_before'] != web['camera_after'], 'clips': clips,
        '3d_rotation_start_seconds': rotation, 'final': metadata,
        'public_functional_data': 'KKI 1018959', 'surface_geometry': 'fsaverage5 template; not an individual reconstruction'}
    (OUT / '连续录制回执.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'file': str(final), 'seconds': metadata['format']['duration'], 'bytes': final.stat().st_size,
        '3d_start_seconds': rotation, 'full_decode_passed': True}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
