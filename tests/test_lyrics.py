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
    # attacco breve ma al livello del canto, riconosciuto da Whisper: è suo («tanto» in Ti pretendo)
    line, (db, thr) = _bleed_intro()
    db[int(1.5 / _HOP) : int(1.58 / _HOP)] = -12.0
    heard = [Word("Stanotte", 1.5, 2.5), Word("ti", 3.0, 3.2), Word("pretendo", 3.8, 5.5)]
    assert late_line_starts([line], (db, thr), heard) == 0


def test_whisper_che_sente_la_parola_nel_fondo_non_basta():
    """«La solitudine»: Whisper sente «Marco» dentro gli strumenti, 0,5 s prima del canto."""
    from singitnow.lyrics import late_line_starts

    line, voice = _bleed_intro()
    heard = [Word("Stanotte", 2.5, 3.4), Word("pretendo", 3.8, 5.5)]
    assert late_line_starts([line], voice, heard) == 1
    assert line.words[0].start == pytest.approx(3.0)


def test_riga_ripetuta_non_sentita_torna_al_tempo_di_lrclib():
    """«Qua dentro non si respira» quattro volte, Whisper ne sente tre: la riga mancante restava
    schiacciata in un istante dietro a «respira» che si era preso tutto lo spazio."""
    from singitnow.lyrics import uncrush_lines

    def qua(t):
        return [Word(x, t + 0.3 * k, t + 0.3 * k + 0.3) for k, x in enumerate(("Qua", "dentro", "non", "si", "respira"))]

    first, crushed, third = Line(qua(16.0), anchor=16.0), Line(qua(0), anchor=18.0), Line(qua(20.2), anchor=20.2)
    first.words[-1].end = 20.0  # «respira» lungo fino alla riga dopo
    for w in crushed.words:
        w.start, w.end = 17.5, 17.5
    assert uncrush_lines([first, crushed, third]) == 1
    assert crushed.words[0].start == pytest.approx(18.0)
    assert crushed.words[-1].start > crushed.words[0].start + 1
    assert crushed.words[-1].end <= 20.1
    assert first.words[-1].end == pytest.approx(18.0)


def test_parole_di_una_riga_non_oltre_la_riga_dopo():
    from singitnow.lyrics import fit_lines

    a = Line([Word("Incominciamo", 11.1, 11.3), Word("(incominciamo)", 14.3, 15.1)])
    b = Line([Word("Incominciamo", 12.4, 13.3)])
    assert fit_lines([a, b]) == 1
    assert 11.1 < a.words[1].start < 12.4
    assert a.words[1].end <= 12.4


def test_tratto_agganciato_alla_ripetizione_sbagliata_passa_all_ordine():
    """«Che cazzata»: con i tempi di LRCLIB l'intro era agganciata alle ripetizioni sbagliate, 2 s
    prima; l'abbinamento per ordine la metteva dove Whisper la sente."""
    from singitnow.lyrics import adopt_confirmed_lines

    heard = sung(("Fabri", 6.5), ("Fibra", 7.3), ("Qua", 16.4), ("Qua", 18.4), ("Qua", 20.3), ("Questa", 31.8))

    def mk(times):
        out = []
        for i, (t, w) in enumerate(zip(times, ("Fabri", "Fibra", "Qua", "Qua", "Qua", "Questa"))):
            l = Line([Word(w, t, t + 0.5, run=2)])
            l.pos = i
            out.append(l)
        return out

    lrc = mk([2.3, 4.0, 14.7, 16.4, 18.4, 31.8])  # «Qua» sulla ripetizione prima
    plain = mk([6.5, 7.3, 16.4, 18.4, 20.3, 31.8])
    assert adopt_confirmed_lines(lrc, plain, heard) == 5
    assert [l.words[0].start for l in lrc] == [6.5, 7.3, 16.4, 18.4, 20.3, 31.8]

    # differenza piccola: si resta con LRCLIB
    lrc = mk([2.3, 7.3, 16.4, 18.4, 18.9, 31.8])
    assert adopt_confirmed_lines(lrc, plain, heard) == 0


