(() => {
    'use strict';
    const guard = window.SessionGuard;
    if (!guard) return;
    const session = guard.captureSession();
    document.addEventListener('DOMContentLoaded', () => {
        const page = document.body.dataset.copilotPage;
        if (!page || !guard.isCurrentSession(session)) return;
        const prompts = {
            home: '请根据我当前获准的实际资料，告诉我现在可以完成的下一步。',
            scale: '请解释量表填写方式，并核对当前评估还需要完成哪些项目。',
            test: '请解释当前认知测试的操作和已有结果的局限。',
            tracking: '请核对当前实际周期的记录、缺失日期和下一步。',
            report: '请解释我当前获准的已发布报告，区分实际结果、局限和下一步。',
            education: '请用通俗的话说明 ADHD 筛查和医生专业评估的关系。'
        };
        const target = new URL('patient_ai.html', location.href);
        target.searchParams.set('prompt', prompts[page] || prompts.home);
        const query = new URLSearchParams(location.search);
        for (const key of ['patient_id', 'assessment_id']) {
            const value = Number(query.get(key));
            if (Number.isSafeInteger(value) && value > 0) target.searchParams.set(key, String(value));
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'floating-ai';
        wrapper.id = 'pageCopilotBubble';
        if (document.getElementById('fabAddLog')) wrapper.classList.add('lifted');
        const open = document.createElement('a');
        open.className = 'ai-avatar';
        open.href = target.href;
        open.title = '打开星仔助手';
        open.setAttribute('aria-label', '打开星仔助手，核对下一步或随时提问');
        open.textContent = '问';
        const tooltip = document.createElement('div');
        tooltip.className = 'ai-tooltip';
        const heading = document.createElement('strong');
        heading.textContent = '星仔助手';
        const text = document.createElement('p');
        text.textContent = '核对当前获准资料和下一步，也可以随时提问。';
        const link = document.createElement('a');
        link.className = 'ai-tooltip-btn';
        link.href = target.href;
        link.textContent = '继续提问';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-close';
        close.setAttribute('aria-label', '收起助手提示');
        close.textContent = '×';
        close.addEventListener('click', () => tooltip.classList.add('hidden'));
        tooltip.append(heading, close, text, link);
        wrapper.append(open, tooltip);
        document.body.append(wrapper);
        guard.onInvalidated(() => wrapper.remove());
        window.addEventListener('pagehide', () => wrapper.remove(), { once: true });
    });
})();
