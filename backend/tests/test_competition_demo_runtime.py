import importlib.util
from pathlib import Path
import pytest

ROOT=Path(__file__).resolve().parents[2]

def module():
    spec=importlib.util.spec_from_file_location('competition_demo_runtime',ROOT/'tools/competition_demo_runtime.py')
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result

def test_demo_rejects_real_paths_and_foreign_store_without_touching_them(tmp_path):
    runtime=module()
    real=tmp_path/'backend';real.mkdir();(real/'app.db').write_bytes(b'untouched-real-placeholder')
    with pytest.raises(ValueError):runtime.prepare(tmp_path,real)
    assert (real/'app.db').read_bytes()==b'untouched-real-placeholder'
    foreign=tmp_path/'.codex-tmp/competition-demo/stores/foreign';foreign.mkdir(parents=True)
    (foreign/'competition-demo.json').write_text('{"synthetic":true,"service":"different"}')
    with pytest.raises(ValueError):runtime.prepare(tmp_path,foreign)
    assert list(foreign.iterdir())==[foreign/'competition-demo.json']

def test_demo_overrides_inherited_real_settings_and_preserves_its_own_store(tmp_path):
    runtime=module();store,meta=runtime.prepare(tmp_path)
    inherited={'APP_ENV':'production','DATABASE_URL':'sqlite:///backend/app.db','DATA_ENCRYPTION_KEY':'real-key',
        'SECRET_KEY':'real-secret','DEEPSEEK_API_KEY':'real-provider','WECHAT_APP_SECRET':'real-wechat',
        'FEDERATED_WORKER_ENABLED':'true','WECHAT_NOTIFICATION_SEND_ENABLED':'true'}
    configured=runtime.environment(tmp_path,store,meta,inherited)
    assert configured['APP_ENV']=='test' and str(store/'synthetic.db').replace('\\','/') in configured['DATABASE_URL']
    for key in ['DEEPSEEK_API_KEY','WECHAT_APP_SECRET']:assert configured[key]==''
    assert configured['FEDERATED_WORKER_ENABLED']=='false' and configured['WECHAT_NOTIFICATION_SEND_ENABLED']=='false'
    assert configured['SECRET_KEY']!='real-secret' and configured['DATA_ENCRYPTION_KEY']!='real-key'
    (store/'synthetic.db').write_bytes(b'preserved-demo')
    same,again=runtime.prepare(tmp_path,store)
    assert same==store and again==meta and (store/'synthetic.db').read_bytes()==b'preserved-demo'
    assert inherited['APP_ENV']=='production'
