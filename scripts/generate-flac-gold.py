"""Regenerate committed FLAC decoder fixtures; tests only need the resulting files."""

from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave

root = Path(__file__).resolve().parents[1]
target = root / "native/audio-host/testdata"
ffmpeg = shutil.which("ffmpeg")
if not ffmpeg:
    raise SystemExit("ffmpeg is required to regenerate the test fixtures")

with tempfile.TemporaryDirectory(prefix="aural-flac-gold-") as temporary:
    for rate, bits in [(44100, 16), (48000, 24)]:
        wav = Path(temporary) / f"cue-gold-{rate}.wav"
        flac = target / f"cue-gold-{rate}-{bits}bit.flac"
        with wave.open(str(wav), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(bits // 8)
            output.setframerate(rate)
            if bits == 16:
                frames = b"".join(struct.pack("<h", (i * 37) % 60001 - 30000) for i in range(rate * 3))
            else:
                frames = b"".join(((i * 937) % 16000001 - 8000000).to_bytes(3, "little", signed=True) for i in range(rate * 3))
            output.writeframes(frames)
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                        "-c:a", "flac", "-compression_level", "8", str(flac)], check=True)
        print(f"{flac.name}: {flac.stat().st_size} bytes")
