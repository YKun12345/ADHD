const REPORT_RADAR_LABELS = {
    attention_control: '注意控制',
    organization: '组织管理',
    task_activation: '任务启动',
    hyperactivity: '多动表现',
    impulsivity: '冲动控制',
    emotional_regulation: '情绪调节'
};

const COGNITIVE_RADAR_LABELS = {
    reaction_speed: '反应速度',
    attention_control: '注意控制',
    inhibitory_control: '抑制控制',
    working_memory: '工作记忆'
};

const SELECTED_PATIENT_STORAGE_KEY = 'smartbrain_selected_patient_id';

function createChip(text) {
    const chip = document.createElement('span');
    chip.textContent = text;
    chip.style.cssText = 'padding:0.45rem 0.75rem;border-radius:999px;background:#F8FAFC;border:1px solid #E2E8F0;color:#334155;font-size:0.9rem;font-weight:600;';
    return chip;
}

function createHeaderChip(text) {
    const chip = document.createElement('span');
    chip.className = 'meta-chip';
    chip.textContent = text;
    return chip;
}

function createMetaChip(label, value) {
    const chip = document.createElement('div');
    chip.className = 'report-meta-chip';
    chip.innerHTML = `
        <span class="report-meta-chip-label">${label}</span>
        <span class="report-meta-chip-value">${value}</span>
    `;
    return chip;
}

function createSizedMetaChip(label, value, size = '') {
    const chip = createMetaChip(label, value);
    if (size) chip.classList.add(size);
    return chip;
}

function mapPatientType(value) {
    if (value === 'adult') return '成人';
    if (value === 'child') return '儿童';
    return value || '--';
}

function mapRiskLevel(value) {
    const mapping = {
        high: '高风险',
        medium: '中风险',
        low: '低风险'
    };
    return mapping[value] || value || '--';
}

function mapRespondentType(value) {
    const mapping = {
        self: '本人',
        parent: '家长',
        guardian: '监护人',
        teacher: '教师'
    };
    return mapping[value] || value || '--';
}

function formatDateTime(value) {
    if (!value) return '--';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '--';
    return parsed.toLocaleString();
}

