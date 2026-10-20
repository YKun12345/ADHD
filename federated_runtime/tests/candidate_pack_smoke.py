"""Fresh synthetic given-state packaging checks. Never executes training."""
import argparse
import io
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--legacy-site-packages', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(Path(args.legacy_site_packages).resolve()))
    from federated_runtime.candidate_pack import package_candidate, preview_candidate, CandidateRejected, load_aggregate
    from federated_runtime.hgst_features import (legacy_dependencies, make_encoder, canonical_json,
        input_contract, sha256_bytes, CLASSIFIER_NAMES)
    np, torch, dhg, modeling, preprocessing, runtime = legacy_dependencies()
    torch.set_num_threads(1)
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    config = {'num_nodes': 90, 'in_dim': 90, 'hid_dim': 8, 'num_classes': 2,
              'encoder_type': 'hgnnp', 'decoder_type': 'hgnnp', 'use_bn': True,
              'dropout': 0., 'mask_rate': .5, 'replace_rate': .05, 'loss_fn': 'sce',
              'edge_lambda': .2, 'connectivity_kind': 'correlation',
              'model_name': 'f05_synthetic_untrained', 'model_version': 'f05-given-state-only'}
    torch.manual_seed(617)
    encoder = make_encoder(modeling, config)
    classifier = modeling.MLPClassifier(720, 2)
    base = directory / 'fresh-untrained-base.pt'
    base_stream = io.BytesIO()
    torch.save({'config_json': canonical_json(config).decode(), 'encoder_state_dict': encoder.state_dict(),
                'classifier_state_dict': classifier.state_dict(), 'classifier_input_dim': 720,
                'encoder_origin': 'fresh_random_synthetic_untrained'}, base_stream)
    base.write_bytes(base_stream.getvalue())
    base_bytes = base.read_bytes()
    arrays = [np.full(shape, .001 * (index + 1), dtype=np.float32)
              for index, shape in enumerate(((256, 720), (256,), (2, 256), (2,)))]
    aggregate = directory / 'given-four-arrays.npz'
    np.savez(aggregate, **dict(zip(CLASSIFIER_NAMES, arrays)))
    aggregate_sha = sha256_bytes(aggregate.read_bytes())
    _, parameters_sha = load_aggregate(aggregate, aggregate_sha, 720)
    metadata = {'purpose': 'research_only', 'synthetic': True,
                'actual_federated_training_performed': False,
                'notice': 'given-state packaging validation only; no real round or budget claim'}
    output = directory / 'candidate.pt'
    request = {'base_path': str(base), 'base_sha256': sha256_bytes(base_bytes), 'output_path': str(output),
               'input_contract_digest': sha256_bytes(canonical_json(input_contract(config))),
               'aggregates': [{'path': str(aggregate), 'sha256': aggregate_sha, 'parameters_sha256': parameters_sha}],
               'metadata': metadata}
    result = package_candidate(request)
    candidate = torch.load(io.BytesIO(output.read_bytes()), map_location='cpu', weights_only=True)
    assert base.read_bytes() == base_bytes
    assert all(torch.equal(candidate['encoder_state_dict'][key], value) for key, value in encoder.state_dict().items())
    assert all(np.array_equal(candidate['classifier_state_dict'][name].numpy(), array)
               for name, array in zip(CLASSIFIER_NAMES, arrays))
    roi = directory / 'synthetic-roi.npz'
    np.savez(roi, roi=np.random.RandomState(519).normal(size=(2, 16, 90)).astype(np.float32),
             labels=np.array([0, 1], np.int64), synthetic=np.array(True))
    preview = preview_candidate({'candidate_path': str(output), 'candidate_sha256': result['artifact_sha256'],
                                 'roi_path': str(roi), 'roi_sha256': sha256_bytes(roi.read_bytes())})
    assert len(preview['predictions']) == 2
    assert preview['artifact_sha256'] == sha256_bytes(output.read_bytes())
    denied = []
    for label, change in [('base-digest', {'base_sha256': '0' * 64}),
                          ('parameter-digest', {'aggregates': [{**request['aggregates'][0], 'parameters_sha256': '0' * 64}]}),
                          ('overwrite', {'output_path': str(base)})]:
        try:
            package_candidate({**request, 'output_path': str(directory / (label + '.pt')), **change})
        except (ValueError, CandidateRejected):
            denied.append(label)
        else:
            raise AssertionError('Negative boundary accepted: ' + label)
    assert len(denied) == 3
    summary = {'status': 'passed', 'actual_federated_training_performed': False, 'runtime': runtime,
               'base_sha256': sha256_bytes(base_bytes), 'candidate_sha256': result['artifact_sha256'],
               'aggregate_parameters_sha256': parameters_sha, 'validation': result['validation'],
               'preview_subjects': len(preview['predictions']), 'negative_cases_refused': denied,
               'base_bytes_preserved': True, 'encoder_exactly_preserved': True, 'given_classifier_exactly_preserved': True}
    (directory / 'result.json').write_bytes(canonical_json(summary))
    print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    main()
