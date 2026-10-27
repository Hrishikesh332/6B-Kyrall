"""Keeps new chats to CAD generation: a prompt about anything else is refused before a task exists.

A prompt passes only when it asks for a CAD design (a CAD term, part name, manufacturing
word or measured size) and asks for nothing else: a request for unrelated work anywhere
in it, such as a poem, general code or trivia, refuses the whole prompt. It only screens
the opening prompt; follow-ups in a chat are already about the design in it.
"""
import re

REFUSAL = 'Please ask only about CAD generation: describe the part, assembly or design you want to create.'
MIXED = 'Your prompt also asks for something other than CAD generation. ' + REFUSAL

# Whole words (plurals allowed): short or common words that would match too much as a word start.
WORDS = (
    'cad', '3d', '2d', 'stl', 'stp', 'iges', 'igs', '3mf', 'dxf', 'mesh', 'pla', 'petg', 'abs', 'tpu', 'cnc', 'lathe',
    'slicer', 'mold', 'mould', 'cube', 'cone', 'part', 'box', 'lid', 'rod', 'cam', 'arm', 'jaw', 'nut', 'peg', 'bin', 'hook',
    'clip', 'stand', 'rack', 'tray', 'hole', 'slot', 'beam', 'plate', 'panel', 'gear', 'tube', 'pipe', 'vent', 'duct',
    'wheel', 'bolt', 'screw', 'washer', 'lever', 'knob', 'hinge', 'shaft', 'axle', 'shelf', 'shelve', 'drawer', 'vase',
    'robot', 'drone', 'servo', 'jig', 'fixture', 'coaster', 'keychain', 'planter', 'lampshade', 'figurine', 'nameplate',
    'step file', 'phone case', 'case for', 'wall thickness', 'wall mount', 'laser cut', 'cnc mill', 'compression spring',
    'torsion spring', 'robot arm', 'robotic arm', 'gripper finger', 'end cap', 'pin joint', 'dowel pin',
)
# Word starts, so "bracket" also covers "brackets" and "print" covers "printable".
STEMS = (
    'onshape', 'fusion 360', 'solidworks', 'freecad', 'openscad', 'cadquery', 'featurescript', 'extru', 'revolv',
    'fillet', 'chamfer', 'parametric', '3d print', 'printable', 'filament', 'machin', 'fabricat', 'manufactur',
    'injection mold', 'weld', 'sheet metal', 'alumin', 'plywood', 'acrylic', 'prototyp', 'toleranc', 'clearance',
    'thickness', 'diameter', 'radius', 'cylind', 'sphere', 'prism', 'torus', 'hexag', 'groove', 'gusset', 'assembl',
    'bracket', 'mount', 'enclosure', 'housing', 'sprocket', 'pulley', 'bearing', 'bushing', 'clamp', 'holder', 'organiz',
    'organis', 'coupler', 'coupling', 'spacer', 'standoff', 'flange', 'fastener', 'chassis', 'gripper', 'effector',
    'suction', 'nozzle', 'adapter', 'actuator', 'mechanism', 'linkage',
)
TERM = re.compile(r'\b(?:(?:' + '|'.join(map(re.escape, WORDS)) + r')(?:e?s)?\b|(?:' + '|'.join(map(re.escape, STEMS)) + '))', re.I)
# A measured size such as "40 mm", "2.5in", '3"', "90°" or a metric thread like "M3".
SIZE = re.compile(r'\d\s*(?:mm|cm|m|in|inch|inches|deg|degrees)(?![a-z])|\d\s*["°]|\bm\d{1,2}\b', re.I)

# Code is fine when it is the CAD script itself.
CODE_WORDS = (r'python', r'javascript', r'typescript', r'java', r'c\+\+', r'c\#', r'golang', r'php', r'ruby', r'sql', r'html',
              r'css', r'react', r'node\.?js', r'django', r'flask', r'api', r'debug\w*', r'algorithm', r'regex')
