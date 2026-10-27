import pytest
from app.main import create_app
from app.config import Settings
from app.models import TaskCreate


@pytest.fixture
def app(tmp_path):
    return create_app(Settings(data_dir=tmp_path,provider='workshop',model='',api_token='',worker_enabled=False,cad_timeout=120))


@pytest.fixture
def task(app):
    return app.state.db.create_task(TaskCreate(prompt='Design an organizer for six markers, 18 mm in diameter.'))
