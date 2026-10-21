"""Build an Anki deck package from Osmosis saved words.

Run with Anki's own Python, which ships the `anki` library:
  <anki python> export-apkg.py <out.apkg> [media dir] < notes.json

notes.json is a list of {hanzi, pinyin, meaning, example, exampleEn, audio,
exampleAudio}; audio names an mp3 in the media dir, used when it is there. The
deck is built in a throwaway collection, so the user's own collection is never
opened. Prints {"notes": n, "audio": files added}.
"""

import hashlib
import json
import sys
import tempfile
from pathlib import Path

from anki.collection import Collection, DeckIdLimit, ExportAnkiPackageOptions
from anki.models import NotetypeId

NOTETYPE_ID = 1760716800000
FIELDS = ["Hanzi", "Pinyin", "Meaning", "Example", "ExampleEn", "Audio", "ExampleAudio"]
BACK = """<div class="hanzi">{{Hanzi}}</div>
<div class="pinyin">{{Pinyin}}</div>
<div>{{Meaning}}</div>
{{#Example}}<div class="example">{{Example}}<br><span class="en">{{ExampleEn}}</span></div>{{/Example}}
{{#Audio}}{{Audio}}{{/Audio}}{{^Audio}}{{tts zh_CN:Hanzi}}{{/Audio}}
{{#Example}}{{#ExampleAudio}}{{ExampleAudio}}{{/ExampleAudio}}{{^ExampleAudio}}{{tts zh_CN:Example}}{{/ExampleAudio}}{{/Example}}"""
# (name, front, id). Listening has no tts fallback: with no Audio its front is
# empty, and Anki makes no card for an empty front.
TEMPLATES = [
    ("Recognition", '<div class="hanzi">{{Hanzi}}</div>', NOTETYPE_ID),
    ("Production", "<div>{{Meaning}}</div>", NOTETYPE_ID + 100),
    ("Listening", '{{#Audio}}<div class="label">🔊 listen</div>{{Audio}}{{/Audio}}', NOTETYPE_ID + 101),
]
CSS = """.card { font-family: sans-serif; font-size: 20px; text-align: center; }
.hanzi { font-size: 48px; }
.pinyin { font-size: 24px; margin: 8px 0; }
.example { margin-top: 16px; }
.en, .label { color: #888; font-size: 16px; }
.t1 { color: #f25c54; } .t2 { color: #f4a259; } .t3 { color: #8cb369; }
.t4 { color: #5b8def; } .t5 { color: #9aa0a6; }"""

# genanki's guid_for, so a re-import updates a note instead of adding a copy
_B91 = list("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~")


def guid_for(*values: str) -> str:
    n = int.from_bytes(hashlib.sha256("__".join(values).encode()).digest()[:8], "big")
    out = []
    while n > 0:
        n, r = divmod(n, len(_B91))
        out.append(_B91[r])
    return "".join(reversed(out))


def build(col: Collection, notes: list[dict], media: Path | None) -> tuple[int, int]:
    mm = col.models
    nt = mm.new("Osmosis")
    for i, name in enumerate(FIELDS):
        f = mm.new_field(name)
        f["id"] = NOTETYPE_ID + i + 1
        mm.add_field(nt, f)
    for name, front, tid in TEMPLATES:
        t = mm.new_template(name)
        t["qfmt"], t["afmt"], t["id"] = front, BACK, tid
        mm.add_template(nt, t)
    nt["css"] = CSS
    mm.add(nt)
    # Anki matches note types by id and field/template ids on import; fresh ids per
    # export would fork an "Osmosis+" copy. The backend will not add a note type
    # with a chosen id, so move it after.
    for table, column in [("notetypes", "id"), ("fields", "ntid"), ("templates", "ntid")]:
        col.db.execute(f"update {table} set {column} = ? where {column} = ?", NOTETYPE_ID, nt["id"])
    mm._clear_cache()
    nt = mm.get(NotetypeId(NOTETYPE_ID))
    did = col.decks.id("Osmosis")
    added = 0
    for n in notes:
        note = col.new_note(nt)
        for name, key in zip(FIELDS[:5], ["hanzi", "pinyin", "meaning", "example", "exampleEn"]):
            note[name] = n.get(key, "")
        for name, key in [("Audio", "audio"), ("ExampleAudio", "exampleAudio")]:
            mp3 = media / n[key] if media and n.get(key) else None
            if mp3 and mp3.is_file() and mp3.stat().st_size > 0:
                note[name] = f"[sound:{col.media.add_file(str(mp3))}]"
                added += 1
        note.guid = guid_for("osmosis", n["hanzi"])
        note.tags = ["osmosis"]
        col.add_note(note, did)
    return did, added


def main() -> None:
    out = Path(sys.argv[1])
    media = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    notes = json.load(sys.stdin)
    with tempfile.TemporaryDirectory() as tmp:
        col = Collection(str(Path(tmp) / "export.anki2"))
        try:
            did, added = build(col, notes, media)
            options = ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False, with_media=True)
            col.export_anki_package(out_path=str(out), options=options, limit=DeckIdLimit(did))
        finally:
            col.close()
    print(json.dumps({"notes": len(notes), "audio": added}))


if __name__ == "__main__":
    main()