def _saved_song(tmp_path):
    import json

    data = {"source": "lrclib+whisper", "language": "it", "snap": 1, "lines": [
        {"start": 1.0, "end": 2.0, "text": "uno due", "words": [{"t": "uno", "s": 1.0, "e": 1.5}, {"t": "due", "s": 1.5, "e": 2.0, "h": 1.7}]},
        {"start": 3.0, "end": 4.0, "text": "tre", "words": [{"t": "tre", "s": 3.0, "e": 4.0}]},
    ]}
    (tmp_path / "lyrics.json").write_text(json.dumps(data), encoding="utf-8")
    return data


def test_tempi_corretti_a_mano_si_salvano(tmp_path):
    import json

    from singitnow.lyrics import TimingError, save_timings

    _saved_song(tmp_path)
    lines = [
        {"words": [{"s": 1.2, "e": 1.6}, {"s": 1.6, "e": 2.2}], "manual": True},
        {"words": [{"s": 3.1, "e": 4.0}], "manual": False},
    ]
    assert save_timings(tmp_path, lines, 200) == 1
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    first = data["lines"][0]
    assert first["manual"] is True and first["start"] == 1.2 and first["end"] == 2.2
    assert "h" not in first["words"][1]  # nota tenuta non mandata: si toglie
    assert first["text"] == "uno due"  # il testo non cambia
    assert "manual" not in data["lines"][1]
    with pytest.raises(TimingError):
        save_timings(tmp_path, lines[:1], 200)  # righe diverse
    bad = [dict(lines[0]), {"words": [{"s": 0.5, "e": 4.0}]}]
    with pytest.raises(TimingError):
        save_timings(tmp_path, bad, 200)  # fuori ordine


def test_righe_corrette_a_mano_restano_dopo_una_nuova_sincronizzazione():
    from singitnow.lyrics import carry_manual

    old = {"lines": [
        {"text": "Yeah", "start": 6.0, "end": 6.4, "manual": True, "words": [{"t": "Yeah", "s": 6.0, "e": 6.4}]},
        {"text": "Fabri", "start": 6.5, "end": 7.0, "words": [{"t": "Fabri", "s": 6.5, "e": 7.0}]},
    ]}
    new = {"lines": [
        {"text": "Intro nuova", "start": 0.5, "end": 1.0, "words": [{"t": "Intro", "s": 0.5, "e": 0.7}, {"t": "nuova", "s": 0.7, "e": 1.0}]},
        {"text": "Yeah", "start": 1.0, "end": 2.0, "words": [{"t": "Yeah", "s": 1.0, "e": 2.0}]},
        {"text": "Fabri", "start": 2.3, "end": 3.0, "words": [{"t": "Fabri", "s": 2.3, "e": 3.0}]},
    ]}
    assert carry_manual(old, new) == 1
    assert new["lines"][1]["words"][0]["s"] == 6.0 and new["lines"][1]["manual"] is True
    assert new["lines"][2]["words"][0]["s"] == 2.3  # non corretta a mano: resta la nuova


def test_righe_corrette_a_mano_non_si_toccano_nella_ricorrezione(tmp_path):
    import json

    import numpy as np

    from singitnow import lyrics as L

    _saved_song(tmp_path)
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    data["lines"][0]["manual"] = True
    (tmp_path / "lyrics.json").write_text(json.dumps(data), encoding="utf-8")
    (tmp_path / "vocals.m4a").write_bytes(b"x")
    db = np.full(int(10 / _HOP), -60.0)
    db[int(1.6 / _HOP) : int(2.5 / _HOP)] = -12.0  # la voce direbbe di spostare «uno»
    db[int(3.0 / _HOP) : int(4.0 / _HOP)] = -12.0
    orig = (L._load_16k, L.voice_activity)
    L._load_16k, L.voice_activity = (lambda p: None), (lambda a: (db, -40.0))
    try:
        L.resnap_saved(tmp_path)
    finally:
        L._load_16k, L.voice_activity = orig
    out = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert [(w["s"], w["e"]) for w in out["lines"][0]["words"]] == [(1.0, 1.5), (1.5, 2.0)]
    assert out["lines"][0]["manual"] is True


