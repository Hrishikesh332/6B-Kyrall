"""CAD-as-code: model-written CadQuery scripts, checked before a sandboxed run.

Defense in depth, in order: a static AST allowlist (imports, names, attributes),
restricted builtins at run time, a subprocess with CPU/file-size limits, and on
macOS an OS sandbox with no network and writes confined to the build folder.
Parameters are read from the script text itself, so sliders always match it.
"""
import ast
import builtins
import io
import math
import re
import tokenize
from typing import Annotated

from pydantic import Field, field_validator, model_validator

from .models import StrictModel

PartName = Annotated[str, Field(pattern=r'^[a-zA-Z][a-zA-Z0-9_]{0,49}$')]
Dimension = Annotated[float, Field(ge=0.2, le=1000, allow_inf_nan=False)]
MAX_SOURCE = 60_000
MAX_PARTS = 24
ALLOWED_MODULES = ('cadquery', 'math')
BLOCKED_NAMES = {
    'open', 'exec', 'eval', 'compile', 'globals', 'locals', 'vars', 'getattr', 'setattr', 'delattr',
    'input', 'breakpoint', 'help', 'memoryview', 'type', 'object', 'super', 'classmethod', 'staticmethod',
    'property', 'dir', 'id', 'exit', 'quit', 'copyright', 'credits', 'license', 'bytearray', 'bytes',
}
# File I/O, kernel internals and string formatting that can reach attributes.
BLOCKED_ATTRIBUTES = {
    'importers', 'exporters', 'occ_impl', 'cqgi', 'vis', 'jupyter_tools', 'plugins', 'export', 'exportStep',
    'exportStl', 'exportBrep', 'exportSvg', 'exportDXF', 'exportBin', 'importStep', 'importBrep', 'importBin',
    'importStl', 'importDXF', 'save', 'load', 'loads', 'dump', 'dumps', 'format', 'format_map', 'toVtkPolyData',
    'show', 'show_object', 'debug', 'wrapped', 'toOCC', 'gi_frame', 'tb_frame', 'cr_frame', 'f_globals', 'f_locals',
}
BLOCKED_NODES = (ast.ClassDef, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith, ast.Await, ast.With,
                 ast.Yield, ast.YieldFrom, ast.Global, ast.Nonlocal)
SAFE_BUILTINS = {name: getattr(builtins, name) for name in (
    'abs', 'all', 'any', 'bool', 'dict', 'divmod', 'enumerate', 'filter', 'float', 'frozenset', 'int', 'isinstance',
    'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'pow', 'range', 'reversed', 'round', 'set', 'slice',
    'sorted', 'str', 'sum', 'tuple', 'zip', 'Exception', 'ValueError', 'TypeError', 'IndexError', 'KeyError',
    'ZeroDivisionError', 'ArithmeticError', 'RuntimeError', 'StopIteration')}

SCRIPT_CONTRACT = (
    'Python using only `import cadquery as cq` and `import math`. Put driving dimensions at the top as '
    '`name = 12.5  # [min:step:max] Description` (or `# [min:max]`); booleans as `name = True  # Description`; '
    'group them under comment lines like `# --- Housing ---`. These become live sliders. End by assigning '
    '`parts = {"name": workplane_or_shape, ...}` with every part in assembly coordinates (mm, Z up), one solid '
    'per part. Optional: `print_rotation = {"name": (rx, ry, rz)}` degrees for the STL print orientation. '
    'No file, network, os, getattr, dunder names, classes or with-statements; exporters/importers are '
    'blocked (the application exports STL/STEP itself).')


class ScriptError(ValueError):
    """A script problem the model can fix; carries the 1-based script line."""

    def __init__(self, message, line=None):
        super().__init__(f'Line {line}: {message}' if line else message)
        self.line = line


class CadScriptInput(StrictModel):
    name: PartName
    script: str = Field(min_length=20, max_length=MAX_SOURCE)
    print_bed: tuple[Dimension, Dimension, Dimension] = (220, 220, 250)
    notes: list[str] = Field(default_factory=list, max_length=20)

    @field_validator('print_bed', mode='before')
    @classmethod
    def bed_height_optional(cls, value):
        # Models often give only the bed footprint; assume a common 250 mm height.
        return [*value, 250] if isinstance(value, (list, tuple)) and len(value) == 2 else value

    @model_validator(mode='after')
    def checked(self):
        validate_script(self.script)
        return self


