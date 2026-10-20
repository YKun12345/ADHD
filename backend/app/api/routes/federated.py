from fastapi import APIRouter,Depends,HTTPException
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db,get_current_user
from backend.app.models.user import User
from backend.app.models.consent import ConsentRecord
from backend.app.schemas.federated import (ProjectCreate,ControlAction,MemberAction,NodeEnrollment,ProjectNodeAction,ConsentWithdraw,ResearchConsentCreate)
from backend.app.schemas.consent import ConsentCreate
from backend.app.services import federated_control_service as service

router=APIRouter(prefix='/federated',tags=['federated'])


@router.get('/projects')
def projects(db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.listing(db,user)


@router.post('/projects',status_code=201)
def create_project(payload:ProjectCreate,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.create_project(db,user,payload)


@router.get('/projects/{project_id}')
def project(project_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.detail(db,user,project_id)


@router.post('/projects/{project_id}/approve')
def approve(project_id:int,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.project_action(db,user,project_id,payload,'project_approve')


@router.post('/projects/{project_id}/revoke')
def revoke(project_id:int,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.project_action(db,user,project_id,payload,'project_revoke')


@router.post('/projects/{project_id}/members')
def member(project_id:int,payload:MemberAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.member_action(db,user,project_id,payload)


@router.post('/projects/{project_id}/members/{user_id}/revoke')
def revoke_member(project_id:int,user_id:int,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.member_action(db,user,project_id,payload,revoke_user_id=user_id)


@router.post('/nodes/enrollment',status_code=201)
def enroll(payload:NodeEnrollment,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.enroll_node(db,user,payload)


@router.post('/nodes/{node_id}/approve')
def approve_node(node_id:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.node_action(db,user,node_id,payload,'node_approve')


@router.post('/nodes/{node_id}/revoke')
def revoke_node(node_id:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.node_action(db,user,node_id,payload,'node_revoke')


@router.post('/projects/{project_id}/nodes')
def link_node(project_id:int,payload:ProjectNodeAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.project_node(db,user,project_id,payload)


@router.get('/projects/{project_id}/audit')
def project_audit(project_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.audit(db,user,project_id)


@router.post('/projects/{project_id}/nodes/{link_id}/approve')
def accept_node(project_id:int,link_id:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.project_node_decision(db,user,project_id,link_id,payload)


@router.post('/projects/{project_id}/nodes/{link_id}/revoke')
def remove_node(project_id:int,link_id:str,payload:ControlAction,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.project_node_decision(db,user,project_id,link_id,payload,revoke=True)


@router.get('/submissions/{client_request_id}')
def original(client_request_id:str,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.submission(db,user,client_request_id)


@router.get('/projects/{project_id}/consent')
def consent_context(project_id:int,patient_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.own_consent_context(db,user,project_id,patient_id)


@router.post('/projects/{project_id}/consent',status_code=201)
def consent(project_id:int,payload:ResearchConsentCreate,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.consent_action(db,user,project_id,payload)


@router.post('/projects/{project_id}/consent/withdraw')
def withdraw(project_id:int,payload:ConsentWithdraw,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return service.consent_action(db,user,project_id,payload,withdraw=True)
