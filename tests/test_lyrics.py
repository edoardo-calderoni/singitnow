"""Lettura dei testi e allineamento delle parole (senza Whisper né rete)."""

from __future__ import annotations

import pytest

from singitnow.lyrics import Line, Word, _distribute, _norm, align, parse_lrc, parse_plain


def test_parse_lrc_tempi_ripetuti_e_ordine():
    lrc = "[ar:Qualcuno]\n[00:20.50]Seconda riga\n[00:05.00][01:00.25]Ritornello qui\n[00:30.00]\n"
    lines = parse_lrc(lrc)
    assert [(l.lrc_time, l.text) for l in lines] == [
        (5.0, "Ritornello qui"),
        (20.5, "Seconda riga"),
        (60.25, "Ritornello qui"),
    ]


def test_parse_lrc_centesimi_e_millesimi():
    lines = parse_lrc("[00:01.5]a\n[00:02.123]b")
    assert [l.lrc_time for l in lines] == [pytest.approx(1.5), pytest.approx(2.123)]


def test_parse_plain_salta_le_righe_vuote():
    lines = parse_plain("uno due\n\n   \ntre")
    assert [l.text for l in lines] == ["uno due", "tre"]
    assert all(l.lrc_time is None for l in lines)


def test_norm_ignora_accenti_e_punteggiatura():
    assert _norm("Perché,") == "perche"
    assert _norm("L'AMORE!") == "lamore"


def test_distribute_proporzionale_e_contiguo():
    words = [Word("a"), Word("lunghissima")]
    _distribute(words, 10.0, 14.0)
    assert words[0].start == 10.0
    assert words[0].end == words[1].start
    assert words[1].end == pytest.approx(14.0)
    assert (words[1].end - words[1].start) > (words[0].end - words[0].start)


def test_distribute_durata_minima():
    words = [Word("a"), Word("b"), Word("c")]
    _distribute(words, 5.0, 5.0)  # intervallo nullo: almeno 0,2 s a parola
    assert words[-1].end == pytest.approx(5.6)


def sung(*items: tuple[str, float]) -> list[Word]:
    return [Word(t, s, s + 0.4) for t, s in items]


def test_align_senza_tempi_abbina_le_parole_nell_ordine():
    lines = parse_plain("Ciao amore mio\nresta qui")
    voice = sung(("ciao", 1.0), ("amore", 1.5), ("mio", 2.0), ("resta", 4.0), ("qui", 4.5))
    ratio = align(lines, voice, duration=10.0)
    assert ratio == 1.0
    assert [w.start for l in lines for w in l.words] == [1.0, 1.5, 2.0, 4.0, 4.5]


def test_align_parola_non_cantata_viene_interpolata():
    lines = parse_plain("uno due tre")
    voice = sung(("uno", 1.0), ("tre", 3.0))
    ratio = align(lines, voice, duration=10.0)
    assert ratio == pytest.approx(2 / 3)
    uno, due, tre = lines[0].words
    assert uno.start == 1.0 and tre.start == 3.0
    assert uno.start < due.start < tre.start  # tempo ricavato fra le parole vicine


def test_align_con_tempi_lrc_segue_lo_scarto_del_video():
    """Il video ha 10 s di intro in più della versione di LRCLIB: le righe si spostano tutte."""
    lines = [
        Line([Word("primo"), Word("verso"), Word("qui")], lrc_time=5.0),
        Line([Word("secondo"), Word("verso"), Word("ancora")], lrc_time=10.0),
        Line([Word("terzo"), Word("verso"), Word("finale")], lrc_time=15.0),
    ]
    voice = sung(
        ("primo", 15.0), ("verso", 15.5), ("qui", 16.0),
        ("secondo", 20.0), ("verso", 20.5), ("ancora", 21.0),
        ("terzo", 25.0), ("verso", 25.5), ("finale", 26.0),
    )
    ratio = align(lines, voice, duration=40.0)
    assert ratio > 0.9
    assert [l.words[0].start for l in lines] == pytest.approx([15.0, 20.0, 25.0])


# ------------------------------------------------------------------ note tenute
from singitnow.lyrics import _HOP, fix_held_notes, syllables, voice_onsets  # noqa: E402


def test_sillabe():
    assert syllables("fateme") == 3
    assert syllables("cantà") == 2
    assert syllables("parcheggio") == 3
    assert syllables("E") == 1
    assert syllables("time", "en") == 1


def held_voice():
    """Voce sintetica di «E… EEEEEE fa-te-me can-tà»: una E breve, una pausa, una E tenuta 2,5 s
    senza stacchi, poi un calo netto (consonante) all'inizio di ogni sillaba."""
    import numpy as np

    db = np.full(int(8 / _HOP), -60.0)

    def sing(a, b):
        db[int(round(a / _HOP)) : int(round(b / _HOP))] = -12.0

    sing(1.0, 1.8)  # E
    sing(2.3, 7.0)  # EEEEEE (tenuta) e poi fa-te-me can-tà
    for t in (4.8, 5.1, 5.4, 5.7):  # f, t, m, c
        db[int(round(t / _HOP))] = -30.0
    return db, -40.0


def bad_line():
    """Come l'aveva sincronizzata Whisper: «fateme» e «cantà» partono dentro la E tenuta."""
    return Line([Word("E", 1.0, 1.3), Word("fateme", 1.3, 3.5), Word("cantà", 3.5, 7.0)])


def test_attacchi_delle_sillabe():
    onsets = [round(i * _HOP, 2) for i in voice_onsets(held_voice())]
    assert onsets == [0.98, 2.28, 4.8, 5.1, 5.4, 5.7]


