import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn

from dua.app import create_app

if __name__ == "__main__":
    port = int(os.environ.get("DUA_PORT", "8644"))
    uvicorn.run(create_app(), port=port, log_level="warning")
