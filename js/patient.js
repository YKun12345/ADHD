document.addEventListener('DOMContentLoaded', async () => {
    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const userName = document.getElementById('userName');
    if (userName && storedUser?.full_name) {
        userName.textContent = storedUser.full_name;
    }

    const taskScale = document.getElementById('taskScale');
    const taskCognitive = document.getElementById('taskCognitive');
    const taskEmotion = document.getElementById('taskEmotion');
    const heroStartScale = document.getElementById('heroStartScale');
    const heroStartTest = document.getElementById('heroStartTest');
    const heroLogEmotion = document.getElementById('heroLogEmotion');
    const allDoneMsg = document.getElementById('allDoneMsg');
    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');
    const homeAiRouteTitle = document.getElementById('homeAiRouteTitle');
    const homeAiRouteText = document.getElementById('homeAiRouteText');
    const homeAiRouteBadge = document.getElementById('homeAiRouteBadge');
    const homeAiRouteMeta = document.getElementById('homeAiRouteMeta');
    const homeAiPrimaryAction = document.getElementById('homeAiPrimaryAction');
    const homeAiSecondaryAction = document.getElementById('homeAiSecondaryAction');

    function goWithLoading(element, loadingHtml, href) {
        if (!element) {
            return;
        }

        element.addEventListener('click', () => {
            element.innerHTML = loadingHtml;
            element.style.justifyContent = 'center';
            element.style.color = '#64748B';
            setTimeout(() => {
                window.location.href = href;
            }, 800);
        });
    }

    goWithLoading(
        taskScale,
        '<ion-icon class="spin" name="sync-outline"></ion-icon> 正在打开基础行为量表...',
        'patient_scale.html'
    );
    goWithLoading(
        taskCognitive,
        '<ion-icon class="spin" name="sync-outline"></ion-icon> 测试加载中...',
        'patient_test.html'
    );
    goWithLoading(
        taskEmotion,
        '<ion-icon class="spin" name="sync-outline"></ion-icon> 正在打开日志表单...',
        'patient_tracking.html'
    );

    heroStartScale?.addEventListener('click', () => {
        window.location.href = 'patient_scale.html';
    });
    heroStartTest?.addEventListener('click', () => {
        window.location.href = 'patient_test.html';
    });
    heroLogEmotion?.addEventListener('click', () => {
        window.location.href = 'patient_tracking.html';
    });

    document.querySelectorAll('.faq-question').forEach((question) => {
        question.addEventListener('click', () => {
            const parent = question.parentElement;
            const isActive = parent.classList.contains('active');
            document.querySelectorAll('.faq-item').forEach((item) => item.classList.remove('active'));
            if (!isActive) {
                parent.classList.add('active');
            }
        });
    });

    function applyDashboardProgress(status) {
        if (!status) {
            return;
        }

        const totalDays = status.total_days || 14;
        const completedCount = (status.completed_days || []).length;
        const progressPercent = Math.min(100, Math.round((completedCount / totalDays) * 100));

        if (progressFill) {
            progressFill.style.width = `${progressPercent}%`;
        }
        if (progressText) {
            progressText.textContent = `打卡: ${completedCount}/${totalDays} 天`;
        }
        if (allDoneMsg) {
            allDoneMsg.classList.toggle('hidden', completedCount < totalDays);
        }
    }

    function createRouteChip(text) {
        const chip = document.createElement('span');
        chip.className = 'home-ai-route-chip';
        chip.textContent = text;
        return chip;
    }

    function updateRouteActions(primary, secondary) {
        if (homeAiPrimaryAction && primary) {
            homeAiPrimaryAction.textContent = primary.label;
            homeAiPrimaryAction.href = primary.href;
        }
        if (homeAiSecondaryAction && secondary) {
            homeAiSecondaryAction.textContent = secondary.label;
            homeAiSecondaryAction.href = secondary.href;
        }
    }

    function renderHomeAiRoute(route) {
        if (!homeAiRouteTitle || !homeAiRouteText || !homeAiRouteBadge || !homeAiRouteMeta) {
            return;
        }

        homeAiRouteTitle.textContent = route.title;
        homeAiRouteText.textContent = route.text;
        homeAiRouteBadge.textContent = route.badge || '实时更新';
        homeAiRouteMeta.innerHTML = '';
        (route.meta || []).forEach((item) => {
            homeAiRouteMeta.appendChild(createRouteChip(item));
        });
        updateRouteActions(route.primaryAction, route.secondaryAction);
    }

    function buildHomeRoute(report, dashboardStatus) {
        const tracking = report?.tracking_summary;
        const latestScale = report?.latest_scale;
        const cognitiveProfile = report?.cognitive_profile;

        if (!latestScale) {
            return {
                title: '先完成行为量表，建立基础画像',
                text: '量表是整条评估链路的起点。先把基础画像建立起来，后面的认知测试、追踪和 AI 解读才会更有方向。',
                badge: '推荐起点',
                meta: ['单次必填', '建立基线', '支持后续 AI 解读'],
                primaryAction: { label: '先做行为量表', href: 'patient_scale.html' },
                secondaryAction: { label: '查看我的报告', href: 'patient_report.html' }
            };
        }

        if (!cognitiveProfile) {
            return {
                title: '补做认知测试，让客观证据更完整',
                text: '你已经有基础量表结果了。现在更适合补充认知测试，把主观画像和客观执行功能证据连接起来。',
                badge: '下一步推荐',
                meta: ['客观指标', '执行功能', '更完整报告'],
                primaryAction: { label: '去做认知测试', href: 'patient_test.html' },
                secondaryAction: { label: '查看我的报告', href: 'patient_report.html' }
            };
        }

        if (!tracking?.completed_count || tracking.completed_count < tracking.total_days) {
            return {
                title: `继续完成 14 天追踪，第 ${tracking?.current_day || 1} 天更值得优先完成`,
                text: tracking?.completed_count
                    ? `你已经完成了 ${tracking.completed_count}/${tracking.total_days} 天追踪，再补几天，整条链路就会更完整。`
                    : '连续记录比单次结果更有价值。如果今天还没开始，先写第一条就很好。',
                badge: '动态追踪',
                meta: [
                    `${tracking?.completed_count || 0}/${tracking?.total_days || 14} 天`,
                    tracking?.latest_mood_text ? `最近状态：${tracking.latest_mood_text}` : '持续记录中',
                    '形成动态评估链路'
                ],
                primaryAction: { label: '继续 14 天追踪', href: 'patient_tracking.html' },
                secondaryAction: { label: '去 AI 解读', href: 'patient_ai.html?scope=tracking' }
            };
        }

        return {
            title: '你的评估链路已经较完整，可以进入综合解读',
            text: '量表、认知测试和 14 天追踪都已形成较完整证据，接下来更适合查看综合报告，并让 AI 帮你解释重点。',
            badge: '闭环完成',
            meta: ['量表已完成', '认知已补充', '追踪已完整'],
            primaryAction: { label: '查看我的报告', href: 'patient_report.html' },
            secondaryAction: { label: '去 AI 解读', href: 'patient_ai.html?scope=report' }
        };
    }

    try {
        const [dashboardStatus, reportSnapshot] = await Promise.all([
            window.API.Patient.getDashboardStatus().catch(() => null),
            window.API.Patient.getComprehensiveReport().catch(() => null)
        ]);

        applyDashboardProgress(dashboardStatus);
        renderHomeAiRoute(buildHomeRoute(reportSnapshot, dashboardStatus));
    } catch (error) {
        console.error('Failed to initialize patient home route:', error);
    }
});
