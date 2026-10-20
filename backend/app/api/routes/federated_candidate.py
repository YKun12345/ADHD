from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from backend.app.api.deps import get_db, get_current_user
from backend.app.models.user import User
from backend.app.schemas.federated_candidate import CandidatePublish
from backend.app.services import federated_candidate_service as service

router = APIRouter(prefix='/federated', tags=['federated-candidates'])


@router.get('/projects/{project_id}/bases')
def bases(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.bases(db, user, project_id)


@router.get('/projects/{project_id}/models')
def listing(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.listing(db, user, project_id)


@router.post('/projects/{project_id}/models/{model_version_id}/publish')
def publish(project_id: int, model_version_id: int, payload: CandidatePublish,
            db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.publish(db, user, project_id, model_version_id, payload)


@router.post('/projects/{project_id}/models/{model_version_id}/preview')
async def preview(project_id: int, model_version_id: int, file: UploadFile = File(...),
                  confirmed_synthetic: bool = Form(...), db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    raw = bytearray()
    try:
        while True:
            chunk = await file.read(65536)
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > service.MAX_PREVIEW_BYTES:
                raise HTTPException(413, '实验ROI上传不得超过10 MiB。')
        return await run_in_threadpool(service.preview, db, user, project_id, model_version_id,
                                       bytes(raw), file.filename or '', confirmed_synthetic)
    finally:
        await file.close()