function formatPercent(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function getConfidenceLevel(probability) {
    const score = Number(probability || 0);
    if (score >= 0.9) return '高置信';
    if (score >= 0.75) return '中等置信';
    return '低置信';
}

function getControlProbability(prediction) {
    const value = Number(prediction?.probability_control);
    if (Number.isFinite(value)) {
        return Math.max(0, Math.min(1, value));
    }
    return Math.max(0, Math.min(1, 1 - Number(prediction?.probability || 0)));
}

function showEmptyState(options = {}) {
    const loading = document.getElementById('reportLoading');
    const empty = document.getElementById('reportEmpty');
    const content = document.getElementById('reportContent');
    const title = empty?.querySelector('h3');
    const description = empty?.querySelector('p');

    loading?.classList.add('hidden');
    content?.classList.add('hidden');
    empty?.classList.remove('hidden');

    if (title) {
        title.textContent = options.title || '暂时没有可展示的报告内容';
    }
    if (description) {
        description.textContent = options.description || '请先返回患者工作台，确认这位患者已经同步了量表、认知测试、14 天追踪或影像可视化数据。';
    }
}

function wrapRadarLabel(label) {
    if (!label || label.length <= 4) return label;
    const chunks = [];
    for (let index = 0; index < label.length; index += 4) {
        chunks.push(label.slice(index, index + 4));
    }
    return chunks.join('\n');
}

function getRadarLayout(containerId, indicatorCount) {
    if (containerId === 'cognitiveRadar') {
        return {
            center: ['50%', '51%'],
            radius: indicatorCount >= 4 ? '58%' : '62%',
            axisNameWidth: 148,
            axisNameFontSize: 12,
            nameGap: 11
        };
    }

    return {
        center: ['50%', '51%'],
        radius: indicatorCount >= 5 ? '60%' : '64%',
        axisNameWidth: 156,
        axisNameFontSize: 12,
        nameGap: 12
    };
}

function attachResizeHandler(chartDom, chart, key) {
    const handlerKey = key || '__chartResizeHandler';
    if (chartDom[handlerKey]) {
        window.removeEventListener('resize', chartDom[handlerKey]);
    }
    chartDom[handlerKey] = () => chart.resize();
    window.addEventListener('resize', chartDom[handlerKey]);
}

function initRadarChart(containerId, radarScores, labels) {
    const chartDom = document.getElementById(containerId);
    if (!chartDom) return;

    if (!window.echarts || !radarScores || !Object.keys(radarScores).length) {
        chartDom.style.display = 'none';
        const existingChart = window.echarts?.getInstanceByDom(chartDom);
        if (existingChart) existingChart.dispose();
        return;
    }

    chartDom.style.display = 'block';
    const keys = Object.keys(radarScores);
    const layout = getRadarLayout(containerId, keys.length);
    const existingChart = window.echarts.getInstanceByDom(chartDom);
    if (existingChart) existingChart.dispose();

    const chart = window.echarts.init(chartDom);
    chart.setOption({
        animationDuration: 450,
        color: ['#0EA5E9'],
        radar: {
            center: layout.center,
            radius: layout.radius,
            nameGap: layout.nameGap,
            splitNumber: 4,
            indicator: keys.map((key) => ({
                name: wrapRadarLabel(labels[key] || key),
                max: 20
            })),
            axisName: {
                color: '#334155',
                fontSize: layout.axisNameFontSize,
                fontWeight: 600,
                lineHeight: 20,
                width: layout.axisNameWidth,
                overflow: 'break',
                align: 'center',
                verticalAlign: 'middle',
                backgroundColor: 'rgba(255,255,255,0.96)',
                borderRadius: 8,
                padding: [4, 6]
            },
            axisLine: {
                lineStyle: { color: 'rgba(14, 165, 233, 0.28)' }
            },
            splitLine: {
                lineStyle: { color: 'rgba(14, 165, 233, 0.22)' }
            },
            splitArea: {
                areaStyle: {
                    color: [
                        'rgba(14, 165, 233, 0.02)',
                        'rgba(14, 165, 233, 0.05)',
                        'rgba(14, 165, 233, 0.09)',
                        'rgba(14, 165, 233, 0.13)'
                    ]
                }
            }
        },
        series: [{
            type: 'radar',
            data: [{
                value: keys.map((key) => radarScores[key]),
                areaStyle: { color: 'rgba(14, 165, 233, 0.35)' },
                lineStyle: { width: 3 },
                itemStyle: { color: '#0EA5E9' },
                symbolSize: 7
            }]
        }]
    });

    attachResizeHandler(chartDom, chart, '__radarResizeHandler');
}

function initTrackingCharts(logs = [], totalDays = 14) {
    if (!window.echarts) return;

    const lineDom = document.getElementById('reportTrackingLineChart');
    const donutDom = document.getElementById('reportTrackingDonutChart');
    if (!lineDom || !donutDom) return;

    const existingLineChart = window.echarts.getInstanceByDom(lineDom);
    if (existingLineChart) existingLineChart.dispose();
    const existingDonutChart = window.echarts.getInstanceByDom(donutDom);
    if (existingDonutChart) existingDonutChart.dispose();

    const days = Array.from({ length: totalDays }, (_, index) => `D${index + 1}`);
    const moodData = new Array(totalDays).fill(null);
    const moodCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    (logs || []).forEach((log) => {
        const dayIndex = Number(log.day_index) - 1;
        const mood = Number(log.mood_tag) || 3;
        if (dayIndex >= 0 && dayIndex < totalDays) {
            moodData[dayIndex] = mood;
            if (moodCounts[mood] != null) moodCounts[mood] += 1;
        }
    });

    const lineChart = window.echarts.init(lineDom);
    lineChart.setOption({
        tooltip: { trigger: 'axis', formatter: '{b}<br/>心情值: {c}' },
        grid: { left: '3%', right: '4%', bottom: '5%', top: '10%', containLabel: true },
        xAxis: {
            type: 'category',
            data: days,
            boundaryGap: false,
            axisLine: { lineStyle: { color: '#E2E8F0' } },
            axisLabel: { color: '#64748B' }
        },
        yAxis: {
            type: 'value',
            min: 1,
            max: 5,
            interval: 1,
            splitLine: { lineStyle: { type: 'dashed', color: '#F1F5F9' } },
            axisLabel: { color: '#64748B' }
        },
        series: [{
            name: '心情',
            type: 'line',
            smooth: true,
            data: moodData,
            itemStyle: { color: '#10B981' },
            lineStyle: { width: 4, shadowColor: 'rgba(16, 185, 129, 0.3)', shadowBlur: 10 },
            areaStyle: {
                color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(16, 185, 129, 0.3)' },
                    { offset: 1, color: 'rgba(16, 185, 129, 0)' }
                ])
            }
        }]
    });

    const donutChart = window.echarts.init(donutDom);
    donutChart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c}次 ({d}%)' },
        legend: { bottom: '0%', left: 'center', icon: 'circle', textStyle: { color: '#64748B' } },
        series: [{
            type: 'pie',
            radius: ['40%', '70%'],
            avoidLabelOverlap: false,
            itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
            label: { show: false, position: 'center' },
            emphasis: { label: { show: true, fontSize: 20, fontWeight: 'bold' } },
            labelLine: { show: false },
            data: [
                { value: moodCounts[5], name: '狂喜', itemStyle: { color: '#10B981' } },
                { value: moodCounts[4], name: '开心', itemStyle: { color: '#84CC16' } },
                { value: moodCounts[3], name: '还行', itemStyle: { color: '#FBBF24' } },
                { value: moodCounts[2], name: '不良', itemStyle: { color: '#F97316' } },
                { value: moodCounts[1], name: '超烂', itemStyle: { color: '#EF4444' } }
            ].filter((item) => item.value > 0)
        }]
    });

    attachResizeHandler(lineDom, lineChart, '__trackingLineResizeHandler');
    attachResizeHandler(donutDom, donutChart, '__trackingDonutResizeHandler');
}

