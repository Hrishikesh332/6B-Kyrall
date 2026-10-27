"""Add one 6B job per Kyrall hackathon object, with the gripper rules available.

Run once 6B is on the current code and a model provider is signed in:
    .venv/bin/python backend/scripts/launch_gripper_usecases.py [http://127.0.0.1:8765]
Jobs are created paused, so nothing repeats; start each with "Run now" in Jobs, one at a
time. The agent decides whether the "Kyrall robot gripper challenge" rule set applies (it
should, from these briefs) and records a check for every must rule.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/') + '/api'
COMMON = ('This is for the Kyrall hackathon robot gripper challenge: purely mechanical actuation, mounted on the '
          'Franka arm, pick at Point A, transport and place at Point B. Parts are 3D printed (Bambu Lab printer) '
          'plus common hardware. Deliver the CAD model, printable STLs and a short explanation of the gripping principle.')
CASES = [
    ('Kyrall gripper — ripe tomato',
     'Design an object-specific gripper for a ripe tomato (assume 55–75 mm diameter, about 100–150 g) that picks, '
     'transports and places it without squashing or visible damage. Prefer a compliant mechanism (for example fin-ray '
     'fingers) with grip force limited by design. ' + COMMON),
    ('Kyrall gripper — slippery cylinder',
     'Design an object-specific gripper for a smooth, slippery cylinder with no handle (assume 40–60 mm diameter, up to '
     '120 mm tall, up to 400 g) that holds it securely for the whole transport without relying on an edge or handle. '
     'Use geometry and friction (for example V-jaws with conformal pads) rather than squeezing force alone. ' + COMMON),
    ('Kyrall gripper — flat plate (suction)',
     'Design a suction gripper that picks and moves a flat plate (assume a smooth, non-porous plate up to 150 × 150 mm '
     'and 300 g). Suction is required. Generate vacuum mechanically (for example a cup with a mechanical pump or '
     'plunger released by the arm motion) with no electronics. ' + COMMON),
]


def call(path, body=None, method='POST'):
    data = json.dumps(body or {}).encode() if method != 'GET' else None
    request = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request) as response:
        return json.load(response)


if __name__ == '__main__':
    for template in ('kyrall_gripper', 'fdm_printing'):
        try:
            print(call(f'/rules/templates/{template}'))
        except urllib.error.HTTPError as exc:
            print(template, 'already present' if exc.code == 422 else exc)
    existing = {job['name'] for job in call('/schedules', method='GET')}
    for title, prompt in CASES:
        if title in existing:
            print(title, 'already in Jobs')
            continue
        job = call('/schedules', {'name': title, 'prompt': prompt, 'interval_minutes': 10080, 'enabled': False})
        print(title, '→ job', job['id'])
