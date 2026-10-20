"""Explicit offline trusted-instance loading and numeric equivalence attestation.

Run only in the intended inference environment with a reviewed model manifest,
a trusted instance key and an exported training reference fixture. No training,
activation, server write or patient-data import occurs here.
"""
import argparse,hashlib,hmac,json,os,sys
from datetime import datetime,timezone
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True,help='One version entry exported from the authenticated registry')
    parser.add_argument('--artifact-root',required=True)
    parser.add_argument('--reference',required=True,help='Reviewed NPZ: timeseries, training_connectivity, training_hyperedge_mask')
    parser.add_argument('--instance-id',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--reviewed-model-preflight',action='store_true',required=True)
    args=parser.parse_args()
    secret=os.environ.get('MODEL_INSTANCE_ATTESTATION_KEY','')
    if len(secret)<32:parser.error('A trusted per-instance key must be provided through MODEL_INSTANCE_ATTESTATION_KEY.')
    manifest=json.loads(Path(args.manifest).read_text(encoding='utf-8'));root=Path(args.artifact_root).resolve()
    target=(root/manifest['manifest']['artifact_file']).resolve()
    if not target.is_relative_to(root) or not target.is_file():parser.error('Trusted model file is outside the configured root.')
    with target.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    if digest!=manifest['artifact_sha256']:parser.error('Actual candidate bytes differ from their immutable digest.')
    reference=Path(args.reference).resolve()
    with reference.open('rb') as stream:reference_digest=hashlib.file_digest(stream,'sha256').hexdigest()
    expected=manifest['manifest'].get('training_metadata',{}).get('numeric_reference_sha256')
    if expected!=reference_digest:parser.error('The training reference is not part of the reviewed numeric input contract.')
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    import numpy as np
    from backend.app.services.hgst_runtime import service
    from backend.app.services.hgst_runtime.preprocessing import normalize_timeseries_shape,subject_connectivity,construct_hyperedges_from_time_series
    torch,Hypergraph,PreModel,MLPClassifier=service._import_runtime_dependencies()
    bundle=torch.load(target,map_location='cpu',weights_only=True)
    if not isinstance(bundle,dict) or not all(key in bundle for key in ('encoder_state_dict','classifier_state_dict','classifier_input_dim')):raise ValueError('Unsupported trusted bundle schema.')
    config={**service._default_bundle_config(),**bundle.get('config',{})}
    with np.load(reference,allow_pickle=False) as values:
        signal=normalize_timeseries_shape(values['timeseries']);training=values['training_connectivity'];expected_edges=values['training_hyperedge_mask']
    connectivity=subject_connectivity(signal)
    if not np.isfinite(connectivity).all() or connectivity.shape!=training.shape or not np.allclose(connectivity,training,rtol=1e-6,atol=1e-6):raise ValueError('Training/deployment numeric inputs differ; no readiness proof is produced.')
    edges=construct_hyperedges_from_time_series(signal,lambda_value=float(config['edge_lambda']))
    mask=np.zeros((int(config['num_nodes']),int(config['num_nodes'])),dtype=np.int8)
    for i,edge in enumerate(edges):mask[i,edge]=1
    if not np.array_equal(mask,expected_edges):raise ValueError('Training/deployment hyperedge membership differs.')
    model=PreModel(in_dim=int(config['in_dim']),hid_dim=int(config['hid_dim']),edge_dim=int(config['num_nodes']),feat_drop=float(config['dropout']),use_bn=bool(config['use_bn']),mask_rate=float(config['mask_rate']),encoder_type=str(config['encoder_type']),decoder_type=str(config['decoder_type']),loss_fn=str(config['loss_fn']),replace_rate=float(config['replace_rate']))
    model.load_state_dict(bundle['encoder_state_dict'],strict=True);model.eval()
    classifier=MLPClassifier(int(bundle['classifier_input_dim']),int(config['num_classes']));classifier.load_state_dict(bundle['classifier_state_dict'],strict=True);classifier.eval()
    with torch.no_grad():output=classifier(model.embed(torch.tensor(connectivity,dtype=torch.float32),Hypergraph(int(config['num_nodes']),edges)).reshape(1,-1),None)
    if output.shape!=(1,int(config['num_classes'])) or not torch.isfinite(output).all():raise ValueError('The actual trusted runtime cannot execute the candidate.')
    proof={'instance_id':args.instance_id,'version_id':manifest['id'],'artifact_sha256':digest,'input_contract_digest':manifest['manifest']['input_contract_digest'],
        'loaded_at':datetime.now(timezone.utc).isoformat(),'loaded':True,'numeric_equivalence_verified':True,'numeric_reference_sha256':reference_digest}
    from backend.app.services.cognitive_contract import canonical_digest
    proof['signature']=hmac.new(secret.encode(),canonical_digest(proof).encode(),hashlib.sha256).hexdigest()
    Path(args.output).write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Actual trusted instance loading and reference equivalence passed. Signed proof written; no activation performed.')


if __name__=='__main__':main()