function renderHeader(report) {
    document.getElementById('patientTitle').textContent = `${report.patient_name} 的综合报告`;
    document.getElementById('patientSubTitle').textContent = `${report.patient_email} · ${mapPatientType(report.patient_type)}患者 · 与患者端报告内容实时同步`;

    const metaRow = document.getElementById('metaRow');
    metaRow.innerHTML = '';
    [
        `患者 ID：${report.patient_id}`,
        `患者类型：${mapPatientType(report.patient_type)}`,
        report.latest_scale ? `最新量表：${report.latest_scale.scale_type}` : '最新量表：暂无',
        report.latest_scale ? `风险等级：${mapRiskLevel(report.latest_scale.risk_level)}` : null,
        report.latest_scale ? `总分：${report.latest_scale.total_score}` : null
    ].filter(Boolean).forEach((text) => metaRow.appendChild(createHeaderChip(text)));
}

function renderSecurityOverview(overview) {
    const card = document.getElementById('securityStatusCard');
    const badge = document.getElementById('securityStatusBadge');
    const grid = document.getElementById('securityStatusGrid');
    if (!card || !badge || !grid || !overview) return;

    const stageClass =
        overview.security_stage === '已完成时间审计'
            ? 'success'
            : overview.security_stage === '时间审计未通过'
                ? 'danger'
                : overview.has_cipher_records
                    ? ''
                    : 'warning';

    badge.textContent = overview.security_stage || '安全状态未知';
    badge.className = `security-audit-badge ${stageClass}`.trim();

    const cipherText = overview.has_cipher_records
        ? `已生成 ${overview.cipher_record_count} 条`
        : '暂未生成';
    const auditText = !overview.latest_temporal_audit_id
        ? '尚未执行时间审计'
        : overview.latest_temporal_audit_passed === true
            ? '最近时间审计通过'
            : overview.latest_temporal_audit_passed === false
                ? '最近时间审计未通过'
                : overview.latest_temporal_audit_status || '时间审计进行中';

    grid.innerHTML = `
        <div class="security-audit-item">
            <span>安全状态</span>
            <strong>${overview.security_stage || '--'}</strong>
        </div>
        <div class="security-audit-item">
            <span>已分配 DAC</span>
            <strong>${overview.assigned_dac_name || '--'}</strong>
        </div>
        <div class="security-audit-item">
            <span>已分配 MCS</span>
            <strong>${overview.assigned_mcs_node_code || '--'}</strong>
        </div>
        <div class="security-audit-item">
            <span>密文记录</span>
            <strong>${cipherText}</strong>
        </div>
        <div class="security-audit-item">
            <span>最近时间审计</span>
            <strong>${auditText}</strong>
        </div>
        <div class="security-audit-item">
            <span>审计数据类型</span>
            <strong>${overview.latest_temporal_audit_source_type || '--'}</strong>
        </div>
        <div class="security-audit-item">
            <span>审计完成时间</span>
            <strong>${formatDateTime(overview.latest_temporal_audit_completed_at)}</strong>
        </div>
        <div class="security-audit-item">
            <span>时间审计任务ID</span>
            <strong>${overview.latest_temporal_audit_id || '--'}</strong>
        </div>
    `;

    card.classList.remove('hidden');
}

