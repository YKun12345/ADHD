"""Independent central witness for conservative reservations and signed local history."""
import hashlib
from types import SimpleNamespace
from fastapi import HTTPException
from sqlalchemy import select
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.exceptions import InvalidSignature
from backend.app.models.federated_experiment import FederatedPrivacyLedger
from backend.app.services import federated_control_service as control
from backend.app.services import federated_experiment_service as experiments
from backend.app.schemas.federated_experiment import PRESET
from backend.app.core.record_envelope import RecordIntegrityError


def _identifier(node):
    return hashlib.sha256((node['institution_id']+':'+node['protection_namespace']).encode()).hexdigest()


def _key(experiment_id,round_number,attempt,node_id):
    return f'{experiment_id}:{round_number}:{attempt}:{node_id}'


def reserve(db,user,experiment_id,round_number,attempt,node):
    identifier=_identifier(node);head,state,_=control._head(db,node['institution_id'],lock=True)
    previous_history=experiments._histories(db)
    row=db.get(FederatedPrivacyLedger,identifier,populate_existing=True)
    if row is None:
        row=FederatedPrivacyLedger(id=identifier,institution_id=node['institution_id'],protection_namespace=node['protection_namespace'],version=0,sealed_payload='')
        values={'protection_namespace':node['protection_namespace'],'reservations':[],'node_anchors':{}};db.add(row)
    else:values=control._object(db,row)
    identity=_key(experiment_id,round_number,attempt,node['node_id'])
    if any(r['identity']==identity for r in values['reservations']):return identity
    values['reservations'].append({'identity':identity,'node_id':node['node_id'],'experiment_id':experiment_id,
        'round':round_number,'attempt':attempt,'noise_multiplier':PRESET['noise_multiplier'],'sample_rate':PRESET['sample_rate'],
        'planned_steps':PRESET['logical_steps'],'source':'central_before_compute','status':'reserved'})
    projected=experiments.account(previous_history+[[PRESET['noise_multiplier'],PRESET['sample_rate'],PRESET['logical_steps']]])
    if projected['epsilon']>PRESET['max_epsilon']:raise HTTPException(409,'持久预算不足；本轮尚未计算，不能重置旧消耗。')
    row.version+=1;row.put(values)
    request={'client_request_id':'budget-'+hashlib.sha256(identity.encode()).hexdigest()[:48],'reservation':identity}
    control._append(db,user,head,state,row,'privacy_reserve',identifier,request,
        {'reservation':identity,'status':'conservatively_reserved','projected_epsilon':projected['epsilon']})
    return identity


def observe(db,node,privacy):
    """Recording a spent fact needs its original node signature, not a new grant."""
    from federated_runtime.hgst_features import canonical_json
    if not isinstance(privacy,dict) or privacy.get('namespace')!=node['protection_namespace']:
        raise RecordIntegrityError('Node privacy namespace differs from its frozen source.')
    node_row,identity=control._node(db,node['node_id'])
    public=load_pem_public_key(identity['public_key_pem'].encode());events=privacy.get('signed_events')
    if not isinstance(events,list) or len(events)>10000:raise RecordIntegrityError('Node privacy history is missing or oversized.')
    previous='0'*64;epoch=privacy.get('ledger_epoch');remote={}
    try:
        for sequence,signed in enumerate(events,1):
            payload=signed['payload'];public.verify(bytes.fromhex(signed['signature_hex']),canonical_json(payload))
            if payload['sequence']!=sequence or payload['previous_sha256']!=previous or payload['ledger_epoch']!=epoch or payload['namespace']!=node['protection_namespace'] or payload['node_id']!=node['node_id'] or payload['public_key_sha256']!=node_row.public_key_fingerprint:
                raise ValueError('Wrong node/epoch/sequence')
            previous=hashlib.sha256(canonical_json(signed)).hexdigest()
            reservation=_key(payload['experiment_id'],payload['round'],payload['attempt'],node['node_id'])
            if payload['event']=='reserved':
                history=payload['history']
                if reservation in remote or len(history)!=1:raise ValueError('Duplicate reservation')
                noise,rate,steps=history[0]
                if noise<2 or rate!=PRESET['sample_rate'] or type(steps) is not int or not 1<=steps<=2:raise ValueError('Invalid mechanism')
                remote[reservation]={'identity':reservation,'node_id':node['node_id'],'experiment_id':payload['experiment_id'],'round':payload['round'],
                    'attempt':payload['attempt'],'noise_multiplier':noise,'sample_rate':rate,'planned_steps':steps,'source':'signed_node_history','status':'reserved'}
            elif payload['event']=='spent':
                if reservation not in remote:raise ValueError('Step without reservation')
                remote[reservation]['actual_history']=payload['history'];remote[reservation]['status']='spent_or_partly_spent'
            else:raise ValueError('Unknown node privacy event')
    except (KeyError,ValueError,TypeError,InvalidSignature) as error:raise RecordIntegrityError('Node privacy signature or history is invalid.') from error
    if privacy.get('ledger_sequence')!=len(events) or privacy.get('ledger_head_sha256')!=previous:
        raise RecordIntegrityError('Node privacy chain was truncated or substituted.')
    identifier=_identifier(node);head,state,_=control._head(db,node['institution_id'],lock=True)
    row=db.get(FederatedPrivacyLedger,identifier,populate_existing=True)
    if row is None:raise RecordIntegrityError('A node cannot compute without a central conservative reservation.')
    values=control._object(db,row);old=values['node_anchors'].get(node['node_id'])
    if old:
        if epoch!=old['ledger_epoch'] or len(events)<old['sequence'] or events[:old['sequence']]!=old['signed_events']:
            raise RecordIntegrityError('Independent privacy witness rejects a reset, rollback or changed prefix.')
        if len(events)==old['sequence']:return False
    reservations={r['identity']:r for r in values['reservations']};new_history=[]
    for identity,remote_value in remote.items():
        local=reservations.get(identity)
        if local:
            if any(local[key]!=remote_value[key] for key in ('noise_multiplier','sample_rate','planned_steps')):
                raise RecordIntegrityError('Local signed mechanism differs from its central reservation.')
            local.update(status=remote_value['status'],actual_history=remote_value.get('actual_history',[]))
        else:
            values['reservations'].append(remote_value);new_history.append([remote_value['noise_multiplier'],remote_value['sample_rate'],remote_value['planned_steps']])
    # Preserve the complete original signed prefix. A later local file deletion
    # or new epoch cannot reset spent or unconfirmed reservations.
    values['node_anchors'][node['node_id']]={'ledger_epoch':epoch,'sequence':len(events),'head_sha256':previous,'signed_events':events}
    row.version+=1;row.put(values)
    client='budget-seen-'+hashlib.sha256((identifier+':'+node['node_id']+':'+str(epoch)+':'+str(len(events))).encode()).hexdigest()[:48]
    control._append(db,SimpleNamespace(id=None),head,state,row,'privacy_observed',identifier,{'client_request_id':client,'node_id':node['node_id'],'sequence':len(events)},
        {'node_id':node['node_id'],'sequence':len(events),'conservative_reservations':len(values['reservations'])})
    if new_history and experiments.account(experiments._histories(db))['epsilon']>PRESET['max_epsilon']:
        raise HTTPException(409,'新核实的历史预算已达到上限，停止本轮；消耗证据继续保留。')
    return True
