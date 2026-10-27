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
        # Hosts such as Railway set PORT and need 6B_HOST=* (all IPv4 and IPv6 interfaces).
        host=os.getenv('6B_HOST') or '127.0.0.1'
        port=int(os.getenv('PORT') or os.getenv('6B_PORT') or '8765')
        # Behind a reverse proxy, trust its X-Forwarded-Proto so same-origin checks see https.
        proxy={'trusted_proxy':'*','trusted_proxy_headers':'x-forwarded-proto'} if os.getenv('6B_BEHIND_PROXY','').lower() in ('1','true','yes') else {}
        serve(app,listen=f'{host}:{port}',threads=12,**proxy)
    finally:
        app.state.runtime.close()
        # Let the last cloud copies finish writing.
        app.state.cloud.close()
