document.addEventListener('DOMContentLoaded', () => {
    const SELECTED_PATIENT_STORAGE_KEY = 'smartbrain_selected_patient_id';
    const CARE_SEEN_KEY = `smartbrain_doctor_care_seen_${JSON.parse(localStorage.getItem('smartbrain_user') || 'null')?.id || 'default'}`;
    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const researcherName = document.getElementById('researcherName');
    const patientEmailInput = document.getElementById('patientEmailInput');
    const bindPatientBtn = document.getElementById('bindPatientBtn');
    const bindFeedback = document.getElementById('bindFeedback');
    const patientListCount = document.getElementById('patientListCount');
    const patientCountHero = document.getElementById('patientCountHero');
    const patientEmptyState = document.getElementById('patientEmptyState');
    const myPatientList = document.getElementById('myPatientList');

    const doctorCareTooltip = document.getElementById('doctorCareTooltip');
    const doctorCareAvatar = document.getElementById('doctorCareAvatar');
    const closeDoctorCareTooltip = document.getElementById('closeDoctorCareTooltip');
    const openDoctorCareDrawerBtn = document.getElementById('openDoctorCareDrawerBtn');
    const doctorCareOverlay = document.getElementById('doctorCareOverlay');
    const doctorCareDrawer = document.getElementById('doctorCareDrawer');
    const closeDoctorCareDrawerBtn = document.getElementById('closeDoctorCareDrawerBtn');
    const doctorCarePatientList = document.getElementById('doctorCarePatientList');
    const doctorCareTitle = document.getElementById('doctorCareTitle');
    const doctorCareHint = document.getElementById('doctorCareHint');
    const doctorCareMessageThread = document.getElementById('doctorCareMessageThread');
    const doctorCareAiLogThread = document.getElementById('doctorCareAiLogThread');
    const doctorCareEmpty = document.getElementById('doctorCareEmpty');
    const doctorCareMessageForm = document.getElementById('doctorCareMessageForm');
    const doctorCareMessageInput = document.getElementById('doctorCareMessageInput');
    const doctorCareFeedback = document.getElementById('doctorCareFeedback');
    const doctorCareSendBtn = document.getElementById('doctorCareSendBtn');
    const doctorCareTabs = Array.from(document.querySelectorAll('[data-care-tab]'));

    const state = {
        patients: [],
        securityOverviewMap: {},
        selectedPatientId: null,
        drawerOpen: false,
        activeTab: 'messages',
        careCache: {},
        readState: loadReadState()
    };

    if (researcherName && currentUser?.full_name) {
        researcherName.textContent = `${currentUser.full_name} · 研究人员`;
    }

    function loadReadState() {
        try {
            return JSON.parse(localStorage.getItem(CARE_SEEN_KEY) || '{}');
        } catch (error) {
            return {};
        }
    }

    function saveReadState() {
        localStorage.setItem(CARE_SEEN_KEY, JSON.stringify(state.readState));
    }

    function setFeedback(message = '', type = '') {
        bindFeedback.textContent = message;
        bindFeedback.className = `bind-feedback ${type}`.trim();
    }

    function setCareFeedback(message = '', type = '') {
        doctorCareFeedback.textContent = message;
        doctorCareFeedback.className = `doctor-care-feedback ${type}`.trim();
    }

    function formatPatientType(type) {
        if (type === 'adult') return '成人就诊者';
        if (type === 'child') return '儿童就诊者';
        return '未分类';
    }

    function formatRiskLevel(level) {
        const mapping = {
            high: '高风险',
            medium: '中风险',
            low: '低风险'
        };
        return mapping[level] || level || '待评估';
    }

    function formatScaleType(type) {
        return type || '未完成量表';
    }

    function formatCompletionStatus(status) {
        const mapping = {
            completed: { label: '追踪完整', className: 'success' },
            in_progress: { label: '追踪进行中', className: '' },
            building_baseline: { label: '正在建立基线', className: '' },
            not_started: { label: '追踪未开始', className: 'warning' }
        };
        return mapping[status] || { label: '待推进', className: 'warning' };
    }

    function formatTaskStatus(status) {
        const mapping = {
            pending: '待完成',
            completed: '已完成',
            dismissed: '已忽略'
        };
        return mapping[status] || status || '待完成';
    }

    function formatTaskType(type) {
        const mapping = {
            scale: '行为量表',
            cognitive: '认知测试',
            tracking: '14天追踪',
            report_review: '报告复核'
        };
        return mapping[type] || type || '研究任务';
    }

    function getSecurityOverview(patientId) {
        return state.securityOverviewMap[String(patientId)] || null;
    }

    function formatSecurityStage(overview) {
        if (!overview) {
            return { label: '安全信息加载中', className: '' };
        }
        const mapping = {
            '未纳入安全链路': { label: '未纳入安全链路', className: 'warning' },
            '已分配待生成密文': { label: '已分配待生成密文', className: '' },
            '已纳入安全链路': { label: '已纳入安全链路', className: 'success' },
            '已完成时间审计': { label: '已完成时间审计', className: 'success' },
            '时间审计未通过': { label: '时间审计未通过', className: 'danger' }
        };
        return mapping[overview.security_stage] || { label: overview.security_stage || '安全状态未知', className: '' };
    }

    function formatAuditSecurityStatus(overview) {
        if (!overview || !overview.latest_temporal_audit_id) {
            return '尚未执行时间审计';
        }
        if (overview.latest_temporal_audit_passed === true) {
            return '最近时间审计通过';
        }
        if (overview.latest_temporal_audit_passed === false) {
            return '最近时间审计未通过';
        }
        return overview.latest_temporal_audit_status || '时间审计进行中';
    }

    function formatTimeDivider(timestamp) {
        const date = new Date(timestamp);
        return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function createInlineTaskRow(task) {
        const row = document.createElement('div');
        row.className = 'inline-mini-row';
        row.innerHTML = `
            <strong>${task.task_title}</strong><br>
            ${task.task_description || '已为就诊者安排下一步任务。'}<br>
            <span style="color:#64748B;">${formatTaskType(task.task_type)} · ${formatTaskStatus(task.status)}</span>
        `;
        return row;
    }

    function renderTaskBlock(patientId, tasks = []) {
        const list = document.getElementById(`taskList-${patientId}`);
        const empty = document.getElementById(`taskEmpty-${patientId}`);
        if (!list || !empty) return;

        list.innerHTML = '';
        if (!tasks.length) {
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        tasks.slice(0, 3).forEach((task) => list.appendChild(createInlineTaskRow(task)));
    }

    async function refreshPatientTaskBlock(patientId) {
        try {
            const tasks = await window.API.Care.getPatientTasksForDoctor(patientId);
            renderTaskBlock(patientId, tasks.items || []);
        } catch (error) {
            renderTaskBlock(patientId, []);
        }
    }

    function buildPatientRow(item) {
        const trackingStatus = formatCompletionStatus(item.completion_status);
        const securityOverview = getSecurityOverview(item.patient_id);
        const securityStage = formatSecurityStage(securityOverview);
        const cipherText = securityOverview
            ? (securityOverview.has_cipher_records ? `已生成 ${securityOverview.cipher_record_count} 条` : '暂未生成')
            : '加载中';
        const assignedDac = securityOverview?.assigned_dac_name || '--';
        const assignedMcs = securityOverview?.assigned_mcs_node_code || '--';
        const latestAudit = formatAuditSecurityStatus(securityOverview);

        const row = document.createElement('article');
        row.className = 'patient-workspace-row';
        row.id = `patient-row-${item.patient_id}`;

        row.innerHTML = `
            <section class="patient-row-main">
                <div class="patient-card-top">
                    <div>
                        <h4>${item.patient_name}</h4>
                        <div class="patient-card-sub">${item.patient_email}</div>
                    </div>
                    <span class="patient-status-pill ${trackingStatus.className}">${trackingStatus.label}</span>
                </div>

                <div class="patient-tags">
                    <span class="tag">${formatPatientType(item.patient_type)}</span>
                    <span class="tag">${formatScaleType(item.latest_scale_type)}</span>
                    <span class="tag">${formatRiskLevel(item.latest_scale_risk_level)}</span>
                    <span class="tag security ${securityStage.className}">${securityStage.label}</span>
                </div>

                <div class="patient-stat-grid">
                    <div class="patient-stat">
                        <span class="patient-stat-label">14天追踪</span>
                        <span class="patient-stat-value">${item.completed_tracking_days}/14 天 · 当前第 ${item.current_tracking_day} 天</span>
                    </div>
                    <div class="patient-stat">
                        <span class="patient-stat-label">认知测试</span>
                        <span class="patient-stat-value">${item.cognitive_test_count} 项${item.cognitive_test_count ? '已补充' : '待补充'}</span>
                    </div>
                    <div class="patient-stat">
                        <span class="patient-stat-label">量表结果</span>
                        <span class="patient-stat-value">${formatRiskLevel(item.latest_scale_risk_level)} · 总分 ${item.latest_scale_total_score ?? '--'}</span>
                    </div>
                    <div class="patient-stat">
                        <span class="patient-stat-label">影像状态</span>
                        <span class="patient-stat-value">${item.has_imaging ? '已有关联影像' : '待进入影像处理'}</span>
                    </div>
                </div>

                <div class="patient-focus-box">
                    <span class="patient-focus-label">当前最值得推进的下一步</span>
                    <div class="patient-focus-text">${item.next_step_text || '建议进入综合分析页，串联查看量表、追踪、认知与影像。'}</div>
                </div>

                <div class="patient-security-box">
                    <div class="patient-security-head">
                        <div>
                            <strong>安全状态</strong>
                            <div class="patient-security-sub">展示该患者是否已经纳入安全链路，以及最近一次时间审计状态。</div>
                        </div>
                        <span class="patient-security-pill ${securityStage.className}">${securityStage.label}</span>
                    </div>
                    <div class="patient-security-grid">
                        <div class="patient-security-item">
                            <span>已分配 DAC</span>
                            <strong>${assignedDac}</strong>
                        </div>
                        <div class="patient-security-item">
                            <span>已分配 MCS</span>
                            <strong>${assignedMcs}</strong>
                        </div>
                        <div class="patient-security-item">
                            <span>密文记录</span>
                            <strong>${cipherText}</strong>
                        </div>
                        <div class="patient-security-item">
                            <span>最近时间审计</span>
                            <strong>${latestAudit}</strong>
                        </div>
                    </div>
                </div>

                <div class="patient-action-row">
                    <button class="view-report-btn" data-patient-id="${item.patient_id}" type="button">查看综合分析</button>
                    <button class="view-visualization-btn" data-patient-id="${item.patient_id}" type="button">进入影像可视化</button>
                </div>
            </section>

            <aside class="patient-row-side">
                <section class="workspace-side-card">
                    <h5>研究人员推送任务</h5>
                    <p>直接在就诊者工作台安排下一步量表、认知测试、追踪或报告复核任务。</p>
                    <div id="taskList-${item.patient_id}" class="inline-mini-list"></div>
                    <div id="taskEmpty-${item.patient_id}" class="inline-empty">暂未向这位就诊者推送任务。</div>
                    <form class="inline-task-form" data-patient-id="${item.patient_id}">
                        <select name="taskType">
                            <option value="scale">行为量表</option>
                            <option value="cognitive">认知测试</option>
                            <option value="tracking">14天追踪</option>
                            <option value="report_review">报告复核</option>
                        </select>
                        <input name="taskTitle" type="text" placeholder="例如：补做 Stroop 认知测试">
                        <textarea name="taskDescription" placeholder="告诉就诊者为什么推荐这个任务，以及建议什么时候完成。"></textarea>
                        <div id="taskFeedback-${item.patient_id}" class="inline-feedback"></div>
                        <div class="inline-task-actions">
                            <button class="inline-task-btn" type="submit">推送任务</button>
                        </div>
                    </form>
                </section>
            </aside>
        `;

        return row;
    }

    function highlightSelectedPatient() {
        const params = new URLSearchParams(window.location.search);
        const targetId = params.get('focus_patient_id') || localStorage.getItem(SELECTED_PATIENT_STORAGE_KEY);
        if (!targetId) return;

        const row = document.getElementById(`patient-row-${targetId}`);
        const card = row?.querySelector('.patient-row-main');
        if (!row || !card) return;

        card.classList.add('active-focus');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function attachPatientActions() {
        myPatientList.querySelectorAll('.view-report-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const patientId = button.dataset.patientId;
                localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
                window.location.href = `doctor_report.html?patient_id=${patientId}`;
            });
        });

        myPatientList.querySelectorAll('.view-visualization-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const patientId = button.dataset.patientId;
                localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
                let baseUrl = '';
                let authParams = '';
                if (window.location.protocol === 'file:') {
                    baseUrl = 'http://127.0.0.1:8000/';
                    authParams = `&_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;
                }
                window.location.href = `${baseUrl}doctor_visualization.html?patient_id=${patientId}${authParams}`;
            });
        });

        myPatientList.querySelectorAll('.inline-task-form').forEach((form) => {
            form.addEventListener('submit', async (event) => {
                event.preventDefault();

                const patientId = form.dataset.patientId;
                const formData = new FormData(form);
                const taskType = String(formData.get('taskType') || 'scale');
                const taskTitle = String(formData.get('taskTitle') || '').trim();
                const taskDescription = String(formData.get('taskDescription') || '').trim();
                const feedback = document.getElementById(`taskFeedback-${patientId}`);
                const submitBtn = form.querySelector('.inline-task-btn');

                if (!taskTitle) {
                    if (feedback) {
                        feedback.textContent = '请填写任务标题。';
                        feedback.className = 'inline-feedback error';
                    }
                    return;
                }

                submitBtn.disabled = true;
                if (feedback) {
                    feedback.textContent = '正在推送任务...';
                    feedback.className = 'inline-feedback';
                }

                const targetPageMap = {
                    scale: 'patient_scale.html',
                    cognitive: 'patient_test.html',
                    tracking: 'patient_tracking.html',
                    report_review: 'patient_report.html'
                };

                try {
                    await window.API.Care.createPatientTask(patientId, {
                        task_type: taskType,
                        task_title: taskTitle,
                        task_description: taskDescription,
                        target_page: targetPageMap[taskType] || 'patient_home.html'
                    });

                    form.reset();
                    if (feedback) {
                        feedback.textContent = '任务已推送给就诊者。';
                        feedback.className = 'inline-feedback success';
                    }
                    await refreshPatientTaskBlock(patientId);
                } catch (error) {
                    if (feedback) {
                        feedback.textContent = error.message || '任务推送失败，请稍后重试。';
                        feedback.className = 'inline-feedback error';
                    }
                } finally {
                    submitBtn.disabled = false;
                }
            });
        });
    }

    function getCareRecord(patientId) {
        if (!state.careCache[patientId]) {
            state.careCache[patientId] = { messages: [], aiLogs: [] };
        }
        return state.careCache[patientId];
    }

    function getUnreadInfo(patientId) {
        const record = getCareRecord(patientId);
        const seen = state.readState[patientId] || {};
        const unreadMessages = (record.messages || []).filter((item) => {
            return item.sender_role !== 'researcher' && (!seen.messages || new Date(item.created_at).getTime() > new Date(seen.messages).getTime());
        }).length;
        const unreadAiLogs = (record.aiLogs || []).filter((item) => {
            return item.role !== 'assistant' && (!seen.logs || new Date(item.created_at).getTime() > new Date(seen.logs).getTime());
        }).length;
        return { unreadMessages, unreadAiLogs };
    }

    function buildUnreadBadges(patientId) {
        const { unreadMessages, unreadAiLogs } = getUnreadInfo(patientId);
        const wrapper = document.createElement('div');
        wrapper.className = 'doctor-care-patient-badges';

        if (unreadMessages > 0) {
            const badge = document.createElement('span');
            badge.className = 'doctor-care-badge unread';
            badge.textContent = `新通知 ${unreadMessages}`;
            wrapper.appendChild(badge);
        }

        if (unreadAiLogs > 0) {
            const badge = document.createElement('span');
            badge.className = 'doctor-care-badge ai';
            badge.textContent = `新AI记录 ${unreadAiLogs}`;
            wrapper.appendChild(badge);
        }

        return wrapper.childElementCount ? wrapper : null;
    }

    function createCarePatientButton(patient, active = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `doctor-care-patient-btn${active ? ' active' : ''}`;
        button.dataset.patientId = String(patient.patient_id);

        const meta = document.createElement('div');
        meta.className = 'doctor-care-patient-meta';
        meta.innerHTML = `
            <strong>${patient.patient_name}</strong>
            <span>${patient.patient_email}</span>
            <span>${formatPatientType(patient.patient_type)} · ${formatRiskLevel(patient.latest_scale_risk_level)}</span>
        `;
        button.appendChild(meta);

        const badges = buildUnreadBadges(patient.patient_id);
        if (badges) {
            button.appendChild(badges);
        }

        return button;
    }

    function renderCarePatientList() {
        doctorCarePatientList.innerHTML = '';

        if (!state.patients.length) {
            doctorCarePatientList.innerHTML = '<div class="doctor-care-empty">当前还没有纳入工作台的就诊者。</div>';
            return;
        }

        state.patients.forEach((patient) => {
            const button = createCarePatientButton(patient, String(patient.patient_id) === String(state.selectedPatientId));
            button.addEventListener('click', () => {
                selectCarePatient(patient.patient_id);
            });
            doctorCarePatientList.appendChild(button);
        });
    }

    function createTimeDivider(timestamp) {
        const divider = document.createElement('div');
        divider.className = 'doctor-care-time-divider';
        divider.textContent = formatTimeDivider(timestamp);
        return divider;
    }

    function createBubbleRow(side, roleText, content) {
        const row = document.createElement('div');
        row.className = `doctor-care-bubble-row ${side}`;
        row.innerHTML = `
            <div class="doctor-care-bubble">
                <div class="doctor-care-bubble-role">${roleText}</div>
                <div>${content}</div>
            </div>
        `;
        return row;
    }

    function renderCareMessages(messages = []) {
        doctorCareMessageThread.innerHTML = '';

        if (!messages.length) {
            doctorCareMessageThread.innerHTML = '<div class="doctor-care-empty">这位就诊者暂时还没有通知记录。你可以直接在这里给他发送一条通知。</div>';
            return;
        }

        messages.forEach((item) => {
            const side = item.sender_role === 'researcher' ? 'researcher' : 'participant';
            doctorCareMessageThread.appendChild(createTimeDivider(item.created_at));
            doctorCareMessageThread.appendChild(
                createBubbleRow(side, item.sender_role === 'researcher' ? '医生' : '就诊者', item.content)
            );
        });
    }

    function renderCareAiLogs(logs = []) {
        doctorCareAiLogThread.innerHTML = '';

        if (!logs.length) {
            doctorCareAiLogThread.innerHTML = '<div class="doctor-care-empty">这位就诊者最近还没有和 AI 助手的互动记录。</div>';
            return;
        }

        logs.slice().reverse().forEach((item) => {
            const side = item.role === 'assistant' ? 'assistant' : 'user';
            doctorCareAiLogThread.appendChild(createTimeDivider(item.created_at));
            doctorCareAiLogThread.appendChild(
                createBubbleRow(side, item.role === 'assistant' ? 'AI助手' : '就诊者', item.content)
            );
        });
    }

    function getSelectedPatient() {
        return state.patients.find((item) => String(item.patient_id) === String(state.selectedPatientId)) || null;
    }

    function markCurrentTabAsRead() {
        const patient = getSelectedPatient();
        if (!patient) return;

        const patientId = String(patient.patient_id);
        const record = getCareRecord(patientId);
        state.readState[patientId] = state.readState[patientId] || {};

        if (state.activeTab === 'messages') {
            const latestParticipantMessage = [...(record.messages || [])]
                .filter((item) => item.sender_role !== 'researcher')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            if (latestParticipantMessage) {
                state.readState[patientId].messages = latestParticipantMessage.created_at;
            }
        } else {
            const latestParticipantAi = [...(record.aiLogs || [])]
                .filter((item) => item.role !== 'assistant')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            if (latestParticipantAi) {
                state.readState[patientId].logs = latestParticipantAi.created_at;
            }
        }

        saveReadState();
        renderCarePatientList();
    }

    function applyCareTab(tab, markRead = true) {
        state.activeTab = tab;
        doctorCareTabs.forEach((button) => {
            button.classList.toggle('active', button.dataset.careTab === tab);
        });

        const showingMessages = tab === 'messages';
        doctorCareMessageThread.classList.toggle('hidden', !showingMessages);
        doctorCareAiLogThread.classList.toggle('hidden', showingMessages);
        doctorCareMessageForm.classList.toggle('hidden', !showingMessages);

        if (markRead) {
            markCurrentTabAsRead();
        }
    }

    async function loadCareRecords(patientId) {
        const record = getCareRecord(patientId);
        const [messages, aiLogs] = await Promise.all([
            window.API.Care.getDoctorMessages(patientId),
            window.API.Care.getDoctorAiLogs(patientId)
        ]);
        record.messages = messages.items || [];
        record.aiLogs = aiLogs.items || [];
        return record;
    }

    async function prefetchCareSummaries() {
        await Promise.allSettled(
            state.patients.map(async (patient) => {
                try {
                    await loadCareRecords(String(patient.patient_id));
                } catch (error) {
                    state.careCache[String(patient.patient_id)] = { messages: [], aiLogs: [] };
                }
            })
        );
        renderCarePatientList();
    }

    async function refreshCareDrawerContent() {
        const patient = getSelectedPatient();
        if (!patient) {
            doctorCareTitle.textContent = '就诊者沟通模块';
            doctorCareHint.textContent = '请选择一位当前研究人员正在管理的就诊者。';
            doctorCareMessageThread.innerHTML = '';
            doctorCareAiLogThread.innerHTML = '';
            doctorCareEmpty.classList.remove('hidden');
            doctorCareMessageForm.classList.add('hidden');
            renderCarePatientList();
            return;
        }

        doctorCareTitle.textContent = `${patient.patient_name} 的沟通记录`;
        doctorCareHint.textContent = `${patient.patient_email} · ${formatPatientType(patient.patient_type)}。你可以切换查看通知记录或这位就诊者与 AI 助手的互动内容。`;
        doctorCareEmpty.classList.add('hidden');

        try {
            const record = await loadCareRecords(String(patient.patient_id));
            renderCareMessages(record.messages);
            renderCareAiLogs(record.aiLogs);
        } catch (error) {
            const fallback = '<div class="doctor-care-empty">当前内容加载失败，请稍后重试。</div>';
            doctorCareMessageThread.innerHTML = fallback;
            doctorCareAiLogThread.innerHTML = fallback;
        }

        applyCareTab(state.activeTab, true);
        renderCarePatientList();
    }

    function selectCarePatient(patientId) {
        state.selectedPatientId = String(patientId);
        localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
        refreshCareDrawerContent();
    }

    async function openCareDrawer() {
        if (state.drawerOpen) return;
        state.drawerOpen = true;
        doctorCareOverlay.classList.remove('hidden');
        document.body.classList.add('ai-drawer-open');
        requestAnimationFrame(() => {
            doctorCareDrawer.classList.add('open');
            doctorCareDrawer.setAttribute('aria-hidden', 'false');
        });

        if (!state.selectedPatientId && state.patients.length) {
            const stored = localStorage.getItem(SELECTED_PATIENT_STORAGE_KEY);
            const targetId = stored && state.patients.some((item) => String(item.patient_id) === stored)
                ? stored
                : state.patients[0].patient_id;
            state.selectedPatientId = String(targetId);
        }

        renderCarePatientList();
        await prefetchCareSummaries();
        await refreshCareDrawerContent();
    }

    function closeCareDrawer() {
        if (!state.drawerOpen) return;
        state.drawerOpen = false;
        doctorCareDrawer.classList.remove('open');
        doctorCareDrawer.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('ai-drawer-open');
        setTimeout(() => {
            if (!state.drawerOpen) {
                doctorCareOverlay.classList.add('hidden');
            }
        }, 280);
    }

    async function loadSecurityOverviewMap(items) {
        const entries = await Promise.allSettled(
            (items || []).map(async (item) => {
                const overview = await window.API.Security.getPatientOverview(item.patient_id);
                return [String(item.patient_id), overview];
            })
        );

        state.securityOverviewMap = {};
        entries.forEach((entry) => {
            if (entry.status === 'fulfilled') {
                const [patientId, overview] = entry.value;
                state.securityOverviewMap[patientId] = overview;
            }
        });
    }

    async function renderPatientList(response) {
        const items = response?.items || [];
        state.patients = items;
        patientListCount.textContent = `当前 ${items.length} 人`;
        patientCountHero.textContent = String(items.length);
        myPatientList.innerHTML = '';

        if (!items.length) {
            patientEmptyState.style.display = 'block';
            renderCarePatientList();
            return;
        }

        patientEmptyState.style.display = 'none';

        await loadSecurityOverviewMap(items);

        items.forEach((item) => {
            myPatientList.appendChild(buildPatientRow(item));
        });

        attachPatientActions();
        highlightSelectedPatient();
        renderCarePatientList();

        await Promise.allSettled(items.map((item) => refreshPatientTaskBlock(item.patient_id)));
    }

    async function loadPatients() {
        try {
            const response = await window.API.Doctor.getMyPatients();
            await renderPatientList(response);
        } catch (error) {
            setFeedback(error.message || '加载就诊者工作台失败，请刷新后重试。', 'error');
        }
    }

    bindPatientBtn?.addEventListener('click', async () => {
        const email = patientEmailInput.value.trim();
        if (!email) {
            setFeedback('请输入就诊者注册邮箱。', 'error');
            return;
        }

        bindPatientBtn.disabled = true;
        bindPatientBtn.textContent = '添加中...';
        setFeedback('', '');

        try {
            const result = await window.API.Doctor.bindPatientByEmail({ patient_email: email });
            localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(result.patient_id));
            setFeedback(`已将 ${result.patient_name} 纳入就诊者工作台。`, 'success');
            patientEmailInput.value = '';
            await loadPatients();
        } catch (error) {
            setFeedback(error.message || '添加就诊者失败，请稍后重试。', 'error');
        } finally {
            bindPatientBtn.disabled = false;
            bindPatientBtn.textContent = '添加就诊者档案';
        }
    });

    doctorCareTabs.forEach((button) => {
        button.addEventListener('click', () => {
            applyCareTab(button.dataset.careTab, true);
        });
    });

    doctorCareMessageForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const patient = getSelectedPatient();
        const content = doctorCareMessageInput.value.trim();

        if (!patient) {
            setCareFeedback('请先选择一位就诊者。', 'error');
            return;
        }

        if (!content) {
            setCareFeedback('请输入要发送的通知内容。', 'error');
            return;
        }

        doctorCareSendBtn.disabled = true;
        setCareFeedback('正在发送通知...', '');

        try {
            await window.API.Care.sendDoctorMessage(patient.patient_id, { content });
            doctorCareMessageInput.value = '';
            setCareFeedback('通知已发送给就诊者。', 'success');
            await refreshCareDrawerContent();
        } catch (error) {
            setCareFeedback(error.message || '通知发送失败，请稍后重试。', 'error');
        } finally {
            doctorCareSendBtn.disabled = false;
        }
    });

    closeDoctorCareTooltip?.addEventListener('click', (event) => {
        event.stopPropagation();
        doctorCareTooltip.classList.add('hidden');
    });

    doctorCareAvatar?.addEventListener('click', openCareDrawer);
    openDoctorCareDrawerBtn?.addEventListener('click', openCareDrawer);
    doctorCareOverlay?.addEventListener('click', closeCareDrawer);
    closeDoctorCareDrawerBtn?.addEventListener('click', closeCareDrawer);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.drawerOpen) {
            closeCareDrawer();
        }
    });

    loadPatients();
});
