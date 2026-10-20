"""F05 pure packaging and explicit-candidate inference in the locked HGST process.

Only an exact trusted base SHA and bounded numeric NPZ arrays enter this module.
No optimizer, training loop, business settings or clinical model pointer is used.
"""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import sys
import zipfile

# The read-only Python 3.10 compatibility executable uses an isolated ._pth
# file. Resolve this trusted repository module explicitly, without site changes.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from federated_runtime.hgst_features import (
    CLASSIFIER_NAMES, MAX_ARRAY_BYTES, MAX_BUNDLE_BYTES, _digest, _load_roi,
    candidate_config, canonical_json, input_contract, legacy_dependencies,
    make_encoder, sha256_bytes, tensor_descriptors,
)


class CandidateRejected(ValueError):
    pass


def _trusted_bytes(path, expected_sha256, maximum):
    _digest(expected_sha256, 'Expected SHA-256')
    target = Path(path)
    if not target.is_absolute() or not target.is_file() or target.stat().st_size > maximum:
        raise CandidateRejected('Trusted input requires a bounded absolute file')
    raw = target.read_bytes()
    if len(raw) > maximum or sha256_bytes(raw) != expected_sha256:
        raise CandidateRejected('Trusted input SHA-256 mismatch')
    return raw


def load_aggregate(path, expected_sha256, input_dim):
    import numpy as np
    raw = _trusted_bytes(path, expected_sha256, MAX_ARRAY_BYTES)
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) != 4 or sum(e.file_size for e in entries) > MAX_ARRAY_BYTES:
                raise CandidateRejected('Aggregate exceeds the four-array numeric bound')
        with np.load(io.BytesIO(raw), allow_pickle=False) as archive:
            if set(archive.files) != set(CLASSIFIER_NAMES):
                raise CandidateRejected('Aggregate requires exactly four classifier arrays')
            arrays = [archive[name].copy() for name in CLASSIFIER_NAMES]
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise CandidateRejected('Aggregate must contain safe numeric arrays with allow_pickle=False') from error
    shapes = ((256, input_dim), (256,), (2, 256), (2,))
    if any(a.dtype != np.float32 or a.shape != shape or not np.isfinite(a).all()
           for a, shape in zip(arrays, shapes)):
        raise CandidateRejected('Aggregate requires four finite float32 arrays of the exact MLP shapes')
    descriptors = [{'name': name, 'shape': list(a.shape), 'dtype': str(a.dtype),
                    'sha256': sha256_bytes(a.tobytes(order='C'))}
                   for name, a in zip(CLASSIFIER_NAMES, arrays)]
    return arrays, sha256_bytes(canonical_json(descriptors))


def _models(raw, np, torch, modeling):
    # A digest is mandatory before this function; never fall back to pickle.
    bundle = torch.load(io.BytesIO(raw), map_location='cpu', weights_only=True)
    config = candidate_config(bundle)
    if bundle.get('classifier_input_dim') != 90 * config['hid_dim']:
        raise CandidateRejected('Trusted base classifier dimension differs from config')
    encoder_state = bundle.get('encoder_state_dict')
    encoder_descriptors = tensor_descriptors(encoder_state, np, torch)
    classifier_state = bundle.get('classifier_state_dict')
    if not isinstance(classifier_state, dict) or set(classifier_state) != set(CLASSIFIER_NAMES):
        raise CandidateRejected('Trusted base requires the exact original classifier structure')
    tensor_descriptors(classifier_state, np, torch, CLASSIFIER_NAMES)
    encoder = make_encoder(modeling, config)
    encoder.load_state_dict(encoder_state, strict=True)
    encoder.eval().requires_grad_(False)
    classifier = modeling.MLPClassifier(90 * config['hid_dim'], 2)
    classifier.load_state_dict(classifier_state, strict=True)
    classifier.eval().requires_grad_(False)
    return bundle, config, encoder, classifier, sha256_bytes(canonical_json(encoder_descriptors))


def _predict(roi, config, encoder, classifier, np, torch, dhg, preprocessing):
    predictions = []
    with torch.no_grad():
        for series in roi:
            connectivity = preprocessing.subject_connectivity(series)
            edges = preprocessing.construct_hyperedges_from_time_series(series, lambda_value=config['edge_lambda'])
            graph = dhg.Hypergraph(90, edges)
            features = encoder.embed(torch.tensor(connectivity, dtype=torch.float32), graph).reshape(1, -1)
            probabilities = torch.softmax(classifier(features), dim=1).cpu().numpy()[0]
            if probabilities.shape != (2,) or not np.isfinite(probabilities).all():
                raise CandidateRejected('Candidate inference produced invalid probabilities')
            predictions.append({'probability': float(probabilities[1]), 'probability_control': float(probabilities[0]),
                                'prediction_label': 'ADHD' if probabilities[1] >= .5 else 'Control'})
    return predictions


