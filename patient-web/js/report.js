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

function createChip(text) {
    const chip = document.createElement('span');
    chip.textContent = text;
    chip.style.cssText = 'padding:0.45rem 0.75rem;border-radius:999px;background:#F8FAFC;border:1px solid #E2E8F0;color:#334155;font-size:0.9rem;font-weight:600;';
    return chip;
}

function createMetaChip(label, value) {
    const chip = document.createElement('div');
    chip.className = 'report-meta-chip';
    chip.appendChild(SafeRender.html`
        <span class="report-meta-chip-label">${label}</span>
        <span class="report-meta-chip-value">${value}</span>
    `);
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
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
}

function getConfidenceLevel(probability) {
    return '未提供校准置信度';
}

function getControlProbability(prediction) {
    const supplied = prediction?.probability_control;
    if (supplied === null || supplied === undefined || supplied === '') return null;
    const value = Number(supplied);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function showEmptyState(options = {}) {
    const loading = document.getElementById('reportLoading');
    const empty = document.getElementById('reportEmpty');
    const content = document.getElementById('reportContent');
    const title = empty?.querySelector('h3');
    const description = empty?.querySelector('p');
    const action = empty?.querySelector('a');

    loading?.classList.add('hidden');
    content?.classList.add('hidden');
    empty?.classList.remove('hidden');

    if (title) {
        title.textContent = options.title || '暂时还没有可展示的报告内容';
    }
    if (description) {
        description.textContent = options.description || '请先完成量表、认知测试或 14 天追踪，系统会再生成更完整的综合报告。';
    }
    if (action) {
        action.href = options.actionHref || 'patient_scale.html';
        action.textContent = options.actionLabel || '去填写量表';
    }
}

function wrapRadarLabel(label) {
    if (!label || label.length <= 4) return label;
    const chunks = [];
    for (let i = 0; i < label.length; i += 4) {
        chunks.push(label.slice(i, i + 4));
    }
    return chunks.join('\n');
}

function getRadarLayout(containerId, indicatorCount) {
    if (containerId === 'cognitiveRadar') {
        return {
            center: ['50%', '50%'],
            radius: indicatorCount >= 4 ? '64%' : '68%',
            axisNameWidth: 128,
            axisNameFontSize: 13,
            nameGap: 14
        };
    }

    return {
        center: ['50%', '50%'],
        radius: indicatorCount >= 5 ? '66%' : '70%',
        axisNameWidth: 132,
        axisNameFontSize: 13,
        nameGap: 16
    };
}

function initRadarChart(containerId, radarScores, labels) {
    const chartDom = document.getElementById(containerId);
    if (!chartDom) return;

    if (!window.echarts || !radarScores || !Object.keys(radarScores).length) {
        chartDom.style.display = 'none';
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

    if (chartDom.__radarResizeHandler) {
        window.removeEventListener('resize', chartDom.__radarResizeHandler);
    }
    chartDom.__radarResizeHandler = () => chart.resize();
    window.addEventListener('resize', chartDom.__radarResizeHandler);
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
        row.appendChild(SafeRender.html`<ion-icon name="checkmark-circle-outline" style="color:#10B981; font-size:1.05rem; margin-top:0.2rem;"></ion-icon><span>${item}</span>`);
        recommendations.appendChild(row);
    });

    disclaimer.innerHTML = '<strong>辅助说明：</strong> 量表结果用于帮助理解当前状态，不代表最终医学诊断。';
    initRadarChart('reportRadar', scale.radar_scores || {}, REPORT_RADAR_LABELS);
}

function renderImagingHistory(report) {
    const status = report.imaging_history_status || '';
    const message = {
        storage_upgrade_required: '影像存储待升级，暂不能读取已有记录。',
        conversion_required: '影像旧记录待审核转换，暂不能读取。',
        not_authorized: '影像与模型资料未共享'
    }[status] || (status && !['ready', 'no_records'].includes(status) ? '影像记录状态待核对，暂不能读取。' : '');
    const notice = document.getElementById('imagingHistoryStatus');
    if (notice) {
        notice.textContent = message;
        notice.classList.toggle('hidden', !message);
    }
    const readable = !status || status === 'ready';
    renderImagingSummary(readable ? report.latest_imaging_visualization : null);
    renderModelPredictionSummary(readable ? report.latest_model_prediction : null);
}