def test_nota_tenuta_resta_alla_parola_prima():
    line = bad_line()
    sung = [Word("E", 0.95, 1.3), Word("fatemi", 1.3, 5.6), Word("cantare", 5.6, 6.6)]
    assert fix_held_notes([line], held_voice(), sung, "it") == 1
    e, fateme, canta = line.words
    assert e.start == 1.0 and e.end == pytest.approx(fateme.start)
    assert fateme.start == pytest.approx(4.8)  # dopo la E tenuta, sulla «f»
    assert 5.3 <= canta.start <= 5.8
    assert canta.end == 7.0


def test_senza_conferma_della_trascrizione_non_cambia_niente():
    """Se anche Whisper aveva sentito «cantà» dove sta già, gli stacchi da soli non bastano."""
    line = bad_line()
    sung = [Word("E", 0.95, 1.3), Word("fatemi", 1.3, 3.5), Word("cantare", 3.5, 6.6)]
    assert fix_held_notes([line], held_voice(), sung, "it") == 0
    assert [w.start for w in line.words] == [1.0, 1.3, 3.5]


def test_riga_senza_note_tenute_non_cambia():
    line = Line([Word("fateme", 4.8, 5.4), Word("cantà", 5.7, 7.0)])
    sung = [Word("fatemi", 4.8, 5.6), Word("cantare", 5.6, 6.6)]
    assert fix_held_notes([line], held_voice(), sung, "it") == 0
    assert [w.start for w in line.words] == [4.8, 5.7]


def test_abbinamento_non_salta_alla_riga_dopo():
    """«Sta pe' strada…»: Whisper sente «per», e il «Pe'» identico è l'inizio della riga dopo.
    Prima l'abbinamento prendeva quello e perdeva tutte le parole in mezzo."""
    from singitnow.lyrics import _match_in_window

    line = Line([Word(t) for t in ("Sta", "pe'", "strada,", "elemosina", "un", "core")])
    heard = sung(("Sta", 175.5), ("per", 176.7), ("strada", 177.2), ("e", 177.9), ("l", 178.5),
                 ("'emosina", 178.6), ("ancora", 179.4), ("Pe'", 180.4), ("quel", 182.2))
    _match_in_window(line, 170.0, 185.0, heard, [w.start for w in heard])
    assert [w.start for w in line.words[:4]] == [175.5, 176.7, 177.2, 178.6]
    assert line.words[1].run >= 3  # «Sta per strada» abbinate in sequenza


def test_parole_simili():
    from singitnow.lyrics import _similar

    assert _similar("pe", "per") > 0
    assert _similar("fateme", "fatemi") > 0
    assert _similar("pe", "e") == 0  # le parole corte devono somigliarsi di più
    assert _similar("un", "in") == 0


def test_nota_tenuta_in_mezzo_alla_riga_si_colora_tutta():
    """«E… EEEEEE» tenuta fino alla parola dopo: la E resta colorata finché la si canta."""
    import numpy as np

    from singitnow.lyrics import extend_to_voice

    db = np.full(int(12 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(4.5 / _HOP)] = -12.0  # E tenuta
    db[int(5.0 / _HOP) : int(6.5 / _HOP)] = -12.0  # fateme cantààà
    line = Line([Word("E", 1.0, 1.3), Word("fateme", 5.0, 5.5), Word("cantà", 5.5, 5.8)])
    extend_to_voice([line], (db, -40.0))
    assert line.words[0].end == pytest.approx(4.48, abs=0.05)  # fino a dove si sente la E
    assert line.words[-1].end == pytest.approx(6.48, abs=0.05)


def test_allungare_due_volte_non_cambia_niente():
    import numpy as np

    from singitnow.lyrics import extend_to_voice

    db = np.full(int(30 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(25 / _HOP)] = -12.0  # coro che non finisce più
    line = Line([Word("Un", 0.5, 1.0), Word("matto", 1.0, 1.5)])
    extend_to_voice([line], (db, -40.0))
    first = line.words[-1].end
    assert first == pytest.approx(9.0, abs=0.05)  # al massimo 8 s dall'inizio della parola
    extend_to_voice([line], (db, -40.0))
    assert line.words[-1].end == first


def test_nota_tenuta_finisce_al_primo_stacco_dopo_la_parola():
    """«un mattoooo» e poi, sulla stessa nota, «na-na-na»: la parola non si colora fino alla fine."""
    import numpy as np

    from singitnow.lyrics import extend_to_voice

    db = np.full(int(30 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(20 / _HOP)] = -12.0  # «matto» tenuto e poi na-na-na sulla stessa nota
    for t in (1.7, 3.6, 4.8, 6.0, 7.2):  # «t» di matto, poi l'attacco di ogni «na»
        db[int(round(t / _HOP))] = -30.0
    line = Line([Word("Un", 0.5, 1.0), Word("matto", 1.0, 1.5)])
    sung = [Word("un", 0.5, 1.0), Word("mato", 1.05, 2.9)]  # Whisper chiude la nota un po' presto
    extend_to_voice([line], (db, -40.0), sung)
    assert line.words[-1].end == pytest.approx(3.6, abs=0.05)  # fino al primo «na», non 8 s


def test_nota_finale_allungata_in_passato_si_accorcia():
    import numpy as np

    from singitnow.lyrics import extend_to_voice

    db = np.full(int(30 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(20 / _HOP)] = -12.0
    for t in (1.7, 3.6, 4.8, 6.0, 7.2):
        db[int(round(t / _HOP))] = -30.0
    line = Line([Word("Un", 0.5, 1.0), Word("matto", 1.0, 9.0)])  # testo salvato prima della correzione
    sung = [Word("un", 0.5, 1.0), Word("mato", 1.05, 2.9)]
    extend_to_voice([line], (db, -40.0), sung)
    assert line.words[-1].end == pytest.approx(3.6, abs=0.05)
