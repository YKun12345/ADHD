from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.cycle_review import CycleReviewCreate
from backend.app.services import cycle_review_service as service

router=APIRouter(prefix='/care',tags=['cycle-reviews'])

@router.get('/cycles/{cycle_id}/review-context')
def context(cycle_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.review_context(db,user,cycle_id))

@router.get('/cycles/{cycle_id}/reviews')
def history(cycle_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.list_reviews(db,user,cycle_id))

@router.post('/cycles/{cycle_id}/reviews',status_code=201)
def confirm(cycle_id:int,payload:CycleReviewCreate,response:Response,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created=service.confirm_review(db,user,cycle_id,payload); response.status_code=201 if created else 200
    return _commit_cycle_response(db,result)

@router.get('/cycle-reviews/submissions/{client_id}')
def original(client_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.query_original(db,user,client_id))

@router.post('/cycle-reviews',status_code=201)
def confirm_original(payload:CycleReviewCreate,response:Response,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created=service.confirm_review(db,user,payload.cycle_id,payload); response.status_code=201 if created else 200
    return _commit_cycle_response(db,result)
