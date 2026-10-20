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
const SESSION_GUARD_SCRIPT_URL = new URL('session-guard.js?v=20261020-login',
    document.currentScript?.src || new URL('js/api.js', window.location.href)).href;
let sessionGuardLoading = null;

function loadLoginSessionGuard() {
    if (sessionGuardLoading) return sessionGuardLoading;
    // Only a login page may recover its dependency and establish a new identity.
    if (!/\/login\.html$/.test(window.location.pathname)) {
        return Promise.reject(new Error('登录组件未加载，请刷新页面后重试。'));
    }
    sessionGuardLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const fail = () => {
            clearTimeout(timer);
            script.remove?.();
            reject(new Error('登录组件加载失败，请按 Ctrl+F5 刷新页面后重试。'));
        };
        const timer = setTimeout(fail, 10000);
        script.src = SESSION_GUARD_SCRIPT_URL;
        script.onload = () => {
            clearTimeout(timer);
            if (typeof window.SessionGuard?.captureSession !== 'function') { fail(); return; }
            resolve(window.SessionGuard);
        };
        script.onerror = fail;
        document.head.appendChild(script);
    }).catch(error => { sessionGuardLoading = null; throw error; });
    return sessionGuardLoading;
}

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

async function request(endpoint, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const isAuthRequest = endpoint.startsWith('/auth/login') || endpoint.startsWith('/auth/register');
    if (!window.SessionGuard && !isAuthRequest) throw new Error('登录组件未加载，请刷新页面后重试。');
    const guard = window.SessionGuard || await loadLoginSessionGuard();
    const snapshot = guard.captureSession();
    guard.assertCurrentSession(snapshot);
    const token = isAuthRequest ? null : snapshot.token;
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
    };

    const controller = new AbortController();
    const release = guard.trackRequest(controller, snapshot);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
        guard.assertCurrentSession(snapshot);
        const response = await fetch(`${BASE_URL}${endpoint}`, config);
        guard.assertCurrentSession(snapshot);

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
                guard.assertCurrentSession(snapshot);
                const detail = String(body.detail || body.message || '').toLowerCase();
                isRealExpired = detail.includes('not authenticated')
                    || detail.includes('invalid token')
                    || detail.includes('expired')
                    || detail.includes('could not validate');
            } catch (_) {
                guard.assertCurrentSession(snapshot);
                // 无法解析响应体时，保守处理：不清除 token，仅报错
                throw new Error('服务器响应异常，请稍后重试。');
            }

            if (isRealExpired) {
                guard.invalidateSession(snapshot);
                guard.assertCurrentSession(snapshot);
            } else {
                throw new Error('认证未通过，请重新登录。');
            }
        }

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : await response.text();
        guard.assertCurrentSession(snapshot);

        if (!response.ok) {
            const error = new Error(normalizeErrorMessage(data));
            error.status = response.status;
            throw error;
        }
        return data;
    } catch (error) {
        guard.assertCurrentSession(snapshot);
        if (error?.name === 'AbortError') {
            throw new Error('请求超时，请确认后端服务已启动并正常响应。');
        }
        throw error;
    } finally {
        release();
        clearTimeout(timeoutId);
    }
}

