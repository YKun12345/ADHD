/**
 * orchestrator.js - 智能任务编排器
 * 根据患者当前状态（量表、认知测试、14天追踪、报告、安全审计）
 * 自动计算"下一步最应该做什么"并驱动首页闭环提示
 */
(function () {

    // ==============================
    // 任务步骤定义（与 clinical_pathway 保持一致）
    // ==============================
    const STEP_DEFS = [
        {
            id: 'scale',
            stepNum: 2,
            icon: 'document-text-outline',
            title: '完成行为量表',
            shortTitle: '行为量表',
            reason: '量表是整个评估链路的基础画像，需要优先完成。',
            reward: '完成后将解锁认知测试入口，系统会为你建立医学评估基线。',
            url: 'patient_scale.html',
            btnText: '去填写量表',
            color: '#7C3AED',
            bgColor: 'rgba(124, 58, 237, 0.08)'
        },
        {
            id: 'cognitive',
            stepNum: 3,
            icon: 'game-controller-outline',
            title: '完成认知测试',
            shortTitle: '认知测试',
            reason: '你已完成量表，接下来需要客观的神经认知数据来验证量表画像。',
            reward: '完成后AI将对比主观量表与客观神经数据，生成更全面的评估。',
            url: 'patient_test.html',
            btnText: '开始认知测试',
            color: '#2563EB',
            bgColor: 'rgba(37, 99, 235, 0.08)'
        },
        {
            id: 'tracking',
            stepNum: 4,
            icon: 'calendar-outline',
            title: '开始14天追踪',
            shortTitle: '14天追踪',
            reason: '量表和认知测试已完成，连续追踪会让你的数据更有纵向价值。',
            reward: '14天追踪完成后，AI将生成动态趋势分析，并触发综合报告生成。',
            url: 'patient_tracking.html',
            btnText: '今天开始打卡',
            color: '#059669',
            bgColor: 'rgba(5, 150, 105, 0.08)'
        },
        {
            id: 'tracking_continue',
            stepNum: 4,
            icon: 'calendar-outline',
            title: '继续14天追踪',
            shortTitle: '追踪打卡',
            reason: '你的追踪还未完成，连续记录让数据更有价值。',
            reward: '完成14天追踪后将解锁完整AI趋势分析和综合报告功能。',
            url: 'patient_tracking.html',
            btnText: '继续今日打卡',
            color: '#059669',
            bgColor: 'rgba(5, 150, 105, 0.08)'
        },
        {
            id: 'view_report',
            stepNum: 5,
            icon: 'sparkles-outline',
            title: '查看AI解读报告',
            shortTitle: 'AI 解读',
            reason: '你的核心评估数据已经比较完整，是时候看看AI的综合解读了。',
            reward: '报告包含五维执行功能雷达图、趋势分析和个性化干预建议。',
            url: 'patient_report.html',
            btnText: '查看综合报告',
            color: '#F59E0B',
            bgColor: 'rgba(245, 158, 11, 0.08)'
        },
        {
            id: 'complete',
            stepNum: 8,
            icon: 'trophy-outline',
            title: '评估路径已完成',
            shortTitle: '已完成',
            reason: '恭喜！你的整条临床评估路径已经完成。',
            reward: '你可以查看完整的综合报告，并与研究人员讨论下一步干预计划。',
            url: 'clinical_pathway.html',
            btnText: '查看完整路径',
            color: '#047857',
            bgColor: 'rgba(4, 120, 87, 0.08)'
        }
    ];

    // ==============================
    // 核心编排逻辑
    // ==============================
    function computeNextAction(reportData, dashboardData) {
        const scale = reportData?.latest_scale;
        const cog = reportData?.cognitive_profile;
        const tracking = reportData?.tracking_summary;
        const imaging = reportData?.imaging_analysis;

        const trackingDone = tracking?.completed_count || 0;
        const trackingTotal = tracking?.total_days || 14;

        // 计算完成的步骤数（共8步）
        let completedSteps = 1; // 注册登录默认完成

        // Step 2: 量表
        if (!scale) {
            return { step: STEP_DEFS[0], completedSteps, currentStep: 2, totalSteps: 8 };
        }
        completedSteps++;

        // Step 3: 认知测试
        if (!cog || cog.sessions_count < 1) {
            return { step: STEP_DEFS[1], completedSteps, currentStep: 3, totalSteps: 8 };
        }
        completedSteps++;

        // Step 4: 14天追踪
        if (trackingDone === 0) {
            return { step: STEP_DEFS[2], completedSteps, currentStep: 4, totalSteps: 8 };
        } else if (trackingDone < trackingTotal) {
            return { step: STEP_DEFS[3], completedSteps: completedSteps + 0.5, currentStep: 4, totalSteps: 8, trackingPct: Math.round(trackingDone / trackingTotal * 100) };
        }
        completedSteps++;

        // Step 5-6: AI解读 + 影像
        if (trackingDone >= trackingTotal && (!imaging?.prediction_label)) {
            return { step: STEP_DEFS[4], completedSteps, currentStep: 5, totalSteps: 8 };
        }
        if (imaging?.prediction_label) completedSteps += 2; // 5+6
        else completedSteps++;

        // Step 7+8: 审计 + 完整报告
        const auditDone = dashboardData?.audit_completed;
        if (!auditDone) completedSteps += 0;
        else completedSteps += 2; // 7+8

        return { step: STEP_DEFS[5], completedSteps: Math.min(completedSteps, 8), currentStep: 8, totalSteps: 8 };
    }

    // ==============================
    // 首页闭环进度条渲染
    // ==============================
    function renderHomeOrchestrator(state) {
        const { step, completedSteps, currentStep, totalSteps, trackingPct } = state;

        // 更新 AI 推荐区域
        const titleEl = document.getElementById('homeAiRouteTitle');
        const textEl = document.getElementById('homeAiRouteText');
        const badgeEl = document.getElementById('homeAiRouteBadge');
        const metaEl = document.getElementById('homeAiRouteMeta');
        const primaryBtn = document.getElementById('homeAiPrimaryAction');
        const secondaryBtn = document.getElementById('homeAiSecondaryAction');

        if (!titleEl) return; // 不在首页

        const pct = Math.round((completedSteps / totalSteps) * 100);

        if (titleEl) titleEl.textContent = `第 ${currentStep}/${totalSteps} 步：${step.shortTitle}`;
        if (textEl) textEl.textContent = step.reason;
        if (badgeEl) {
            badgeEl.textContent = `进度 ${pct}%`;
            badgeEl.style.background = step.bgColor;
            badgeEl.style.color = step.color;
            badgeEl.style.border = `1px solid ${step.color}30`;
        }
        if (primaryBtn) {
            primaryBtn.textContent = step.btnText;
            primaryBtn.href = step.url;
            primaryBtn.style.background = step.color;
            primaryBtn.style.color = 'white';
            primaryBtn.style.padding = '0.75rem 1.2rem';
            primaryBtn.style.borderRadius = '12px';
            primaryBtn.style.fontWeight = '700';
        }
        if (secondaryBtn) {
            secondaryBtn.textContent = '查看完整路径';
            secondaryBtn.href = 'clinical_pathway.html';
        }

        if (metaEl) {
            metaEl.innerHTML = '';

            // 步骤指示器
            const stepIndicator = document.createElement('div');
            stepIndicator.style.cssText = `
                display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem;
                font-size:0.82rem; color:${step.color}; font-weight:700;
            `;
            stepIndicator.innerHTML = `
                <ion-icon name="${step.icon}" style="font-size:1.1rem;"></ion-icon>
                <span>当前推荐：${step.title}</span>
            `;
            metaEl.appendChild(stepIndicator);

            // 进度条（步骤）
            const progressWrap = document.createElement('div');
            progressWrap.style.cssText = 'margin-bottom:0.6rem;';
            progressWrap.innerHTML = `
                <div style="display:flex; justify-content:space-between; font-size:0.76rem; color:#64748B; margin-bottom:0.3rem; font-weight:600;">
                    <span>路径进度</span>
                    <span>${Math.floor(completedSteps)}/${totalSteps} 步</span>
                </div>
                <div style="height:7px; background:#E2E8F0; border-radius:999px; overflow:hidden;">
                    <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, ${step.color}, ${step.color}99); border-radius:999px; transition:width 1s ease;"></div>
                </div>
            `;
            metaEl.appendChild(progressWrap);

            // 完成后的奖励提示
            const rewardHint = document.createElement('div');
            rewardHint.style.cssText = `
                padding:0.6rem 0.85rem; border-radius:12px;
                background:${step.bgColor}; border:1px solid ${step.color}25;
                font-size:0.8rem; color:${step.color}; line-height:1.6;
            `;
            rewardHint.innerHTML = `<strong>完成后：</strong>${step.reward}`;
            metaEl.appendChild(rewardHint);

            // 如果追踪进行中，显示追踪进度
            if (trackingPct !== undefined) {
                const trackProg = document.createElement('div');
                trackProg.style.cssText = 'margin-top:0.5rem;';
                trackProg.innerHTML = `
                    <div style="display:flex; justify-content:space-between; font-size:0.76rem; color:#64748B; margin-bottom:0.3rem; font-weight:600;">
                        <span>追踪完成率</span>
                        <span>${trackingPct}%</span>
                    </div>
                    <div style="height:6px; background:#E2E8F0; border-radius:999px; overflow:hidden;">
                        <div style="height:100%; width:${trackingPct}%; background:linear-gradient(90deg,#059669,#34D399); border-radius:999px; transition:width 1s ease;"></div>
                    </div>
                `;
                metaEl.appendChild(trackProg);
            }
        }
    }

    // ==============================
    // 任务卡片智能高亮
    // ==============================
    function highlightTaskCards(step) {
        const taskMap = {
            'scale': 'taskScale',
            'cognitive': 'taskCognitive',
            'tracking': 'taskEmotion',
            'tracking_continue': 'taskEmotion'
        };

        const activeTaskId = taskMap[step.id];
        if (!activeTaskId) return;

        ['taskScale', 'taskCognitive', 'taskEmotion'].forEach(id => {
            const card = document.getElementById(id);
            if (!card) return;
            if (id === activeTaskId) {
                card.style.borderColor = step.color;
                card.style.boxShadow = `0 0 0 3px ${step.color}22`;
                card.style.background = step.bgColor;
                // 添加脉冲提示
                const badge = card.querySelector('.badge');
                if (badge) {
                    badge.style.background = step.bgColor;
                    badge.style.color = step.color;
                }
            }
        });
    }

    // ==============================
    // 主入口
    // ==============================
    async function init() {
        const user = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
        if (!user) return;

        let reportData = null;
        let dashboardData = null;

        try {
            [reportData, dashboardData] = await Promise.all([
                window.API?.Patient?.getComprehensiveReport().catch(() => null),
                window.API?.Patient?.getDashboardStatus().catch(() => null)
            ]);
        } catch (e) { /* silent */ }

        const state = computeNextAction(reportData, dashboardData);

        // 渲染首页编排区域
        renderHomeOrchestrator(state);

        // 高亮任务卡
        highlightTaskCards(state.step);

        // 更新进度条（首页已有的那个）
        const progressFill = document.querySelector('.progress-fill.fill-green');
        if (progressFill) {
            const pct = Math.round((state.completedSteps / state.totalSteps) * 100);
            setTimeout(() => { progressFill.style.width = `${pct}%`; }, 300);
        }

        // 更新打卡天数
        const progressText = document.querySelector('.progress-text');
        if (progressText) {
            const tracking = reportData?.tracking_summary;
            const done = tracking?.completed_count || 0;
            const total = tracking?.total_days || 14;
            progressText.textContent = `打卡: ${done}/${total} 天`;
        }

        // 如果今日所有任务已完成，显示全部完成消息
        const allDoneMsg = document.getElementById('allDoneMsg');
        if (allDoneMsg) {
            const today = dashboardData?.today_completed;
            if (today?.scale && today?.cognitive && today?.tracking) {
                allDoneMsg.classList.remove('hidden');
            }
        }

        // 暴露给外部备用
        window._orchestratorState = state;
    }

    // 页面加载完成后执行
    document.addEventListener('DOMContentLoaded', () => {
        // 只在首页运行（或有相应元素的页面）
        if (document.getElementById('homeAiRouteTitle') || document.getElementById('homeAiRouteMeta')) {
            init();
        }
    });

    // 暴露公共 API
    window.Orchestrator = {
        computeNextAction,
        init,
        getStepDefs: () => STEP_DEFS
    };

})();
