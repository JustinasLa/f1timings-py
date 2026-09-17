import uvicorn
import importlib
import sys
import types
from pathlib import Path

if __name__ == "__main__":
    print("Starting F1 Timings application...")

    package_dir = Path(__file__).resolve().parent / "app"
    app_package = types.ModuleType("app")
    app_package.__path__ = [str(package_dir)]
    sys.modules["app"] = app_package

    fastapi_app = importlib.import_module("app.main").app
    uvicorn.run(fastapi_app, host="0.0.0.0", port=8000)
