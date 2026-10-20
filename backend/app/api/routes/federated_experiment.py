from fastapi import APIRouter,Depends
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db,get_current_user
from backend.app.models.user import User
from backend.app.schemas.federated import ControlAction
from backend.app.schemas.federated_experiment import ExperimentCreate
from backend.app.services import federated_experiment_service as service

router=APIRouter(prefix='/federated',tags=['federated-experiments'])


@router.post('/projects/{project_id}/experiments',status_code=201)
def create(project_id:int,payload:ExperimentCreate,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.create(db,user,project_id,payload)


@router.get('/projects/{project_id}/experiments')
def listing(project_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.listing(db,user,project_id)


@router.get('/experiments/{identifier}')
def detail(identifier:str,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.detail(db,user,identifier)


@router.post('/experiments/{identifier}/preflight')
def preflight(identifier:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.action(db,user,identifier,payload,'preflight')


@router.post('/experiments/{identifier}/start')
def start(identifier:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.action(db,user,identifier,payload,'start')


@router.post('/experiments/{identifier}/stop')
def stop(identifier:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.action(db,user,identifier,payload,'stop')


@router.get('/experiments/{identifier}/rounds')
def rounds(identifier:str,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.rounds(db,user,identifier)


@router.get('/projects/{project_id}/privacy')
def privacy(project_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.privacy(db,user,project_id)
