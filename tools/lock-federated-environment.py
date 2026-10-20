"""Freeze the actually installed isolated environment and official wheel hashes."""
import argparse,importlib.metadata,json,platform,sys
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',required=True);parser.add_argument('--manifest',required=True)
    args=parser.parse_args();root=Path(__file__).resolve().parents[1]
    if Path(sys.prefix).resolve()!=(root/'.venv-federated').resolve():parser.error('Only the isolated federated environment may generate its runtime lock.')
    report=json.loads(Path(args.report).read_text(encoding='utf8'));manifest=json.loads(Path(args.manifest).read_text(encoding='utf8'))
    official={(row['package'].lower().replace('_','-'),row['version']):row for row in manifest};rows=[]
    for item in report['install']:
        name=item['metadata']['name'];version=item['metadata']['version'];actual=importlib.metadata.version(name)
        source=official[(name.lower().replace('_','-'),version)];digest=item['download_info']['archive_info']['hashes']['sha256']
        if actual!=version or digest!=source['sha256']:raise ValueError('Actual installed distribution differs from the resolved official wheel.')
        rows.append({'name':name,'version':version,'sha256':digest,'official_url':source['url']})
    rows.sort(key=lambda row:row['name'].lower())
    (root/'requirements-federated-lock.txt').write_text('# Actual isolated Windows cp311 distributions; official PyPI wheel SHA-256.\n'+'\n'.join(f"{row['name']}=={row['version']} --hash=sha256:{row['sha256']}" for row in rows)+'\n',encoding='utf8')
    (root/'docs/evidence/federated-environment-lock.json').write_text(json.dumps({'python':platform.python_version(),'interpreter':sys.executable,'isolated':True,'packages':rows,'f00_protocol_passed':False},indent=2),encoding='utf8')
    print(json.dumps({'locked_actual_distributions':len(rows),'python':platform.python_version(),'isolated':True}))


if __name__=='__main__':main()
