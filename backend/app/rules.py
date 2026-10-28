"""Rule sets the agent applies per task, with recorded decisions and per-rule checks.

A rule with no `applies_when` is general and always binding. Rules sharing a
`rule_set` with an `applies_when` description are conditional: for each task the
agent decides (with a reason) whether the set applies, or asks the user when it
cannot tell. A set made from a template starts from the template's default instead
(FDM printing on, the Kyrall challenge off), so the agent never has to ask about it;
the user can switch it per chat. Applied rules are binding and each "must" rule gets
a recorded check.
"""
import time
from typing import Literal

from pydantic import Field, model_validator

from .db import uid
from .models import StrictModel

GENERAL = ''
STATUSES = ('met', 'not_met', 'unverified', 'not_applicable')

TEMPLATES = {
    'kyrall_gripper': {
        'name': 'Kyrall robot gripper challenge',
        'applies_when': 'Designing a gripper, gripper finger, suction cup or end effector for the Kyrall hackathon '
                        'or the Franka arm pick-and-place task (ripe tomato, slippery cylinder, flat plate).',
        'source': 'Kyrall Hackathon Challenge: Robot Gripper (brief PDF)',
        'default': False,
        'rules': [
            ('must', 'Actuation is purely mechanical: no electronics, motors or electrical actuation in the gripper.'),
            ('must', 'Mounts on the Franka robotic arm used at the event; verify the flange interface against the official '
                     'Franka documentation and keep it as a named, checkable feature.'),
            ('must', 'Ripe tomato: pick, transport and place without squashing or visible damage; contact must be compliant '
                     'and grip force limited by design.'),
            ('must', 'Smooth, slippery cylinder with no handle: held securely for the whole transport, without relying on '
                     'a handle or edge.'),
            ('must', 'Flat plate: picked and moved using suction (a suction gripper is required for this object).'),
            ('must', 'Each object is picked at Point A, transported and placed at Point B without being dropped or damaged.'),
            ('must', 'Either one adaptable gripper for all three objects or a set of object-specific grippers; state which.'),
            ('must', 'Deliver the final CAD model and a short explanation of the gripping principle for each object.'),
            ('must', 'Feasible to fabricate and test during the hackathon with common equipment (design for 3D printing '
                     'and readily available hardware).'),
            ('should', 'Use compliant-mechanism design principles where they suit the object.'),
            ('should', 'Optimise for the judging criteria: handling success, tomato protection, grip security, prototype '
                       'quality, reliable arm integration, feasibility of manufacture and originality.'),
            ('should', 'Object locations, transport distance, attempts, materials and mounting interfaces are announced at '
                       'the event: record them as explicit assumptions and keep the design adjustable.'),
        ],
    },
    'fdm_printing': {
        'name': 'FDM 3D printing',
        'applies_when': 'Parts that will be 3D printed on an FDM printer (for example a Bambu Lab printer).',
        'source': '6B printing guidance',
        'default': True,
        'rules': [
            ('must', 'Every part fits the print bed in its chosen print orientation.'),
            ('must', 'No feature thinner than 0.8 mm; structural walls at least 1.2 mm.'),
            ('must', 'Overhangs steeper than 45° are avoided by orientation, chamfers or teardrops, or their supports are '
                     'stated explicitly.'),
            ('should', 'Mating parts use 0.2–0.4 mm clearance per side and a fit test coupon for critical fits.'),
            ('should', 'Flat, large faces go on the bed; load paths run along layers, not across layer lines.'),
        ],
    },
}
# Rule set name -> whether a chat follows it until someone decides otherwise.
DEFAULTS = {t['name']: t['default'] for t in TEMPLATES.values()}


class RuleChoice(StrictModel):
    rule_set: str = Field(min_length=1, max_length=120)
    apply: bool
    reason: str = Field(min_length=3, max_length=600)


class ChooseRulesInput(StrictModel):
    decisions: list[RuleChoice] = Field(min_length=1, max_length=12)


class RuleCheck(StrictModel):
    rule_id: str = Field(min_length=1, max_length=64)
    status: Literal['met', 'not_met', 'unverified', 'not_applicable']
    evidence: str = Field(min_length=3, max_length=1200)
    evidence_ids: list[str] = Field(default_factory=list, max_length=8)


class RuleChecksInput(StrictModel):
    checks: list[RuleCheck] = Field(min_length=1, max_length=40)

    @model_validator(mode='after')
    def unique(self):
        if len({c.rule_id for c in self.checks}) != len(self.checks):
            raise ValueError('Check each rule once per call')
        return self