class ScriptEdit(StrictModel):
    find: str = Field(min_length=1, max_length=8000)
    replace: str = Field(max_length=12000)


class CadScriptRevision(StrictModel):
    source_artifact_id: str = Field(min_length=1, max_length=64)
    edits: list[ScriptEdit] = Field(min_length=1, max_length=24)
    notes: list[str] | None = Field(default=None, max_length=20)


class ParameterValues(StrictModel):
    values: dict[str, float | bool] = Field(min_length=1, max_length=80)


def validate_script(source):
    if len(source) > MAX_SOURCE or source.count('\n') > 2000:
        raise ScriptError('Script is too long; keep it under 60,000 characters and 2,000 lines')
    try:
        tree = ast.parse(source, '<cad-script>')
    except SyntaxError as exc:
        raise ScriptError(f'SyntaxError: {exc.msg}', exc.lineno) from None
    count = 0
    for node in ast.walk(tree):
        count += 1
        line = getattr(node, 'lineno', None)
        if count > 40_000:
            raise ScriptError('Script is too complex to check')
        if isinstance(node, BLOCKED_NODES):
            raise ScriptError(f'{type(node).__name__} statements are not allowed in CAD scripts', line)
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_MODULES:
                    raise ScriptError(f'Only cadquery and math can be imported, not {alias.name}', line)
        elif isinstance(node, ast.ImportFrom):
            if node.level or node.module not in ALLOWED_MODULES:
                raise ScriptError(f'Only cadquery and math can be imported, not {node.module}', line)
            for alias in node.names:
                if alias.name == '*' or alias.name.startswith('_') or alias.name in BLOCKED_ATTRIBUTES:
                    raise ScriptError(f'Importing {alias.name} is not allowed', line)
        elif isinstance(node, ast.Name):
            if node.id.startswith('_') or node.id in BLOCKED_NAMES:
                raise ScriptError(f'The name {node.id} is not allowed in CAD scripts', line)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith('_') or node.attr in BLOCKED_ATTRIBUTES:
                raise ScriptError(f'.{node.attr} is not available in CAD scripts', line)
        elif isinstance(node, (ast.FunctionDef, ast.Lambda)):
            names = [a.arg for a in node.args.args + node.args.kwonlyargs + node.args.posonlyargs]
            names += [a.arg for a in (node.args.vararg, node.args.kwarg) if a]
            if isinstance(node, ast.FunctionDef): names.append(node.name)
            if any(n.startswith('_') or n in BLOCKED_NAMES for n in names):
                raise ScriptError('Function and argument names cannot start with _ or shadow blocked names', line)
        elif isinstance(node, ast.alias) and node.asname and (node.asname.startswith('_') or node.asname in BLOCKED_NAMES):
            raise ScriptError(f'Import alias {node.asname} is not allowed', line)
    if not any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'parts' for t in n.targets)
               for n in tree.body):
        raise ScriptError('Assign the result at top level: parts = {"part_name": shape, ...}')
    return tree


def _comments(source):
    comments = {}
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT:
                comments[token.start[0]] = (token.start[1], token.string[1:].strip())
    except (tokenize.TokenError, IndentationError):
        pass
    return comments


def _literal(value):
    if isinstance(value, ast.Constant) and type(value.value) in (int, float, bool):
        return value.value
    if isinstance(value, ast.UnaryOp) and isinstance(value.op, ast.USub) and isinstance(value.operand, ast.Constant) \
            and type(value.operand.value) in (int, float):
        return -value.operand.value
    return None


def _nice_step(value):
    magnitude = abs(value) or 1
    return max(0.01, 10 ** (math.floor(math.log10(magnitude)) - 1))


RANGE = re.compile(r'^\[\s*(-?[\d.]+)\s*:\s*(-?[\d.]+)\s*(?::\s*(-?[\d.]+)\s*)?\]\s*(.*)$')
GROUP = re.compile(r'^-{2,}\s*(.+?)\s*-{2,}$')


