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


def test_parola_sulla_coda_della_precedente_parte_dopo_il_silenzio():
    """«…a girl, beautiful and sweet»: «beautiful» iniziava mentre si teneva ancora «girl» e si
    colorava per tutto il silenzio prima dell'attacco vero."""
    import numpy as np

    from singitnow.lyrics import snap_to_voice

    db = np.full(int(10 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(3.0 / _HOP)] = -15.0  # giiirl tenuta
    db[int(4.7 / _HOP) : int(6.0 / _HOP)] = -15.0  # beautiful and sweet
    line = Line([Word("girl,", 1.0, 2.5), Word("beautiful", 2.5, 5.5), Word("and", 5.5, 6.0)])
    snap_to_voice([line], (db, -40.0))
    assert line.words[0].start == 1.0
    assert line.words[1].start == pytest.approx(4.7, abs=0.05)


def test_parola_senza_voce_si_colora_solo_alla_fine():
    """«Well,» iniziava un secondo prima del cantante e finiva proprio quando lui attaccava."""
    import numpy as np

    from singitnow.lyrics import snap_to_voice

    db = np.full(int(10 / _HOP), -60.0)
    db[int(2.0 / _HOP) : int(4.0 / _HOP)] = -15.0
    line = Line([Word("Well,", 1.0, 2.0), Word("I", 2.0, 2.3), Word("found", 2.3, 4.0)])
    snap_to_voice([line], (db, -40.0))
    assert line.words[0].start == pytest.approx(1.85, abs=0.05)
    assert line.words[1].start == 2.0


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


def test_riga_spostata_da_lrclib_dopo_una_pausa():
    """«Stella»: LRCLIB mette la riga subito dopo il ritornello e poi lascia 35 s vuoti, mentre nel
    video la pausa strumentale viene prima e la riga si canta ~28 s più tardi."""
    texts = [
        (10.0, "stella stella mia resta ancora nel mio cuore"),
        (18.0, "proteggi i nostri figli puri nella vita quotidiana"),
        (53.0, "e salvali dall odio e dal potere"),
        (60.0, "come il primo giorno come nella fantasia"),
    ]
    lines = [Line([Word(w) for w in t.split()], lrc_time=lt) for lt, t in texts]
    heard = []
    for start, (_, t) in zip((10.0, 46.0, 53.0, 60.0), texts):  # la seconda riga si canta a 46 s
        heard += sung(*[(w, start + 0.4 * k) for k, w in enumerate(t.split())])
    align(lines, heard, duration=80.0)
    assert lines[1].words[0].start == pytest.approx(46.0)
    assert [l.words[0].start for l in (lines[0], lines[2], lines[3])] == pytest.approx([10.0, 53.0, 60.0])


def _intro_song(intro_db: float):
    """Due righe d'apertura a 2 s, pausa, poi la canzone (6 righe) da 15 s."""
    import numpy as np

    db = np.full(int(40 / _HOP), -60.0)
    db[int(2.0 / _HOP) : int(5.0 / _HOP)] = intro_db
    db[int(15.0 / _HOP) : int(33.0 / _HOP)] = -12.0
    intro = [Line([Word("che", 2.0, 2.5), Word("giornata", 2.5, 3.0)]), Line([Word("portame", 3.5, 4.0), Word("vino", 4.0, 5.0)])]
    song = [Line([Word("fateme", 15.0 + 3 * i, 16.0 + 3 * i), Word("cantare", 16.0 + 3 * i, 17.0 + 3 * i)]) for i in range(6)]
    heard = [w for l in intro + song for w in l.words]
    return intro + song, (db, -40.0), [Word(w.text, w.start, w.end) for w in heard]


def test_introduzione_parlata_di_sottofondo_si_toglie():
    from singitnow.lyrics import drop_intro

    lines, voice, heard = _intro_song(-32.0)  # 20 dB sotto il canto
    assert drop_intro(lines, voice, heard) == 2
    assert lines[0].words[0].start == 15.0


def test_riga_d_apertura_agganciata_a_caso_si_toglie():
    from singitnow.lyrics import drop_intro

    lines, voice, heard = _intro_song(-14.0)
    heard = [w for w in heard if w.start > 10]  # Whisper all'inizio sente tutt'altro
    assert drop_intro(lines, voice, heard) == 2


def test_apertura_vera_cantata_resta():
    """Un attacco a cappella o cantato piano, sentito da Whisper, è la canzone."""
    from singitnow.lyrics import drop_intro

    lines, voice, heard = _intro_song(-22.0)  # 10 dB sotto: cantato piano
    assert drop_intro(lines, voice, heard) == 0
    assert len(lines) == 8


def _late_line():
    """Silenzio, poi il cantante attacca a 10 s e tiene la nota fino alla riga, stimata a 12.5 s."""
    import numpy as np

    db = np.full(int(30 / _HOP), -60.0)
    db[int(10.0 / _HOP) : int(16.0 / _HOP)] = -12.0
    line = Line([Word("So", 12.5, 13.0), Word("tell", 13.0, 14.0), Word("me", 14.0, 16.0)])
    return line, (db, -40.0)


def test_riga_in_ritardo_parte_quando_il_cantante_attacca():
    """Wannabe: «Yoooou… tell me what you want» cantato da 50 s, la riga stimata a 52.6 s."""
    from singitnow.lyrics import early_line_starts

    line, voice = _late_line()
    heard = [Word("me", 14.2, 14.8)]  # Whisper non ha riconosciuto l'inizio
    assert early_line_starts([line], voice, heard) == 1
    assert line.words[0].start == pytest.approx(10.0, abs=0.05)


def test_riga_confermata_da_whisper_non_si_anticipa():
    """La voce prima della riga è un vocalizzo: Whisper ha sentito la parola dov'è."""
    from singitnow.lyrics import early_line_starts

    line, voice = _late_line()
    assert early_line_starts([line], voice, [Word("So", 12.6, 13.0)]) == 0
    assert line.words[0].start == 12.5


def test_parole_di_una_riga_non_si_agganciano_a_parole_uguali_lontane():
    """Wannabe a mano: «Yooo tell me what you want,» finiva sulle voci dell'intro (20 s) mentre
    il resto della riga era giusto a 51 s."""
    intro = sung(("if", 21.2), ("you", 21.8), ("want", 21.9), ("to", 22.1), ("be", 22.2))
    song = sung(("yo", 50.0), ("what", 51.1), ("you", 51.2), ("really", 51.9), ("really", 52.2), ("want", 52.4))
    line = Line([Word(t) for t in ("Yooo", "you", "want,", "what", "you", "really,", "really", "want")])
    align([line], intro + song, 60.0)
    assert all(w.start > 45 for w in line.words)
    assert [w.start for w in line.words[3:]] == [51.1, 51.2, 51.9, 52.2, 52.4]


def _tail_voice():
    """«lontaniii»: parola da 1.0, nota tenuta fino a 2.2, poi solo la coda (riverbero) fino a 4."""
    import numpy as np

    db = np.full(int(10 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(2.2 / _HOP)] = -12.0
    db[int(2.2 / _HOP) : int(4.0 / _HOP)] = -24.0  # 12 dB sotto: non è più il cantante
    return (db, -40.0)


def test_nota_tenuta_non_si_allunga_sulla_coda_della_voce():
    """Destinazione Paradiso: «lontani» durava 1,3 s più della voce e si colorava piano."""
    from singitnow.lyrics import extend_to_voice, to_json

    line = Line([Word("troppo", 0.5, 1.0), Word("lontani", 1.0, 1.8)])
    heard = [Word("troppo", 0.5, 1.0), Word("lontani", 1.0, 1.8)]
    extend_to_voice([line], _tail_voice(), heard)
    w = line.words[-1]
    assert w.end == pytest.approx(2.2, abs=0.05)
    assert w.hold == pytest.approx(1.8)  # pronunciata a 1.8, poi solo la nota
    assert to_json([line], "x", "it")["lines"][0]["words"][1]["h"] == pytest.approx(1.8)
    assert "h" not in to_json([line], "x", "it")["lines"][0]["words"][0]


def test_coda_allungata_in_passato_si_accorcia_e_resta_stabile():
    from singitnow.lyrics import extend_to_voice

    line = Line([Word("troppo", 0.5, 1.0), Word("lontani", 1.0, 3.9)])  # salvata con la coda
    heard = [Word("troppo", 0.5, 1.0), Word("lontani", 1.0, 1.8)]
    extend_to_voice([line], _tail_voice(), heard)
    assert line.words[-1].end == pytest.approx(2.2, abs=0.05)
    first = (line.words[-1].end, line.words[-1].hold)
    extend_to_voice([line], _tail_voice(), heard)
    assert (line.words[-1].end, line.words[-1].hold) == first


def test_nota_ripresa_dopo_una_pausa_non_si_accorcia():
    """«E… EEEEEE»: dopo la pausa la voce torna a pieno volume, la parola dura fino a lì."""
    import numpy as np

    from singitnow.lyrics import extend_to_voice

    db = np.full(int(12 / _HOP), -60.0)
    db[int(1.0 / _HOP) : int(1.3 / _HOP)] = -12.0
    db[int(2.0 / _HOP) : int(5.0 / _HOP)] = -12.0
    line = Line([Word("E", 1.0, 5.0), Word("fateme", 5.0, 5.5)])
    extend_to_voice([line], (db, -40.0), [Word("E", 1.0, 1.3), Word("fateme", 5.0, 5.5)])
    assert line.words[0].end == 5.0
    assert line.words[0].hold == pytest.approx(1.3)


def _bleed_intro():
    """Strumenti rimasti nella traccia della voce (-22 dB, 10 sotto il canto) fino a 3 s, poi il canto."""
    import numpy as np

    db = np.full(int(10 / _HOP), -60.0)
    db[int(0.0 / _HOP) : int(3.0 / _HOP)] = -22.0
    db[int(3.0 / _HOP) : int(6.0 / _HOP)] = -12.0
    line = Line([Word("Stanotte", 0.2, 3.5), Word("ti", 3.5, 3.8), Word("pretendo", 3.8, 5.5)])
    return line, (db, -45.0)


def test_prima_parola_non_parte_sugli_strumenti():
    """«Ti pretendo»: Whisper sente «Sto a notte», «Stanotte» restava al tempo di LRCLIB 3 s prima."""
    from singitnow.lyrics import late_line_starts, snap_to_voice

    line, voice = _bleed_intro()
    snap_to_voice([line], voice)
    assert line.words[0].start == 0.2  # gli strumenti sembrano voce
    heard = [Word("Sto", 3.0, 3.2), Word("notte", 3.2, 3.5), Word("pretendo", 3.8, 5.5)]
    assert late_line_starts([line], voice, heard) == 1
    assert line.words[0].start == pytest.approx(3.0)


def test_prima_parola_riconosciuta_prima_non_si_sposta():
    """Whisper ha sentito proprio la parola all'inizio: è cantata piano, resta dov'è."""
    from singitnow.lyrics import late_line_starts

    line, voice = _bleed_intro()
    heard = [Word("Stanotte", 0.25, 1.0), Word("pretendo", 3.8, 5.5)]
    assert late_line_starts([line], voice, heard) == 0
    line, voice = _bleed_intro()
    heard = [Word("Stanotte", 1.5, 2.5), Word("ti", 3.0, 3.2), Word("pretendo", 3.8, 5.5)]
    assert late_line_starts([line], voice, heard) == 0
