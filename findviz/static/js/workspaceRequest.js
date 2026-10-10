// Patient identity is explicit on every request; the short-lived credential stays HttpOnly.
export async function workspaceFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (window.FINDVIZ_PATIENT_ID) {
        headers.set('X-Findviz-Patient-Id', String(window.FINDVIZ_PATIENT_ID));
    }
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) {
        throw new Error('影像工作区授权失败或会话已过期，请重新进入当前患者页面。');
    }
    return response;
}
