from fastapi import APIRouter
from backend.app.api.routes.notifications import router as notifications_router

from backend.app.api.routes.ai import router as ai_router
from backend.app.api.routes.ai_enhanced import router as ai_enhanced_router
from backend.app.api.routes.auth import router as auth_router
from backend.app.api.routes.care import router as care_router
from backend.app.api.routes.care_attention import router as care_attention_router
from backend.app.api.routes.service_coverage import router as service_coverage_router
from backend.app.api.routes.care_transfer import router as care_transfer_router
from backend.app.api.routes.review import router as review_router
from backend.app.api.routes.care_plan import router as care_plan_router
from backend.app.api.routes.agent import router as agent_router
from backend.app.api.routes.cycle_review import router as cycle_review_router
from backend.app.api.routes.imaging_report import router as imaging_report_router
from backend.app.api.routes.followup_summary import router as followup_summary_router
from backend.app.api.routes.model_registry import router as model_registry_router
from backend.app.api.routes.federated import router as federated_router
from backend.app.api.routes.federated_node import router as federated_node_router
from backend.app.api.routes.federated_experiment import router as federated_experiment_router
from backend.app.api.routes.federated_candidate import router as federated_candidate_router
from backend.app.api.routes.doctor import router as doctor_router
from backend.app.api.routes.health import router as health_router
from backend.app.api.routes.imaging_session import router as imaging_session_router
from backend.app.api.routes.model_inference import router as model_inference_router
from backend.app.api.routes.patient import router as patient_router
from backend.app.api.routes.security import router as security_router
from backend.app.api.routes.identity import router as identity_router
from backend.app.api.routes.authorizations import router as authorizations_router


api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(identity_router)
api_router.include_router(authorizations_router)
api_router.include_router(patient_router)
api_router.include_router(ai_router)
api_router.include_router(ai_enhanced_router)
api_router.include_router(care_router)
api_router.include_router(care_attention_router)
api_router.include_router(service_coverage_router)
api_router.include_router(care_transfer_router)
api_router.include_router(review_router)
api_router.include_router(care_plan_router)
api_router.include_router(agent_router)
api_router.include_router(cycle_review_router)
api_router.include_router(imaging_report_router)
api_router.include_router(followup_summary_router)
api_router.include_router(model_registry_router)
api_router.include_router(federated_router)
api_router.include_router(federated_node_router)
api_router.include_router(federated_experiment_router)
api_router.include_router(federated_candidate_router)
api_router.include_router(doctor_router)
api_router.include_router(model_inference_router)
api_router.include_router(security_router)

api_router.include_router(imaging_session_router)
api_router.include_router(notifications_router)
