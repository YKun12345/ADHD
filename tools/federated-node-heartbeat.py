"""Send a signed local-node heartbeat. No user JWT or private key leaves the node."""
import argparse
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request,urlopen
from uuid import uuid4


def canonical(value):
    return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()


def request(base,route,body=None):
    operation=Request(base+route,data=canonical(body) if body else None,headers={'Content-Type':'application/json'},method='POST' if body else 'GET')
    with urlopen(operation,timeout=10) as response:
        return json.loads(response.read(128*1024))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-directory',required=True)
    parser.add_argument('--api-base',required=True,help='Local API prefix, e.g. http://127.0.0.1:8000/api/v1')
    parser.add_argument('--compatibility',default='flower-1.23/secaggplus-v1')
    parser.add_argument('--retry-original',action='store_true',help='Explicitly resend the exact original only after a fresh signed not-found query')
    parser.add_argument('--archive-rejected-original',action='store_true',help='Keep an archive after an actual write rejection and fresh signed not-found query')
    args=parser.parse_args();base=args.api_base.rstrip('/')
    url=urlsplit(base)
    if url.scheme!='http' or url.hostname not in {'127.0.0.1','localhost'} or url.username or url.password or url.query or url.fragment:
        parser.error('This first-version local-node channel only connects to localhost HTTP; remote deployment needs separate F07 admission.')
    node=Path(args.node_directory).resolve();manifest=json.loads((node/'manifest.json').read_text(encoding='utf8'))
    if manifest.get('mode')!='synthetic_research_only' or manifest.get('synthetic') is not True:parser.error('Only explicit synthetic nodes are supported.')
    key=(node/manifest['private_key_file']).resolve()
    if not key.is_relative_to(node) or key==node or not key.is_file():parser.error('The node private key must stay inside this node directory.')
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    private=load_pem_private_key(key.read_bytes(),password=None)
    if not isinstance(private,Ed25519PrivateKey):parser.error('Expected the registered local Ed25519 key.')
    pending=node/'heartbeat-original.json'
    ack=None;entry=None
    if pending.exists():
        entry=json.loads(pending.read_text(encoding='utf8'))
        if entry['api_base']!=base or entry['request']['node_id']!=manifest['node_id']:parser.error('Original heartbeat belongs to another node or API; preserve it.')
        body=entry['request'];signed={k:v for k,v in body.items() if k!='signature'}
        private.public_key().verify(base64.b64decode(body['signature'],validate=True),hashlib.sha256(canonical(signed)).hexdigest().encode())
        query={'node_id':manifest['node_id'],'target_client_request_id':body['client_request_id'],'query_id':'query-'+uuid4().hex,
            'requested_at':datetime.now(timezone.utc).isoformat()}
        query['signature']=base64.b64encode(private.sign(hashlib.sha256(canonical(query)).hexdigest().encode())).decode()
        try:
            response=request(base,'/federated/node-channel/submissions/query',query)
            if response.get('query_id')!=query['query_id'] or response.get('node_id')!=manifest['node_id'] or response.get('target_client_request_id')!=body['client_request_id']:
                raise ValueError('Signed original query returned another identity.')
            ack=response['operation_receipt']
        except HTTPError as error:
            if error.code!=404:raise
            if args.archive_rejected_original:
                if entry.get('last_write_rejection') not in {403,409,422}:raise ValueError('Archive requires an actual original write rejection, not a query error or lost response.')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',body['client_request_id']):raise ValueError('Unsafe original identifier')
                directory=(node/'heartbeat-archives').resolve();target=(directory/(body['client_request_id']+'.json')).resolve()
                if not target.is_relative_to(node) or not directory.is_relative_to(node):raise ValueError('Archive path escapes this node')
                directory.mkdir(exist_ok=True)
                if json.loads(pending.read_text(encoding='utf8'))!=entry:raise ValueError('Local original changed before archiving')
                with target.open('x',encoding='utf8') as archive:json.dump(entry,archive,sort_keys=True)
                if json.loads(target.read_text(encoding='utf8'))!=entry:raise ValueError('Archive verification failed')
                pending.unlink();print(json.dumps({'status':'archived_unconfirmed','node_id':manifest['node_id'],'notice':'Original kept in this node archive. Invoke again explicitly to request a new challenge.'}));return 0
            if not args.retry_original:
                print(json.dumps({'status':'unconfirmed','node_id':manifest['node_id'],'notice':'Original preserved. Explicit --retry-original resends the same signed bytes; --archive-rejected-original requires a recorded write rejection and fresh not-found query.'}));return 3
    else:
        if args.retry_original or args.archive_rejected_original:parser.error('No pending original exists; no recovery action was performed.')
        challenge=request(base,'/federated/node-channel/'+manifest['node_id']+'/challenge')
        if challenge['node_id']!=manifest['node_id'] or challenge['protocol']!='ed25519-sha256-canonical-v1':raise ValueError('Node challenge identity/protocol differs.')
        body={'client_request_id':'heartbeat-'+uuid4().hex,'node_id':manifest['node_id'],'challenge':challenge['challenge'],
            'sequence':challenge['next_sequence'],'observed_at':datetime.now(timezone.utc).isoformat(),'compatibility':args.compatibility}
        body['signature']=base64.b64encode(private.sign(hashlib.sha256(canonical(body)).hexdigest().encode())).decode()
        # Exclusive create prevents another local launcher replacing an in-flight
        # original; an explicit next invocation reuses these exact signed bytes.
        entry={'api_base':base,'request':body}
        with pending.open('x',encoding='utf8') as target:json.dump(entry,target,sort_keys=True)
    if ack is None:
        try:ack=request(base,'/federated/node-channel/heartbeat',body)
        except HTTPError as error:
            if error.code in {403,409,422}:
                current=json.loads(pending.read_text(encoding='utf8'))
                if current.get('request')!=body or current.get('api_base')!=base:raise ValueError('Local original changed before rejection was recorded')
                current['last_write_rejection']=error.code
                temporary=node/('heartbeat-status-'+uuid4().hex+'.tmp')
                with temporary.open('x',encoding='utf8') as target:json.dump(current,target,sort_keys=True)
                temporary.replace(pending)
            raise
    if ack.get('actor_user_id') is not None or ack.get('client_request_id')!=body['client_request_id'] or ack.get('original_request')!=body or ack.get('submission_status')!='committed' or ack.get('result',{}).get('node_id')!=manifest['node_id'] or ack['result'].get('sequence')!=body['sequence']:
        raise ValueError('Node acknowledgement differs; original remains on this node.')
    current=json.loads(pending.read_text(encoding='utf8'))
    if current.get('request')!=body or current.get('api_base')!=base:raise ValueError('Local original changed before acknowledgement.')
    pending.unlink()
    print(json.dumps(ack['result'],ensure_ascii=False))
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print('Signed node heartbeat failed; any in-flight original remains local. '+type(error).__name__,file=sys.stderr)
        raise SystemExit(1)