function renderScaleSummary(report) {
    const scale = report.latest_scale;
    const reportBadge = document.getElementById('reportBadge');
    const reportScaleTitle = document.getElementById('reportScaleTitle');
    const reportSummary = document.getElementById('reportSummary');
    const reportMeta = document.getElementById('reportMeta');
    const recommendations = document.getElementById('reportRecommendations');
    const disclaimer = document.getElementById('reportDisclaimer');

    if (!scale) {
        reportBadge.textContent = '暂无量表';
        reportScaleTitle.textContent = '还没有最新量表结果';
        reportSummary.textContent = '当前患者还没有完成可用于综合解读的量表，建议先完成行为量表后再回来查看。';
        reportMeta.innerHTML = '';
        recommendations.innerHTML = '';
        disclaimer.innerHTML = '<strong>提示：</strong> 当前报告内容仅供辅助参考，不替代医生诊断。';
        initRadarChart('reportRadar', {}, REPORT_RADAR_LABELS);
        return;
    }

    reportBadge.textContent = `${scale.scale_type} · ${mapRiskLevel(scale.risk_level)}`;
    reportScaleTitle.textContent = `${scale.scale_type} 量表结果`;
    reportSummary.textContent = scale.summary || '已生成量表结果摘要。';

    reportMeta.innerHTML = '';
    [
        { label: '患者', value: report.patient_name || '--', size: 'narrow' },
        { label: '类型', value: mapPatientType(report.patient_type), size: 'narrow' },
        { label: '总分', value: scale.total_score, size: 'narrow' },
        { label: '填写方式', value: mapRespondentType(scale.respondent_type), size: 'wide' },
        { label: '风险等级', value: mapRiskLevel(scale.risk_level), size: 'wide' }
    ].forEach((item) => reportMeta.appendChild(createSizedMetaChip(item.label, item.value, item.size)));

    recommendations.innerHTML = '';
    (scale.recommendations || []).forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:0.7rem; align-items:flex-start; color:#475569; line-height:1.7;';
        row.innerHTML = `<ion-icon name="checkmark-circle-outline" style="color:#10B981; font-size:1.05rem; margin-top:0.2rem;"></ion-icon><span>${item}</span>`;
        recommendations.appendChild(row);
    });

    disclaimer.innerHTML = '<strong>辅助说明：</strong> 量表结果用于帮助理解当前状态，不代表最终医学诊断。';
    initRadarChart('reportRadar', scale.radar_scores || {}, REPORT_RADAR_LABELS);
}

