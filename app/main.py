import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dotenv import load_dotenv

import uvicorn

# Load environment variables first
load_dotenv()
from fastapi import FastAPI, HTTPException, Request
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError

# Import services
from app.services.lap_time_store import (
    set_websocket_manager,
)
from app.services.websocket_manager import ConnectionManager

# Configure logging based on DEBUG environment variable
debug_mode = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes", "on")
log_level = logging.DEBUG if debug_mode else logging.INFO

logging.basicConfig(
    level=log_level, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Silence noisy loggers when not in debug mode
if not debug_mode:
    logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("f1_24_telemetry").setLevel(logging.WARNING)

# Create the WebSocket connection manager
manager = ConnectionManager()


# --- Lifespan Management ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Application startup...")
    set_websocket_manager(manager)
    from app.api.udp_telemetry_routes import set_main_event_loop
    set_main_event_loop(asyncio.get_event_loop())
    yield
    logger.info("Application shutdown...")


app = FastAPI(title="F1 Telemetry API", version="1.0.0", lifespan=lifespan)

# --- Middleware ---
# CORS is opt-in: set CORS_ORIGINS (comma-separated) to enable cross-origin
# access. The dashboard is served by this same app, so it is unneeded by default.
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


# -- WebSocket Connection Management ---
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


# --- Custom Exception Handlers ---
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Log the validation errors for debugging
    logger.error(f"Validation error for request {request.url}: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    # Log HTTP exceptions that we raise intentionally
    logger.warning(
        f"HTTP Exception for request {request.url}: Status={exc.status_code}, Detail={exc.detail}"
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    # Catch-all for unexpected server errors
    logger.exception(
        f"Unhandled exception for request {request.url}: {exc}"
    )  # Log the full traceback
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal server error occurred."},
    )


# --- Import API Routers ---
from app.api.display_data_routes import router as drivers_router
from app.api.udp_telemetry_routes import telemetry_router

# --- Include Routers ---
app.include_router(drivers_router)
app.include_router(telemetry_router, prefix="/api/telemetry", tags=["Telemetry"])

# You can still add additional routes here if necessary


# --- Static Files Serving ---
# Serve shared assets (like images) or a root index.html from the main static folder
# This also acts as a fallback for other paths under /
app.mount("/", StaticFiles(directory="static", html=True), name="static")

# --- Run the application ---
if __name__ == "__main__":
    logger.info("Starting Uvicorn server...")
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
