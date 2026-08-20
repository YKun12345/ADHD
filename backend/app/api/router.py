from fastapi import APIRouter

from backend.app.api.routes.ai import router as ai_router
from backend.app.api.routes.ai_enhanced import router as ai_enhanced_router
from backend.app.api.routes.auth import router as auth_router
from backend.app.api.routes.care import router as care_router
from backend.app.api.routes.doctor import router as doctor_router
from backend.app.api.routes.health import router as health_router
from backend.app.api.routes.model_inference import router as model_inference_router
from backend.app.api.routes.patient import router as patient_router
from backend.app.api.routes.security import router as security_router


api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(patient_router)
api_router.include_router(ai_router)
api_router.include_router(ai_enhanced_router)
api_router.include_router(care_router)
api_router.include_router(doctor_router)
api_router.include_router(model_inference_router)
api_router.include_router(security_router)