function renderImagingSummary(imaging) {
    const section = document.getElementById('imagingSection');
    if (!imaging) {
        section.classList.add('hidden');
        ['imagingBadge', 'imagingSummary', 'imagingInterpretation', 'imagingMeta', 'imagingFiles'].forEach(id => {
            const node = document.getElementById(id); if (node) node.textContent = '';
        });
        ['imagingSlicePreview', 'imagingSurfacePreview'].forEach(id => {
            const node = document.getElementById(id); if (node) SafeRender.setImage(node, null);
        });
        return;
    }

    section.classList.remove('hidden');
    document.getElementById('imagingBadge').textContent = imaging.visualization_type.toUpperCase();
    document.getElementById('imagingSummary').textContent = imaging.summary_text || '已生成影像可视化摘要。';

    const interpretation = document.getElementById('imagingInterpretation');
    if (interpretation) {
        const interpretationParts = [];
        if (imaging.slice_interpretation) {
            interpretationParts.push(`脑剖面解读：${imaging.slice_interpretation}`);
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
        SafeRender.setImage(slicePreview, imaging.slice_screenshot_data, imaging.slice_screenshot_name || '脑剖面截图',
            '研究人员上传脑剖面截图后，这里会显示在报告摘要中。', 'width:100%;height:100%;object-fit:contain;border-radius:12px;');
    }

    const surfacePreview = document.getElementById('imagingSurfacePreview');
    if (surfacePreview) {
        SafeRender.setImage(surfacePreview, imaging.surface_screenshot_data, imaging.surface_screenshot_name || '3D表面截图',
            '研究人员上传 3D 表面截图后，这里会显示在报告摘要中。', 'width:100%;height:100%;object-fit:contain;border-radius:12px;');
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
        imaging.anat_file_name ? `脑剖面文件：${imaging.anat_file_name}` : null,
        imaging.mask_file_name ? `掩膜文件：${imaging.mask_file_name}` : null,
        imaging.left_func_file_name ? `左半球功能：${imaging.left_func_file_name}` : null,
        imaging.left_mesh_file_name ? `左半球表面：${imaging.left_mesh_file_name}` : null,
        imaging.right_func_file_name ? `右半球功能：${imaging.right_func_file_name}` : null,
        imaging.right_mesh_file_name ? `右半球表面：${imaging.right_mesh_file_name}` : null,
        imaging.slice_screenshot_name ? `脑剖面截图：${imaging.slice_screenshot_name}` : null,
        imaging.surface_screenshot_name ? `3D表面截图：${imaging.surface_screenshot_name}` : null
    ].filter(Boolean).forEach((text) => files.appendChild(createChip(text)));
}

function renderModelPredictionSummary(prediction) {
    const section = document.getElementById('modelPredictionSection');
    if (!section) return;

    if (!prediction) {
        section.classList.add('hidden');
        ['modelPredictionBadge', 'modelPredictionLabel', 'modelPredictionConfidence', 'modelPredictionSummary',
            'modelPredictionMeta', 'modelPredictionAdhdValue', 'modelPredictionControlValue', 'modelPredictionDemoNotice'].forEach(id => {
            const node = document.getElementById(id); if (node) node.textContent = '';
        });
        ['modelPredictionAdhdBar', 'modelPredictionControlBar'].forEach(id => {
            const node = document.getElementById(id); if (node) node.style.width = '0%';
        });
        return;
    }

    section.classList.remove('hidden');
    const controlProbability = getControlProbability(prediction);

    const demo = prediction.is_demo === true || prediction.source_type === 'mock';
    document.getElementById('modelPredictionBadge').textContent = `${demo ? '演示 · ' : ''}${prediction.prediction_label} · ${formatPercent(prediction.probability)}`;
    document.getElementById('modelPredictionLabel').textContent = prediction.prediction_label || '--';
    document.getElementById('modelPredictionConfidence').textContent = getConfidenceLevel(prediction.probability);
    document.getElementById('modelPredictionSummary').textContent =
        prediction.summary_text ||
        `基于时间序列影像分析，当前模型输出标签为 ${prediction.prediction_label}，对应概率为 ${formatPercent(prediction.probability)}。`;

    const meta = document.getElementById('modelPredictionMeta');
    meta.innerHTML = '';
    [
        `生成时间：${formatDateTime(prediction.created_at)}`,
        demo ? '演示结果，不用于临床' : prediction.source_admission_status === 'legacy_accepted' ? '沿用原有HGST权重，训练来源未重新核验' : !prediction.source_admission_status || prediction.source_admission_status === 'not_recorded' ? '历史来源准入状态未记录' : '来源准入状态待核对',
        !prediction.professional_review_status || prediction.professional_review_status === 'not_recorded' ? '专业审核状态未记录' : '专业审核状态待核对',
        !prediction.version_status || prediction.version_status === 'legacy_unversioned' ? '尚未绑定不可变报告版本' : '报告版本待核对',
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
    document.getElementById('modelPredictionControlBar').style.visibility = controlProbability === null ? 'hidden' : '';
}

function renderCognitiveSummary(profile) {
    const section = document.getElementById('cognitiveSection');
    if (!profile) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');
    const groups = Array.isArray(profile.protocol_profiles) && profile.protocol_profiles.length
        ? profile.protocol_profiles : [profile];
    const meta = document.getElementById('cognitiveMeta');
    const tests = document.getElementById('cognitiveTests');
    let selector = null;
    if (groups.length > 1) {
        selector = document.createElement('select');
        selector.id = 'cognitiveProtocolSelect';
        selector.ariaLabel = '选择认知测试来源与协议';
        selector.style.cssText = 'width:100%;padding:0.7rem;border:1px solid #CBD5E1;border-radius:10px;background:#FFFFFF;color:#334155;';
        groups.forEach((group) => {
            const option = document.createElement('option');
            option.value = group.protocol_key;
            const source = { patient_web: '网页', miniprogram: '小程序', unknown: '来源未知' }[group.source] || group.source;
            const age = { adult: '成人', child: '儿童', unspecified: '未区分年龄', unknown: '年龄组未知' }[group.age_group] || group.age_group;
            option.textContent = `${source} · ${group.protocol_label || group.protocol_id} v${group.protocol_schema_version} · ${age}`;
            selector.appendChild(option);
        });
        selector.value = profile.active_protocol_key || groups[0].protocol_key;
        selector.addEventListener('change', () => {
            renderGroup(groups.find((group) => group.protocol_key === selector.value) || groups[0]);
        });
    }
    function renderGroup(group) {
        document.getElementById('cognitiveBadge').textContent = `${group.latest_tests?.length || 0} 项测试`;
        document.getElementById('cognitiveSummary').textContent = group.summary || '已生成认知能力摘要。';
        meta.innerHTML = '';
        if (selector) meta.appendChild(selector);
        Object.entries(group.radar_scores || {}).forEach(([key, value]) => {
            meta.appendChild(createChip(`${COGNITIVE_RADAR_LABELS[key] || key}：${value}/20`));
        });
        tests.innerHTML = '';
        (group.latest_tests || []).forEach((item) => {
            const row = document.createElement('div');
            row.style.cssText = 'padding:0.95rem 1rem;border-radius:14px;background:#F8FAFC;border:1px solid #E2E8F0;';
            const heading = document.createElement('div');
            heading.style.cssText = 'display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:0.35rem;';
            const title = document.createElement('strong');
            title.style.cssText = 'color:#0F172A;font-size:0.96rem;';
            title.textContent = item.test_name;
            const time = document.createElement('span');
            time.style.cssText = 'color:#64748B;font-size:0.82rem;';
            time.textContent = formatDateTime(item.finished_at);
            heading.appendChild(title);
            heading.appendChild(time);
            const detail = document.createElement('div');
            detail.style.cssText = 'color:#475569;font-size:0.9rem;line-height:1.6;';
            detail.textContent = `${item.status_text} · 关键指标：${item.key_metric}`;
            row.appendChild(heading);
            row.appendChild(detail);
            tests.appendChild(row);
        });
        initRadarChart('cognitiveRadar', group.radar_scores || {}, COGNITIVE_RADAR_LABELS);
    }
    renderGroup(groups.find((group) => group.protocol_key === profile.active_protocol_key) || groups[0]);
}

function initTrackingCharts(logs = [], totalDays = 14) {
    if (!window.echarts) return;

    const lineDom = document.getElementById('reportTrackingLineChart');
    const donutDom = document.getElementById('reportTrackingDonutChart');
    if (!lineDom || !donutDom) return;

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
        tooltip: { trigger: 'axis', formatter: '{b}<br/>情绪评分: {c}' },
        grid: { left: '6%', right: '4%', bottom: '8%', top: '10%', containLabel: true },
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
            splitLine: { lineStyle: { type: 'dashed', color: '#E5EEF8' } },
            axisLabel: { color: '#64748B' }
        },
        series: [{
            type: 'line',
            smooth: true,
            data: moodData,
            itemStyle: { color: '#0EA5E9' },
            lineStyle: { width: 4 },
            areaStyle: {
                color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(14, 165, 233, 0.28)' },
                    { offset: 1, color: 'rgba(14, 165, 233, 0)' }
                ])
            }
        }]
    });

    const donutChart = window.echarts.init(donutDom);
    donutChart.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} 次 ({d}%)' },
        legend: { bottom: '0%', left: 'center', icon: 'circle', textStyle: { color: '#64748B' } },
        series: [{
            type: 'pie',
            radius: ['42%', '72%'],
            itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
            label: { show: false },
            labelLine: { show: false },
            data: [
                { value: moodCounts[5], name: '状态很好', itemStyle: { color: '#10B981' } },
                { value: moodCounts[4], name: '整体不错', itemStyle: { color: '#84CC16' } },
                { value: moodCounts[3], name: '状态一般', itemStyle: { color: '#FBBF24' } },
                { value: moodCounts[2], name: '有些吃力', itemStyle: { color: '#F97316' } },
                { value: moodCounts[1], name: '状态低落', itemStyle: { color: '#EF4444' } }
            ].filter((item) => item.value > 0)
        }]
    });

    window.addEventListener('resize', () => {
        lineChart.resize();
        donutChart.resize();
    }, { once: true });
}