window.API = {
    Agent: {
        profiles: doctor => request(doctor ? '/doctor/my_patients' : '/identity/context'),
        context: id => request(`/agent/context?patient_id=${encodeURIComponent(id)}`),
        actions: id => request(`/agent/actions?patient_id=${encodeURIComponent(id)}`),
        resolve: (id,body) => request(`/agent/actions/${encodeURIComponent(id)}/resolve`,{method:'POST',body}),
        prepare: (id,mode,ids=[]) => request(`/agent/run-context?patient_id=${encodeURIComponent(id)}`+(mode?'&question_mode='+encodeURIComponent(mode):'')+ids.map(value=>'&context_run_ids='+encodeURIComponent(value)).join('')),
        observe: body => request('/agent/companion-observations',{method:'POST',body}),
        create: body => request('/agent/runs',{method:'POST',body}),
        original: id => request(`/agent/runs/submissions/${encodeURIComponent(id)}`),
        runs: id => request(`/agent/runs?patient_id=${encodeURIComponent(id)}`),
        adoption: id => request(`/agent/artifact-decisions/${encodeURIComponent(id)}/adoption-context`),
    },
    CareReports: {
        list: id => request(`/care/assessments/${encodeURIComponent(id)}/reports`, { method: 'GET' }),
        get: id => request(`/care/reports/${encodeURIComponent(id)}`, { method: 'GET' }),
    },
    CareSharedMessages: {
        relationships: patientId => request(`/care/shared-messages/relationships?patient_id=${encodeURIComponent(patientId)}`, { method: 'GET' }),
        list: (patientId, relationshipId) => request(`/care/shared-messages?patient_id=${encodeURIComponent(patientId)}&relationship_id=${encodeURIComponent(relationshipId)}`, { method: 'GET' }),
        markRead: messageId => request(`/care/shared-messages/${encodeURIComponent(messageId)}/read`, { method: 'POST' }),
    },
    Transfers: {
        list: patientId => request('/care/responsibility-transfers' + (patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ''), { method: 'GET' }),
        get: id => request(`/care/responsibility-transfers/${encodeURIComponent(id)}`, { method: 'GET' }),
        work: patientId => request('/care/transferred-work' + (patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ''), { method: 'GET' }),
        getWork: id => request(`/care/transferred-work/${encodeURIComponent(id)}`, { method: 'GET' }),
        history: id => request(`/care/transferred-work/${encodeURIComponent(id)}/history`, { method: 'GET' }),
    },
    CareWorkflow: {
        getContext: () => request('/identity/context', { method: 'GET' }),
        getPatientAttention: patientId => request(`/care/patient/attention?patient_id=${encodeURIComponent(patientId)}`, { method: 'GET' }),
        getDoctorQueue: () => request('/care/doctor/work_queue', { method: 'GET' }),
        getEvidence: submissionId => request(`/care/submissions/${encodeURIComponent(submissionId)}/evidence`, { method: 'GET' }),
        getCycles: patientId => request(`/care/cycles?patient_id=${encodeURIComponent(patientId)}`, { method: 'GET' }),
        getCycle: cycleId => request(`/care/cycles/${encodeURIComponent(cycleId)}`, { method: 'GET' }),
        getDailyHistory: (cycleId, date) => request(`/care/cycles/${encodeURIComponent(cycleId)}/daily-history?record_date=${encodeURIComponent(date)}`, { method: 'GET' }),
    },
    Assessment: {
        getTemplates: (patientId) => request(`/care/assessment-templates?patient_id=${encodeURIComponent(patientId)}`),
        list: (patientId) => request(`/care/assessments?patient_id=${encodeURIComponent(patientId)}`),
        createSelf: (data) => request('/care/patient/assessments', { method: 'POST', body: data }),
        createDoctor: (data) => request('/care/doctor/assessments', { method: 'POST', body: data }),
        get: (id) => request(`/care/assessments/${encodeURIComponent(id)}`),
        publish: (id, version) => request(`/care/assessments/${encodeURIComponent(id)}/publish`, { method: 'POST', body: { expected_version: version } }),
        createAttempt: (itemId, data) => request(`/care/assessment-items/${encodeURIComponent(itemId)}/attempts`, { method: 'POST', body: data }),
    },
    Authorization: {
        getContext: () => request('/identity/context'),
        getRelationships: () => request('/care/relationships'),
        getConsents: (patientId) => request(`/patient/consents?patient_id=${encodeURIComponent(patientId)}`),
        invite: (data) => request('/care/relationships/invitations', { method: 'POST', body: data }),
        accept: (id, revision) => request(`/care/relationships/${id}/accept`, { method: 'POST', body: { expected_revision: revision } }),
        revoke: (id, revision) => request(`/care/relationships/${id}/revoke`, { method: 'POST', body: { expected_revision: revision } }),
        grant: (data) => request('/patient/consents', { method: 'POST', body: data }),
        withdraw: (id, revision) => request(`/patient/consents/${id}/withdraw`, { method: 'POST', body: { expected_revision: revision } }),
        getGuardianQueue: () => request('/identity/guardians/review_queue'),
        guardianAction: (id, action, data) => request(`/identity/guardians/${id}/${action}`, { method: 'POST', body: data }),
    },
    Auth: {
        register: (data) => request('/auth/register', { method: 'POST', body: data }),
        login: (data) => request('/auth/login', { method: 'POST', body: data }),
        getMe: () => request('/auth/me', { method: 'GET' }),
        logout: () => request('/imaging/session', { method: 'DELETE', credentials: 'include' }, 5000),
    },

    Model: {
        getAdmission: () => request('/model/admission', { method: 'GET' }),
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
        predictModel: (formData) => request('/model/predict_fmri', { method: 'POST', body: formData }),
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
