from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class SaveImagingVisualizationRequest(BaseModel):
    visualization_type: str
    func_file_name: str | None = None
    anat_file_name: str | None = None
    mask_file_name: str | None = None
    left_func_file_name: str | None = None
    left_mesh_file_name: str | None = None
    right_func_file_name: str | None = None
    right_mesh_file_name: str | None = None
    slice_screenshot_name: str | None = None
    slice_screenshot_data: str | None = None
    surface_screenshot_name: str | None = None
    surface_screenshot_data: str | None = None
    slice_interpretation: str | None = None
    surface_interpretation: str | None = None
    notes: str | None = None


class ImagingVisualizationResponse(BaseModel):
    id: int
    visualization_type: str
    func_file_name: str | None = None
    anat_file_name: str | None = None
    mask_file_name: str | None = None
    left_func_file_name: str | None = None
    left_mesh_file_name: str | None = None
    right_func_file_name: str | None = None
    right_mesh_file_name: str | None = None
    slice_screenshot_name: str | None = None
    slice_screenshot_data: str | None = None
    surface_screenshot_name: str | None = None
    surface_screenshot_data: str | None = None
    slice_interpretation: str | None = None
    surface_interpretation: str | None = None
    summary_text: str
    notes: str | None = None
    created_at: datetime
    professional_review_status: Literal['not_recorded'] = 'not_recorded'
    version_status: Literal['legacy_mutable_record'] = 'legacy_mutable_record'
    storage_integrity: dict | None = None
    storage_context: dict | None = None
