import asyncio
import ipaddress
import logging
import os
import socket
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from dotenv import load_dotenv

import uvicorn

load_dotenv()
from fastapi import FastAPI, HTTPException, Request
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import Headers

from app.services.lap_time_store import (
    set_websocket_manager,
)
from app.services.websocket_manager import ConnectionManager

debug_mode = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes", "on")
log_level = logging.DEBUG if debug_mode else logging.INFO

logging.basicConfig(
    level=log_level, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

if not debug_mode:
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("f1_24_telemetry").setLevel(logging.WARNING)

manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Application startup...")
    set_websocket_manager(manager)
    from app.api.udp_telemetry_routes import set_main_event_loop
    set_main_event_loop(asyncio.get_event_loop())
    yield
    logger.info("Application shutdown...")


app = FastAPI(title="F1 Telemetry API", version="1.0.0", lifespan=lifespan)

cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
if any(origin.lower() == "null" for origin in cors_origins):
    logger.warning("Ignoring 'null' CORS origin")
    cors_origins = [origin for origin in cors_origins if origin.lower() != "null"]
if cors_origins:
    allow_credentials = True
    if "*" in cors_origins:
        allow_credentials = False
        logger.warning("Wildcard CORS origin (*) enabled; disabling credentials")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    logger.info("CORS enabled for origins: %s", cors_origins)

_machine_name = socket.gethostname().lower().removesuffix(".local")
allowed_hosts = {"localhost", _machine_name, _machine_name + ".local"} | {
    host.strip().lower()
    for host in os.getenv("ALLOWED_HOSTS", "").split(",")
    if host.strip()
}


def _host_allowed(host_header: str) -> bool:
    hostname = urlsplit("//" + host_header).hostname or ""
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return hostname in allowed_hosts


def _origin_allowed(origin: str, scheme: str, host_header: str) -> bool:
    origin = origin.lower()
    scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
    return (
        origin == f"{scheme}://{host_header.lower()}"
        or "*" in cors_origins
        or origin in (o.lower() for o in cors_origins)
    )


SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (
        b"content-security-policy",
        b"script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ),
]


class HostOriginGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = Headers(scope=scope)
            host = headers.get("host", "")
            origin = headers.get("origin")
            status = None
            if not _host_allowed(host):
                status = 400
            elif (
                origin is not None
                and scope.get("method") not in ("GET", "HEAD", "OPTIONS")
                and not _origin_allowed(origin, scope["scheme"], host)
            ):
                status = 403
            if status is not None:
                logger.warning(
                    "Rejected %s (%s) host=%r origin=%r",
                    scope["type"], status, host, origin,
                )
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    response = PlainTextResponse(
                        "Invalid host" if status == 400 else "Forbidden",
                        status_code=status,
                    )
                    await response(scope, receive, send)
                return
        if scope["type"] == "http":
            inner_send = send

            async def send(message):
                if message["type"] == "http.response.start":
                    message["headers"] = [*message.get("headers", []), *SECURITY_HEADERS]
                await inner_send(message)

        await self.app(scope, receive, send)


app.add_middleware(HostOriginGuard)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        logger.info(f"Client disconnected")
    finally:
        manager.disconnect(websocket)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.error(f"Validation error for request {request.url}: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    logger.warning(
        f"HTTP Exception for request {request.url}: Status={exc.status_code}, Detail={exc.detail}"
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.exception(
        f"Unhandled exception for request {request.url}: {exc}"
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal server error occurred."},
    )


from app.api.display_data_routes import router as drivers_router
from app.api.udp_telemetry_routes import telemetry_router

app.include_router(drivers_router)
app.include_router(telemetry_router, prefix="/api/telemetry", tags=["Telemetry"])


app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    logger.info("Starting Uvicorn server...")
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