function renderTrackingSection(report) {
    const section = document.getElementById('trackingSection');
    const tracking = report.tracking_summary;
    if (!section || !tracking) return;

    section.classList.remove('hidden');
    document.getElementById('trackingBadge').textContent = `${tracking.completed_count}/${tracking.total_days} 天`;

    const chips = document.getElementById('trackingMetaChips');
    chips.innerHTML = '';
    [
        `当前建议记录：第 ${tracking.current_day} 天`,
        tracking.average_mood != null ? `平均情绪：${tracking.average_mood}` : null,
        tracking.average_focus_minutes != null ? `平均专注：${tracking.average_focus_minutes} 分钟` : null,
        tracking.latest_mood_text ? `最近状态：${tracking.latest_mood_text}` : null
    ].filter(Boolean).forEach((text) => chips.appendChild(createChip(text)));

    const summaryText = document.getElementById('trackingSummaryText');
    summaryText.textContent = tracking.completed_count
        ? `最近 ${tracking.completed_count} 天的追踪已经形成了较稳定的动态记录，能够帮助研究人员与患者一起看到情绪和专注波动。`
        : '14 天追踪还没有开始，建议从今天先记录一条简短状态。';

    initTrackingCharts(report.tracking_logs || [], tracking.total_days || 14);
}

function renderImagingSummary(imaging) {
    const section = document.getElementById('imagingSection');
    if (!section) return;

    if (!imaging) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    document.getElementById('imagingBadge').textContent = imaging.visualization_type?.toUpperCase?.() || '--';
    document.getElementById('imagingSummary').textContent = imaging.summary_text || '已生成影像可视化摘要。';

    const interpretation = document.getElementById('imagingInterpretation');
    if (interpretation) {
        const interpretationParts = [];
        if (imaging.slice_interpretation) {
            interpretationParts.push(`脑切面解读：${imaging.slice_interpretation}`);
        }
        if (imaging.surface_interpretation) {
            interpretationParts.push(`3D 表面解读：${imaging.surface_interpretation}`);
        }
        interpretation.textContent =
            interpretationParts.join('\n\n') ||
            imaging.summary_text ||
            imaging.notes ||
            '研究人员上传影像截图并补充解读后，这里会显示相应的文字说明。';
    }

    const slicePreview = document.getElementById('imagingSlicePreview');
    if (slicePreview) {
        slicePreview.innerHTML = imaging.slice_screenshot_data
            ? `<img src="${imaging.slice_screenshot_data}" alt="${imaging.slice_screenshot_name || '脑切面截图'}" style="width:100%;height:100%;object-fit:contain;border-radius:12px;">`
            : '研究人员上传脑切面截图后，这里会显示在报告摘要中。';
    }

    const surfacePreview = document.getElementById('imagingSurfacePreview');
    if (surfacePreview) {
        surfacePreview.innerHTML = imaging.surface_screenshot_data
            ? `<img src="${imaging.surface_screenshot_data}" alt="${imaging.surface_screenshot_name || '3D表面截图'}" style="width:100%;height:100%;object-fit:contain;border-radius:12px;">`
            : '研究人员上传 3D 表面截图后，这里会显示在报告摘要中。';
    }

    const meta = document.getElementById('imagingMeta');
    meta.innerHTML = '';
    [
        `生成时间：${formatDateTime(imaging.created_at)}`,
        imaging.notes ? `备注：${imaging.notes}` : null
    ].filter(Boolean).forEach((text) => meta.appendChild(createChip(text)));

    const files = document.getElementById('imagingFiles');
    files.innerHTML = '';
    [
        imaging.func_file_name ? `功能影像：${imaging.func_file_name}` : null,
        imaging.anat_file_name ? `脑切面文件：${imaging.anat_file_name}` : null,
        imaging.mask_file_name ? `掩膜文件：${imaging.mask_file_name}` : null,
        imaging.left_func_file_name ? `左半球功能：${imaging.left_func_file_name}` : null,
        imaging.left_mesh_file_name ? `左半球表面：${imaging.left_mesh_file_name}` : null,
        imaging.right_func_file_name ? `右半球功能：${imaging.right_func_file_name}` : null,
        imaging.right_mesh_file_name ? `右半球表面：${imaging.right_mesh_file_name}` : null,
        imaging.slice_screenshot_name ? `脑切面截图：${imaging.slice_screenshot_name}` : null,
        imaging.surface_screenshot_name ? `3D表面截图：${imaging.surface_screenshot_name}` : null
    ].filter(Boolean).forEach((text) => files.appendChild(createChip(text)));
}

