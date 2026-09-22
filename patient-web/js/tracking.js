/**
 * 14天追踪页面应用级全栈交互逻辑 - 智绘脑图
 * 重构版本：Daylio 交互风格，支持分步弹窗、信息流展示与环形图表
 */

let lineChartInstance = null;
let donutChartInstance = null;

let state = {
    currentDay: 1,
    totalDays: 14,
    completedDays: [],
    logs: [],
    
    // Wizard Form State
    draftMood: null,
    draftMoodLabel: '',
    draftActivities: [],
    draftNote: '',
    draftFocus: 60,
    currentStep: 1
};

// Mood Config
const MOOD_MAP = {
    5: { emoji: '🤩', name: '狂喜', color: '#10B981' },
    4: { emoji: '😊', name: '开心', color: '#84CC16' },
    3: { emoji: '😐', name: '还行', color: '#FBBF24' },
    2: { emoji: '😕', name: '不良', color: '#F97316' },
    1: { emoji: '😫', name: '超烂', color: '#EF4444' }
};

// --- DOM 元素绑定 ---
const tabs = document.querySelectorAll('.app-tab');
const contentAreas = document.querySelectorAll('.app-content-area');
const logsFeedList = document.getElementById('logsFeedList');
const emptyLogsMsg = document.getElementById('emptyLogsMsg');
const emptyLogsText = document.getElementById('emptyLogsText');
const loginRedirectBtn = document.getElementById('loginRedirectBtn');

const calendarGrid = document.getElementById('calendarGrid');
const calendarProgress = document.getElementById('calendarProgress');

const fabAddLog = document.getElementById('fabAddLog');
const wizardOverlay = document.getElementById('wizardOverlay');
const closeWizardBtn = document.getElementById('closeWizardBtn');
const wizardSteps = [
    document.getElementById('wizardStep1'),
    document.getElementById('wizardStep2'),
    document.getElementById('wizardStep3')
];
const wizardBackBtns = document.querySelectorAll('.wizard-back');
const wizardNextBtns = document.querySelectorAll('.wizard-next-btn');

const hugeMoodBtns = document.querySelectorAll('.huge-mood-btn');
const activityPills = document.querySelectorAll('.activity-pill');
const saveLogBtnFinal = document.getElementById('saveLogBtnFinal');
const magicFillBtn = document.getElementById('magicFillBtn');

const focusSlider = document.getElementById('focusSlider');
const focusValue = document.getElementById('focusValue');
const wizardNoteInput = document.getElementById('wizardNoteInput');


// --- 初始化 ---
async function init() {
    try {
        const data = await window.API.Patient.getDashboardStatus();
        state.currentDay = data.current_day;
        state.completedDays = data.completed_days || [];
        state.logs = data.logs || [];
        state.totalDays = data.total_days || 14;

        renderApp();
        
    } catch (error) {
        console.error('初始化失败:', error);
        logsFeedList.innerHTML = '';
        emptyLogsText.innerText = '拉取数据失败，您似乎还没有登录哦~';
        loginRedirectBtn.style.display = 'inline-block';
    }
}