def extract_parameters(source):
    """Top-of-file literal assignments become parameters, CADAM/Customizer style."""
    tree = ast.parse(source)
    comments = _comments(source)
    lines = source.splitlines()
    parameters, group, previous_end = [], '', 0
    for statement in tree.body:
        is_doc = isinstance(statement, ast.Expr) and isinstance(getattr(statement, 'value', None), ast.Constant)
        if isinstance(statement, (ast.Import, ast.ImportFrom)) or is_doc:
            previous_end = statement.end_lineno
            continue
        literal = _literal(statement.value) if isinstance(statement, ast.Assign) else None
        if literal is None or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
            break  # The parameter header ends at the first real computation.
        # Group headers are comment-only lines between the previous statement and this one.
        for number in range(previous_end + 1, statement.lineno):
            text = lines[number - 1].strip()
            if text.startswith('#') and (match := GROUP.match(text[1:].strip())):
                group = match.group(1)
        previous_end = statement.end_lineno
        name = statement.targets[0].id
        if name == 'parts':
            break
        comment = comments.get(statement.end_lineno, (None, ''))[1]
        value = statement.value
        entry = {'name': name, 'value': literal, 'group': group, 'line': statement.lineno,
                 'col': value.col_offset, 'end_col': value.end_col_offset, 'description': comment}
        if isinstance(literal, bool):
            entry['type'] = 'boolean'
        else:
            entry['type'] = 'integer' if isinstance(literal, int) else 'number'
            match = RANGE.match(comment)
            if match:
                low, a, b, text = match.groups()
                high, step = (b, a) if b is not None else (a, None)
                # A whole-number default with a fractional range is a continuous dimension.
                if any(float(x) != int(float(x)) for x in (low, high, step) if x is not None):
                    entry['type'] = 'number'
                entry.update(min=float(low), max=float(high), description=text.strip(), annotated=True)
                entry['step'] = (int(float(step)) if entry['type'] == 'integer' else float(step)) if step else \
                    (1 if entry['type'] == 'integer' else _nice_step(literal))
            else:
                span = max(abs(literal) * 2, 10)
                entry.update(min=0.0 if literal >= 0 else -span, max=span if literal >= 0 else 0.0, annotated=False,
                             step=1 if entry['type'] == 'integer' else _nice_step(literal))
            if entry['min'] > entry['max'] or not (entry['min'] <= literal <= entry['max']):
                entry.update(min=min(entry['min'], literal), max=max(entry['max'], literal))
        parameters.append(entry)
    return parameters


def apply_parameters(source, values):
    """Rewrite literal values in place; comments and formatting are kept."""
    parameters = {p['name']: p for p in extract_parameters(source)}
    unknown = set(values) - set(parameters)
    if unknown:
        raise ValueError(f'Unknown parameters: {", ".join(sorted(unknown))}')
    lines = source.splitlines(keepends=True)
    for name, value in sorted(values.items(), key=lambda item: -parameters[item[0]]['line']):
        p = parameters[name]
        if p['type'] == 'boolean':
            if not isinstance(value, bool): raise ValueError(f'{name} must be true or false')
            text = 'True' if value else 'False'
        else:
            if isinstance(value, bool) or not math.isfinite(value):
                raise ValueError(f'{name} must be a number')
            if not p['min'] - 1e-9 <= value <= p['max'] + 1e-9:
                raise ValueError(f'{name} must be between {p["min"]:g} and {p["max"]:g}')
            if p['type'] == 'integer':
                if value != int(value): raise ValueError(f'{name} must be a whole number')
                text = str(int(value))
            else:
                text = repr(round(float(value), 6))
        line = lines[p['line'] - 1]
        lines[p['line'] - 1] = line[:p['col']] + text + line[p['end_col']:]
    updated = ''.join(lines)
    validate_script(updated)
    return updated


def apply_edits(source, edits):
    for number, edit in enumerate(edits, 1):
        found = source.count(edit['find'])
        if found != 1:
            raise ScriptError(f'Edit {number}: the find text occurs {found} times; it must match exactly once. '
                              'Include more surrounding lines.')
        source = source.replace(edit['find'], edit['replace'], 1)
    validate_script(source)
    return source


def sandbox_profile(work, home, cache=None):
    """macOS Seatbelt profile: no network, no writes outside the build folder (and font cache)."""
    quote = lambda p: '"' + str(p).replace('\\', '\\\\').replace('"', '\\"') + '"'
    secrets = ''.join(f'(subpath {quote(f"{home}/{d}")})' for d in ('.ssh', '.aws', '.gnupg', '.config', '.netrc', 'Library/Keychains'))
    return ('(version 1)(allow default)(deny network*)(deny file-write*)'
            f'(allow file-write* (subpath {quote(work)}){f" (subpath {quote(cache)})" if cache else ""} '
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))'
            f'(deny file-read* {secrets})')

