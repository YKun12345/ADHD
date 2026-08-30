document.addEventListener('DOMContentLoaded', async () => {
    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if (!currentUser || currentUser.role !== 'researcher' || currentUser.subrole !== 'dac') {
        window.location.href = 'login.html';
        return;
    }

    const el = {
        dacName: document.getElementById('dacName'),
        systemStatusBadge: document.getElementById('systemStatusBadge'),
        systemStatusText: document.getElementById('systemStatusText'),
        keyCountValue: document.getElementById('keyCountValue'),
        mcsNodeCountValue: document.getElementById('mcsNodeCountValue'),
        routingCountValue: document.getElementById('routingCountValue'),
        cipherCountValue: document.getElementById('cipherCountValue'),
        auditCountValue: document.getElementById('auditCountValue'),
        patientCountValue: document.getElementById('patientCountValue'),
        auditPatientSelect: document.getElementById('auditPatientSelect'),
        auditSourceTypeSelect: document.getElementById('auditSourceTypeSelect'),
        auditResultBox: document.getElementById('auditResultBox'),
        cipherRecordStatusBox: document.getElementById('cipherRecordStatusBox'),
        cipherRecordTableBody: document.getElementById('cipherRecordTableBody'),
        spatialSourceTypeSelect: document.getElementById('spatialSourceTypeSelect'),
        spatialPatientHint: document.getElementById('spatialPatientHint'),
        spatialPatientList: document.getElementById('spatialPatientList'),
        spatialAuditResultBox: document.getElementById('spatialAuditResultBox'),
        keyAssignmentTableBody: document.getElementById('keyAssignmentTableBody'),
        mcsNodeTableBody: document.getElementById('mcsNodeTableBody'),
        patientAssignmentTableBody: document.getElementById('patientAssignmentTableBody'),
        recentAuditList: document.getElementById('recentAuditList'),
        recentLogList: document.getElementById('recentLogList'),
        initSecurityBtn: document.getElementById('initSecurityBtn'),
        refreshDacBtn: document.getElementById('refreshDacBtn'),
        runAuditBtn: document.getElementById('runAuditBtn'),
        loadCipherBtn: document.getElementById('loadCipherBtn'),
        runSpatialAuditBtn: document.getElementById('runSpatialAuditBtn'),
    };

    const actionLabels = {
        system_init: '系统初始化',
        key_provision: '密钥分发',
        patient_route_assigned: '患者分配链建立',
        temporal_audit_requested: '发起时间审计',
        temporal_audit_completed: '完成时间审计',
        spatial_audit_requested: '发起空间审计',
        spatial_audit_completed: '完成空间审计',
    };

    const statusLabels = {
        success: '成功',
        failed: '失败',
        completed: '已完成',
        created: '已创建',
        aggregating: '聚合中',
        verifying: '校验中',
        active: '活跃',
    };

    const sourceLabels = {
        tracking: '14天追踪',
        scale: '量表',
        cognitive: '认知测试',
    };

    const metricLabels = {
        mood_value: '情绪评分',
        focus_minutes: '专注时长（分钟）',
        test_score_scaled: '追踪测验得分',
        total_score: '量表总分',
        risk_score: '风险指数',
        attention_control: '注意控制指数',
        hyperactivity: '多动冲动指数',
        performance_score: '综合表现指数',
        accuracy_score: '任务准确率指数',
        latency_score: '反应时指标',
    };

    let patientItems = [];

    function sourceLabel(value) {
        return sourceLabels[value] || value || '--';
    }

    function statusLabel(value) {
        return statusLabels[value] || value || '--';
    }

    function actionLabel(value) {
        return actionLabels[value] || value || '--';
    }

    function metricLabel(value) {
        return metricLabels[value] || value;
    }

    function percent(value, maxValue) {
        if (!maxValue || maxValue <= 0) return 0;
        return Math.max(6, Math.min(100, (Number(value || 0) / maxValue) * 100));
    }

    function patientNameById(patientId) {
        const match = patientItems.find((item) => Number(item.patient_id) === Number(patientId));
        return match ? `${match.patient_name}（#${match.patient_id}）` : `患者 #${patientId}`;
    }

    function setButtonLoading(button, text) {
        if (!button) return;
        button.dataset.originalText = button.dataset.originalText || button.textContent;
        button.disabled = true;
        button.textContent = text;
    }

    function restoreButton(button) {
        if (!button) return;
        button.disabled = false;
        button.textContent = button.dataset.originalText || button.textContent;
    }

    function hasSourceData(patient, sourceType) {
        if (sourceType === 'tracking') return Number(patient.completed_tracking_days || 0) > 0;
        if (sourceType === 'scale') return Boolean(patient.latest_scale_type);
        if (sourceType === 'cognitive') return Number(patient.cognitive_test_count || 0) > 0;
        return false;
    }

    function patientSourceHint(patient, sourceType) {
        if (hasSourceData(patient, sourceType)) return '可参与聚合';
        if (sourceType === 'tracking') return '缺少追踪记录';
        if (sourceType === 'scale') return '缺少量表结果';
        if (sourceType === 'cognitive') return '缺少认知测试结果';
        return '暂无数据';
    }

    function setResultBox(target, html) {
        target.innerHTML = html;
    }

    function buildStatsGrid(stats = {}) {
        const items = Object.entries(stats);
        if (!items.length) {
            return '<div class="result-note">当前没有可展示的统计指标。</div>';
        }

        return items.map(([key, value]) => {
            const maxMetricValue = Math.max(
                Number(value.sum || 0),
                Number(value.average || 0),
                Number(value.variance || 0),
                1
            );

            return `
                <div class="result-stat">
                    <label>${metricLabel(key)}</label>
                    <strong>群体均值 ${value.average}</strong>
                    <div class="result-stat-meta">
                        <span>聚合总和 ${value.sum}</span>
                        <span>波动方差 ${value.variance}</span>
                    </div>
                    <div class="result-mini-chart">
                        <div class="result-mini-row">
                            <span>总和</span>
                            <div class="result-mini-track"><div class="result-mini-fill sum" style="width:${percent(value.sum, maxMetricValue)}%"></div></div>
                        </div>
                        <div class="result-mini-row">
                            <span>均值</span>
                            <div class="result-mini-track"><div class="result-mini-fill avg" style="width:${percent(value.average, maxMetricValue)}%"></div></div>
                        </div>
                        <div class="result-mini-row">
                            <span>方差</span>
                            <div class="result-mini-track"><div class="result-mini-fill var" style="width:${percent(value.variance, maxMetricValue)}%"></div></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function buildVerificationSummaryList(result) {
        const details = result.verification_details || {};
        const items = [
            `本地 MCS 节点：${result.mcs_node_id || details.mcs_node_id || '--'}`,
            `参与记录总数：${details.record_count ?? result.decrypted_stats?.record_count ?? 0}`,
            `完整性校验：${details.integrity_verified ? '通过' : '未通过'}`,
            `聚合一致性校验：${details.aggregate_verified ? '通过' : '未通过'}`,
            `密文校验通过记录：${Array.isArray(details.verified_record_ids) ? details.verified_record_ids.length : 0} 条`,
            `异常问题数：${Array.isArray(details.issues) ? details.issues.length : 0} 项`,
        ];

        if (Array.isArray(details.issues) && details.issues.length) {
            details.issues.forEach((issue) => items.push(`异常：${issue}`));
        }

        return `<ul class="result-summary-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
    }

    function buildPatientPanels(result) {
        const taskType = result.task_type;
        if (taskType !== 'spatial') {
            return '';
        }

        const stats = result.decrypted_stats || {};
        const aggregatedIds = stats.aggregated_patient_ids || [];
        const missingIds = stats.missing_patient_ids || result.verification_details?.missing_patient_ids || [];

        const aggregatedList = aggregatedIds.length
            ? aggregatedIds.map((id) => `<span class="result-person-tag">${patientNameById(id)}</span>`).join('')
            : '<span class="result-person-tag">暂无可参与聚合的患者</span>';
        const missingList = missingIds.length
            ? missingIds.map((id) => `<span class="result-person-tag missing">${patientNameById(id)}</span>`).join('')
            : '<span class="result-person-tag">当前无缺失患者</span>';

        return `
            <div class="result-person-grid">
                <div class="result-person-panel">
                    <strong>参与患者名单</strong>
                    <div class="result-person-tags">${aggregatedList}</div>
                </div>
                <div class="result-person-panel">
                    <strong>缺失患者名单</strong>
                    <div class="result-person-tags">${missingList}</div>
                </div>
            </div>
        `;
    }

    function buildAuditCard(result, modeLabel) {
        const stats = result.decrypted_stats?.stats || {};
        const missingPatients = result.decrypted_stats?.missing_patient_ids || result.verification_details?.missing_patient_ids || [];
        const missingText = missingPatients.length
            ? `当前数据类型下缺少有效记录的患者ID：${missingPatients.join('、')}`
            : '当前参与对象都具备可用密文记录。';

        return `
            <div class="result-card ${result.verification_passed ? 'success' : 'fail'}">
                <div class="result-status-strip"><div class="fill"></div></div>
                <div class="result-head">
                    <div>
                        <h3>${modeLabel}</h3>
                        <p>聚合类型：${sourceLabel(result.source_type)} · 本地 MCS 节点：${result.mcs_node_id || result.decrypted_stats?.mcs_node_id || '--'}</p>
                    </div>
                    <span class="dac-badge${result.verification_passed ? '' : ' fail'}">${result.verification_passed ? '校验通过' : '校验失败'}</span>
                </div>
                <div class="result-kv-grid">
                    <div class="result-kv emphasis">
                        <label>任务编号</label>
                        <strong>${result.id}</strong>
                    </div>
                    <div class="result-kv emphasis">
                        <label>审计类别</label>
                        <strong>${result.task_type === 'spatial' ? '空间聚合' : '时间聚合'}</strong>
                    </div>
                    <div class="result-kv">
                        <label>参与记录数</label>
                        <strong>${result.decrypted_stats?.record_count || result.verification_details?.record_count || 0}</strong>
                    </div>
                    <div class="result-kv">
                        <label>分配关系ID</label>
                        <strong>${result.patient_assignment_id || '--'}</strong>
                    </div>
                </div>
                <div class="result-note">${missingText}</div>
                <div class="result-stat-grid">
                    ${buildStatsGrid(stats)}
                </div>
                ${buildPatientPanels(result)}
                <div class="result-note">
                    <strong style="display:block; margin-bottom:0.4rem; color:#0F172A;">完整校验摘要</strong>
                    ${buildVerificationSummaryList(result)}
                </div>
            </div>
        `;
    }

    function renderSystemStatus(status) {
        el.dacName.textContent = `${currentUser.full_name || 'DAC 审计员'} · DAC`;
        el.systemStatusBadge.textContent = status.is_initialized ? '已初始化' : '未初始化';
        el.systemStatusBadge.className = `dac-badge${status.is_initialized ? '' : ' fail'}`;
        setResultBox(el.systemStatusText, `
            <pre>${[
                `初始化状态：${status.is_initialized ? '已完成' : '未完成'}`,
                `系统版本：${status.system_version}`,
                `存储模式：${status.storage_mode}`,
                `已分配密钥：${status.key_assignment_count}`,
                `本地 MCS 节点：${status.mcs_node_count || 0}`,
                `患者分配关系：${status.patient_assignment_count || 0}`,
                `密文记录数：${status.cipher_record_count}`,
                `审计任务数：${status.audit_task_count}`,
                `初始化执行人ID：${status.initialized_by_user_id || '--'}`,
                `初始化时间：${status.initialized_at || '--'}`,
                `最近更新时间：${status.updated_at || '--'}`,
            ].join('\n')}</pre>
        `);

        el.keyCountValue.textContent = String(status.key_assignment_count || 0);
        el.mcsNodeCountValue.textContent = String(status.mcs_node_count || 0);
        el.routingCountValue.textContent = String(status.patient_assignment_count || 0);
        el.cipherCountValue.textContent = String(status.cipher_record_count || 0);
        el.auditCountValue.textContent = String(status.audit_task_count || 0);
    }

    function renderPatients(items = []) {
        patientItems = items;
        el.patientCountValue.textContent = String(items.length);
        el.auditPatientSelect.innerHTML = '';

        if (!items.length) {
            el.auditPatientSelect.innerHTML = '<option value="">暂无患者</option>';
        } else {
            items.forEach((item) => {
                const option = document.createElement('option');
                option.value = String(item.patient_id);
                option.textContent = `${item.patient_name}（#${item.patient_id}）`;
                el.auditPatientSelect.appendChild(option);
            });
        }

        renderSpatialPatientList();
    }

    function renderSpatialPatientList() {
        const sourceType = el.spatialSourceTypeSelect.value;
        const available = patientItems.filter((item) => hasSourceData(item, sourceType));
        const missing = patientItems.filter((item) => !hasSourceData(item, sourceType));

        const missingNames = missing.map((item) => `${item.patient_name}(#${item.patient_id})`);
        el.spatialPatientHint.textContent = available.length
            ? `当前数据类型为“${sourceLabel(sourceType)}”。可参与聚合 ${available.length} 位，缺少该类数据 ${missing.length} 位。${missingNames.length ? `缺失对象：${missingNames.join('、')}。` : ''}`
            : `当前数据类型为“${sourceLabel(sourceType)}”。暂无可参与空间聚合的患者。`;

        el.spatialPatientList.innerHTML = '';
        if (!patientItems.length) {
            el.spatialPatientList.innerHTML = '<div class="dac-item"><span>暂无可选患者</span></div>';
            return;
        }

        let checkedCount = 0;
        patientItems.forEach((item) => {
            const canUse = hasSourceData(item, sourceType);
            const wrapper = document.createElement('label');
            if (!canUse) wrapper.classList.add('disabled');
            wrapper.innerHTML = `
                <input type="checkbox" class="spatial-patient-checkbox" value="${item.patient_id}" ${canUse && checkedCount < 2 ? 'checked' : ''} ${canUse ? '' : 'disabled'}>
                <div>
                    <strong>${item.patient_name}</strong>
                    <span>患者ID：${item.patient_id} · ${patientSourceHint(item, sourceType)}</span>
                </div>
            `;
            if (canUse && checkedCount < 2) checkedCount += 1;
            el.spatialPatientList.appendChild(wrapper);
        });
    }

    function renderCipherRecords(items = [], context = {}) {
        el.cipherRecordTableBody.innerHTML = '';
        if (!items.length) {
            el.cipherRecordTableBody.innerHTML = '<tr><td colspan="4">暂无密文记录</td></tr>';
            setResultBox(el.cipherRecordStatusBox, `<pre>${context.patientName || '当前患者'} 在 ${context.sourceTypeLabel || '当前数据类型'} 下暂无密文记录。</pre>`);
            return;
        }

        items.forEach((item) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${item.id}</td>
                <td>${item.time_bucket}</td>
                <td>${sourceLabel(item.source_type)}</td>
                <td>${item.mcs_node_id || '--'}</td>
            `;
            el.cipherRecordTableBody.appendChild(row);
        });

        setResultBox(el.cipherRecordStatusBox, `<pre>已加载 ${items.length} 条密文记录。目标患者：${context.patientName || '--'}；数据类型：${context.sourceTypeLabel || '--'}。</pre>`);
    }

    function renderSimpleTable(body, items, createRow, emptyText, colspan) {
        body.innerHTML = '';
        if (!items.length) {
            body.innerHTML = `<tr><td colspan="${colspan}">${emptyText}</td></tr>`;
            return;
        }
        items.forEach((item) => body.appendChild(createRow(item)));
    }

    function renderKeyAssignments(items = []) {
        renderSimpleTable(
            el.keyAssignmentTableBody,
            items,
            (item) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.full_name}<br><span style="color:#64748B;">${item.staff_id || item.email}</span></td>
                    <td>${item.role}${item.subrole ? ` / ${item.subrole}` : ''}</td>
                    <td>${item.key_fingerprint || '--'}</td>
                `;
                return row;
            },
            '暂无密钥分配数据',
            3
        );
    }

    function renderMcsNodes(items = []) {
        renderSimpleTable(
            el.mcsNodeTableBody,
            items,
            (item) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.node_name}<br><span style="color:#64748B;">${item.node_code}</span></td>
                    <td>${item.storage_backend}<br><span style="color:#64748B;">${item.storage_namespace}</span></td>
                    <td>${item.is_active ? '可用' : '停用'}</td>
                `;
                return row;
            },
            '暂无节点数据',
            3
        );
    }

    function renderPatientAssignments(items = []) {
        renderSimpleTable(
            el.patientAssignmentTableBody,
            items,
            (item) => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.patient_name || '--'}<br><span style="color:#64748B;">Patient #${item.patient_id}</span></td>
                    <td>${item.assigned_dac_name || '--'}<br><span style="color:#64748B;">${statusLabel(item.assignment_status)}</span></td>
                    <td>${item.assigned_mcs_node_code || '--'}</td>
                `;
                return row;
            },
            '暂无分配数据',
            3
        );
    }

    function renderRecentAudits(items = []) {
        el.recentAuditList.innerHTML = '';
        if (!items.length) {
            el.recentAuditList.innerHTML = '<div class="dac-item"><span>暂无审计任务</span></div>';
            return;
        }

        items.forEach((item) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'dac-item';

            const modeLabel = item.task_type === 'spatial' ? '空间聚合' : '时间聚合';
            const detail = document.createElement('div');
            detail.style.display = 'none';
            detail.style.marginTop = '0.8rem';
            detail.innerHTML = buildAuditCard(item, `${modeLabel}历史结果`);

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'btn-outline';
            toggleBtn.style.padding = '0.55rem 0.85rem';
            toggleBtn.style.fontSize = '0.84rem';
            toggleBtn.textContent = '查看完整结果';
            toggleBtn.addEventListener('click', () => {
                const expanded = detail.style.display !== 'none';
                detail.style.display = expanded ? 'none' : 'block';
                toggleBtn.textContent = expanded ? '查看完整结果' : '收起完整结果';
            });

            wrapper.innerHTML = `
                <strong>任务 #${item.id} · ${modeLabel} · ${sourceLabel(item.source_type)}</strong>
                <span>状态：${statusLabel(item.status)} · MCS：${item.mcs_node_id || '--'}</span>
                <p><span class="dac-badge${item.verification_passed ? '' : ' fail'}">${item.verification_passed ? '校验通过' : '校验未通过 / 待完成'}</span></p>
                <p>参与记录数：${item.decrypted_stats?.record_count || item.verification_details?.record_count || 0}</p>
            `;
            wrapper.appendChild(toggleBtn);
            wrapper.appendChild(detail);
            el.recentAuditList.appendChild(wrapper);
        });
    }

    function renderAuditLogs(items = []) {
        el.recentLogList.innerHTML = '';
        if (!items.length) {
            el.recentLogList.innerHTML = '<div class="dac-item"><span>暂无审计日志</span></div>';
            return;
        }

        items.forEach((item) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'dac-item';
            wrapper.innerHTML = `
                <strong>${actionLabel(item.action)}</strong>
                <span>${statusLabel(item.status)} · ${item.created_at || '--'}</span>
                <p>${item.message}</p>
            `;
            el.recentLogList.appendChild(wrapper);
        });
    }

    function getSelectedSpatialPatientIds() {
        return Array.from(document.querySelectorAll('.spatial-patient-checkbox:checked'))
            .map((input) => Number(input.value))
            .filter((value) => Number.isFinite(value));
    }

    async function loadSystemStatus() {
        renderSystemStatus(await window.API.Security.getSystemStatus());
    }

    async function loadPatients() {
        const response = await window.API.Security.getAuditPatients();
        renderPatients(response.items || []);
    }

    async function loadKeyAssignments() {
        renderKeyAssignments((await window.API.Security.getKeyAssignments()).items || []);
    }

    async function loadMcsNodes() {
        renderMcsNodes((await window.API.Security.getMcsNodes()).items || []);
    }

    async function loadPatientAssignments() {
        renderPatientAssignments((await window.API.Security.getPatientAssignments()).items || []);
    }

    async function loadRecentAudits() {
        renderRecentAudits(await window.API.Security.getRecentAudits() || []);
    }

    async function loadAuditLogs() {
        renderAuditLogs((await window.API.Security.getAuditLogs()).items || []);
    }

    async function loadCipherRecords() {
        const patientId = Number(el.auditPatientSelect.value);
        const sourceType = el.auditSourceTypeSelect.value;
        const selectedPatient = patientItems.find((item) => Number(item.patient_id) === patientId);

        if (!patientId) {
            renderCipherRecords([], { sourceTypeLabel: sourceLabel(sourceType) });
            return;
        }

        setButtonLoading(el.loadCipherBtn, '加载中...');
        setResultBox(el.cipherRecordStatusBox, `<pre>正在加载 ${selectedPatient?.patient_name || '当前患者'} 的 ${sourceLabel(sourceType)} 密文记录...</pre>`);
        try {
            const response = await window.API.Security.getPatientCipherRecords(patientId, sourceType);
            renderCipherRecords(response.items || [], {
                patientName: selectedPatient?.patient_name,
                sourceTypeLabel: sourceLabel(sourceType),
            });
        } catch (error) {
            setResultBox(el.cipherRecordStatusBox, `<pre>${error.message || '密文记录加载失败。'}</pre>`);
        } finally {
            restoreButton(el.loadCipherBtn);
        }
    }

    async function refreshAll() {
        try {
            await Promise.all([
                loadSystemStatus(),
                loadPatients(),
                loadKeyAssignments(),
                loadMcsNodes(),
                loadPatientAssignments(),
                loadRecentAudits(),
                loadAuditLogs(),
            ]);
            await loadCipherRecords();
        } catch (error) {
            setResultBox(el.auditResultBox, `<pre>${error.message || 'DAC 数据加载失败。'}</pre>`);
        }
    }

    el.initSecurityBtn?.addEventListener('click', async () => {
        setButtonLoading(el.initSecurityBtn, '初始化中...');
        try {
            await window.API.Security.initializeSystem();
            await refreshAll();
            setResultBox(el.auditResultBox, '<pre>安全系统初始化完成，已同步用户密钥、患者分配关系与本地 MCS 密文记录。</pre>');
        } catch (error) {
            setResultBox(el.auditResultBox, `<pre>${error.message || '初始化失败。'}</pre>`);
        } finally {
            restoreButton(el.initSecurityBtn);
        }
    });

    el.refreshDacBtn?.addEventListener('click', refreshAll);
    el.loadCipherBtn?.addEventListener('click', loadCipherRecords);

    el.runAuditBtn?.addEventListener('click', async () => {
        const patientId = Number(el.auditPatientSelect.value);
        const sourceType = el.auditSourceTypeSelect.value;
        const selectedPatient = patientItems.find((item) => Number(item.patient_id) === patientId);

        if (!patientId) {
            setResultBox(el.auditResultBox, '<pre>请先选择患者。</pre>');
            return;
        }

        setButtonLoading(el.runAuditBtn, '审计中...');
        setResultBox(el.auditResultBox, `<pre>正在对 ${selectedPatient?.patient_name || '当前患者'} 的 ${sourceLabel(sourceType)} 执行时间聚合审计，请稍候...</pre>`);
        try {
            const result = await window.API.Security.runTemporalAudit({
                patient_id: patientId,
                source_type: sourceType,
            });
            el.auditResultBox.innerHTML = buildAuditCard(result, '时间聚合审计');
            await Promise.all([loadRecentAudits(), loadAuditLogs(), loadCipherRecords(), loadSystemStatus()]);
        } catch (error) {
            setResultBox(el.auditResultBox, `<pre>${error.message || '执行时间审计失败。'}</pre>`);
        } finally {
            restoreButton(el.runAuditBtn);
        }
    });

    el.runSpatialAuditBtn?.addEventListener('click', async () => {
        const sourceType = el.spatialSourceTypeSelect.value;
        const patientIds = getSelectedSpatialPatientIds();

        if (patientIds.length < 2) {
            setResultBox(el.spatialAuditResultBox, '<pre>请至少选择两位患者后再执行空间审计。</pre>');
            return;
        }

        setButtonLoading(el.runSpatialAuditBtn, '审计中...');
        setResultBox(el.spatialAuditResultBox, `<pre>正在对 ${patientIds.length} 位患者执行 ${sourceLabel(sourceType)} 空间聚合审计，请稍候...</pre>`);
        try {
            const result = await window.API.Security.runSpatialAudit({
                patient_ids: patientIds,
                source_type: sourceType,
            });
            el.spatialAuditResultBox.innerHTML = buildAuditCard(result, '空间聚合审计');
            await Promise.all([loadRecentAudits(), loadAuditLogs(), loadSystemStatus()]);
        } catch (error) {
            setResultBox(el.spatialAuditResultBox, `<pre>${error.message || '执行空间审计失败。'}</pre>`);
        } finally {
            restoreButton(el.runSpatialAuditBtn);
        }
    });

    el.auditPatientSelect?.addEventListener('change', loadCipherRecords);
    el.auditSourceTypeSelect?.addEventListener('change', loadCipherRecords);
    el.spatialSourceTypeSelect?.addEventListener('change', renderSpatialPatientList);

    await refreshAll();
});
