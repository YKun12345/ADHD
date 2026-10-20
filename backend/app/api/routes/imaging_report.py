from fastapi import APIRouter,Depends,Response
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db,get_current_user
from backend.app.models.user import User
from backend.app.schemas.imaging_report import ImagingReportPublish
from backend.app.services import imaging_report_service as service
from backend.app.api.routes.care import _commit_cycle_response

router=APIRouter(prefix='/care/imaging-reports',tags=['imaging-reports'])
@router.get('')
def listing(patient_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.listing(db,user,patient_id))
@router.get('/publication-context')
def prepare(patient_id:int,prediction_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.prepare(db,user,patient_id,prediction_id))
@router.get('/submissions/{client_id}')
def original(client_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.original(db,user,client_id))
@router.post('',status_code=201)
def publish(payload:ImagingReportPublish,response:Response,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created=service.publish(db,user,payload);response.status_code=201 if created else 200
    return _commit_cycle_response(db,result)
@router.get('/{report_id}')
def detail(report_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,service.detail(db,user,report_id))
