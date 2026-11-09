"""Link di YouTube incollati nella ricerca."""

from __future__ import annotations

from singitnow import youtube


def test_link_di_playlist():
    pl = "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"
    assert youtube.playlist_id_from_url(f"https://www.youtube.com/playlist?list={pl}") == pl
    assert youtube.playlist_id_from_url(f"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list={pl}&index=3") == pl
    assert youtube.playlist_id_from_url(f"https://music.youtube.com/playlist?list={pl}") == pl
    assert youtube.playlist_id_from_url(f"https://youtu.be/dQw4w9WgXcQ?list={pl}") == pl


def test_non_sono_playlist():
    assert youtube.playlist_id_from_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ") is None
    assert youtube.playlist_id_from_url("vasco rossi albachiara") is None
    assert youtube.playlist_id_from_url("https://example.com/x?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI") is None
    # i «Mix» di YouTube sono infiniti e personali
    assert youtube.playlist_id_from_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ") is None
