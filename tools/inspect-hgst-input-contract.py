"""Compare actual legacy paths on fixed synthetic ROI, without loading weights/data."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'HGST-main'))


def inspect():
    import numpy as np
    research = importlib.import_module('src.getData')
    research_corr = importlib.import_module('src.corr')
    from backend.app.services.hgst_runtime import preprocessing as deployment
    assert Path(research.__file__).resolve() == ROOT / 'HGST-main/src/getData.py'
    generator = np.random.default_rng(20261013)
    shared = generator.normal(size=(64, 1))
    roi = generator.normal(size=(64, 90)) + 0.7 * shared
    roi += np.sin(np.arange(64)[:, None] / 4 + np.arange(90)[None, :] / 10)
    research_features = research_corr.subject_connectivity(roi.copy(), 'correlation')
    deployed_features = deployment.subject_connectivity(roi.copy())
    research_edges = research.construct_hyperedges_from_time_series(roi.copy(), 0.2)
    deployed_edges = deployment.construct_hyperedges_from_time_series(roi.copy(), 0.2)
    identical_edges = research_edges == deployed_edges
    equivalent_features = bool(np.allclose(research_features, deployed_features, rtol=1e-6, atol=1e-6))
    digest = lambda values: hashlib.sha256(np.asarray(values, dtype='<f8').tobytes()).hexdigest()
    paths = ['HGST-main/src/corr.py', 'HGST-main/src/getData.py', 'HGST-main/constr_edges_sparse.py',
        'backend/app/services/hgst_runtime/preprocessing.py']
    report = {
        'purpose': 'synthetic_input_contract_counterexample_only', 'weights_loaded': False, 'real_subject_data_read': False,
        'actual_encoder_training_provenance': 'unverified', 'golden_contract_accepted': False,
        'python': sys.version, 'dependencies': {name: importlib.metadata.version(name) for name in
            ['numpy', 'scipy', 'scikit-learn', 'nilearn']},
        'fixture': {'kind': 'synthetic_roi', 'seed': 20261013, 'shape': list(roi.shape), 'sha256_float64_le': digest(roi)},
        'sources': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in paths},
        'research': {'feature_sha256_float64_le': digest(research_features), 'implementation': 'Nilearn ConnectivityMeasure(correlation,zscore_sample)'},
        'deployment': {'feature_sha256_float64_le': digest(deployed_features), 'implementation': 'numpy.corrcoef after population zscore, float32'},
        'comparison': {'features_equivalent_rtol_1e_6_atol_1e_6': equivalent_features,
            'feature_max_abs_difference': float(np.max(np.abs(research_features - deployed_features))),
            'hyperedges_equal': identical_edges, 'hyperedge_count': len(deployed_edges), 'lasso_alpha': 0.2},
        'embedding_comparison': 'not_run_unverified_encoder_contract',
        'R03_closed': False,
    }
    return report, research_features, deployed_features


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--assert-equivalent', action='store_true')
    args = parser.parse_args()
    report, research, deployed = inspect()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['comparison'], ensure_ascii=False))
    if args.assert_equivalent:
        import numpy as np
        np.testing.assert_allclose(research, deployed, rtol=1e-6, atol=1e-6,
            err_msg='Actual current research/deployment features differ; do not accept an unverified golden contract')


if __name__ == '__main__':
    main()