# Requests for work that is not CAD generation. Any of these refuses the prompt, even beside a CAD request.
UNRELATED_WORDS = (
    r'poems?', r'poetry', r'haiku', r'lyrics', r'songs?', r'stor(?:y|ies) about', r'fiction', r'jokes?', r'riddles?',
    r'essays?', r'articles?', r'blog posts?', r'cover letter', r'resume', r'cv', r'emails?', r'letters? to', r'tweets?',
    r'captions?', r'slogans?', r'speech', r'summari[sz]e', r'paraphrase', r'proofread', r'grammar',
    r'translat\w* (?:it |this |that )?(?:in)?to (?:english|hindi|marathi|spanish|french|german|chinese|japanese|arabic)',
    r'recipes?', r'cooking', r'cook (?:me|a|an|dinner|lunch|breakfast)', r'baking', r'diet', r'workout', r'horoscope',
    r'astrology', r'weather (?:today|tomorrow|forecast|in|like)', r'news', r'headlines?', r'stock (?:market|prices?)',
    r'crypto\w*', r'bitcoin', r'invest\w*', r'bank account', r'loans?', r'tax(?:es)?', r'homework', r'exams?', r'quiz',
    r'trivia', r'capital of', r'who (?:is|was|are|were)', r'history of', r'meaning of life', r'movies?', r'tv shows?',
    r'celebrit\w*', r'sports? scores?', r'politic\w*', r'elections?', r'religio\w*', r'relationship', r'dating',
    r'girlfriend', r'boyfriend', r'diagnos\w*', r'symptoms?', r'legal advice', r'lawyer', r'business plan', r'marketing',
    r'seo', r'sales pitch', r'pitch deck', r'presentation', r'spreadsheet', r'excel', r'logo design',
    r'design (?:a|me a|my) logo', r'website', r'web ?site', r'web ?page', r'landing page', r'mobile app', r'ui', r'ux',
    r'poster', r'flyer', r'banner', *CODE_WORDS, r'leetcode', r'database', r'play a game', r'roleplay', r'pretend',
    r'ignore (?:all|previous|your)', r'system prompt', r'jailbreak', r'how are you', r"what(?:'s| is) your name",
    r'who are you',
)
UNRELATED = re.compile(r'\b(?:' + '|'.join(UNRELATED_WORDS) + r')\b', re.I)
# A message that is only a greeting, thanks or a question about the assistant, with no request in it.
SMALL_TALK_WORDS = (
    r'hi+', r'hey+', r'heya', r'hiya', r'hello+', r'yo', r'sup', r'hola', r'namaste', r'greetings',
    r'good (?:morning|afternoon|evening|night)', r'thanks?', r'thank you', r'ty', r'bye', r'how are you(?: doing)?',
    r"how(?:'s| is) it going", r"what(?:'s| is) up", r'wassup', r'what can you do', r'what do you do',
    r'what (?:tools|features|skills|capabilities) do you have', r'who are you', r'what are you', r'help', r'test(?:ing)?',
    r'there', r'buddy', r'bro', r'mate', r'how',
)
SMALL_TALK = re.compile(r'^(?:[\W_]*\b(?:' + '|'.join(SMALL_TALK_WORDS) + r')\b)+[\W_]*$', re.I)
CAD_CODE = re.compile(r'\b(?:cadquery|openscad|featurescript|onshape|freecad)\b', re.I)
CODE = re.compile(r'^(?:' + '|'.join(CODE_WORDS) + r')$', re.I)
# The same rules for the browser, so a prompt is refused there before anything starts.
# The patterns are written to mean the same in Python and JavaScript regular expressions.
RULES = {'term': TERM.pattern, 'size': SIZE.pattern, 'unrelated': UNRELATED.pattern, 'cad_code': CAD_CODE.pattern,
         'code': CODE.pattern, 'small_talk': SMALL_TALK.pattern, 'refusal': REFUSAL, 'mixed': MIXED}


def unrelated(prompt: str) -> bool:
    hits = {m.group(0).lower() for m in UNRELATED.finditer(prompt)}
    if hits and CAD_CODE.search(prompt): hits = {h for h in hits if not CODE.match(h)}
    return bool(hits)


def refusal(prompt: str) -> str | None:
    """Why the prompt is not a CAD request, or None when it is one."""
    if not (TERM.search(prompt) or SIZE.search(prompt)): return REFUSAL
    if unrelated(prompt): return MIXED
    return None


def follow_up_refusal(content: str) -> str | None:
    """Why a follow-up in a chat should not start a run, or None when it may.

    A follow-up need not name a part ("make it thicker"), so only small talk and
    requests for unrelated work are refused.
    """
    if SMALL_TALK.match(content): return REFUSAL
    if unrelated(content): return MIXED
    return None


def is_cad_request(prompt: str) -> bool:
    return refusal(prompt) is None


class OffTopic(ValueError):
    """A prompt that is not only a CAD request; no task is created for it."""


def require_cad_request(prompt: str):
    if message := refusal(prompt): raise OffTopic(message)


def require_cad_follow_up(content: str):
    if message := follow_up_refusal(content): raise OffTopic(message)