def test_righe_e_parole_eliminate_nell_editor(tmp_path):
    import json

    from singitnow.lyrics import TimingError, save_timings

    _saved_song(tmp_path)  # «uno due» (parole 0, 1) e «tre» (parola 2)
    # via «uno» dalla prima riga, via la seconda riga
    assert save_timings(tmp_path, [{"words": [{"k": 1, "t": "due", "s": 1.5, "e": 2.0}]}], 200) == 1
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert [l["text"] for l in data["lines"]] == ["due"]
    assert data["lines"][0]["manual"] is True and data["lines"][0]["start"] == 1.5

    _saved_song(tmp_path)
    for bad in (
        [{"words": [{"k": 1, "t": "due", "s": 1.5, "e": 2}, {"k": 0, "t": "uno", "s": 1.6, "e": 2}]}],  # riordinate
        [{"words": [{"k": 1, "t": "DUE", "s": 1.5, "e": 2}]}],  # testo diverso
        [{"words": [{"k": 1, "t": "due", "s": 1.5, "e": 2}, {"k": 2, "t": "tre", "s": 3, "e": 4}]}],  # righe unite
        [{"words": []}],  # tutto vuoto
    ):
        with pytest.raises(TimingError):
            save_timings(tmp_path, bad, 200)


def test_riga_riscritta_nell_editor(tmp_path):
    import json

    from singitnow.lyrics import TimingError, save_timings

    _saved_song(tmp_path)  # «uno due» (parole 0, 1) e «tre» (parola 2)
    lines = [
        {"edited": True, "words": [{"t": "uno", "s": 1.0, "e": 1.3}, {"t": "e", "s": 1.3, "e": 1.5}, {"t": "due", "s": 1.5, "e": 2.0}]},
        {"words": [{"k": 2, "t": "tre", "s": 3.0, "e": 4.0}]},
    ]
    assert save_timings(tmp_path, lines, 200) == 1
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert [l["text"] for l in data["lines"]] == ["uno e due", "tre"]
    assert data["lines"][0]["manual"] is True and data["lines"][0]["end"] == 2.0
    assert "manual" not in data["lines"][1]

    _saved_song(tmp_path)
    bad = [{"edited": True, "words": [{"t": "due parole", "s": 1.0, "e": 2.0}]}]
    with pytest.raises(TimingError):
        save_timings(tmp_path, bad, 200)  # una «parola» con spazi
    bad = [{"edited": True, "words": [{"t": "x", "s": 5.0, "e": 6.0}]}, {"words": [{"k": 2, "t": "tre", "s": 3.0, "e": 4.0}]}]
    with pytest.raises(TimingError):
        save_timings(tmp_path, bad, 200)  # fuori ordine


def _breath_voice(dip_at: float, dip_len: float = 0.2):
    """Riga prima cantata fino a dip_at (nota tenuta), respiro di dip_len secondi, poi la riga nuova."""
    import numpy as np

    db = np.full(int(30 / _HOP), -60.0)
    db[int(8.0 / _HOP) : int(16.0 / _HOP)] = -10.0
    db[int(dip_at / _HOP) : int((dip_at + dip_len) / _HOP)] = -30.0
    return db, -40.0


def _breath_line(start: float = 10.0):
    return Line([Word("Starò", start, 11.6), Word("attento", 11.6, 12.4), Word("ad", 12.4, 13.0), Word("uscire", 13.0, 15.5)])


def test_riga_sulla_coda_della_precedente_parte_dopo_il_respiro():
    """Ragni: «Starò attento…» partiva mentre il cantante teneva ancora «…a te»."""
    from singitnow.lyrics import breath_line_starts

    line = _breath_line()
    assert breath_line_starts([line], _breath_voice(10.5)) == 1
    assert line.words[0].start == pytest.approx(10.7, abs=0.05)
    assert breath_line_starts([line], _breath_voice(10.5)) == 0  # ripetere non cambia niente