// --- 核心渲染 ---
function renderApp() {
    // 1. 渲染信息流 (Feed)
    if (state.logs.length === 0) {
        emptyLogsMsg.style.display = 'block';
        emptyLogsText.innerText = '今天还没有记录哦，快来写下你的第一篇日记吧！';
        loginRedirectBtn.style.display = 'none';
        logsFeedList.innerHTML = '';
    } else {
        emptyLogsMsg.style.display = 'none';
        logsFeedList.innerHTML = '';
        // 倒序排列，最新的在上面
        const sortedLogs = [...state.logs].sort((a, b) => b.day_index - a.day_index);
        
        sortedLogs.forEach(log => {
            const mood = MOOD_MAP[log.mood_tag] || MOOD_MAP[3];
            let actsHtml = '';
            if (log.activities) {
                const acts = log.activities.split(',');
                actsHtml = acts.map(a => `<span class="log-card-activity-pill">${a}</span>`).join('');
            }
            
            const card = document.createElement('div');
            card.className = 'log-card';

            // Build extra info
            let extraHtml = '';
            if (log.is_medication) {
                extraHtml += `<span style="font-size:0.75rem; background:#EFF6FF; color:#3B82F6; padding:2px 8px; border-radius:4px;">用药${log.medication_dosage ? ` (${log.medication_dosage})` : ''}</span>`;
            }
            if (log.sleep_quality) {
                extraHtml += `<span style="font-size:0.75rem; background:#F0FDF4; color:#16A34A; padding:2px 8px; border-radius:4px;">睡眠:${log.sleep_quality}</span>`;
            }
            if (log.has_conflict) {
                extraHtml += `<span style="font-size:0.75rem; background:#FEF2F2; color:#DC2626; padding:2px 8px; border-radius:4px;">有冲突</span>`;
            }
            if (log.was_criticized) {
                extraHtml += `<span style="font-size:0.75rem; background:#FEF2F2; color:#DC2626; padding:2px 8px; border-radius:4px;">受批评</span>`;
            }

            // Build core ratings display
            let ratingsHtml = '';
            const ratingLabels = { attention: '注意力', hyperactivity: '多动', impulsivity: '冲动', emotion: '情绪', taskCompletion: '任务' };
            const ratingEmojis = ['', '😫', '😕', '😐', '😊', '🤩'];
            const ratingFields = ['attention', 'hyperactivity', 'impulsivity', 'emotion', 'taskCompletion'];
            const ratingValues = ratingFields.map(f => log[`${f}_rating`]).filter(v => v != null);
            if (ratingValues.length > 0) {
                const ratingParts = ratingFields
                    .filter(f => log[`${f}_rating`] != null)
                    .map(f => `${ratingLabels[f]}${ratingEmojis[log[`${f}_rating`]]}`);
                ratingsHtml = `<div style="font-size:0.75rem; color:#64748B; margin-top:4px;">${ratingParts.join(' · ')}</div>`;
            }

            card.innerHTML = `
                <div class="log-card-header">
                    <span class="log-card-date">第 ${log.day_index} 天打卡记录</span>
                    <span class="log-card-emoji" title="${mood.name}">${mood.emoji}</span>
                </div>
                ${actsHtml ? `<div class="log-card-activities">${actsHtml}</div>` : ''}
                ${log.note ? `<div class="log-card-note">"${log.note}"</div>` : ''}
                ${ratingsHtml}
                ${extraHtml ? `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">${extraHtml}</div>` : ''}
                <div style="font-size:0.8rem; color:#94A3B8; margin-top:4px;">
                    专注表现: ${log.focus_minutes || 0} min &nbsp; • &nbsp; ${new Date(log.created_at).toLocaleString()}
                </div>
            `;
            logsFeedList.appendChild(card);
        });
    }

    // 2. 渲染日历网格
    calendarProgress.innerText = `进度: ${state.completedDays.length}/${state.totalDays}`;
    calendarGrid.innerHTML = '';
    for (let i = 1; i <= state.totalDays; i++) {
        const log = state.logs.find(l => l.day_index === i);
        const cell = document.createElement('div');
        cell.className = 'cal-cell';
        if (log) {
            cell.classList.add('completed');
            const mood = MOOD_MAP[log.mood_tag] || MOOD_MAP[3];
            cell.innerText = mood.emoji;
            cell.style.background = `${mood.color}20`; // 带透明度底色
        } else {
            cell.innerText = i;
        }
        calendarGrid.appendChild(cell);
    }

    // 3. 渲染图表
    if (state.logs.length > 0) {
        renderCharts();
    }
}

// --- Tabs 交互 ---
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        contentAreas.forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
        
        // ECharts 需要在可见时 resize 保证尺寸正确
        if (tab.dataset.target === 'tab-charts') {
            setTimeout(() => {
                if (lineChartInstance) lineChartInstance.resize();
                if (donutChartInstance) donutChartInstance.resize();
            }, 100);
        }
    });
});

// --- Wizard 弹窗控制逻辑 ---
fabAddLog.addEventListener('click', () => {
    // 检查是否超过 14 天
    if (state.currentDay > state.totalDays) {
        alert("恭喜您，14天追踪已全部完成！");
        return;
    }
    
    // 初始化向导
    state.draftMood = null;
    state.draftActivities = [];
    state.draftNote = '';
    state.draftFocus = 60;
    state.currentStep = 1;

    hugeMoodBtns.forEach(b => b.classList.remove('selected'));
    activityPills.forEach(p => p.classList.remove('selected'));
    wizardNoteInput.value = '';
    focusSlider.value = 60;
    updateFocusSliderVisual(60);
    
    document.getElementById('wizardDateObj').innerText = `第 ${state.currentDay} 天的记录`;

    goToStep(1);
    wizardOverlay.style.display = 'flex';
});

closeWizardBtn.addEventListener('click', () => {
    wizardOverlay.style.display = 'none';
});

wizardOverlay.addEventListener('click', (event) => {
    if (event.target === wizardOverlay) {
        wizardOverlay.style.display = 'none';
    }
});

wizardBackBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (state.currentStep > 1) {
            goToStep(state.currentStep - 1);
        }
    });
});

wizardNextBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.id === 'saveLogBtnFinal') return; // 保存按钮另算
        
        if (state.currentStep === 1 && !state.draftMood) {
            alert('请先选择一个心情哦！');
            return;
        }
        
        if (state.currentStep === 2) {
            // 解析出选择的活动
            state.draftActivities = Array.from(document.querySelectorAll('.activity-pill.selected'))
                                         .map(el => el.innerText.trim());
            // 更新预览
            const mood = MOOD_MAP[state.draftMood];
            document.getElementById('previewMoodEmoji').innerText = mood.emoji;
            document.getElementById('previewActivities').innerHTML = 
                state.draftActivities.map(a => `<span class="log-card-activity-pill">${a}</span>`).join('');
        }

        if (state.currentStep < 3) {
            goToStep(state.currentStep + 1);
        }
    });
});

function goToStep(stepNum) {
    state.currentStep = stepNum;
    wizardSteps.forEach((step, idx) => {
        if (!step) return;
        step.classList.toggle('active', idx + 1 === stepNum);
        if (idx + 1 === stepNum) {
            step.style.transform = 'translateX(0)';
        } else if (idx + 1 < stepNum) {
            step.style.transform = 'translateX(-100%)';
        } else {
            step.style.transform = 'translateX(100%)';
        }
    });
}

// 情绪单选
hugeMoodBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        hugeMoodBtns.forEach((b) => {
            b.classList.remove('selected');
            b.style.removeProperty('--color');
            b.style.removeProperty('--bg-color');
        });
        const target = e.currentTarget;
        target.classList.add('selected');
        if (target.dataset.color) {
            target.style.setProperty('--color', target.dataset.color);
            target.style.setProperty('--bg-color', `${target.dataset.color}20`);
        }
        state.draftMood = parseInt(target.dataset.mood, 10);
        state.draftMoodLabel = target.dataset.label || '';
        
        // 自动延时跳下一步，体验更流畅
        setTimeout(() => goToStep(2), 300);
    });
});

// 活动多选
activityPills.forEach(pill => {
    pill.addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('selected');
    });
});

// 专注力拉动
focusSlider.addEventListener('input', (e) => {
    updateFocusSliderVisual(e.target.value);
});

function updateFocusSliderVisual(val) {
    focusValue.innerText = val;
    state.draftFocus = parseInt(val);
    const percent = (val / 180) * 100;
    focusSlider.style.setProperty('--bg-size', `${percent}%`);
}

// 保存逻辑
saveLogBtnFinal.addEventListener('click', async () => {
    state.draftNote = wizardNoteInput.value.trim();

    // Collect core ratings
    const coreRatings = {};
    ['attention', 'hyperactivity', 'impulsivity', 'emotion', 'taskCompletion'].forEach(field => {
        const selected = document.querySelector(`.core-rating-btn[data-field="${field}"][style*="border-color: rgb(59, 130, 246)"]`);
        coreRatings[field] = selected ? parseInt(selected.dataset.score) : null;
    });

    // Collect life items
    const sleepGroup = document.querySelector('.life-item-group[data-field="sleep_quality"]');
    const sleepSelected = sleepGroup?.querySelector('.life-item-btn[style*="border-color: rgb(59, 130, 246)"]');

    const appetiteGroup = document.querySelector('.life-item-group[data-field="appetite_quality"]');
    const appetiteSelected = appetiteGroup?.querySelector('.life-item-btn[style*="border-color: rgb(59, 130, 246)"]');

    const sideEffectsGroup = document.querySelector('.life-item-group[data-field="side_effects"]');
    const sideEffectsSelected = Array.from(sideEffectsGroup?.querySelectorAll('.life-item-btn.selected') || []).map(b => b.dataset.value);

    const payload = {
        day_index: state.currentDay,
        mood_tag: state.draftMood.toString(),
        focus_minutes: state.draftFocus,
        note: state.draftNote,
        activities: state.draftActivities.join(','),
        is_medication: document.getElementById('medication')?.checked || false,
        medication_dosage: document.getElementById('medicationDosage')?.value || null,
        attention_rating: coreRatings.attention,
        hyperactivity_rating: coreRatings.hyperactivity,
        impulsivity_rating: coreRatings.impulsivity,
        emotion_rating: coreRatings.emotion,
        task_completion_rating: coreRatings.taskCompletion,
        sleep_quality: sleepSelected?.dataset.value || null,
        appetite_quality: appetiteSelected?.dataset.value || null,
        has_conflict: document.getElementById('conflict')?.checked || false,
        was_criticized: document.getElementById('criticism')?.checked || false,
        side_effects: sideEffectsSelected.length > 0 ? sideEffectsSelected.join(',') : null,
        special_events: document.getElementById('specialEvents')?.value?.trim() || null,
        highlights: document.getElementById('highlights')?.value?.trim() || null
    };

    try {
        saveLogBtnFinal.innerHTML = '保存中...';
        saveLogBtnFinal.disabled = true;
        
        await window.API.Patient.submitDailyLog(payload);
        document.dispatchEvent(new CustomEvent('tracking:log-saved'));
        
        wizardOverlay.style.display = 'none';
        saveLogBtnFinal.innerHTML = '保存 <ion-icon name="checkmark-circle"></ion-icon>';
        saveLogBtnFinal.disabled = false;
        
        init(); // 重新拉取数据刷新界面

    } catch (error) {
        alert(`保存失败: ${error.message}`);
        saveLogBtnFinal.innerHTML = '保存 <ion-icon name="checkmark-circle"></ion-icon>';
        saveLogBtnFinal.disabled = false;
    }
});


// --- ECharts 图表引擎 ---
function renderCharts() {
    if (!lineChartInstance) {
        lineChartInstance = echarts.init(document.getElementById('lineChart'));
    }
    if (!donutChartInstance) {
        donutChartInstance = echarts.init(document.getElementById('donutChart'));
    }

    const days = Array.from({length: state.totalDays}, (_, i) => `D${i+1}`);
    const moodData = new Array(state.totalDays).fill(null);
    let moodCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    state.logs.forEach(log => {
        const idx = log.day_index - 1;
        if (idx >= 0 && idx < state.totalDays) {
            const m = parseInt(log.mood_tag) || 3;
            moodData[idx] = m;
            moodCounts[m] += 1;
        }
    });

    // 折线趋势图
    const lineOption = {
        tooltip: { trigger: 'axis', formatter: '{b}<br/>心情值: {c}' },
        grid: { left: '3%', right: '4%', bottom: '5%', top: '10%', containLabel: true },
        xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { lineStyle: { color: '#E2E8F0' } }, axisLabel: { color: '#64748B' } },
        yAxis: { type: 'value', min: 1, max: 5, interval: 1, splitLine: { lineStyle: { type: 'dashed', color: '#F1F5F9' } }, axisLabel: { color: '#64748B' } },
        series: [{
            name: '心情',
            type: 'line',
            smooth: true,
            data: moodData,
            itemStyle: { color: '#10B981' },
            lineStyle: { width: 4, shadowColor: 'rgba(16, 185, 129, 0.3)', shadowBlur: 10 },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(16, 185, 129, 0.3)' },
                    { offset: 1, color: 'rgba(16, 185, 129, 0)' }
                ])
            }
        }]
    };
    lineChartInstance.setOption(lineOption);

    // 甜甜圈饼图
    const donutData = [
        { value: moodCounts[5], name: '狂喜', itemStyle: { color: '#10B981' } },
        { value: moodCounts[4], name: '开心', itemStyle: { color: '#84CC16' } },
        { value: moodCounts[3], name: '还行', itemStyle: { color: '#FBBF24' } },
        { value: moodCounts[2], name: '不良', itemStyle: { color: '#F97316' } },
        { value: moodCounts[1], name: '超烂', itemStyle: { color: '#EF4444' } }
    ].filter(i => i.value > 0);

    const donutOption = {
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
            data: donutData
        }]
    };
    donutChartInstance.setOption(donutOption);
}

// --- 演示专用 Magic Fill ---
const DEMO_ACTIVITIES = [
    "良好睡眠", "睡眠不足", "深度办公", "见朋友", "冥想", "打游戏", "垃圾食品", "锻炼"
];
magicFillBtn.addEventListener('click', async () => {
    if (!confirm('✨ 确定要生成 14 天的完整趋势演示数据吗？')) return;
    
    try {
        magicFillBtn.innerText = '正在施法生成数据...';
        magicFillBtn.disabled = true;

        for (let i = 1; i <= 14; i++) {
            // 伪造一点随机真实的波浪规律
            const baseMood = i < 5 ? 4 : (i < 10 ? 2 : 4);
            const rMood = Math.max(1, Math.min(5, baseMood + Math.floor(Math.random() * 3) - 1));
            
            const shuffled = [...DEMO_ACTIVITIES].sort(() => 0.5 - Math.random());
            const selectedActs = shuffled.slice(0, 2 + Math.floor(Math.random() * 2)); // 取2~3个活动

            const payload = {
                day_index: i,
                mood_tag: rMood.toString(),
                focus_minutes: 30 + Math.floor(Math.random() * 100),
                note: `这是来自 AI Magic Fill 的自动生成的第 ${i} 天记录随笔。`,
                activities: selectedActs.join(','),
                is_medication: Math.random() > 0.6,
                medication_dosage: Math.random() > 0.6 ? '10mg' : null,
                attention_rating: Math.max(1, Math.min(5, 3 + Math.floor(Math.random() * 3) - 1)),
                hyperactivity_rating: Math.max(1, Math.min(5, 3 + Math.floor(Math.random() * 3) - 1)),
                impulsivity_rating: Math.max(1, Math.min(5, 3 + Math.floor(Math.random() * 3) - 1)),
                emotion_rating: Math.max(1, Math.min(5, 3 + Math.floor(Math.random() * 3) - 1)),
                task_completion_rating: Math.max(1, Math.min(5, 3 + Math.floor(Math.random() * 3) - 1)),
                sleep_quality: ['很好', '一般', '较差'][Math.floor(Math.random() * 3)],
                appetite_quality: ['很好', '一般', '较差'][Math.floor(Math.random() * 3)],
                has_conflict: Math.random() > 0.7,
                was_criticized: Math.random() > 0.8,
                side_effects: Math.random() > 0.7 ? '头痛,失眠' : null,
                special_events: null,
                highlights: null
            };
            await window.API.Patient.submitDailyLog(payload);
        }
        
        await init();
        document.dispatchEvent(new CustomEvent('tracking:log-saved'));
        magicFillBtn.innerText = '✨ 数据已装填完毕';
        // 自动切到图表 tab 观赏
        document.querySelector('.app-tab[data-target="tab-charts"]').click();

    } catch (error) {
        alert('填充失败: ' + error.message);
        magicFillBtn.innerText = '一键补齐 14 天演示数据';
        magicFillBtn.disabled = false;
    }
});

// 窗口自适应
window.addEventListener('resize', () => {
    if (lineChartInstance) lineChartInstance.resize();
    if (donutChartInstance) donutChartInstance.resize();
});

// 启动
document.addEventListener('DOMContentLoaded', init);
