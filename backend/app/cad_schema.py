"""Finite, declarative CAD language: model output is data, never executable Python."""
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .models import StrictModel

Dimension = Annotated[float, Field(ge=0.2, le=1000, allow_inf_nan=False)]
Coordinate = Annotated[float, Field(ge=-2000, le=2000, allow_inf_nan=False)]
Vector = tuple[Coordinate, Coordinate, Coordinate]
Name = Annotated[str, Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,49}$")]


class Box(StrictModel):
    id: Name
    op: Literal["box"]
    size: tuple[Dimension, Dimension, Dimension]


class Cylinder(StrictModel):
    id: Name
    op: Literal["cylinder"]
    radius: Dimension
    height: Dimension


class Sphere(StrictModel):
    id: Name
    op: Literal["sphere"]
    radius: Dimension


class Extrude(StrictModel):
    id: Name
    op: Literal["polygon_extrude"]
    points: list[tuple[Coordinate, Coordinate]] = Field(min_length=3, max_length=50)
    height: Dimension


class Boolean(StrictModel):
    id: Name
    op: Literal["union", "cut", "intersect"]
    inputs: list[Name] = Field(min_length=2, max_length=24)


class EdgeFinish(StrictModel):
    id: Name
    op: Literal["fillet", "chamfer"]
    source: Name
    radius: Dimension
    edges: Literal["all", "|Z", "|X", "|Y", ">Z", "<Z"] = "all"


class Transform(StrictModel):
    id: Name
    op: Literal["transform"]
    source: Name
    translation: Vector = (0, 0, 0)
    rotation: Vector = (0, 0, 0)


Node = Annotated[Box | Cylinder | Sphere | Extrude | Boolean | EdgeFinish | Transform, Field(discriminator="op")]


class Part(StrictModel):
    name: Name
    shape: Name
    translation: Vector = (0, 0, 0)
    rotation: Vector = (0, 0, 0)
    print_rotation: Vector = (0, 0, 0)


class CadInput(StrictModel):
    name: Name
    units: Literal["mm"] = "mm"
    nodes: list[Node] = Field(min_length=1, max_length=120)
    parts: list[Part] = Field(min_length=1, max_length=12)
    print_bed: tuple[Dimension, Dimension, Dimension] = (220, 220, 250)
    notes: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def graph_is_acyclic(self):
        known = set()
        for node in self.nodes:
            if node.id in known:
                raise ValueError("Node IDs must be unique")
            dependencies = getattr(node, 'inputs', []) or ([node.source] if hasattr(node, 'source') else [])
            if any(x not in known for x in dependencies):
                raise ValueError("References must point to earlier nodes")
            known.add(node.id)
        if any(p.shape not in known for p in self.parts):
            raise ValueError("Every part must refer to a shape")
        if len({p.name for p in self.parts}) != len(self.parts):
            raise ValueError("Part names must be unique")
        return self


class CadPatchInput(StrictModel):
    source_artifact_id: str
    replace_nodes: list[Node] = Field(default_factory=list, max_length=120)
    delete_nodes: list[Name] = Field(default_factory=list, max_length=120)
    replace_parts: list[Part] = Field(default_factory=list, max_length=12)
    delete_parts: list[Name] = Field(default_factory=list, max_length=12)
    notes: list[str] | None = Field(default=None, max_length=20)


def apply_cad_patch(source, patch):
    patch=CadPatchInput.model_validate(patch)
    result=CadInput.model_validate(source).model_dump()
    for field,replacements,deletions,key in (
        ('nodes',patch.replace_nodes,patch.delete_nodes,'id'),
        ('parts',patch.replace_parts,patch.delete_parts,'name')):
        replacement={getattr(x,key):x.model_dump() for x in replacements}
        if len(replacement)!=len(replacements) or len(set(deletions))!=len(deletions):
            raise ValueError('Patch identifiers must be unique')
        existing={x[key] for x in result[field]}
        if set(deletions)-existing: raise ValueError('Cannot delete an unknown identifier')
        if set(deletions)&set(replacement): raise ValueError('Cannot replace and delete the same identifier')
        updated=[replacement.pop(x[key],x) for x in result[field] if x[key] not in deletions]
        updated.extend(replacement.values())
        result[field]=updated
    # Reorder the finite DAG after inserting new dependencies; never execute expressions.
    ordered=[];known=set();remaining=result['nodes'][:]
    while remaining:
        ready=[n for n in remaining if all(x in known for x in n.get('inputs',[]) or ([n['source']] if 'source' in n else []))]
        if not ready: raise ValueError('Patch creates missing references or a dependency cycle')
        ordered.extend(ready);known.update(n['id'] for n in ready)
        remaining=[n for n in remaining if n not in ready]
    result['nodes']=ordered
    if patch.notes is not None: result['notes']=patch.notes
    return CadInput.model_validate(result).model_dump()



def _shape_closure(nodes, shape):
    seen=set();stack=[shape]
    while stack:
        node=nodes[stack.pop()]
        if node['id'] in seen: continue
        seen.add(node['id'])
        stack.extend(node.get('inputs',[]) or ([node['source']] if 'source' in node else []))
    return seen


def part_dependencies(source, part_name):
    """Node IDs one part is built from, and the subset other parts also use."""
    nodes={n['id']:n for n in source['nodes']}
    part=next((p for p in source['parts'] if p['name']==part_name),None)
    if part is None: raise ValueError('That component is not in the selected CAD source')
    own=_shape_closure(nodes,part['shape'])
    shared=set().union(*(_shape_closure(nodes,p['shape']) for p in source['parts'] if p['name']!=part_name))&own
    order=[n['id'] for n in source['nodes']]
    return [n for n in order if n in own],[n for n in order if n in shared]
