document.addEventListener('DOMContentLoaded', () => {
    const card = document.getElementById('trackingAiReminder');
    const title = document.getElementById('trackingAiTitle');
    const message = document.getElementById('trackingAiMessage');
    const meta = document.getElementById('trackingAiMeta');
    const action = document.getElementById('trackingAiActionBtn');
    const ask = document.getElementById('trackingAiAskLink');
    if (!card || !title || !message || !meta || !action || !ask) return;
    const target = new URL('patient_ai.html', location.href);
    target.searchParams.set('prompt', '请结合我当前获准的实际周期和每日记录，说明已有记录、缺失日期和下一步。');
    const patientId = Number(new URLSearchParams(location.search).get('patient_id'));
    if (Number.isSafeInteger(patientId) && patientId > 0) target.searchParams.set('patient_id', String(patientId));
    ask.href = target.href;
    ask.textContent = '问星仔助手';
    title.textContent = '记录今天的实际情况';
    message.textContent = '完成记录后，可以请星仔助手核对当前获准资料和下一步。';
    meta.textContent = '星仔助手按实际资料核对，不自动生成或提交记录';
    action.textContent = '去记录今天';
    action.addEventListener('click', () => {
        const add = document.getElementById('fabAddLog');
        if (add) add.click();
        else location.assign(target.href);
    });
    card.classList.remove('hidden', 'completed');
});
