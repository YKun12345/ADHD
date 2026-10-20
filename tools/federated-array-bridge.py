"""Explicit synthetic NPZ exchange between the old HGST and new runtime."""
import argparse,hashlib,json,sys
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['export','roundtrip','verify'])
    parser.add_argument('--directory',required=True)
    parser.add_argument('--old-site-packages',help='Read-only old ABI libraries when the original interpreter executable is missing.')
    parser.add_argument('--synthetic-only',action='store_true',required=True)
    args=parser.parse_args();root=Path(__file__).resolve().parents[1];directory=Path(args.directory).resolve()
    if not directory.is_relative_to((root/'.codex-tmp').resolve()) or not directory.name.startswith('federated-f00-'):parser.error('Use a dedicated temporary F00 directory.')
    directory.mkdir(exist_ok=True)
    old_runtime=Path(sys.prefix).resolve().name=='.venv-hgst'
    if args.old_site_packages:
        source=Path(args.old_site_packages).resolve()
        if args.operation=='roundtrip' or source!=(root/'.venv-hgst/Lib/site-packages').resolve() or sys.version_info[:3]!=(3,10,11):parser.error('The compatibility bridge requires exact Python 3.10.11 and the existing original HGST libraries.')
        sys.dont_write_bytecode=True;sys.path.insert(0,str(source));old_runtime=True
    import numpy as np
    original=directory/'synthetic-old-environment.npz';returned=directory/'synthetic-new-environment.npz'
    if args.operation=='export':
        if not old_runtime:parser.error('Export requires the unchanged old HGST libraries and their exact interpreter ABI.')
        if original.exists():parser.error('An existing original exchange is never overwritten.')
        roi=np.random.default_rng(20261017).normal(size=(32,190)).astype(np.float32)
        matrix=np.corrcoef(roi.T).astype(np.float32)
        np.savez(original,roi=roi,connectivity=matrix)
    else:
        if original.stat().st_size>8*1024*1024:parser.error('Synthetic exchange exceeds its explicit bound.')
        with np.load(original,allow_pickle=False) as values:
            if set(values.files)!={'roi','connectivity'}:raise ValueError('Unexpected exchange fields.')
            data={key:values[key] for key in values.files}
        if data['roi'].shape!=(32,190) or data['connectivity'].shape!=(190,190) or any(value.dtype!=np.float32 or not np.isfinite(value).all() for value in data.values()):raise ValueError('Invalid synthetic numerical contract.')
        if args.operation=='roundtrip':
            if Path(sys.prefix).resolve().name!='.venv-federated':parser.error('Roundtrip uses the independent new federated interpreter.')
            if returned.exists():parser.error('An existing returned exchange is never overwritten.')
            np.savez(returned,**data)
        else:
            if not old_runtime:parser.error('Final verification requires the original old ABI libraries.')
            with np.load(returned,allow_pickle=False) as values:
                if set(values.files)!=set(data) or any(not np.array_equal(values[key],value) or values[key].dtype!=value.dtype for key,value in data.items()):raise ValueError('Actual old/new array exchange changed a number or dtype.')
    record={'operation':args.operation,'interpreter':sys.executable,'numpy_version':np.__version__,'synthetic_only':True,'numeric_input_equivalence_verified':False,'encoder_loaded':False,'old_site_packages':args.old_site_packages or None}
    if args.operation=='verify':
        record['exact_array_exchange_verified']=True
        record['array_sha256']={key:hashlib.sha256(value.tobytes()).hexdigest() for key,value in data.items()}
    (directory/(args.operation+'-receipt.json')).write_text(json.dumps(record,indent=2),encoding='utf8');print(json.dumps(record))


if __name__=='__main__':main()
