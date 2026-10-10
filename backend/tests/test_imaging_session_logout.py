from backend.tests.test_findviz_security import imaging_actors, open_workspace
import pytest


@pytest.mark.parametrize('with_auth', [True, False])
def test_logout_clears_imaging_cookie_and_blocks_workspace(client, imaging_actors, with_auth):
    open_workspace(client, imaging_actors)
    assert client.get('/findviz/check_cache').status_code == 200
    headers = imaging_actors['doctor']['headers'] if with_auth else {}
    response = client.delete('/api/v1/imaging/session', headers=headers)
    assert response.status_code == 200
    cookie = response.headers['set-cookie'].lower()
    assert 'adhd_findviz_session=' in cookie
    assert 'max-age=0' in cookie and 'path=/findviz' in cookie
    assert 'httponly' in cookie and 'samesite=strict' in cookie
    assert response.headers['cache-control'] == 'no-store'
    assert client.get('/findviz/check_cache').status_code == 401
    assert client.delete('/api/v1/imaging/session').status_code == 200
