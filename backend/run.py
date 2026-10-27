from pathlib import Path
import os
from dotenv import load_dotenv
from waitress import serve

if __name__ == '__main__':
    root=Path(__file__).resolve().parent
    os.chdir(root)
    load_dotenv(root/'.env')
    from app.main import create_app
    app=create_app()
    try:
        serve(app,host='127.0.0.1',port=int(os.getenv('6B_PORT','8765')),threads=12)
    finally:
        app.state.runtime.close()