function renderTrackingSection(report, dashboardStatus = null) {
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
        ? `最近 ${tracking.completed_count} 天的追踪已经形成了较稳定的动态记录，能够帮助你更直观地看到情绪和专注的波动。`
        : '14 天追踪还没有开始，建议从今天先记录一条简短状态。';

    initTrackingCharts(dashboardStatus?.logs || [], tracking.total_days || 14);
}

function renderPatientCareSection() {
    const section = document.getElementById('careSection');
    const taskList = document.getElementById('patientTaskList');
    const taskEmpty = document.getElementById('patientTaskEmpty');
    const messageList = document.getElementById('patientMessageList');
    const messageEmpty = document.getElementById('patientMessageEmpty');

    if (!section || !taskList || !taskEmpty || !messageList || !messageEmpty) return;
    section.classList.remove('hidden');

    function renderMessageThread(items = []) {
        messageList.innerHTML = '';
        if (!items.length) {
            messageEmpty.style.display = 'block';
            return;
        }

        messageEmpty.style.display = 'none';
        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = `care-message-row ${item.sender_role === 'patient' ? 'patient' : 'researcher'}`;
            const bubble = document.createElement('div');
            bubble.className = 'care-message-bubble';
            bubble.appendChild(SafeRender.html`
                <div>${item.content}</div>
                <span class="care-message-meta">${item.sender_role === 'patient' ? '患者' : '研究人员'} · ${formatDateTime(item.created_at)}</span>
            `);
            row.appendChild(bubble);
            messageList.appendChild(row);
        });
    }

    async function refreshCare() {
        const [taskData, messageData] = await Promise.all([
            window.API.Care.getMyTasks(),
            window.API.Care.getPatientMessages()
        ]);

        taskList.innerHTML = '';
        const tasks = taskData.items || [];
        if (!tasks.length) {
            taskEmpty.style.display = 'block';
        } else {
            taskEmpty.style.display = 'none';
            tasks.forEach((task) => {
                const row = document.createElement('div');
                row.className = 'care-mini-row';
                row.appendChild(SafeRender.html`
                    <strong>${task.task_title}</strong><br>
                    ${task.task_description || '研究人员为你安排了下一步任务。'}<br>
                    <span style="color:#64748B;">${task.task_type} · ${task.status === 'completed' ? '已完成' : '待完成'}</span>
                `);

                if (task.status !== 'completed') {
                    const actions = document.createElement('div');
                    actions.className = 'care-mini-actions';

                    const targetUrl = SafeRender.navigationUrl(task.target_page);
                    if (targetUrl) {
                        const link = document.createElement('a');
                        link.href = targetUrl;
                        link.className = 'btn-outline';
                        link.style.textDecoration = 'none';
                        link.style.padding = '0.62rem 0.9rem';
                        link.style.fontSize = '0.84rem';
                        link.textContent = '去做任务';
                        actions.appendChild(link);
                    }

                    const completeBtn = document.createElement('button');
                    completeBtn.type = 'button';
                    completeBtn.className = 'btn-primary-orange';
                    completeBtn.style.padding = '0.62rem 0.9rem';
                    completeBtn.style.fontSize = '0.84rem';
                    completeBtn.textContent = '标记完成';
                    completeBtn.addEventListener('click', async () => {
                        completeBtn.disabled = true;
                        try {
                            await window.API.Care.completeMyTask(task.id);
                            await refreshCare();
                        } catch (error) {
                            completeBtn.disabled = false;
                            alert(error.message || '任务状态更新失败，请稍后重试。');
                        }
                    });
                    actions.appendChild(completeBtn);
                    row.appendChild(actions);
                }

                taskList.appendChild(row);
            });
        }

        renderMessageThread((messageData.items || []).slice(-8));
    }

    refreshCare().catch((error) => {
        console.error('Failed to load patient care data:', error);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const userName = document.getElementById('userName');
    const reportPdfTitle = document.getElementById('reportPdfTitle');
    const reportPdfSubtitle = document.getElementById('reportPdfSubtitle');
    const reportAiDeepLink = document.getElementById('reportAiDeepLink');
    if (userName && storedUser?.full_name) {
        userName.textContent = storedUser.full_name;
    }

    const loading = document.getElementById('reportLoading');
    const content = document.getElementById('reportContent');

    try {
        const [report, dashboardStatus] = await Promise.all([
            window.API.Patient.getComprehensiveReport(),
            window.API.Patient.getDashboardStatus().catch(() => null)
        ]);
        loading.classList.add('hidden');

        if (
            !report.latest_scale &&
            !report.latest_imaging_visualization &&
            !report.latest_model_prediction &&
            !report.cognitive_profile &&
            !report.tracking_summary &&
            (!report.imaging_history_status || ['ready', 'no_records'].includes(report.imaging_history_status))
        ) {
            showEmptyState({
                title: '还没有生成报告内容',
                description: '请先完成行为量表、认知测试或 14 天追踪后，再回来查看更完整的综合报告。',
                actionHref: 'patient_scale.html',
                actionLabel: '去填写量表'
            });
            return;
        }

        content.classList.remove('hidden');
        renderScaleSummary(report);
        renderTrackingSection(report, dashboardStatus);
        renderImagingHistory(report);
        renderCognitiveSummary(report.cognitive_profile);
        renderPatientCareSection();
    } catch (error) {
        console.error('Failed to load patient report:', error);
        showEmptyState({
            title: '报告加载失败',
            description: error?.message || '当前无法获取综合报告，请稍后重试。',
            actionHref: 'patient_scale.html',
            actionLabel: '返回量表页'
        });
    }
});
