from fastapi.testclient import TestClient

import app.main as main_module


def test_mobile_page_is_served():
    resp = TestClient(main_module.app).get("/mobile.html")

    assert resp.status_code == 200
    assert 'src="/js/mobile-view.js"' in resp.text