def test_calo_subito_dopo_l_inizio_e_una_consonante():
    """Un calo entro mezzo secondo è quasi sempre la parola stessa («Sta-volta»): si resta."""
    from singitnow.lyrics import breath_line_starts

    line = _breath_line()
    assert breath_line_starts([line], _breath_voice(10.15)) == 0
    assert line.words[0].start == 10.0


def test_riga_che_parte_sul_fondo():
    """Shallow: la riga partiva sui cori rimasti nella traccia della voce, 12 dB sotto il canto."""
    import numpy as np

    from singitnow.lyrics import breath_line_starts

    db = np.full(int(30 / _HOP), -60.0)
    db[int(9.0 / _HOP) : int(10.8 / _HOP)] = -22.0  # fondo
    db[int(10.8 / _HOP) : int(16.0 / _HOP)] = -10.0  # il cantante
    line = _breath_line()
    assert breath_line_starts([line], (db, -40.0)) == 1
    assert line.words[0].start == pytest.approx(10.8, abs=0.05)


def _gap_voice(before: float):
    """Voce a -10 dB fino a 10.2 (da `before`), silenzio vero fino a 11.55, poi la riga nuova."""
    import numpy as np

    db = np.full(int(30 / _HOP), -60.0)
    db[int(before / _HOP) : int(10.2 / _HOP)] = -10.0
    db[int(11.55 / _HOP) : int(16.0 / _HOP)] = -10.0
    return db, -40.0


def test_prima_parola_allungata_sul_silenzio_parte_dopo():
    """Prima di ogni cosa: «Che» partiva sulla coda di «…bambino» e copriva un secondo e mezzo di
    silenzio; la riga parte dove la voce riprende, anche a ridosso della fine della parola."""
    from singitnow.lyrics import breath_line_starts

    line = _breath_line()
    assert breath_line_starts([line], _gap_voice(8.0)) == 1
    assert line.words[0].start == pytest.approx(11.55, abs=0.03)
    assert line.words[0].end == 11.6
    assert breath_line_starts([line], _gap_voice(8.0)) == 0


def test_silenzio_dopo_un_attacco_vero_non_sposta():
    """Se prima dell'inizio c'è silenzio, la parola parte davvero lì (un «Oh-oh» seguito da una pausa)."""
    from singitnow.lyrics import breath_line_starts

    line = _breath_line()
    assert breath_line_starts([line], _gap_voice(10.0)) == 0
    assert line.words[0].start == 10.0


def test_lrclib_contrario_ferma_lo_spostamento():
    """Se LRCLIB (con lo scarto tipico del brano) mette la riga dov'era, non si sposta."""
    from singitnow.lyrics import breath_line_starts

    others = [Line([Word("a", t, t + 0.5)], lrc_time=t - 1.0) for t in (2.0, 4.0, 6.0)]
    line = _breath_line()
    line.lrc_time = 9.0  # con lo scarto (+1 s) dice 10.0: proprio dove già sta
    assert breath_line_starts(others + [line], _breath_voice(10.5)) == 0
    assert line.words[0].start == 10.0


def test_brano_corretto_a_mano_non_si_ricorregge(tmp_path):
    """Chi corregge un brano ascolta tutte le righe: anche quelle lasciate com'erano sono giuste."""
    import json

    import numpy as np

    from singitnow import lyrics as L

    _saved_song(tmp_path)
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    data["lines"][0]["manual"] = True
    (tmp_path / "lyrics.json").write_text(json.dumps(data), encoding="utf-8")
    (tmp_path / "vocals.m4a").write_bytes(b"x")
    db = np.full(int(10 / _HOP), -60.0)
    db[int(3.5 / _HOP) : int(4.0 / _HOP)] = -12.0  # la voce direbbe di spostare «tre» (riga non toccata)
    orig = (L._load_16k, L.voice_activity)
    L._load_16k, L.voice_activity = (lambda p: None), (lambda a: (db, -40.0))
    try:
        assert L.resnap_saved(tmp_path) is None
    finally:
        L._load_16k, L.voice_activity = orig
    out = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert out["lines"][1]["words"][0]["s"] == 3.0
    assert out["snap"] == L.SNAP_VERSION


