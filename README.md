# F1Timings-Py

FastAPI dashboard for F1 24 lap times and live telemetry (UDP, default port 20777), pushed to the browser over WebSockets. Successor to [f1timings-rs](https://github.com/edoardo-morosanu/f1timings-rs).

## Run

```bash
pip install -r requirements.txt
python app.py   # http://localhost:8000
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Bind address. Use `127.0.0.1` to stay off the LAN. |
| `ALLOWED_HOSTS` | — | Extra accepted `Host` headers (localhost, IPs, machine hostname always allowed). |
| `CORS_ORIGINS` | — | Comma-separated cross-origin allowlist. Unset disables CORS. |
| `F1_TELEMETRY_LISTENER_HOST` | `0.0.0.0` | UDP telemetry bind address. |
| `DEBUG` | `false` | Verbose logging. |

Cross-origin non-GET requests and `/ws` connections are rejected with `403`. There is no login: anyone who can reach the port can use the API.

## License

MIT, see [LICENSE](LICENSE).
