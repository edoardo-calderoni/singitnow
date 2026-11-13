"""Coda fra microfono e casse del motore voce: il margine cresce coi buchi e poi riscende."""

import numpy as np

from singitnow.voice_engine import BLOCK, SR, TARGET_MAX, TARGET_MIN, _Ring


def _run(ring: _Ring, seconds: float, level: float = 0.0, jitter: int = 0) -> tuple[int, list[int]]:
    """Microfono a pacchetti da 10 ms (in ritardo di `jitter` campioni a volte), casse a blocchi da 5 ms.
    Restituisce i buchi e il ritardo (campioni in coda) dopo ogni lettura."""
    holes = 0
    delays = []
    pkt = 2 * BLOCK
    t_mic = 0
    for t in range(0, int(seconds * SR), BLOCK):
        late = jitter if (t // pkt) % 7 == 0 else 0
        while t_mic + pkt <= t + BLOCK - late:
            ring.write(np.full(pkt, level, dtype=np.float32))
            t_mic += pkt
        before = ring.underruns
        ring.read(BLOCK)
        holes += ring.underruns - before
        delays.append(ring.w - ring.r)
    return holes, delays


def test_margine_riscende_dopo_i_buchi_in_silenzio():
    ring = _Ring()
    ring.target = TARGET_MAX  # come dopo una serie di buchi
    _run(ring, 1.0)
    assert min(_run(ring, 1.0)[1]) >= TARGET_MAX - BLOCK  # prima dei 10 s di calma resta alto
    holes, delays = _run(ring, 90.0)
    assert holes == 0
    assert ring.target == TARGET_MIN
    assert max(delays[-SR // BLOCK :]) <= TARGET_MIN + 3 * BLOCK


def test_col_canto_il_salto_aspetta_il_silenzio():
    ring = _Ring()
    ring.target = TARGET_MAX
    _run(ring, 1.0, level=0.3)
    holes, _ = _run(ring, 30.0, level=0.3)
    assert holes == 0 and ring.skips == 0  # il margine scende ma la voce non viene tagliata
    assert ring.target < TARGET_MAX
    _run(ring, 2.0)  # pausa fra due righe
    assert ring.skips == 1
    assert ring.w - ring.r <= ring.target + 3 * BLOCK


def test_pacchetti_irregolari_non_svuotano_la_coda():
    ring = _Ring()
    holes, _ = _run(ring, 60.0, jitter=BLOCK)
    assert holes == 0
    assert ring.target == TARGET_MIN