class RuleSetUserDecision(StrictModel):
    rule_set: str = Field(min_length=1, max_length=120)
    apply: bool
    reason: str = Field(default='', max_length=600)


def migrate(c):
    columns = {row[1] for row in c.execute('PRAGMA table_info(rules)')}
    for name, ddl in (('rule_set', "TEXT NOT NULL DEFAULT ''"), ('applies_when', "TEXT NOT NULL DEFAULT ''"),
                      ('level', "TEXT NOT NULL DEFAULT 'must'"), ('source', "TEXT NOT NULL DEFAULT ''")):
        if name not in columns:
            c.execute(f'ALTER TABLE rules ADD COLUMN {name} {ddl}')
    c.execute('''CREATE TABLE IF NOT EXISTS task_rule_sets(
        task_id TEXT NOT NULL REFERENCES tasks(id), rule_set TEXT NOT NULL, applied INTEGER NOT NULL,
        reason TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at REAL NOT NULL, PRIMARY KEY(task_id, rule_set))''')
    c.execute('''CREATE TABLE IF NOT EXISTS rule_checks(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT, rule_id TEXT NOT NULL,
        status TEXT NOT NULL, evidence TEXT NOT NULL, evidence_ids TEXT NOT NULL, build_id TEXT, created_at REAL NOT NULL)''')


def _text(value):
    import json
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def scoped_rules(db, project_id):
    rows = db.all('SELECT * FROM rules WHERE enabled=1 AND (project_id IS NULL OR project_id=?) ORDER BY created_at',
                  (project_id,))
    for r in rows:
        r['content'] = _text(r['content'])
    return rows


def task_rules(db, task_id):
    """Every rule set in scope for the task, its decision and each rule's latest check."""
    task = db.require_task(task_id)
    rules = scoped_rules(db, task['project_id'])
    decisions = {d['rule_set']: d for d in db.all('SELECT * FROM task_rule_sets WHERE task_id=?', (task_id,))}
    checks = {}
    for check in db.all('SELECT * FROM rule_checks WHERE task_id=? ORDER BY created_at', (task_id,)):
        checks[check['rule_id']] = check
    sets = {}
    for rule in rules:
        name = rule['rule_set'] or GENERAL
        entry = sets.setdefault(name, {'rule_set': name, 'applies_when': '', 'source': '', 'rules': []})
        entry['applies_when'] = entry['applies_when'] or rule['applies_when']
        entry['source'] = entry['source'] or rule['source']
        check = checks.get(rule['id'])
        entry['rules'].append({'id': rule['id'], 'text': rule['content'], 'level': rule['level'],
                               'check': {k: check[k] for k in ('status', 'evidence', 'build_id', 'created_at')}
                               if check else None})
    result = []
    for name, entry in sets.items():
        conditional = bool(name and entry['applies_when'])
        decision = decisions.get(name)
        if not decision and conditional and name in DEFAULTS:
            on = DEFAULTS[name]
            decision = {'applied': on, 'decided_by': 'default', 'decided_at': None,
                        'reason': 'On by default for every chat' if on else
                                  'Off by default; choose Apply here to follow it in this chat'}
        entry['conditional'] = conditional
        entry['status'] = ('applied' if decision['applied'] else 'skipped') if decision else \
            ('pending' if conditional else 'always')
        entry['decision'] = {k: decision[k] for k in ('reason', 'decided_by', 'decided_at')} if decision else None
        result.append(entry)
    return result


def agent_view(db, task_id):
    """What the model sees: binding rules plus the conditional sets it still has to decide."""
    sets = task_rules(db, task_id)
    if not sets:
        return None
    binding = [{'rule_set': s['rule_set'] or 'General', 'rules': [{'id': r['id'], 'level': r['level'], 'text': r['text'],
                                                                    'last_check': r['check'] and r['check']['status']}
                                                                   for r in s['rules']]}
               for s in sets if s['status'] in ('always', 'applied')]
    pending = [{'rule_set': s['rule_set'], 'applies_when': s['applies_when'], 'rule_count': len(s['rules']),
                'preview': [r['text'] for r in s['rules'][:3]]} for s in sets if s['status'] == 'pending']
    skipped = [{'rule_set': s['rule_set'], 'reason': s['decision']['reason']} for s in sets if s['status'] == 'skipped']
    return {'binding': binding, 'undecided': pending, 'skipped': skipped,
            'instructions': 'Binding rules must be followed unless the current user message overrides them. Before '
                            'designing, call choose_rules for every undecided set with a reason; if you cannot tell '
                            'whether a set applies, ask the user with ask_questions first. After each final build, '
                            'call record_rule_checks for every binding "must" rule with honest evidence.'}


