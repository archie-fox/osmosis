"""Synthesize mp3s with edge-tts (Microsoft's online Edge voices).

Run with the plugin's own venv that has edge-tts installed:
  <venv python> tts.py <media dir> < clips.json

clips.json is a list of {text, name}. A file already there is kept, so each
text is synthesized once. Prints how many files exist afterwards.
"""

import asyncio
import json
import sys
from pathlib import Path

import edge_tts

VOICE = "zh-CN-XiaoxiaoNeural"


async def synth(text: str, path: Path, sem: asyncio.Semaphore) -> None:
    if path.exists() and path.stat().st_size > 0:
        return
    async with sem:
        part = path.with_suffix(".part")
        try:
            await asyncio.wait_for(edge_tts.Communicate(text, VOICE).save(str(part)), timeout=30)
            if part.stat().st_size > 0:
                part.replace(path)
        finally:
            part.unlink(missing_ok=True)


async def main() -> None:
    media = Path(sys.argv[1])
    media.mkdir(parents=True, exist_ok=True)
    clips = json.load(sys.stdin)
    sem = asyncio.Semaphore(4)
    results = await asyncio.gather(*(synth(c["text"], media / c["name"], sem) for c in clips), return_exceptions=True)
    errors = [r for r in results if isinstance(r, BaseException)]
    if errors:
        print(f"{len(errors)} failed: {type(errors[0]).__name__}: {errors[0]}", file=sys.stderr)
    print(sum((media / c["name"]).exists() for c in clips))


if __name__ == "__main__":
    asyncio.run(main())
