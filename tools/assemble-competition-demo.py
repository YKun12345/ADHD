"""Join only checked app-region clips into one silent H.264 demonstration."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.codex-tmp/competition-recording-20261019'
OUT = ROOT / 'docs/竞赛演示视频-2026-10-19'
sys.path.insert(0, str(WORK / 'media-runtime'))
from imageio_ffmpeg import get_ffmpeg_exe
ENCODER = get_ffmpeg_exe()
PROBE = 'C:/Program Files (x86)/ACLOS/Cross/recorder-release/ffprobe.exe'


def probe(path):
    result = subprocess.run([PROBE, '-v', 'error', '-show_entries',
        'format=duration,size:stream=width,height,codec_name,codec_type,r_frame_rate', '-of', 'json', str(path)],
        capture_output=True, text=True, encoding='utf8', check=True)
    return json.loads(result.stdout)


def main():
    native_before = ['10-user-home', '11-user-assessment', '12-user-question', '13-xingzai-answer',
        '14-user-message-form', '15-user-message-saved', '20-doctor-home', '21-doctor-patient',
        '22-doctor-originals', '23-doctor-reply-form', '24-doctor-reply-saved']
    native_after = ['40-published-opinion', '41-professional-plan', '42-dated-record-form',
        '43-dated-record-saved', '44-historical-records', '45-patient-reads-reply', '46-mini-imaging-report']
    all_native = [WORK / (name + '.mp4') for name in native_before + native_after]
    if not all(path.is_file() and path.stat().st_size > 1000 for path in all_native):
        raise RuntimeError('One or more checked native clips are missing; no final video created.')
    web_receipt = json.loads((WORK / 'web-receipt.json').read_text(encoding='utf8'))
    assert web_receipt['status'] == 'passed' and web_receipt['native_web_viewport_only']
    assert web_receipt.get('real_public_research_images') is True, 'The public MRI recording must succeed first.'
    assert web_receipt['real_findviz_upload_status'] == 201
    web = WORK / '30-web-h264.mp4'
    subprocess.run([ENCODER, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(WORK / '03-web-raw.mp4'),
        '-vf', 'scale=1920:1080,setsar=1,fps=30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(web)], check=True)
    clips = [WORK / (name + '.mp4') for name in native_before] + [web] + [WORK / (name + '.mp4') for name in native_after]
    receipt = {'silent': True, 'narration': False, 'desktop_capture_used': False,
        'mini_capture': 'PrintWindow on the verified project HWND, fixed phone-only crop; dimension change aborts',
        'web_capture': 'Chrome page screencast, independent profile, viewport only',
        'synthetic_accounts_only': True, 'clips': [], 'excluded_failed_recording': '01-user.mp4',
        'web_public_research_images': True, 'web_image_files': web_receipt['image_files'],
        'existing_mini_reports': 'Synthetic demonstration inputs; not claimed as analyses of the public viewer images',
        'excluded_other_sources': ['capture-probe.mp4', '03-web-synthetic-original.mp4', '03-web-real-grid-mismatch.mp4'],
        'capture_crop': [1042, 137, 544, 1174], 'source_window_size': [1875, 1500]}
    cursor = 0
    for clip in clips:
        metadata = probe(clip)
        streams = metadata['streams']
        assert len(streams) == 1 and streams[0]['codec_type'] == 'video'
        assert (streams[0]['width'], streams[0]['height']) == (1920, 1080)
        assert streams[0]['codec_name'] == 'h264'
        duration = float(metadata['format']['duration'])
        assert duration > 2
        receipt['clips'].append({'file': clip.name, 'start_seconds': round(cursor, 3), 'duration_seconds': duration})
        cursor += duration
    concat = WORK / 'final-concat.txt'
    concat.write_text('\n'.join("file '" + path.as_posix().replace("'", "'\\''") + "'" for path in clips), encoding='utf8')
    final = OUT / '知行合医-小程序与网页完整演示-无解说.mp4'
    subprocess.run([ENCODER, '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0',
        '-i', str(concat), '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', str(final)], check=True)
    receipt['final'] = probe(final)
    receipt['output'] = str(final)
    assert len(receipt['final']['streams']) == 1 and receipt['final']['streams'][0]['codec_name'] == 'h264'
    assert abs(float(receipt['final']['format']['duration']) - cursor) < 2
    (OUT / '录制回执.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf8')
    # Contact sheet samples are made from the encoded result, covering every
    # source clip. They are for inspection, not substituted for actual footage.
    for index, clip in enumerate(receipt['clips']):
        second = clip['start_seconds'] + min(3, clip['duration_seconds']/2)
        subprocess.run([ENCODER, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(second), '-i', str(final),
            '-frames:v', '1', '-vf', 'scale=480:270', str(WORK / f'check-{index:02}.jpg')], check=True)
    print(json.dumps({'status': 'assembled', 'file': str(final),
        'seconds': receipt['final']['format']['duration'], 'bytes': final.stat().st_size,
        'app_only': True, 'silent': True}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
