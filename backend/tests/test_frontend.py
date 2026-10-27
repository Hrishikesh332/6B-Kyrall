from app.main import create_app
from app.config import Settings


def test_react_build_and_docs_are_served_without_exposing_sources(tmp_path):
    frontend = tmp_path / 'frontend'
    (frontend / 'dist' / 'assets').mkdir(parents=True)
    (frontend / 'dist' / 'index.html').write_text('<div id="root"></div><script src="/assets/client-abc.js"></script>')
    (frontend / 'dist' / 'docs.html').write_text('<h1>API reference</h1>')
    (frontend / 'dist' / 'assets' / 'client-abc.js').write_text('console.log("compiled")')
    (frontend / 'package.json').write_text('{"private":true}')
    app = create_app(Settings(data_dir=tmp_path / 'data', frontend_dir=frontend, provider='workshop', api_token='', worker_enabled=False))
    client = app.test_client()
    response = client.get('/')
    assert response.status_code == 200
    assert 'id="root"' in response.text
    assert response.headers['Cache-Control'] == 'no-cache'
    assert client.get('/docs').status_code == 200
    asset = client.get('/assets/client-abc.js')
    assert asset.status_code == 200
    assert 'immutable' in asset.headers['Cache-Control']
    assert client.get('/assets/package.json').status_code == 404
    assert client.get('/assets/../../package.json').status_code == 404
    assert 'script-src \'self\'' in response.headers['Content-Security-Policy']


def test_missing_build_explains_setup_and_can_be_built_while_running(tmp_path):
    frontend = tmp_path / 'frontend'
    frontend.mkdir()
    app = create_app(Settings(data_dir=tmp_path / 'data', frontend_dir=frontend, provider='workshop', api_token='', worker_enabled=False))
    client = app.test_client()
    assert client.get('/').status_code == 503
    assert 'npm --prefix frontend' in client.get('/').text
    (frontend / 'dist').mkdir()
    (frontend / 'dist' / 'index.html').write_text('<div id="root"></div>')
    assert client.get('/').status_code == 200
