"""Fetch already-resolved official wheels concurrently with full SHA-256 checks.

No environment is installed or upgraded. A subsequent isolated offline pip
resolution remains authoritative; the resolver log is not itself a lock file.
"""
import argparse,concurrent.futures,hashlib,json,re,time,urllib.request,urllib.error
from pathlib import Path
from urllib.parse import urlparse
from packaging.utils import parse_wheel_filename,canonicalize_name


def official_json(name,version):
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json',timeout=15) as response:return json.load(response)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resolver-log',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--workers',type=int,default=24,choices=range(1,25))
    args=parser.parse_args();root=Path(__file__).resolve().parents[1];output=Path(args.output).resolve()
    if not output.is_relative_to((root/'.codex-tmp').resolve()):parser.error('Use a dedicated workspace temporary wheel cache.')
    output.mkdir(parents=True,exist_ok=True);log=Path(args.resolver_log)
    if log.stat().st_size>4*1024*1024:parser.error('The resolver log exceeds its bounded size.')
    selected={}
    for filename in re.findall(r'Downloading ([^\s/\\]+\.whl)\.metadata',log.read_text(encoding='utf8')):
        name,version,_,_=parse_wheel_filename(filename);selected[canonicalize_name(name)]=(str(version),filename)
    if any(selected.get(name,('',''))[0]!=version for name,version in {'flwr':'1.23.0','opacus':'1.5.4','torch':'2.6.0','numpy':'1.26.4'}.items()):parser.error('The four explicit independent-environment pins must match the resolver output.')
    def resolve(pair):
        name,(version,filename)=pair;release=official_json(name,version);record=next(value for value in release['urls'] if value['filename']==filename)
        if urlparse(record['url']).hostname!='files.pythonhosted.org' or not record['url'].startswith('https://'):raise ValueError('Unexpected official wheel host.')
        return {'package':name,'version':version,'filename':filename,'url':record['url'],'size':record['size'],'sha256':record['digests']['sha256']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:manifest=list(pool.map(resolve,selected.items()))
    (output/'official-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
    chunk=1024*1024;started=time.monotonic();parts={}
    def fetch_once(job):
        record,index,first,last=job;target=output/(record['filename']+f'.part-{index}');expected=last-first+1
        if target.is_file() and target.stat().st_size==expected:return
        request=urllib.request.Request(record['url'],headers={'Range':f'bytes={first}-{last}'})
        temporary=target.with_suffix(target.suffix+'.incomplete');begin=time.monotonic()
        with urllib.request.urlopen(request,timeout=15) as response,temporary.open('wb') as stream:
            if response.status!=206 or response.headers.get('Content-Range')!=f"bytes {first}-{last}/{record['size']}":raise ValueError('Official server did not honor the exact bounded byte range.')
            size=0
            while size<expected:
                if time.monotonic()-begin>180:raise TimeoutError('A wheel segment exceeded its deadline.')
                block=response.read(min(65536,expected-size))
                if not block:raise EOFError('Incomplete official wheel segment.')
                stream.write(block);size+=len(block)
        temporary.replace(target)
    def fetch(job):
        for attempt in range(3):
            try:return fetch_once(job)
            except (TimeoutError,urllib.error.URLError):
                if attempt==2:raise
    jobs=[]
    for record in manifest:
        target=output/record['filename']
        if target.is_file() and hashlib.file_digest(target.open('rb'),'sha256').hexdigest()==record['sha256']:continue
        count=(record['size']+chunk-1)//chunk;parts[record['filename']]=count
        jobs.extend((record,index,index*chunk,min(record['size']-1,(index+1)*chunk-1)) for index in range(count))
    print(json.dumps({'resolved_wheels':len(manifest),'segments':len(jobs),'workers':args.workers}),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures={pool.submit(fetch,job):job for job in jobs};completed=0
        for future in concurrent.futures.as_completed(futures):
            future.result();completed+=1
            if completed%24==0:print(json.dumps({'completed_segments':completed,'total_segments':len(jobs),'elapsed_seconds':round(time.monotonic()-started,1)}),flush=True)
    for record in manifest:
        if record['filename'] not in parts:continue
        assembled=output/(record['filename']+'.assembling');digest=hashlib.sha256()
        with assembled.open('wb') as target:
            for index in range(parts[record['filename']]):
                with (output/(record['filename']+f'.part-{index}')).open('rb') as source:
                    for block in iter(lambda:source.read(1024*1024),b''):digest.update(block);target.write(block)
        if assembled.stat().st_size!=record['size'] or digest.hexdigest()!=record['sha256']:raise ValueError('Complete official wheel digest mismatch; it will not be installed.')
        assembled.replace(output/record['filename']);print(json.dumps({'verified_wheel':record['filename'],'sha256':record['sha256']}),flush=True)
    print(json.dumps({'status':'all_selected_official_wheels_verified','elapsed_seconds':round(time.monotonic()-started,2)}),flush=True)


if __name__=='__main__':main()
