import asyncio

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # Store active WebSocket connections
        self.active_connections = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def _send_to_one(self, connection, message: dict):
        """Send one message to one client, dropping the client if it fails."""
        try:
            await asyncio.wait_for(connection.send_json(message), timeout=1.0)
        except Exception:
            self.disconnect(connection)
            print(f"Disconnected from {connection.client}")

    async def broadcast(self, message: dict):
        connections = self.active_connections.copy()
        if not connections:
            return

        # Send to every client at the same time so one slow or stuck client does
        # not hold up delivery to all the others.
        send_tasks = []
        for connection in connections:
            send_tasks.append(self._send_to_one(connection, message))
        await asyncio.gather(*send_tasks)
