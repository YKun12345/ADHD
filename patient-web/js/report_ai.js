function escapeReportHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    const triggerBtn = document.getElementById('reportAiExplainBtn');
    const panel = document.getElementById('reportAiPanel');
    const status = document.getElementById('reportAiStatus');
    const title = document.getElementById('reportAiTitle');
    const summary = document.getElementById('reportAiSummary');
    const findings = document.getElementById('reportAiFindings');
    const actions = document.getElementById('reportAiActions');
    const disclaimer = document.getElementById('reportAiDisclaimer');
    const deepLink = document.getElementById('reportAiDeepLink');

    if (!triggerBtn || !panel) {
        return;
    }

    if (deepLink) {
        deepLink.href = `patient_ai.html?scope=report&prompt=${encodeURIComponent('请进一步解释我的最新报告，并告诉我优先要做什么。')}`;
    }

    function renderList(container, items) {
        container.innerHTML = '';
        (items || []).forEach((item) => {
            const li = document.createElement('li');
            li.textContent = item;
            container.appendChild(li);
        });
    }

    async function loadExplanation() {
        panel.classList.remove('hidden');
        panel.classList.add('loading');
        status.textContent = 'AI 正在整理你的最新报告...';
        title.textContent = '正在生成解读';
        summary.textContent = '请稍候，系统会结合量表、认知测试和追踪结果生成一段患者版说明。';
        findings.innerHTML = '';
        actions.innerHTML = '';
        disclaimer.textContent = '';
        triggerBtn.disabled = true;

        try {
            const response = await window.API.AI.explainReport({ focus: 'patient_report_page' });
            panel.classList.remove('loading');
            status.textContent = response.degraded ? '已切换为降级模式解读' : 'AI 解读已就绪';
            title.textContent = response.headline;
            summary.textContent = response.plain_summary;
            renderList(findings, response.key_findings);
            renderList(actions, response.next_actions);
            disclaimer.textContent = response.disclaimer;
        } catch (error) {
            panel.classList.remove('loading');
            status.textContent = 'AI 解读暂时不可用';
            title.textContent = '还没生成解读';
            summary.textContent = error.message || '请稍后重试，或者先前往 AI 助手页继续提问。';
            findings.innerHTML = '<li>可以先查看页面上的量表摘要和雷达图。</li>';
            actions.innerHTML = '<li>稍后再试，或进入 AI 助手页继续提问。</li>';
            disclaimer.textContent = 'AI 解读仅作辅助参考。';
        } finally {
            triggerBtn.disabled = false;
        }
    }

    triggerBtn.addEventListener('click', loadExplanation);
});
