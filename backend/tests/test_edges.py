import json
import pytest
from app.recipes import marker_rack,plate
from app.models import TaskCreate
from .test_provider_loop import ScriptedProvider,response,message


def test_workshop_rejects_unsupported_custom_choice():
    with pytest.raises(ValueError,match='custom choice'):
        marker_rack(mounting='Magnets')


def test_workshop_geometry_bounds_and_constraints():
    with pytest.raises(ValueError):marker_rack(count=9)
    with pytest.raises(ValueError):plate(width=10)


def test_workshop_parameters_and_width_limit(app):
    params=app.state.engine.workshop_parameters('Use eight markers, diameter 20 mm, clearance 1.2 mm. Keep width below 210 mm.',{})
    assert params=={'count':8,'diameter':20,'clearance':1.2,'max_width':210}


@pytest.mark.asyncio
async def test_user_context_does_not_enter_provider_instructions(app):
    app.state.settings.provider='openai'
    provider=ScriptedProvider([response(1,message('Ready.'))]);app.state.engine.provider=provider
    tid=app.state.db.create_task(TaskCreate(prompt='User-specific special test wording'))
    await app.state.engine.run(app.state.db.claim())
    assert 'User-specific special test wording' not in provider.inputs[0]['instructions']
    assert 'User-specific special test wording' in provider.inputs[0]['items'][-1]['content']
