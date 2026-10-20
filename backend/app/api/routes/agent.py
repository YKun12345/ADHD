from fastapi import APIRouter, Depends, BackgroundTasks, Response, Query
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.services.agent.context import build_context
from backend.app.services.agent.tools import current_actions, resolve_action
from backend.app.schemas.agent import AgentActionResolve
from backend.app.schemas.agent import AgentRunCreate
from backend.app.services.agent import runner
from backend.app.services.agent import artifact_decision_service as decisions
from backend.app.schemas.agent import ArtifactDecisionCreate
from backend.app.schemas.companion import AgentCompanionObservation
from backend.app.services.agent.companion_workflow import acknowledge_observation
from typing import Literal

router = APIRouter(prefix='/agent', tags=['unified-agent'])


@router.get('/context')
def current_agent_context(patient_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, build_context(db, user, patient_id))


@router.get('/actions')
def next_actions(patient_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, current_actions(db, user, patient_id))


@router.post('/actions/{action_id}/resolve')
def resolve_next_action(action_id: int, payload: AgentActionResolve, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, resolve_action(db, user, action_id, payload))


@router.post('/companion-observations')
def observe_companion(payload: AgentCompanionObservation, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, acknowledge_observation(db, user, payload))


@router.get('/run-context')
def prepare_run(patient_id: int, question_mode: Literal['local', 'smart'] | None = None, context_run_ids: list[int] | None = Query(default=None), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, runner.run_context(db, user, patient_id, question_mode=question_mode, context_run_ids=context_run_ids))


@router.post('/runs', status_code=202)
def create_run(payload: AgentRunCreate, background: BackgroundTasks, response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from backend.app.db.session import SessionLocal
    result, created = runner.enqueue_run(db, user, payload); response.status_code = 202 if created else 200
    result = _commit_cycle_response(db, result)
    background.add_task(runner.schedule_run, SessionLocal, result['run_id'])
    return result


@router.get('/runs/submissions/{client_run_id}')
def original_run(client_run_id: str, background: BackgroundTasks, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from backend.app.db.session import SessionLocal
    result = _commit_cycle_response(db, runner.query_original(db, user, client_run_id))
    background.add_task(runner.schedule_run, SessionLocal, result['run_id'])
    return result


@router.get('/runs')
def private_run_history(patient_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, runner.list_runs(db, user, patient_id))


@router.get('/runs/{run_id}')
def read_run(run_id: int, background: BackgroundTasks, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from backend.app.db.session import SessionLocal
    result = _commit_cycle_response(db, runner.get_run(db, user, run_id))
    if result['status'] in {'queued', 'running'}:
        background.add_task(runner.schedule_run, SessionLocal, run_id)
    return result


@router.get('/artifacts/{artifact_id}/decision-context')
def disposition_preflight(artifact_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,decisions.decision_context(db,user,artifact_id))

@router.get('/artifacts/{artifact_id}/decisions')
def human_history(artifact_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,decisions.history(db,user,artifact_id))

@router.post('/artifact-decisions',status_code=201)
def save_disposition(payload:ArtifactDecisionCreate,response:Response,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created=decisions.decide(db,user,payload); response.status_code=201 if created else 200
    return _commit_cycle_response(db,result)

@router.get('/artifact-decisions/submissions/{client_id}')
def disposition_original(client_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,decisions.query_original(db,user,client_id))

@router.get('/artifact-decisions/{decision_id}/adoption-context')
def adoptable_disposition(decision_id:int,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,decisions.adoption_context(db,user,decision_id))
