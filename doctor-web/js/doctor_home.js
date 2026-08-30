document.addEventListener('DOMContentLoaded', async () => {
    const SELECTED_PATIENT_STORAGE_KEY = 'smartbrain_selected_patient_id';

    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const researcherName = document.getElementById('researcherName');
    const patientCount = document.getElementById('patientCount');
    const pendingImagingCount = document.getElementById('pendingImagingCount');
    const weeklyReportCount = document.getElementById('weeklyReportCount');
    const focusPatientName = document.getElementById('focusPatientName');
    const focusPatientHint = document.getElementById('focusPatientHint');
    const focusPatientMeta = document.getElementById('focusPatientMeta');
    const focusPatientReportBtn = document.getElementById('focusPatientReportBtn');
    const focusPatientVizBtn = document.getElementById('focusPatientVizBtn');
    const openBindModalBtn = document.getElementById('openBindModalBtn');
    const bindModalOverlay = document.getElementById('bindModalOverlay');
    const bindModalEmailInput = document.getElementById('bindModalEmailInput');
    const bindModalFeedback = document.getElementById('bindModalFeedback');
    const closeBindModalBtn = document.getElementById('closeBindModalBtn');
    const confirmBindPatientBtn = document.getElementById('confirmBindPatientBtn');

    if (researcherName && currentUser?.full_name) {
        researcherName.textContent = `${currentUser.full_name} · 研究人员`;
    }

    function setFeedback(message = '', type = '') {
        bindModalFeedback.textContent = message;
        bindModalFeedback.className = `bind-modal-feedback ${type}`.trim();
    }

    function resetConfirmButton() {
        if (!confirmBindPatientBtn) {
            return;
        }
        confirmBindPatientBtn.disabled = false;
        confirmBindPatientBtn.textContent = '立即添加';
    }

    function createMetaChip(text) {
        const chip = document.createElement('span');
        chip.className = 'doctor-focus-chip';
        chip.textContent = text;
        return chip;
    }

    function formatPatientType(type) {
        if (type === 'adult') return '成人';
        if (type === 'child') return '儿童';
        return '未填写';
    }

    function formatRiskLevel(level) {
        const mapping = {
            high: '高风险',
            medium: '中风险',
            low: '低风险'
        };
        return mapping[level] || '待评估';
    }

    function pickPriorityPatient(items) {
        if (!items.length) {
            return null;
        }

        const score = (item) => {
            let total = 0;
            if (!item.latest_scale_type) total += 6;
            if ((item.cognitive_test_count || 0) === 0) total += 5;
            if ((item.completed_tracking_days || 0) < 7) total += 4;
            if (!item.has_imaging) total += 3;
            if (item.latest_scale_risk_level === 'high') total += 2;
            return total;
        };

        return [...items].sort((a, b) => score(b) - score(a))[0];
    }

    function renderPriorityPatient(items) {
        if (!focusPatientName || !focusPatientHint || !focusPatientMeta || !focusPatientReportBtn || !focusPatientVizBtn) {
            return;
        }

        focusPatientMeta.innerHTML = '';
        const patient = pickPriorityPatient(items);

        if (!patient) {
            focusPatientName.textContent = '先添加患者档案，建立患者工作台';
            focusPatientHint.textContent = '当前还没有患者档案。建议先添加患者，再围绕该患者组织量表、追踪、AI摘要与影像分析。';
            focusPatientReportBtn.href = 'doctor_patients.html';
            focusPatientReportBtn.textContent = '进入患者工作台';
            let emptyBaseUrl = '';
            let authParams1 = '';
            if (window.location.protocol === 'file:') {
                emptyBaseUrl = 'http://127.0.0.1:8000/';
                authParams1 = `?_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;
            }
            focusPatientVizBtn.href = `${emptyBaseUrl}doctor_visualization.html${authParams1}`;
            focusPatientVizBtn.textContent = '查看影像可视化';
            return;
        }

        localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patient.patient_id));

        focusPatientName.textContent = `${patient.patient_name} 是当前更适合优先推进分析的患者`;
        focusPatientHint.textContent = patient.next_step_text || '建议先进入综合分析页，联动查看量表、追踪与影像证据。';
        [
            `${formatPatientType(patient.patient_type)}患者`,
            `${patient.completed_tracking_days || 0}/14 天追踪`,
            `${patient.cognitive_test_count || 0} 项认知结果`,
            `量表风险：${formatRiskLevel(patient.latest_scale_risk_level)}`,
            patient.has_imaging ? '已补充影像证据' : '待补充影像分析'
        ].forEach((text) => focusPatientMeta.appendChild(createMetaChip(text)));

        focusPatientReportBtn.href = `doctor_report.html?patient_id=${patient.patient_id}`;
        focusPatientReportBtn.textContent = '查看患者综合分析';
        let baseUrl = '';
        let authParams2 = '';
        if (window.location.protocol === 'file:') {
            baseUrl = 'http://127.0.0.1:8000/doctor-web/';
            authParams2 = `&_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;
        }
        focusPatientVizBtn.href = `${baseUrl}doctor_visualization.html?patient_id=${patient.patient_id}${authParams2}`;
        focusPatientVizBtn.textContent = '继续影像可视化';
    }

    function openModal() {
        bindModalOverlay?.classList.add('active');
        bindModalEmailInput?.focus();
    }

    function closeModal() {
        bindModalOverlay?.classList.remove('active');
        if (bindModalEmailInput) {
            bindModalEmailInput.value = '';
        }
        setFeedback('');
        resetConfirmButton();
    }

    async function loadDashboardStats() {
        try {
            const stats = await window.API.Doctor.getDashboardStats();
            if (patientCount) patientCount.textContent = String(stats.patient_count || 0);
            if (pendingImagingCount) pendingImagingCount.textContent = String(stats.pending_imaging_count || 0);
            if (weeklyReportCount) weeklyReportCount.textContent = String(stats.weekly_report_count || 0);
        } catch (error) {
            console.error('Failed to load dashboard stats:', error);
            if (patientCount) patientCount.textContent = '--';
            if (pendingImagingCount) pendingImagingCount.textContent = '--';
            if (weeklyReportCount) weeklyReportCount.textContent = '--';
        }
    }

    async function loadPriorityPatient() {
        try {
            const response = await window.API.Doctor.getMyPatients();
            renderPriorityPatient(response.items || []);
        } catch (error) {
            console.error('Failed to load patients for home focus panel:', error);
            renderPriorityPatient([]);
        }
    }

    openBindModalBtn?.addEventListener('click', openModal);
    closeBindModalBtn?.addEventListener('click', closeModal);

    bindModalOverlay?.addEventListener('click', (event) => {
        if (event.target === bindModalOverlay) {
            closeModal();
        }
    });

    bindModalEmailInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            confirmBindPatientBtn?.click();
        }
    });

    confirmBindPatientBtn?.addEventListener('click', async () => {
        const email = bindModalEmailInput?.value.trim();
        if (!email) {
            setFeedback('请输入患者注册邮箱。', 'error');
            return;
        }

        confirmBindPatientBtn.disabled = true;
        confirmBindPatientBtn.textContent = '添加中...';
        setFeedback('');

        try {
            const result = await window.API.Doctor.bindPatientByEmail({ patient_email: email });
            localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(result.patient_id));
            setFeedback(`已添加患者：${result.patient_name}，正在进入综合分析页...`, 'success');

            setTimeout(() => {
                window.location.href = `doctor_report.html?patient_id=${result.patient_id}`;
            }, 600);
        } catch (error) {
            setFeedback(error.message || '添加失败，请稍后再试。', 'error');
            resetConfirmButton();
        }
    });

    await loadDashboardStats();
    await loadPriorityPatient();
});
