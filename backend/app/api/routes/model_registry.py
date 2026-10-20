from fastapi import APIRouter,Depends
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user,get_db
from backend.app.models.user import User
from backend.app.schemas.model_registry import CandidateCreate,RegistryAction
from backend.app.services import model_registry_service as service
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.services.review_service import storage_boundary
router=APIRouter(prefix='/model/registry',tags=['model-registry'])
@router.get('/actions/submissions/{client_id}')
@storage_boundary
def original(client_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    from sqlalchemy import select
    from fastapi import HTTPException
    from backend.app.models.model_registry import ModelRegistryAction
    service._reviewer(db,user);service._schema(db)
    row=db.scalar(select(ModelRegistryAction).where(ModelRegistryAction.client_action_id==client_id))
    if row is None:raise HTTPException(404,'原模型操作尚未保存。')
    if row.actor_user_id!=user.id:raise HTTPException(403,'仅原实际审核人可以恢复这份操作。')
    service._head(db,row.family)
    return {'id':row.id,'action':row.action,'version_id':row.version_id,'original_request':row.payload,'submission_status':'committed'}
@router.get('')
@storage_boundary
def listing(family:str='hgst',user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.listing(db,user,family))
@router.post('/candidates',status_code=201)
@storage_boundary
def register(payload:CandidateCreate,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.register(db,user,payload))
@router.post('/actions',status_code=201)
@storage_boundary
def act(payload:RegistryAction,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.action(db,user,payload))
