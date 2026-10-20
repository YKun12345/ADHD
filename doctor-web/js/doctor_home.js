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

    const hasScope = (item, scope) => !Array.isArray(item.allowed_scope) || item.allowed_scope.includes(scope);
    const subjectName = item => item.patient_name || `共享档案 #${item.patient_id}`;

    function pickPriorityPatient(items) {
        if (!items.length) {
            return null;
        }

        const score = (item) => {
            let total = 0;
            if (hasScope(item, 'assessment') && !item.latest_scale_type) total += 6;
            if (hasScope(item, 'assessment') && (item.cognitive_test_count || 0) === 0) total += 5;
            if (hasScope(item, 'tracking') && (item.completed_tracking_days || 0) < 7) total += 4;
            if (hasScope(item, 'imaging') && !item.has_imaging) total += 3;
            if (hasScope(item, 'assessment') && item.latest_scale_risk_level === 'high') total += 2;
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
            if (window.location.protocol === 'file:') {
                emptyBaseUrl = 'http://127.0.0.1:8000/doctor-web/';
            }
            focusPatientVizBtn.href = `${emptyBaseUrl}doctor_visualization.html`;
            focusPatientVizBtn.textContent = '查看影像可视化';
            return;
        }

        focusPatientName.textContent = `${subjectName(patient)} 是当前更适合优先推进的档案`;
        focusPatientHint.textContent = patient.next_step_text || '按已确认的共享范围查看资料或处理随访。';
        [
            hasScope(patient, 'profile') ? `${formatPatientType(patient.patient_type)}患者` : '基础资料未共享',
            hasScope(patient, 'tracking') ? `${patient.completed_tracking_days || 0}/14 天追踪` : '跟踪未共享',
            hasScope(patient, 'assessment') ? `${patient.cognitive_test_count || 0} 项认知结果` : '认知评估未共享',
            hasScope(patient, 'assessment') ? `量表风险：${formatRiskLevel(patient.latest_scale_risk_level)}` : '评估未共享',
            hasScope(patient, 'imaging') ? (patient.has_imaging ? '已补充影像证据' : '待补充影像分析') : '影像未共享'
        ].forEach((text) => focusPatientMeta.appendChild(createMetaChip(text)));

        const reportShared = ['profile', 'assessment', 'tracking', 'imaging'].some(scope => hasScope(patient, scope));
        focusPatientReportBtn.href = reportShared ? `doctor_report.html?patient_id=${patient.patient_id}` : `doctor_patients.html?focus_patient_id=${patient.patient_id}&care=1`;
        focusPatientReportBtn.textContent = reportShared ? '查看已共享报告' : '处理已共享随访';
        let baseUrl = '';
        if (window.location.protocol === 'file:') {
            baseUrl = 'http://127.0.0.1:8000/doctor-web/';
        }
        focusPatientVizBtn.href = hasScope(patient, 'imaging') ? `${baseUrl}doctor_visualization.html?patient_id=${patient.patient_id}` : `doctor_patients.html?focus_patient_id=${patient.patient_id}`;
        focusPatientVizBtn.textContent = hasScope(patient, 'imaging') ? '继续影像可视化' : '影像未共享';
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
            if (pendingImagingCount) pendingImagingCount.textContent = stats.pending_imaging_count === null ? '未共享' : String(stats.pending_imaging_count || 0);
            if (weeklyReportCount) weeklyReportCount.textContent = stats.weekly_report_count === null ? '未共享' : String(stats.weekly_report_count || 0);
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

    function openDacAudit() {
        const user = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
        if (user?.subrole === 'dac') {
            window.location.href = 'dac_dashboard.html';
            return;
        }
        const modal = document.getElementById('dacPermissionModal');
        if (modal) {
            modal.classList.add('active');
        }
    }
    window.openDacAudit = openDacAudit;

    const dacPermissionModal = document.getElementById('dacPermissionModal');
    const closeDacPermissionBtn = document.getElementById('closeDacPermissionBtn');

    closeDacPermissionBtn?.addEventListener('click', () => {
        dacPermissionModal?.classList.remove('active');
    });

    dacPermissionModal?.addEventListener('click', (event) => {
        if (event.target === dacPermissionModal) {
            dacPermissionModal.classList.remove('active');
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
            await window.API.Authorization.invite({ target_email: email,
                scope: ['profile', 'assessment', 'tracking', 'care', 'imaging'], purpose: 'clinical_sharing',
                expires_at: new Date(Date.now() + 90 * 86400000).toISOString() });
            setFeedback('邀请已发出，等待对方确认。', 'success');
            resetConfirmButton();
            await loadDashboardStats();
            await loadPriorityPatient();
        } catch (error) {
            setFeedback(error.message || '添加失败，请稍后再试。', 'error');
            resetConfirmButton();
        }
    });

    await loadDashboardStats();
    await loadPriorityPatient();
});