function renderModelPredictionSummary(prediction) {
    const section = document.getElementById('modelPredictionSection');
    if (!section) return;

    if (!prediction) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    const controlProbability = getControlProbability(prediction);

    document.getElementById('modelPredictionBadge').textContent = `${prediction.prediction_label} · ${formatPercent(prediction.probability)}`;
    document.getElementById('modelPredictionLabel').textContent = prediction.prediction_label || '--';
    document.getElementById('modelPredictionConfidence').textContent = getConfidenceLevel(prediction.probability);
    document.getElementById('modelPredictionSummary').textContent =
        prediction.summary_text ||
        `基于时间序列影像分析，当前模型输出标签为 ${prediction.prediction_label}，对应概率为 ${formatPercent(prediction.probability)}。`;

    const meta = document.getElementById('modelPredictionMeta');
    meta.innerHTML = '';
    [
        `生成时间：${formatDateTime(prediction.created_at)}`,
        prediction.file_name ? `文件：${prediction.file_name}` : null,
        prediction.source_type ? `来源：${String(prediction.source_type).toUpperCase()}` : null,
        prediction.model_name ? `模型：${prediction.model_name}` : null,
        prediction.model_version ? `版本：${prediction.model_version}` : null,
        prediction.timepoints != null ? `时间点数：${prediction.timepoints}` : null,
        prediction.roi_dim_used != null ? `ROI 维度：${prediction.roi_dim_used}` : null,
        prediction.prediction_id != null ? `结果ID：${prediction.prediction_id}` : null
    ].filter(Boolean).forEach((text) => meta.appendChild(createChip(text)));

    document.getElementById('modelPredictionAdhdValue').textContent = formatPercent(prediction.probability);
    document.getElementById('modelPredictionControlValue').textContent = formatPercent(controlProbability);
    document.getElementById('modelPredictionAdhdBar').style.width = `${Math.max(0, Math.min(100, Number(prediction.probability || 0) * 100))}%`;
    document.getElementById('modelPredictionControlBar').style.width = `${Math.max(0, Math.min(100, controlProbability * 100))}%`;
}