def test_brano_gia_riallineato_non_riallunga_le_note(tmp_path):
    """Dalla versione 13 la catena intera è già passata: si rifà solo l'inizio delle righe, perché
    ripassare extend_to_voice allungherebbe di nuovo le note tenute."""
    import json

    import numpy as np

    from singitnow import lyrics as L

    _saved_song(tmp_path)
    data = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    data["snap"] = 13
    (tmp_path / "lyrics.json").write_text(json.dumps(data), encoding="utf-8")
    (tmp_path / "vocals.m4a").write_bytes(b"x")
    db = np.full(int(10 / _HOP), -10.0)  # voce piena ovunque: extend_to_voice allungherebbe tutto

    def boom(*a, **k):
        raise AssertionError("catena intera ripassata")

    orig = (L._load_16k, L.voice_activity, L.extend_to_voice, L.snap_to_voice)
    L._load_16k, L.voice_activity = (lambda p: None), (lambda a: (db, -40.0))
    L.extend_to_voice = L.snap_to_voice = boom
    try:
        L.resnap_saved(tmp_path)
    finally:
        L._load_16k, L.voice_activity, L.extend_to_voice, L.snap_to_voice = orig
    out = json.loads((tmp_path / "lyrics.json").read_text(encoding="utf-8"))
    assert [l["end"] for l in out["lines"]] == [2.0, 4.0]
    assert out["snap"] == L.SNAP_VERSION


def _pause_voice(pause_len: float):
    """Riga cantata a -10 dB; dopo 12.0 la voce cala a -25 dB per pause_len secondi."""
    import numpy as np

    db = np.full(int(30 / _HOP), -60.0)
    db[int(10.0 / _HOP) : int(16.0 / _HOP)] = -10.0
    db[int(12.1 / _HOP) : int((12.1 + pause_len) / _HOP)] = -25.0
    return db, -40.0


def _pause_line():
    return Line([Word("parlar", 10.0, 11.0), Word("d'amore", 11.0, 12.0), Word("l'emozione", 12.0, 14.0), Word("non", 14.0, 15.5)])


def test_parola_dopo_una_pausa_nella_riga_parte_quando_la_voce_torna():
    """L'emozione non ha voce: «l'emozione» partiva attaccata a «d'amore», un secondo prima."""
    from singitnow.lyrics import pause_word_starts

    line = _pause_line()
    assert pause_word_starts([line], _pause_voice(0.9)) == 1
    assert line.words[2].start == pytest.approx(13.0, abs=0.03)
    assert line.words[1].end == 12.0  # nella pausa non si canta: la parola prima non si allunga
    assert pause_word_starts([line], _pause_voice(0.9)) == 0


def test_calo_breve_nella_riga_non_sposta():
    """Un calo di un attimo (consonante, respiro rapido) non è una pausa."""
    from singitnow.lyrics import pause_word_starts

    line = _pause_line()
    assert pause_word_starts([line], _pause_voice(0.2)) == 0
    assert line.words[2].start == 12.0


def test_prima_parola_sola_nel_silenzio_si_attacca_alla_seconda():
    """Sally: «Tanto» stava un secondo prima, dove la voce non c'è; il resto della riga era giusto."""
    import numpy as np

    from singitnow.lyrics import lonely_first_words

    db = np.full(int(30 / _HOP), -60.0)
    db[int(11.0 / _HOP) : int(14.0 / _HOP)] = -10.0  # la riga cantata
    line = Line([Word("Tanto", 10.0, 10.15), Word("per", 11.2, 11.6), Word("non", 11.6, 12.2), Word("sentire", 12.2, 14.0)])
    assert lonely_first_words([line], (db, -40.0)) == 1
    assert line.words[0].start == pytest.approx(11.0, abs=0.03)
    assert line.words[0].end == 11.2
    assert lonely_first_words([line], (db, -40.0)) == 0


