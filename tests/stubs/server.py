from aiohttp import web
class _PS:
    def __init__(self):
        self.routes = web.RouteTableDef()
        self.events = []
    def send_sync(self, event, data, sid=None):
        self.events.append((event, data))
class PromptServer:
    instance = _PS()
