"""Fixed official endpoints and generic approved-template fields; no private text."""
from dataclasses import dataclass
from datetime import timezone, timedelta
import os
import re

import httpx


@dataclass(frozen=True)
class WechatNotificationConfig:
    app_id: str = ''
    app_secret: str = ''
    template_id: str = ''
    title_field: str = ''
    time_field: str = ''
    send_enabled: bool = False
    worker_enabled: bool = False
    miniprogram_state: str = 'formal'

    @classmethod
    def from_environment(cls):
        return cls(app_id=os.getenv('WECHAT_APP_ID', '').strip(),
            app_secret=os.getenv('WECHAT_APP_SECRET', '').strip(),
            template_id=os.getenv('WECHAT_SUBSCRIBE_TEMPLATE_ID', '').strip(),
            title_field=os.getenv('WECHAT_SUBSCRIBE_TITLE_FIELD', '').strip(),
            time_field=os.getenv('WECHAT_SUBSCRIBE_TIME_FIELD', '').strip(),
            send_enabled=os.getenv('WECHAT_NOTIFICATION_SEND_ENABLED', 'false').lower() == 'true',
            worker_enabled=os.getenv('WECHAT_NOTIFICATION_WORKER_ENABLED', 'false').lower() == 'true',
            miniprogram_state=os.getenv('WECHAT_MINIPROGRAM_STATE', 'formal').strip())

    def blockers(self, *, include_disabled=True):
        result = []
        if not self.app_id: result.append('missing_app_id')
        if not self.app_secret: result.append('missing_app_secret')
        if not self.template_id: result.append('missing_template_id')
        if not re.fullmatch(r'thing[1-9][0-9]*', self.title_field) or not re.fullmatch(r'time[1-9][0-9]*', self.time_field):
            result.append('template_fields_not_configured')
        if self.miniprogram_state not in {'developer', 'trial', 'formal'}: result.append('invalid_miniprogram_state')
        if include_disabled and not self.send_enabled: result.append('delivery_disabled')
        return result


TEMPLATES = {
    'shared_message_sent': ('有新的协作消息', 'pages/shared-messages/index'),
    'professional_report_published': ('新的报告已发布', 'pages/care-reports/index'),
    'professional_plan_published': ('新的随访计划已发布', 'pages/patient-plan/index'),
    'attention_response_overdue': ('待办响应窗口已到', 'pages/care-attention/index'),
}


class WechatProviderError(Exception):
    def __init__(self, reason, *, uncertain=False):
        self.reason = reason
        self.uncertain = uncertain
        super().__init__(reason)  # Never preserve provider response text, URL or secrets.


class WechatNotificationProvider:
    def __init__(self, config=None, *, transport=None):
        self.config = config or WechatNotificationConfig.from_environment()
        self.transport = transport

    def _call(self, method, path, *, params=None, body=None, sending=False):
        try:
            # No redirects, retries or caller-controlled host. Transport injection is test-only.
            with httpx.Client(transport=self.transport, timeout=8, follow_redirects=False, trust_env=False) as client:
                response = client.request(method, 'https://api.weixin.qq.com' + path, params=params, json=body)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict): raise ValueError('invalid_shape')
        except (httpx.HTTPError, ValueError) as exc:
            raise WechatProviderError('wechat_delivery_unknown' if sending else 'wechat_unavailable', uncertain=sending) from None
        if sending and 'errcode' not in data:
            raise WechatProviderError('wechat_delivery_unknown', uncertain=True)
        code = data.get('errcode', 0)
        if type(code) is not int:
            raise WechatProviderError('wechat_delivery_unknown' if sending else 'wechat_invalid_response', uncertain=sending)
        if code:
            reason = {43101: 'wechat_permission_unavailable', 40003: 'wechat_binding_invalid',
                40037: 'wechat_template_invalid', 43107: 'wechat_template_banned',
                43108: 'wechat_concurrent_send', 47003: 'wechat_template_fields_invalid',
                40029: 'wechat_login_code_invalid', 40163: 'wechat_login_code_used'}.get(code, 'wechat_rejected')
            raise WechatProviderError(reason)
        return data

    def exchange_login_code(self, code):
        if not self.config.app_id or not self.config.app_secret:
            raise WechatProviderError('wechat_binding_not_configured')
        data = self._call('GET', '/sns/jscode2session', params={'appid': self.config.app_id,
            'secret': self.config.app_secret, 'js_code': code, 'grant_type': 'authorization_code'})
        openid = data.get('openid')
        if not isinstance(openid, str) or not 1 <= len(openid) <= 128:
            raise WechatProviderError('wechat_invalid_response')
        return openid  # session_key/unionid are deliberately neither stored nor exposed.

    def send(self, *, openid, event_type, occurred_at):
        blockers = self.config.blockers()
        if blockers: raise WechatProviderError(blockers[0])
        if event_type not in TEMPLATES: raise WechatProviderError('unsupported_event')
        token = self._call('POST', '/cgi-bin/stable_token', body={'grant_type': 'client_credential',
            'appid': self.config.app_id, 'secret': self.config.app_secret, 'force_refresh': False}).get('access_token')
        if not isinstance(token, str) or not token: raise WechatProviderError('wechat_invalid_response')
        title, _ = TEMPLATES[event_type]
        occurred_at = occurred_at if occurred_at.tzinfo else occurred_at.replace(tzinfo=timezone.utc)
        self._call('POST', '/cgi-bin/message/subscribe/send', params={'access_token': token}, body={
            'touser': openid, 'template_id': self.config.template_id, 'page': 'pages/notifications/index',
            'miniprogram_state': self.config.miniprogram_state, 'lang': 'zh_CN',
            'data': {self.config.title_field: {'value': title}, self.config.time_field: {
                'value': occurred_at.astimezone(timezone(timedelta(hours=8))).strftime('%Y年%m月%d日 %H:%M')}}}, sending=True)
