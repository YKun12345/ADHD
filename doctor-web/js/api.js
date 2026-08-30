(function interceptAuthFromParams() {
    try {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('_token');
        const userStr = params.get('_user');
        
        let updated = false;
        if (token) {
            localStorage.setItem('smartbrain_token', token);
            params.delete('_token');
            updated = true;
        }
        if (userStr) {
            localStorage.setItem('smartbrain_user', userStr);
            params.delete('_user');
            updated = true;
        }
        
        if (updated) {
            const newSearch = params.toString() ? '?' + params.toString() : '';
            const newUrl = window.location.pathname + newSearch + window.location.hash;
            window.history.replaceState({}, document.title, newUrl);
        }
    } catch (e) {
        console.error('Failed to intercept cross-domain auth:', e);
    }
})();

const LOCAL_API_ORIGIN = 'http://127.0.0.1:8000';
const REQUEST_TIMEOUT_MS = 120000;

function resolveApiBaseUrl() {
    const override = window.SMARTBRAIN_API_BASE_URL;
    if (typeof override === 'string' && override.trim()) {
        return override.replace(/\/$/, '');
    }

    const { protocol, hostname, port, origin } = window.location;
    const isLocalDevHost = hostname === 'localhost' || hostname === '127.0.0.1';
    const isHttpOrigin = protocol === 'http:' || protocol === 'https:';

    if (isHttpOrigin && (!isLocalDevHost || port === '8000')) {
        return `${origin}/api/v1`;
    }

    return `${LOCAL_API_ORIGIN}/api/v1`;
}

const BASE_URL = resolveApiBaseUrl();

function normalizeErrorMessage(data) {
    if (typeof data === 'string' && data.trim()) {
        return data;
    }

    if (!data || typeof data !== 'object') {
        return '服务器内部错误，请稍后重试。';
    }

    if (typeof data.message === 'string' && data.message.trim()) {
        return data.message;
    }

    if (typeof data.detail === 'string' && data.detail.trim()) {
        return data.detail;
    }

    if (Array.isArray(data.detail)) {
        return data.detail
            .map((item) => {
                if (typeof item === 'string') return item;
                if (item && typeof item.msg === 'string') return item.msg;
                return JSON.stringify(item);
            })
            .join('；');
    }

    return '请求失败，请稍后重试。';
}

