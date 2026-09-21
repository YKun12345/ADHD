document.addEventListener('DOMContentLoaded', () => {
    const card = document.getElementById('trackingAiReminder');
    const title = document.getElementById('trackingAiTitle');
    const message = document.getElementById('trackingAiMessage');
    const meta = document.getElementById('trackingAiMeta');
    const actionBtn = document.getElementById('trackingAiActionBtn');
    const askAiLink = document.getElementById('trackingAiAskLink');
    const fabAddLog = document.getElementById('fabAddLog');

    if (!card || !title || !message || !meta || !actionBtn || !askAiLink) {
        return;
    }

    askAiLink.href = `patient_ai.html?scope=tracking&prompt=${encodeURIComponent('请结合我的 14 天追踪，帮我看看最近状态和下一步建议。')}`;

    let latestReminder = null;

    async function loadReminder() {
        try {
            const response = await window.API.AI.generateReminder({ tone: 'gentle' });
            latestReminder = response;
            card.classList.remove('hidden');
            card.classList.toggle('completed', response.completion_status === 'completed');
            title.textContent = response.title;
            message.textContent = response.message;
            meta.textContent = response.degraded
                ? '当前使用降级模式提醒'
                : '这条提醒由 AI 结合追踪数据生成';
            actionBtn.textContent = response.action_label || '去处理';
        } catch (error) {
            latestReminder = null;
            card.classList.remove('hidden');
            card.classList.remove('completed');
            title.textContent = 'AI 提醒暂时不可用';
            message.textContent = error.message || '稍后再试，或者先手动完成今天的记录。';
            meta.textContent = '系统没有拿到可用的提醒结果';
            actionBtn.textContent = '去记录今天';
        }
    }

    actionBtn.addEventListener('click', () => {
        if (latestReminder?.completion_status === 'completed') {
            window.location.href = askAiLink.href;
            return;
        }

        if (fabAddLog) {
            fabAddLog.click();
            return;
        }

        window.location.href = askAiLink.href;
    });

    document.addEventListener('tracking:log-saved', loadReminder);
    loadReminder();
});
