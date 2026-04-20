#!/usr/bin/env python3
"""
Converts the per-slide WebM recordings into a single GST_Presentation.mp4.

Pipeline per slide:
  WebM  →  MP4 (H.264, 1920×1080, 24fps)
         with 0.6s fade-in at start and 0.6s fade-out at end

Then all segment MP4s are concatenated into the final video.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

VIDEOS_DIR  = Path('/home/user/designs/videos')
OUTPUT_FILE = Path('/home/user/designs/GST_Presentation.mp4')

# Fade duration applied to each segment (seconds)
FADE_DURATION = 0.6

# ── ffmpeg binary (bundled with imageio-ffmpeg) ───────────────────────────────

def get_ffmpeg() -> str:
    try:
        import imageio.plugins.ffmpeg as ff
        exe = ff.get_exe()
        if os.path.isfile(exe):
            return exe
    except Exception:
        pass
    raise RuntimeError('imageio-ffmpeg not found. Run: pip3 install imageio-ffmpeg')


def run(cmd: list[str]) -> None:
    """Run an ffmpeg command, printing it first."""
    print('  $', ' '.join(str(c) for c in cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print('STDERR:', result.stderr[-2000:])
        raise RuntimeError(f'ffmpeg exited {result.returncode}')


# ── Per-segment conversion ────────────────────────────────────────────────────

def webm_duration(ffmpeg: str, webm: Path) -> float:
    """Return the duration of a WebM file in seconds using ffprobe."""
    ffprobe = str(ffmpeg).replace('ffmpeg-', 'ffprobe-')
    # ffprobe ships alongside ffmpeg in imageio-ffmpeg
    if not os.path.isfile(ffprobe):
        # Fall back: use ffmpeg itself with -i and parse stderr
        result = subprocess.run(
            [ffmpeg, '-i', str(webm)],
            capture_output=True, text=True
        )
        for line in result.stderr.splitlines():
            if 'Duration' in line:
                parts = line.split('Duration:')[1].split(',')[0].strip()
                h, m, s = parts.split(':')
                return float(h) * 3600 + float(m) * 60 + float(s)
        return 8.0   # fallback
    result = subprocess.run(
        [ffprobe, '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', str(webm)],
        capture_output=True, text=True
    )
    return float(result.stdout.strip())


def convert_segment(ffmpeg: str, webm: Path, mp4: Path) -> None:
    """Convert WebM → MP4 with fade-in and fade-out."""
    dur = webm_duration(ffmpeg, webm)
    fade_out_start = max(0.0, dur - FADE_DURATION)

    vf = (
        f'fade=t=in:st=0:d={FADE_DURATION},'
        f'fade=t=out:st={fade_out_start:.3f}:d={FADE_DURATION}'
    )

    run([
        ffmpeg, '-y',
        '-i', str(webm),
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-r', '24',
        '-an',          # no audio
        str(mp4),
    ])


# ── Concatenation ─────────────────────────────────────────────────────────────

def concatenate(ffmpeg: str, segments: list[Path], output: Path) -> None:
    """Concatenate MP4 segments using the concat demuxer (stream copy)."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        for seg in segments:
            f.write(f"file '{seg.resolve()}'\n")
        list_path = f.name

    try:
        run([
            ffmpeg, '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', list_path,
            '-c', 'copy',
            str(output),
        ])
    finally:
        os.unlink(list_path)


# ── Main ──────────────────────────────────────────────────────────────────────

def build_mp4() -> None:
    manifest_path = VIDEOS_DIR / 'manifest.json'
    if not manifest_path.exists():
        raise FileNotFoundError('Run capture_mp4.js first to generate videos/manifest.json')

    with open(manifest_path) as f:
        manifest = json.load(f)

    ffmpeg = get_ffmpeg()
    print(f'Using ffmpeg: {ffmpeg}\n')

    segments_dir = VIDEOS_DIR / 'segments'
    segments_dir.mkdir(exist_ok=True)

    segment_files: list[Path] = []

    for slide in manifest['slides']:
        name = slide['name']
        webm = Path(slide['webm'])

        if not webm.exists():
            print(f'  ⚠  Missing {webm}, skipping')
            continue

        mp4 = segments_dir / f'{name}.mp4'
        print(f'Converting: {slide["file"]}')
        convert_segment(ffmpeg, webm, mp4)
        segment_files.append(mp4)
        print(f'  → {mp4}\n')

    if not segment_files:
        raise RuntimeError('No segments to concatenate')

    print(f'Concatenating {len(segment_files)} segments …')
    concatenate(ffmpeg, segment_files, OUTPUT_FILE)

    size_mb = OUTPUT_FILE.stat().st_size / 1_048_576
    print(f'\n✓  {OUTPUT_FILE}  ({size_mb:.1f} MB)')


if __name__ == '__main__':
    build_mp4()