def test_ultima_parola_non_resta_accesa_nel_silenzio():
    """Sally: «niente» restava accesa un secondo e mezzo dopo che la voce si era spenta."""
    import numpy as np

    from singitnow.lyrics import trim_silent_ends

    db = np.full(int(30 / _HOP), -60.0)
    db[int(10.0 / _HOP) : int(12.5 / _HOP)] = -10.0
    line = Line([Word("pensare", 10.0, 11.0), Word("niente", 11.0, 14.0)])
    assert trim_silent_ends([line], (db, -40.0)) == 1
    assert line.words[-1].end == pytest.approx(12.5, abs=0.03)
    assert trim_silent_ends([line], (db, -40.0)) == 0
    held = Line([Word("pensare", 10.0, 11.0), Word("niente", 11.0, 14.0, hold=12.0)])
    assert trim_silent_ends([held], (db, -40.0)) == 0  # nota tenuta riconosciuta: non si tocca


def test_coda_corta_nel_silenzio_resta():
    """Code di silenzio di pochi decimi non si tagliano: non danno fastidio e spesso sono giuste."""
    import numpy as np

    from singitnow.lyrics import trim_silent_ends

    db = np.full(int(30 / _HOP), -60.0)
    db[int(10.0 / _HOP) : int(13.7 / _HOP)] = -10.0
    line = Line([Word("pensare", 10.0, 11.0), Word("niente", 11.0, 14.0)])
    assert trim_silent_ends([line], (db, -40.0)) == 0


def test_viterbi_trova_le_lettere_nell_ordine():
    """Allineamento CTC: tre lettere in fila dentro il silenzio (blank)."""
    import numpy as np

    from singitnow.phonetic import _viterbi

    lp = np.full((20, 6), -10.0)
    lp[:, 0] = -0.1  # blank ovunque…
    for t, tok in ((3, 4), (4, 4), (8, 5), (14, 4)):  # …tranne dove si sentono le lettere
        lp[t, :] = -10.0
        lp[t, tok] = -0.1
    assert _viterbi(lp, [4, 5, 4]) == [(3, 4), (8, 8), (14, 14)]


def test_inizi_corretti_dall_allineatore_fonetico(monkeypatch):
    """I want it that way: «your» cominciava sulla vocale di «to»; l'allineatore lo sente oltre mezzo secondo dopo.
    Solo spostamenti in avanti e netti: quelli piccoli o all'indietro restano."""
    from singitnow import lyrics as L
    from singitnow import phonetic

    line = Line([Word("Can't", 42.5, 43.2), Word("reach", 43.2, 43.7), Word("to", 43.7, 44.57), Word("your", 44.57, 45.27), Word("heart", 45.27, 46.0)])
    found = [(42.3, 43.0), (43.4, 44.0), (43.5, 44.2), (45.1, 45.4), (45.6, 46.1)]
    monkeypatch.setattr(phonetic, "align_line", lambda audio, words, a, b: found)
    assert L.phonetic_starts([line], object()) == 1
    assert [round(w.start, 2) for w in line.words] == [42.5, 43.2, 43.7, 45.1, 45.27]
    assert line.words[2].end == 44.57  # la parola prima non si allunga


def test_senza_modello_fonetico_resta_tutto_com_era(monkeypatch):
    import numpy as np

    from singitnow import lyrics as L
    from singitnow import phonetic

    monkeypatch.setattr(phonetic, "_get", lambda: None)
    line = _breath_line()
    assert L.phonetic_starts([line], np.zeros(16000 * 20, dtype=np.float32)) == 0


def test_viterbi_riga_lunga():
    """Wannabe: con più di 63 lettere l'indice dello stato non sta più in 8 bit."""
    import numpy as np

    from singitnow.phonetic import _viterbi

    toks = [4 + (i % 2) for i in range(100)]
    lp = np.full((400, 6), -10.0)
    lp[:, 0] = -0.1
    for i, tok in enumerate(toks):
        lp[2 + 3 * i, :] = -10.0
        lp[2 + 3 * i, tok] = -0.1
    spans = _viterbi(lp, toks)
    assert spans[0] == (2, 2) and spans[-1] == (299, 299)