function renderCognitiveSummary(profile) {
    const section = document.getElementById('cognitiveSection');
    if (!section) return;

    if (!profile) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    document.getElementById('cognitiveBadge').textContent = `${profile.latest_tests?.length || 0} 项测试`;
    document.getElementById('cognitiveSummary').textContent = profile.summary || '已生成认知能力摘要。';

    const meta = document.getElementById('cognitiveMeta');
    meta.innerHTML = '';
    Object.entries(profile.radar_scores || {}).forEach(([key, value]) => {
        meta.appendChild(createChip(`${COGNITIVE_RADAR_LABELS[key] || key}：${value}/20`));
    });

    const tests = document.getElementById('cognitiveTests');
    tests.innerHTML = '';
    (profile.latest_tests || []).forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:0.95rem 1rem;border-radius:14px;background:#F8FAFC;border:1px solid #E2E8F0;';
        row.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:0.35rem;">
                <strong style="color:#0F172A;font-size:0.96rem;">${item.test_name}</strong>
                <span style="color:#64748B;font-size:0.82rem;">${formatDateTime(item.finished_at)}</span>
            </div>
            <div style="color:#475569;font-size:0.9rem;line-height:1.6;">${item.status_text} · 关键指标：${item.key_metric}</div>
        `;
        tests.appendChild(row);
    });

    initRadarChart('cognitiveRadar', profile.radar_scores || {}, COGNITIVE_RADAR_LABELS);
}

function renderDoctorReport(report) {
    renderHeader(report);
    renderScaleSummary(report);
    renderTrackingSection(report);
    renderImagingSummary(report.latest_imaging_visualization);
    renderModelPredictionSummary(report.latest_model_prediction);
    renderCognitiveSummary(report.cognitive_profile);
}

document.addEventListener('DOMContentLoaded', async () => {
    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const researcherName = document.getElementById('researcherName');
    if (researcherName && currentUser?.full_name) {
        researcherName.textContent = `${currentUser.full_name} · 研究人员`;
    }

    const params = new URLSearchParams(window.location.search);
    const patientId = params.get('patient_id');
    const reportLoading = document.getElementById('reportLoading');
    const reportContent = document.getElementById('reportContent');
    const openImagingBtn = document.getElementById('openImagingBtn');
    const openVisualizationBtn = document.getElementById('openVisualizationBtn');

    if (!patientId) {
        showEmptyState({
            title: '未选择患者',
            description: '请从患者工作台进入指定患者的综合报告页。'
        });
        return;
    }

    try {
        const report = await window.API.Doctor.getPatientReportDetails(patientId);
        reportLoading.classList.add('hidden');

        if (
            !report?.latest_scale &&
            !report?.latest_imaging_visualization &&
            !report?.latest_model_prediction &&
            !report?.cognitive_profile &&
            !report?.tracking_summary
        ) {
            showEmptyState({
                title: '还没有生成报告内容',
                description: '请先让患者完成量表、认知测试或 14 天追踪，或者同步影像可视化数据后再查看。'
            });
            return;
        }

        localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
        reportContent.classList.remove('hidden');
        requestAnimationFrame(() => {
            renderDoctorReport(report);
            requestAnimationFrame(() => {
                [
                    'reportRadar',
                    'cognitiveRadar',
                    'reportTrackingLineChart',
                    'reportTrackingDonutChart'
                ].forEach((id) => {
                    const chartDom = document.getElementById(id);
                    const chart = chartDom ? window.echarts?.getInstanceByDom(chartDom) : null;
                    chart?.resize();
                });
            });
        });

        window.API.Security.getPatientOverview(patientId)
            .then((overview) => {
                renderSecurityOverview(overview);
            })
            .catch((error) => {
                console.error('Failed to load patient security overview:', error);
            });

        openImagingBtn?.addEventListener('click', () => {
            localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
            window.location.href = `doctor_imaging.html?patient_id=${patientId}`;
        });

        openVisualizationBtn?.addEventListener('click', () => {
            localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
            let baseUrl = '';
            let authParams = '';
            if (window.location.protocol === 'file:') {
                baseUrl = 'http://127.0.0.1:8000/';
                authParams = `&_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;
            }
            window.location.href = `${baseUrl}doctor_visualization.html?patient_id=${patientId}${authParams}`;
        });
    } catch (error) {
        console.error('Failed to load doctor report:', error);
        showEmptyState({
            title: '报告加载失败',
            description: error?.message || '当前无法获取这位患者的综合报告，请稍后重试。'
        });
    }
});
