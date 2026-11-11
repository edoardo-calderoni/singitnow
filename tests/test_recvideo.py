from singitnow import recvideo


def _line(text, start, step=0.5):
    words = [{"t": w, "s": start + i * step, "e": start + i * step + step * 0.9} for i, w in enumerate(text.split())]
    return {"text": text, "words": words, "start": words[0]["s"], "end": words[-1]["e"]}


def test_tempi_della_registrazione_con_salto():
    lines = [_line("uno due", 10), _line("tre quattro", 20), _line("cinque sei", 40)]
    # registrazione partita al secondo 9 del brano; dopo 8 s si è saltati al secondo 39
    out = recvideo.song_to_rec(lines, [[0, 9], [8, 39]], 30)
    assert [l["text"] for l in out] == ["uno due", "cinque sei"]  # «tre quattro» è stata saltata
    assert out[0]["start"] == 1.0
    assert out[1]["start"] == 9.0


def test_senza_segni_si_parte_da_zero():
    out = recvideo.song_to_rec([_line("ciao a tutti", 5)], [], 60)
    assert out[0]["start"] == 5.0


def test_storia_sul_ritornello():
    lines = [_line(f"strofa {i}", 5 + 4 * i) for i in range(20)]  # 5..81 s, tutte diverse
    lines += [_line("questo è il ritornello", 120 + 4 * i) for i in range(6)]
    lines += [_line(f"altra {i}", 150 + 4 * i) for i in range(10)]
    a, b = recvideo.story_window(lines, 240)
    assert b - a == 60
    assert a <= 120 and b >= 140


def test_storia_di_un_brano_corto():
    assert recvideo.story_window([_line("ciao", 2)], 40) == (0.0, 40)


def test_sottotitoli_karaoke():
    lines = [_line("uno due", 2.0), _line("tre", 5.0)]
    ass = recvideo.build_ass(lines, 0, 10)
    assert r"\kf" in ass and "uno" in ass and "tre" in ass
    # la prima riga entra in anticipo (0.9 s) e la sua prima parola aspetta il canto con \k
    assert "Dialogue: 1,0:00:01.10," in ass
    assert r"{\k90}{\kf45}uno" in ass