def choose(db, task_id, run_id, data, decided_by='agent'):
    names = {s['rule_set'] for s in task_rules(db, task_id) if s['conditional']}
    with db.transaction() as c:
        for d in data:
            if d['rule_set'] not in names:
                raise ValueError(f'Unknown conditional rule set: {d["rule_set"]}')
            c.execute('INSERT OR REPLACE INTO task_rule_sets VALUES(?,?,?,?,?,?)',
                      (task_id, d['rule_set'], int(d['apply']), d['reason'].strip() or 'Set by the user',
                       decided_by, time.time()))
            db.event(c, task_id, run_id, 'rules.decided', {**d, 'decided_by': decided_by})
    sets = task_rules(db, task_id)
    return {'applied': [{'rule_set': s['rule_set'], 'rules': [{'id': r['id'], 'level': r['level'], 'text': r['text']}
                                                              for r in s['rules']]} for s in sets
                        if s['status'] == 'applied' and s['rule_set'] in {d['rule_set'] for d in data}],
            'skipped': [s['rule_set'] for s in sets if s['status'] == 'skipped'],
            'undecided': [s['rule_set'] for s in sets if s['status'] == 'pending']}


def record_checks(db, task_id, run_id, data):
    binding = {r['id']: s for s in task_rules(db, task_id) if s['status'] in ('always', 'applied') for r in s['rules']}
    build = db.one("SELECT json_extract(metadata,'$.build_id') AS build FROM artifacts WHERE task_id=? AND "
                   "json_extract(metadata,'$.kind')='validation' ORDER BY created_at DESC LIMIT 1", (task_id,))
    import json
    with db.transaction() as c:
        for check in data:
            if check['rule_id'] not in binding:
                raise ValueError(f'{check["rule_id"]} is not a binding rule for this task')
            c.execute('INSERT INTO rule_checks VALUES(?,?,?,?,?,?,?,?,?)',
                      (uid(), task_id, run_id, check['rule_id'], check['status'], check['evidence'].strip(),
                       json.dumps(check['evidence_ids']), build and build['build'], time.time()))
        db.event(c, task_id, run_id, 'rules.checked', {'count': len(data), 'build_id': build and build['build'],
                                                        'not_met': sum(1 for x in data if x['status'] == 'not_met')})
    missing = [r for r, s in binding.items() if not any(x['rule_id'] == r for x in data)
               and next(x for x in s['rules'] if x['id'] == r)['level'] == 'must']
    return {'recorded': len(data), 'build_id': build and build['build'],
            'must_rules_still_unchecked_in_this_call': missing}


def undecided(db, task_id):
    return [s['rule_set'] for s in task_rules(db, task_id) if s['status'] == 'pending']


def unchecked_must_rules(db, task_id, run_ids):
    """Must rules without a check recorded in these runs (a run and the attempts it retries) against the latest build."""
    run_ids = [run_ids] if isinstance(run_ids, str) else list(run_ids)
    among = f"run_id IN ({','.join('?' * len(run_ids))})"
    build = db.one(f"SELECT json_extract(metadata,'$.build_id') AS build FROM artifacts WHERE task_id=? AND {among} AND "
                   "json_extract(metadata,'$.kind')='validation' ORDER BY created_at DESC LIMIT 1", (task_id, *run_ids))
    if not build:
        return []
    done = {r['rule_id'] for r in db.all(f'SELECT rule_id FROM rule_checks WHERE task_id=? AND {among} AND build_id=?',
                                         (task_id, *run_ids, build['build']))}
    return [r['text'] for s in task_rules(db, task_id) if s['status'] in ('always', 'applied')
            for r in s['rules'] if r['level'] == 'must' and r['id'] not in done]


def add_template(db, key, project_id=None):
    template = TEMPLATES.get(key)
    if not template:
        raise ValueError('Unknown rule template')
    import json
    existing = db.one('SELECT 1 FROM rules WHERE rule_set=? AND (project_id IS ? OR project_id=?)',
                      (template['name'], project_id, project_id))
    if existing:
        raise ValueError(f'"{template["name"]}" is already in your rules')
    with db.transaction() as c:
        for index, (level, text) in enumerate(template['rules']):
            c.execute('INSERT INTO rules(id,content,project_id,enabled,created_at,rule_set,applies_when,level,source) '
                      'VALUES(?,?,?,?,?,?,?,?,?)', (uid(), json.dumps(text), project_id, 1, time.time() + index * 1e-3,
                                                    template['name'], template['applies_when'], level, template['source']))
    return {'rule_set': template['name'], 'added': len(template['rules'])}
