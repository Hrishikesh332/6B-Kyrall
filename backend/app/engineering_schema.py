"""Typed evidence contracts; declared intent is kept separate from measured geometry."""
from typing import Literal
from pydantic import Field, model_validator
from .models import StrictModel
from .cad_schema import Vector, Name


class Pose(StrictModel):
    part: Name
    translation: Vector = (0, 0, 0)
    rotation: Vector = (0, 0, 0)
    pivot: Vector = (0, 0, 0)


class MotionState(StrictModel):
    name: Name
    poses: list[Pose] = Field(default_factory=list, max_length=12)


class MotionTransition(StrictModel):
    start: Name
    end: Name
    samples: int = Field(default=5, ge=3, le=25)


class GapCheck(StrictModel):
    state: Name
    parts: tuple[Name, Name]
    minimum_mm: float = Field(default=0, ge=0, le=1000, allow_inf_nan=False)
    maximum_mm: float = Field(le=2000, ge=0, allow_inf_nan=False)


class MotionInput(StrictModel):
    source_artifact_id: str
    name: Name = 'motion'
    states: list[MotionState] = Field(min_length=2, max_length=12)
    transitions: list[MotionTransition] = Field(min_length=1, max_length=12)
    gap_checks: list[GapCheck] = Field(default_factory=list, max_length=24)

    @model_validator(mode='after')
    def connected_inputs(self):
        names={s.name for s in self.states}
        if len(names)!=len(self.states): raise ValueError('State names must be unique')
        for s in self.states:
            if len({p.part for p in s.poses})!=len(s.poses): raise ValueError('One pose per part per state')
        touched=set()
        for t in self.transitions:
            if t.start not in names or t.end not in names or t.start==t.end:
                raise ValueError('Transitions must connect distinct declared states')
            touched.update((t.start,t.end))
        if touched!=names: raise ValueError('Every state must participate in a transition')
        if sum(t.samples for t in self.transitions)>240: raise ValueError('At most 240 transition samples')
        for g in self.gap_checks:
            if g.state not in names or g.minimum_mm>g.maximum_mm or g.parts[0]==g.parts[1]:
                raise ValueError('Invalid gap check')
        return self


class RequirementEvidence(StrictModel):
    requirement: str = Field(min_length=3, max_length=500)
    status: Literal['measured', 'assumed', 'unverified']
    evidence_ids: list[str] = Field(default_factory=list, max_length=8)
    limitation: str = Field(min_length=3, max_length=1000)


class CycleStep(StrictModel):
    phase: Literal['approach','engage','transport','release','withdraw','reset']
    trigger: str = Field(min_length=3, max_length=500)
    energy_source: str = Field(min_length=3, max_length=500)
    retention_or_release: str = Field(min_length=3, max_length=500)
    unresolved_test: str = Field(min_length=3, max_length=700)


class Alternative(StrictModel):
    concept: str = Field(min_length=3, max_length=300)
    selected: bool
    tradeoff: str = Field(min_length=3, max_length=800)


class HardwareItem(StrictModel):
    name: str = Field(min_length=2, max_length=200)
    quantity: int = Field(ge=1, le=100)
    included_in_cad: bool
    specification_or_open_question: str = Field(min_length=3, max_length=800)


class BenchTest(StrictModel):
    failure_mode: str = Field(min_length=3, max_length=400)
    procedure: str = Field(min_length=3, max_length=1000)
    acceptance: str = Field(min_length=3, max_length=700)


class DesignReviewInput(StrictModel):
    source_artifact_id: str
    base_part: Name | None = None
    retaining_parts: list[Name] = Field(default_factory=list, max_length=6)
    requirements: list[RequirementEvidence] = Field(min_length=3, max_length=30)
    operating_cycle: list[CycleStep] = Field(min_length=6, max_length=6)
    alternatives: list[Alternative] = Field(min_length=2, max_length=4)
    hardware: list[HardwareItem] = Field(min_length=1, max_length=30)
    bench_tests: list[BenchTest] = Field(min_length=3, max_length=20)

    @model_validator(mode='after')
    def honest_evidence(self):
        if len({s.phase for s in self.operating_cycle})!=6:
            raise ValueError('Cover approach, engage, transport, release, withdraw and reset exactly once')
        if sum(a.selected for a in self.alternatives)!=1: raise ValueError('Select exactly one alternative')
        if any(r.status=='measured' and not r.evidence_ids for r in self.requirements):
            raise ValueError('Measured claims require artifact evidence')
        return self
