document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('reportAiExplainBtn');
    if (!button) return;
    const query = new URLSearchParams(location.search);
    const target = new URL('patient_ai.html', location.href);
    target.searchParams.set('prompt', '请解释我当前获准的已发布报告，区分实际结果、局限和下一步。');
    for (const key of ['patient_id', 'assessment_id']) {
        const value = Number(query.get(key));
        if (Number.isSafeInteger(value) && value > 0) target.searchParams.set(key, String(value));
    }
    const link = document.getElementById('reportAiDeepLink');
    if (link) link.href = target.href;
    button.textContent = '用星仔助手解读';
    button.addEventListener('click', () => location.assign(target.href));
});