async function request(endpoint, options = {}) {
    const token = localStorage.getItem('smartbrain_token');
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const config = {
        ...options,
        headers,
        signal: controller.signal,
    };

    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
        config.body = JSON.stringify(config.body);
    }

    if (config.body instanceof FormData) {
        delete config.headers['Content-Type'];
    }

    try {
        const response = await fetch(`${BASE_URL}${endpoint}`, config);
        const isAuthRequest = endpoint.startsWith('/auth/login') || endpoint.startsWith('/auth/register');

        if ((response.status === 401 || response.status === 403) && token && !isAuthRequest) {
            // 403 可能是 CORS 预检或权限误判，不自动登出；仅 401 且响应体明确提示 token 过期时才登出
            if (response.status === 403) {
                throw new Error('权限不足或网络异常，请确认后端服务已启动。');
            }

            // 尝试读取响应体判断是否为真正的 token 过期
            let isRealExpired = false;
            try {
                const clone = response.clone();
                const body = await clone.json();
                const detail = String(body.detail || body.message || '').toLowerCase();
                isRealExpired = detail.includes('not authenticated')
                    || detail.includes('invalid token')
                    || detail.includes('expired')
                    || detail.includes('could not validate');
            } catch (_) {
                // 无法解析响应体时，保守处理：不清除 token，仅报错
                throw new Error('服务器响应异常，请稍后重试。');
            }

            if (isRealExpired) {
                localStorage.removeItem('smartbrain_token');
                localStorage.removeItem('smartbrain_user');
                if (!window._authRedirectPending) {
                    window._authRedirectPending = true;
                    setTimeout(() => { window.location.href = 'login.html'; }, 300);
                }
            } else {
                throw new Error('认证未通过，请重新登录。');
            }
            return null;
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            throw new Error(normalizeErrorMessage(data));
        }
        return data;
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('请求超时，请确认后端服务已启动并正常响应。');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

window.API = {
    Auth: {
        register: (data) => request('/auth/register', { method: 'POST', body: data }),
        login: (data) => request('/auth/login', { method: 'POST', body: data }),
        getMe: () => request('/auth/me', { method: 'GET' }),
    },

    Patient: {
        getDashboardStatus: () => request('/patient/dashboard_status', { method: 'GET' }),
        submitScale: (scaleData) => request('/patient/submit_scale', { method: 'POST', body: scaleData }),
        submitCognitiveTest: (testData) => request('/patient/submit_cognitive_test', { method: 'POST', body: testData }),
        submitDailyLog: (logData) => request('/patient/submit_daily_log', { method: 'POST', body: logData }),
        getComprehensiveReport: () => request('/patient/comprehensive_report', { method: 'GET' }),
    },

    Doctor: {
        bindPatientByEmail: (data) => request('/doctor/bind_patient', { method: 'POST', body: data }),
        getMyPatients: () => request('/doctor/my_patients', { method: 'GET' }),
        getDashboardStats: () => request('/doctor/dashboard_stats', { method: 'GET' }),
        getPatientsList: (page = 1, keyword = '') =>
            request(`/doctor/patients_list?page=${page}&keyword=${encodeURIComponent(keyword)}`, { method: 'GET' }),
        predictModel: (formData) => request('/model/predict_fmri', { method: 'POST', body: formData }),
        uploadImage: (formData) => request('/doctor/upload_image', { method: 'POST', body: formData }),
        getPatientReportDetails: (patientId) => request(`/doctor/patient/${patientId}/report`, { method: 'GET' }),
        saveImagingVisualization: (patientId, data) =>
            request(`/doctor/patient/${patientId}/imaging_visualization`, { method: 'POST', body: data }),
        predictTimeseries: (patientId, formData) =>
            request(`/model/predict_fmri?patient_id=${patientId}`, { method: 'POST', body: formData }),
    },

    Care: {
        createPatientTask: (patientId, data) => request(`/care/doctor/patient/${patientId}/tasks`, { method: 'POST', body: data }),
        getPatientTasksForDoctor: (patientId) => request(`/care/doctor/patient/${patientId}/tasks`, { method: 'GET' }),
        getMyTasks: () => request('/care/patient/tasks', { method: 'GET' }),
        completeMyTask: (taskId) => request(`/care/patient/tasks/${taskId}/complete`, { method: 'POST' }),
        sendDoctorMessage: (patientId, data) => request(`/care/doctor/patient/${patientId}/messages`, { method: 'POST', body: data }),
        sendPatientMessage: (data) => request('/care/patient/messages', { method: 'POST', body: data }),
        getDoctorMessages: (patientId) => request(`/care/doctor/patient/${patientId}/messages`, { method: 'GET' }),
        getPatientMessages: () => request('/care/patient/messages', { method: 'GET' }),
        getDoctorAiLogs: (patientId) => request(`/care/doctor/patient/${patientId}/ai_logs`, { method: 'GET' }),
        getPatientAiLogs: () => request('/care/patient/ai_logs', { method: 'GET' }),
    },

    AI: {
        chatMessage: (payload) =>
            request('/ai/chat', {
                method: 'POST',
                body: typeof payload === 'string' ? { message: payload } : payload,
            }),
        explainReport: (payload = {}) => request('/ai/explain_report', { method: 'POST', body: payload }),
        generateReminder: (payload = {}) => request('/ai/generate_reminder', { method: 'POST', body: payload }),
        getStatus: () => request('/ai/status', { method: 'GET' }),
    },

    Security: {
        getSystemStatus: () => request('/security/system/status', { method: 'GET' }),
        initializeSystem: () => request('/security/system/init', { method: 'POST' }),
        getKeyAssignments: () => request('/security/system/key_assignments', { method: 'GET' }),
        getMcsNodes: () => request('/security/system/mcs_nodes', { method: 'GET' }),
        getPatientAssignments: () => request('/security/system/patient_assignments', { method: 'GET' }),
        getAuditPatients: () => request('/security/dac/patients', { method: 'GET' }),
        getPatientOverview: (patientId) => request(`/security/patient/${patientId}/overview`, { method: 'GET' }),
        getPatientCipherRecords: (patientId, sourceType = '') =>
            request(`/security/patient/${patientId}/cipher_records${sourceType ? `?source_type=${encodeURIComponent(sourceType)}` : ''}`, { method: 'GET' }),
        runTemporalAudit: (payload) => request('/security/dac/temporal_audits', { method: 'POST', body: payload }),
        runSpatialAudit: (payload) => request('/security/dac/spatial_audits', { method: 'POST', body: payload }),
        getRecentAudits: () => request('/security/dac/recent_audits', { method: 'GET' }),
        getAuditLogs: () => request('/security/dac/audit_logs', { method: 'GET' }),
    },
};
