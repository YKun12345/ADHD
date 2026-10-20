"""Final authority checks must not stop the server from finishing other requests."""
import asyncio
import time


def test_final_authority_check_keeps_async_server_responsive(client, monkeypatch):
    from backend.app import main
    from backend.app.services import identity_access
    from starlette.requests import Request
    from starlette.responses import Response

    request = Request({'type': 'http', 'method': 'GET', 'path': '/api/v1/auth/me', 'headers': []})
    request.state.authorization_receipts = ['synthetic-check-marker']
    def bounded_slow_check(db, receipts):
        assert receipts == ['synthetic-check-marker']
        time.sleep(.25)
    monkeypatch.setattr(identity_access, 'recheck_receipts', bounded_slow_check)
    async def next_response(request):
        return Response('synthetic response')
    async def exercise():
        started = time.monotonic()
        pending = asyncio.create_task(main.recheck_authorization_before_response(request, next_response))
        await asyncio.sleep(.01)
        responsive_after = time.monotonic() - started
        response = await pending
        assert response.headers['Cache-Control'] == 'no-store'
        assert responsive_after < .15, 'A final database check must run outside the async event loop.'
    asyncio.run(exercise())
