"""whisper.cpp subprocess runner.

The Pi shares 4 cores with bitcoind + LND, so transcription is deliberately
a second-class citizen: nice'd, ≤2 threads, one at a time (the job queue's
`cpu_heavy` queue has concurrency 1). Capture never waits on this — it is
async by design and the UI says "transcribing…" honestly.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from ..config import settings


class TranscriptionError(Exception):
    pass


def _to_wav(src: Path, dst: Path) -> None:
    # Browsers upload webm/opus or m4a; whisper.cpp wants 16 kHz mono wav.
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-ar", "16000", "-ac", "1", "-f", "wav", str(dst)],
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise TranscriptionError(f"ffmpeg failed: {proc.stderr[-500:].decode(errors='replace')}")


def transcribe(audio_path: Path) -> str:
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "audio.wav"
        _to_wav(audio_path, wav)
        proc = subprocess.run(
            [
                "nice", "-n", str(settings.whisper_nice),
                settings.whisper_bin,
                "-m", str(settings.whisper_model),
                "-t", str(settings.whisper_threads),
                "--no-timestamps",
                "-f", str(wav),
            ],
            capture_output=True,
            timeout=settings.whisper_timeout_s,
        )
        if proc.returncode != 0:
            raise TranscriptionError(f"whisper failed: {proc.stderr[-500:].decode(errors='replace')}")
        return proc.stdout.decode(errors="replace").strip()
