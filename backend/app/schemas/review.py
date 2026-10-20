from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictReview(BaseModel):
    model_config = ConfigDict(extra='forbid')


class EvidenceDecision(StrictReview):
    submission_id: str = Field(min_length=1, max_length=64)
    assessment_item_id: int = Field(gt=0, strict=True)
    attempt_id: int = Field(gt=0, strict=True)
    decision: Literal['accepted', 'needs_repeat', 'rejected']
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator('reason')
    @classmethod
    def actual_reason(cls, value):
        if not value.strip():
            raise ValueError('A real explanation is required.')
        return value


class ReviewCreate(StrictReview):
    client_review_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    expected_assessment_version: int = Field(gt=0, strict=True)
    input_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    review_context: str = Field(min_length=20, max_length=65536)
    category: Literal['evidence_review', 'screening_opinion', 'clinical_assessment', 'diagnosis']
    body: str = Field(min_length=1, max_length=12000)
    limitations: str = Field(min_length=1, max_length=4000)
    decisions: list[EvidenceDecision] = Field(min_length=1, max_length=100)
    confirmed: bool = Field(strict=True)
    source_ai_decision_id: int | None = Field(default=None,gt=0,strict=True)

    @field_validator('body', 'limitations')
    @classmethod
    def actual_text(cls, value):
        if not value.strip():
            raise ValueError('Actual doctor text and limitations are required.')
        return value

    @field_validator('confirmed')
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError('The actual doctor must explicitly confirm.')
        return value


class ReviewPublicationCreate(StrictReview):
    client_publication_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    review_id: int = Field(gt=0, strict=True)
    expected_assessment_version: int = Field(gt=0, strict=True)
    expected_previous_report_version: int = Field(ge=0, strict=True)
    input_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    publication_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @field_validator('confirmed')
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError('Publication requires actual doctor confirmation.')
        return value


class ClarificationCreate(StrictReview):
    client_question_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    expected_assessment_version: int = Field(gt=0, strict=True)
    input_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    review_context: str = Field(min_length=20, max_length=65536)
    source_type: Literal['submission', 'background']
    source_key: str = Field(min_length=1, max_length=64)
    question: str = Field(min_length=1, max_length=2000)
    source_ai_decision_id: int | None = Field(default=None,gt=0,strict=True)
    confirmed: bool = Field(strict=True)

    @model_validator(mode='after')
    def actual_question(self):
        if self.confirmed is not True or not self.question.strip():
            raise ValueError('A specific question requires the actual doctor confirmation.')
        return self


class ClarificationReplyCreate(StrictReview):
    client_reply_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    question_id: int = Field(gt=0, strict=True)
    expected_assessment_version: int = Field(gt=0, strict=True)
    expected_previous_revision: int = Field(ge=0, strict=True)
    reply_context: str = Field(min_length=20, max_length=65536)
    answer_status: Literal['provided', 'unknown', 'skipped']
    answer: str | None = Field(default=None, max_length=4000)
    confirmed: bool = Field(strict=True)

    @model_validator(mode='after')
    def real_answer(self):
        if self.confirmed is not True or (self.answer_status == 'provided' and (not self.answer or not self.answer.strip())):
            raise ValueError('A provided answer needs actual text and explicit confirmation.')
        if self.answer_status != 'provided' and self.answer is not None:
            raise ValueError('Unknown or skipped information must remain null.')
        return self
