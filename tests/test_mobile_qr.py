import socket

import pytest
import segno
from fastapi.testclient import TestClient

import app.main as main_module
from app.api import display_data_routes


@pytest.fixture
def qr_urls(monkeypatch):
    urls = []
    real_make = segno.make

    def make(url, **kwargs):
        urls.append(url)
        return real_make(url, **kwargs)

    monkeypatch.setattr(display_data_routes.segno, "make", make)
    monkeypatch.setattr(display_data_routes, "_lan_ip", lambda: "192.168.1.50")
    return urls


@pytest.mark.parametrize(
    "host, expected",
    [
        ("localhost:8000", "http://192.168.1.50:8000/mobile.html"),
        ("127.0.0.1:8000", "http://192.168.1.50:8000/mobile.html"),
        ("[::1]:8000", "http://192.168.1.50:8000/mobile.html"),
        ("10.0.0.7:9000", "http://10.0.0.7:9000/mobile.html"),
        ("[fe80::1]:8000", "http://[fe80::1]:8000/mobile.html"),
        ("testserver", "http://testserver/mobile.html"),
    ],
)
def test_qr_points_phones_at_a_reachable_mobile_url(qr_urls, host, expected):
    resp = TestClient(main_module.app).get("/api/qr.svg", headers={"host": host})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert resp.headers["cache-control"] == "no-store"
    assert "<svg" in resp.text and "http://www.w3.org/2000/svg" in resp.text
    assert qr_urls == [expected]


class _FakeSocket:
    def __init__(self, fail):
        self.fail = fail

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def connect(self, addr):
        if self.fail:
            raise OSError("network unreachable")

    def getsockname(self):
        return ("192.168.1.50", 54321)


@pytest.mark.parametrize("fail, expected", [(False, "192.168.1.50"), (True, "127.0.0.1")])
def test_lan_ip_uses_outbound_interface_or_falls_back(monkeypatch, fail, expected):
    monkeypatch.setattr(socket, "socket", lambda *a: _FakeSocket(fail))

    assert display_data_routes._lan_ip() == expected


def test_mobile_page_is_served():
    resp = TestClient(main_module.app).get("/mobile.html")

    assert resp.status_code == 200
    assert 'src="/js/mobile-view.js"' in resp.text
