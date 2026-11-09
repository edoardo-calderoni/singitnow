"""Backup della libreria: esportazione e importazione (anche su un altro PC)."""

from __future__ import annotations

import json
import shutil
import zipfile

import pytest

from singitnow import backup, config, halloffame
from singitnow.library import QUEUED, READY, library


def make_song(add_song, sid, media=True, source="lrclib+whisper"):
    s = add_song(sid)
    (s.dir / "song.json").write_text(json.dumps({"id": sid, "youtube_id": sid, "title": f"Brano {sid}", "status": "ready"}))
    (s.dir / "lyrics.json").write_text(json.dumps({"source": source, "lines": [{"text": sid}]}))
    if media:
        for f in backup.MEDIA_FILES:
            (s.dir / f).write_bytes(b"m" * 10)
    return s


def wipe():
    """Un altro PC: libreria e dati vuoti."""
    with library._lock:
        library._songs.clear()
    for d in config.DATA_DIR.iterdir():
        shutil.rmtree(d) if d.is_dir() else d.unlink()
    config.ensure_dirs()


@pytest.fixture
def out(tmp_path):
    return tmp_path


def test_backup_completo_su_un_altro_pc(add_song, out):
    make_song(add_song, "a")
    halloffame.add("Anna", "Verdi", "a", "Brano A", 80, 1.0, "Anna")
    z = backup.export(full=True, dest_dir=out)
    with zipfile.ZipFile(z) as f:
        assert "library/a/video.mp4" in f.namelist() and "scores.json" in f.namelist()

    wipe()
    r = backup.restore(z)
    assert r["added"] == 1 and r["to_download"] == 0 and r["scores"] == 1
    assert library.get("a").status == READY
    assert (library.get("a").dir / "video.mp4").exists()
    assert halloffame.rows()[0]["score"] == 80


def test_backup_solo_dati_riscarica_tenendo_il_testo(add_song, out):
    make_song(add_song, "a", source="manual+whisper")
    z = backup.export(full=False, dest_dir=out)
    with zipfile.ZipFile(z) as f:
        assert "library/a/video.mp4" not in f.namelist() and "library/a/lyrics.json" in f.namelist()

    wipe()
    r = backup.restore(z)
    s = library.get("a")
    assert r["to_download"] == 1 and s.status == QUEUED
    assert (s.dir / backup.KEEP_LYRICS).exists()  # la pipeline non rigenererà il testo


def test_testo_corretto_a_mano_sostituisce_quello_automatico(add_song, out):
    make_song(add_song, "a", source="manual+whisper")
    z = backup.export(full=False, dest_dir=out)
    s = library.get("a")
    (s.dir / "lyrics.json").write_text(json.dumps({"source": "lrclib+whisper", "lines": []}))
    r = backup.restore(z)
    assert r["lyrics"] == 1 and r["added"] == 0
    assert json.loads((s.dir / "lyrics.json").read_text())["source"] == "manual+whisper"


def test_voti_non_si_duplicano(add_song, out):
    make_song(add_song, "a")
    halloffame.add("Anna", "Verdi", "a", "Brano A", 80, 1.0, "Anna")
    z = backup.export(full=False, dest_dir=out)
    assert backup.restore(z)["scores"] == 0
    assert len(halloffame.rows()) == 1


def test_file_che_non_e_un_backup(out):
    bad = out / "x.zip"
    with zipfile.ZipFile(bad, "w") as f:
        f.writestr("ciao.txt", "no")
    with pytest.raises(ValueError):
        backup.restore(bad)


def test_percorsi_fuori_dalla_cartella_dati_si_ignorano(out):
    evil = out / "evil.zip"
    with zipfile.ZipFile(evil, "w") as f:
        f.writestr("manifest.json", "{}")
        f.writestr("avatars/../../fuori.txt", "x")
        f.writestr("library/../fuori/song.json", "{}")
    backup.restore(evil)
    assert not (config.DATA_DIR.parent / "fuori.txt").exists()
