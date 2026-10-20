from fastapi import APIRouter,Depends
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db
from backend.app.schemas.federated_node import NodeHeartbeat,NodeOriginalQuery
from backend.app.services import federated_node_service as service

router=APIRouter(prefix='/federated/node-channel',tags=['federated-node-identity'])


@router.get('/{node_id}/challenge')
def challenge(node_id:str,db:Session=Depends(get_db)):
    return service.challenge(db,node_id)


@router.post('/heartbeat')
def heartbeat(payload:NodeHeartbeat,db:Session=Depends(get_db)):
    return service.heartbeat(db,payload)


@router.post('/submissions/query')
def original(payload:NodeOriginalQuery,db:Session=Depends(get_db)):
    return service.original_query(db,payload)