def package_candidate(request):
    raw = _trusted_bytes(request['base_path'], request['base_sha256'], MAX_BUNDLE_BYTES)
    output = Path(request['output_path'])
    if not output.is_absolute() or output.exists() or output.resolve() == Path(request['base_path']).resolve():
        raise CandidateRejected('Candidate output requires a fresh distinct absolute path')
    np, torch, dhg, modeling, preprocessing, runtime = legacy_dependencies()
    torch.set_num_threads(1)
    bundle, config, encoder, classifier, encoder_sha = _models(raw, np, torch, modeling)
    contract_digest = sha256_bytes(canonical_json(input_contract(config)))
    if request['input_contract_digest'] != contract_digest:
        raise CandidateRejected('Trusted base input contract differs from the frozen registry')
    aggregates = request['aggregates']
    if not isinstance(aggregates, list) or not 1 <= len(aggregates) <= 5:
        raise CandidateRejected('Candidate requires one to five committed rounds')
    digests = []
    for item in aggregates:
        arrays, digest = load_aggregate(item['path'], item['sha256'], 90 * config['hid_dim'])
        if digest != item['parameters_sha256']:
            raise CandidateRejected('Committed aggregate parameter SHA-256 mismatch')
        digests.append(digest)
    classifier_state = {name: torch.from_numpy(a.copy()) for name, a in zip(CLASSIFIER_NAMES, arrays)}
    classifier.load_state_dict(classifier_state, strict=True)
    metadata = request['metadata']
    if metadata.get('synthetic') is not True or metadata.get('purpose') != 'research_only':
        raise CandidateRejected('Only explicit synthetic research candidates may be packaged')
    candidate = {'config_json': canonical_json(config).decode(), 'encoder_state_dict': bundle['encoder_state_dict'],
                 'classifier_state_dict': classifier_state, 'classifier_input_dim': 90 * config['hid_dim'],
                 'class_names': ['Control', 'ADHD'], 'encoder_origin': str(bundle.get('encoder_origin', 'external_unverified')),
                 'federated_metadata_json': canonical_json(metadata).decode()}
    stream = io.BytesIO()
    torch.save(candidate, stream)
    candidate_bytes = stream.getvalue()
    # Validate the exact serialized bytes in the old runtime before publishing.
    _, loaded_config, loaded_encoder, loaded_classifier, loaded_encoder_sha = _models(candidate_bytes, np, torch, modeling)
    if loaded_encoder_sha != encoder_sha:
        raise CandidateRejected('Packaging changed the frozen encoder')
    roi = np.random.RandomState(518).normal(size=(1, 16, 90)).astype(np.float32)
    predictions = _predict(roi, loaded_config, loaded_encoder, loaded_classifier, np, torch, dhg, preprocessing)
    validation = {'status': 'synthetic_load_and_inference_passed', 'artifact_sha256': sha256_bytes(candidate_bytes),
                  'input_sha256': sha256_bytes(roi.tobytes(order='C')), 'input_shape': list(roi.shape),
                  'predictions_sha256': sha256_bytes(canonical_json(predictions)), 'runtime': runtime,
                  'accuracy_or_clinical_validity_verified': False, 'r03_equivalence_verified': False}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents overwriting another immutable package.
    with output.open('xb') as target:
        target.write(candidate_bytes)
        target.flush()
        os.fsync(target.fileno())
    return {'artifact_sha256': sha256_bytes(candidate_bytes), 'aggregate_parameters_sha256': digests[-1],
            'round_parameter_digests': digests, 'encoder_parameters_sha256': encoder_sha,
            'config_sha256': sha256_bytes(canonical_json(config)), 'input_contract_digest': contract_digest,
            'encoder_origin': candidate['encoder_origin'], 'validation': validation}


def preview_candidate(request):
    raw = _trusted_bytes(request['candidate_path'], request['candidate_sha256'], MAX_BUNDLE_BYTES)
    np, torch, dhg, modeling, preprocessing, runtime = legacy_dependencies()
    torch.set_num_threads(1)
    _, config, encoder, classifier, _ = _models(raw, np, torch, modeling)
    roi, _ = _load_roi(Path(request['roi_path']), request['roi_sha256'], np)
    predictions = _predict(roi, config, encoder, classifier, np, torch, dhg, preprocessing)
    return {'artifact_sha256': request['candidate_sha256'], 'input_sha256': request['roi_sha256'],
            'predictions': predictions, 'runtime': runtime, 'research_only': True,
            'synthetic': True, 'clinical_activation_allowed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--legacy-site-packages', required=True)
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.legacy_site_packages).resolve()))
    try:
        request = json.loads(Path(args.request).read_text(encoding='utf8'))
        if request.get('operation') == 'package':
            result = package_candidate(request)
        elif request.get('operation') == 'preview':
            result = preview_candidate(request)
        else:
            raise CandidateRejected('Unknown candidate operation')
    except Exception as error:
        print('F05 candidate refused: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
