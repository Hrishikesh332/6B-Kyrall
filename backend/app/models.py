from typing import Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TaskCreate(StrictModel):
    prompt: str = Field(min_length=1, max_length=24000)
    title: str | None = Field(default=None, max_length=100)
    project_id: str | None = None
    context_scope: Literal["isolated", "project", "workspace"] = "isolated"

    @model_validator(mode="after")
    def valid_scope(self):
        if not self.prompt.strip():
            raise ValueError("Prompt cannot be blank")
        if self.context_scope == "project" and not self.project_id:
            raise ValueError("Project context requires a project")
        return self


class MessageFocus(StrictModel):
    """A component picked in the 3D studio; scopes the follow-up to one part."""
    part: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_]{0,49}$")
    source_artifact_id: str = Field(min_length=1, max_length=64)


class MessageCreate(StrictModel):
    content: str = Field(min_length=1, max_length=24000)
    focus: MessageFocus | None = None


class TaskPatch(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    archived: bool | None = None
    approval_policy: Literal["ask", "auto"] | None = None


class ProjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    brief: str = Field(default="", max_length=20000)
    memory_scope: Literal["project", "workspace"] = "project"


class ProjectPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    brief: str | None = Field(default=None, max_length=20000)
    memory_scope: Literal["project", "workspace"] | None = None


class ClarificationAnswer(StrictModel):
    answers: dict[str, str] = Field(default_factory=dict)
    notes: str = Field(default="", max_length=4000)
    skip: bool = False


class Question(StrictModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    question: str = Field(min_length=1, max_length=300)
    options: list[str] = Field(min_length=2, max_length=4)
    default: str

    @model_validator(mode="after")
    def default_is_option(self):
        if self.default not in self.options or len(set(self.options)) != len(self.options):
            raise ValueError("Default must be one of the distinct options")
        return self


class PlannedChange(StrictModel):
    target: str = Field(min_length=1, max_length=120)
    change: str = Field(min_length=1, max_length=600)


class ApprovalInput(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=1200)
    changes: list[PlannedChange] = Field(min_length=1, max_length=12)
    preserved: list[str] = Field(default_factory=list, max_length=12)
    risks: list[str] = Field(default_factory=list, max_length=8)
    checks: list[str] = Field(default_factory=list, max_length=8)
    # Open choices the user settles in the same step as approving the plan.
    questions: list["Question"] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def unique_questions(self):
        if len({q.id for q in self.questions}) != len(self.questions):
            raise ValueError("Question IDs must be unique")
        return self


class ApprovalDecision(StrictModel):
    decision: Literal["approve", "changes"]
    note: str = Field(default="", max_length=4000)
    answers: dict[str, str] = Field(default_factory=dict, max_length=3)

    @model_validator(mode="after")
    def note_for_changes(self):
        if self.decision == "changes" and not self.note.strip():
            raise ValueError("Describe the changes you want before sending them back")
        return self


class AskInput(StrictModel):
    title: str = Field(max_length=120)
    questions: list[Question] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({q.id for q in self.questions}) != len(self.questions):
            raise ValueError("Question IDs must be unique")
        return self


class PlanItem(StrictModel):
    id: str = Field(max_length=40)
    title: str = Field(max_length=200)
    status: Literal["pending", "in_progress", "completed", "blocked"] = "pending"


class PlanInput(StrictModel):
    steps: list[PlanItem] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def coherent_steps(self):
        if len({s.id for s in self.steps}) != len(self.steps):
            raise ValueError('Plan step IDs must be unique')
        if sum(s.status == 'in_progress' for s in self.steps) > 1:
            raise ValueError('Only one plan step may be in progress')
        return self


class SpecInput(StrictModel):
    title: str = Field(min_length=1, max_length=100)
    requirements: list[str] = Field(max_length=30)
    assumptions: list[str] = Field(max_length=20)
    parameters: dict[str, str | float | int | bool] = Field(default_factory=dict)
    deliverables: list[str] = Field(max_length=20)


class ActivityInput(StrictModel):
    title: str = Field(max_length=120)
    detail: str = Field(max_length=1500)
    phase: Literal['interpret','clarify','research','build','inspect','revise','package'] = 'interpret'


class DecisionInput(StrictModel):
    key: str = Field(pattern=r'^[a-z][a-z0-9_-]{0,39}$')
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=1000)
    basis: Literal['assumption','user_choice','source','measurement','design']
    evidence_ids: list[str] = Field(default_factory=list, max_length=10)
    tradeoffs: list[str] = Field(default_factory=list, max_length=4)
    uncertainties: list[str] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def evidence_required(self):
        if self.basis in ('source','measurement') and not self.evidence_ids:
            raise ValueError('Source and measurement summaries require evidence artifact IDs')
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError('Evidence IDs must be distinct')
        if any(len(x)>500 for x in self.tradeoffs+self.uncertainties):
            raise ValueError('Keep each tradeoff or uncertainty below 500 characters')
        return self


class ReadFileInput(StrictModel):
    artifact_id: str


class WriteFileInput(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.(md|txt|json|csv)$")
    content: str = Field(max_length=150000)


class SearchContextInput(StrictModel):
    query: str = Field(min_length=1, max_length=200)


class MemoryInput(StrictModel):
    content: str = Field(min_length=1, max_length=4000)


class WorkflowInput(StrictModel):
    name: Literal['cad', 'research', 'manufacturing', 'review', 'mechanism']


class ReferenceInput(StrictModel):
    url: str = Field(max_length=2000)
    page_start: int = Field(default=1, ge=1, le=500)
    page_count: int = Field(default=2, ge=1, le=3)
    find: str = Field(default='', max_length=150)


class PackageInput(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}(\.zip)?$")
    artifact_ids: list[str] = Field(min_length=1, max_length=30)


class ScheduleCreate(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=24000)
    interval_minutes: int = Field(ge=60, le=525600)
    enabled: bool = False


class SchedulePatch(StrictModel):
    enabled: bool


class RuleCreate(StrictModel):
    content: str = Field(min_length=1, max_length=2000)
    project_id: str | None = Field(default=None, max_length=100)
    rule_set: str = Field(default="", max_length=120)
    applies_when: str = Field(default="", max_length=600)
    level: Literal["must", "should"] = "must"


class RulePatch(StrictModel):
    enabled: bool | None = None
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    level: Literal["must", "should"] | None = None
    rule_set: str | None = Field(default=None, max_length=120)
    applies_when: str | None = Field(default=None, max_length=600)
