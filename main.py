import os
import threading
import webbrowser

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("DUA_PORT", "8644"))
    host = os.environ.get("DUA_HOST", "127.0.0.1")
    url = f"http://{host if host != '0.0.0.0' else '127.0.0.1'}:{port}/"
    if host == "127.0.0.1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run("dua.app:create_app", factory=True, host=host, port=port, log_level="warning")
