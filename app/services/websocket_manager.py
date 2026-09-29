import asyncio
import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self.active_connections = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def _send_to_one(self, connection, message: dict):
        try:
            await asyncio.wait_for(connection.send_json(message), timeout=1.0)
        except Exception:
            self.disconnect(connection)
            logger.warning("Dropping websocket client %s: send failed", connection.client)
            try:
                await asyncio.wait_for(connection.close(), timeout=1.0)
            except Exception:
                logger.debug("Closing websocket client %s failed", connection.client)

    async def broadcast(self, message: dict):
        connections = self.active_connections.copy()
        if not connections:
            return

        send_tasks = []
        for connection in connections:
            send_tasks.append(self._send_to_one(connection, message))
        await asyncio.gather(*send_tasks)
