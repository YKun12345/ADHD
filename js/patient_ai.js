function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatAiReplyText(value) {
    const raw = String(value ?? '').replace(/\r\n/g, '\n').trim();
    if (!raw) {
        return '';
    }

    const existingParagraphs = raw
        .split(/\n{2,}/)
        .map((part) => part.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    if (existingParagraphs.length > 1) {
        return existingParagraphs.join('\n\n');
    }

    const normalized = raw.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    let sentences = normalized
        .replace(/([。！？!?；;])(?=[^\n])/g, '$1\n')
        .split('\n')
        .map((part) => part.trim())
        .filter(Boolean);

    if (sentences.length === 1 && sentences[0].length > 42) {
        sentences = normalized
            .replace(/([，,、：:；;])(?=[^\n])/g, '$1\n')
            .split('\n')
            .map((part) => part.trim())
            .filter(Boolean);
    }

    const paragraphs = [];
    let current = '';
    let sentenceCount = 0;

    sentences.forEach((sentence) => {
        if (!current) {
            current = sentence;
            sentenceCount = 1;
            return;
        }

        if (sentenceCount < 2 && current.length + sentence.length <= 46) {
            current += sentence;
            sentenceCount += 1;
            return;
        }

        paragraphs.push(current);
        current = sentence;
        sentenceCount = 1;
    });

    if (current) {
        paragraphs.push(current);
    }

    return (paragraphs.length ? paragraphs : [normalized]).join('\n\n');
}

function buildReportCard(data) {
    const findings = (data.key_findings || [])
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('');
    const actions = (data.next_actions || [])
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('');

    return `
        <div class="ai-rich-card">
            <div class="ai-rich-card-tag">AI解读${data.degraded ? ' · 降级模式' : ''}</div>
            <h4>${escapeHtml(data.headline || '报告解读')}</h4>
            <p>${escapeHtml(data.plain_summary || '')}</p>
            <div class="ai-rich-card-section">
                <strong>你现在最值得关注的点</strong>
                <ul>${findings || '<li>先继续补充量表和追踪数据，结论会更稳。</li>'}</ul>
            </div>
            <div class="ai-rich-card-section">
                <strong>下一步建议</strong>
                <ul>${actions || '<li>先完成今天的记录，再来看趋势。</li>'}</ul>
            </div>
            <div class="ai-mini-note">${escapeHtml(data.disclaimer || '')}</div>
        </div>
    `;
}

document.addEventListener('DOMContentLoaded', async () => {
    const userName = document.getElementById('userName');
    const messagesEl = document.getElementById('aiMessages');
    const form = document.getElementById('aiComposerForm');
    const input = document.getElementById('aiMessageInput');
    const sendBtn = document.getElementById('aiSendBtn');
    const statusBadge = document.getElementById('aiStatusBadge');
    const statusText = document.getElementById('aiStatusText');
    const scopePills = document.querySelectorAll('[data-ai-scope]');
    const quickButtons = document.querySelectorAll('[data-ai-quick]');
    const resetBtn = document.getElementById('resetAiChatBtn');

    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if (userName && storedUser?.full_name) {
        userName.textContent = storedUser.full_name;
    }

    const query = new URLSearchParams(window.location.search);
    const initialScope = query.get('scope') || 'general';
    const initialPrompt = query.get('prompt') || '';

    const state = {
        scope: initialScope,
        conversation: [],
        sending: false
    };

    function scrollMessagesToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setScope(scope) {
        state.scope = scope;
        scopePills.forEach((pill) => {
            pill.classList.toggle('active', pill.dataset.aiScope === scope);
        });
    }

    function pushConversation(role, content) {
        state.conversation.push({ role, content });
        if (state.conversation.length > 12) {
            state.conversation = state.conversation.slice(-12);
        }
    }

    function appendBubble(role, content, options = {}) {
        const item = document.createElement('div');
        item.className = `ai-message ${role}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';

        if (options.html) {
            bubble.innerHTML = content;
        } else {
            bubble.textContent = role === 'assistant' ? formatAiReplyText(content) : content;
        }

        item.appendChild(bubble);
        messagesEl.appendChild(item);
        scrollMessagesToBottom();
        return item;
    }

    function clearMessages() {
        messagesEl.innerHTML = '';
        state.conversation = [];
        appendBubble(
            'assistant',
            '你好，我是知行合医 AI 助手。你可以直接问我报告怎么看、最近 14 天有什么趋势，或者让我要点具体建议。'
        );
    }

    function renderPrefillHint(text) {
        if (!text) {
            return;
        }

        appendBubble(
            'assistant',
            `我已经帮你把问题预填到输入框里了。你可以先看看，再决定是否发送：${text}`
        );
    }

    async function loadStatus() {
        try {
            const status = await window.API.AI.getStatus();
            statusBadge.textContent = status.configured ? '千问已连接' : 'AI网关已接入';
            statusBadge.classList.toggle('degraded', !status.configured);
            statusText.textContent = status.message;
        } catch (error) {
            statusBadge.textContent = '状态未知';
            statusBadge.classList.add('degraded');
            statusText.textContent = error.message || '暂时无法获取 AI 状态。';
        }
    }

    async function sendMessage(rawText, scopeOverride) {
        const message = (rawText || '').trim();
        if (!message || state.sending) {
            return;
        }

        if (scopeOverride) {
            setScope(scopeOverride);
        }

        state.sending = true;
        input.value = '';
        sendBtn.disabled = true;

        appendBubble('user', message);
        pushConversation('user', message);

        const typingBubble = appendBubble('assistant', '正在整理你的最近数据并生成回答...');

        try {
            const response = await window.API.AI.chatMessage({
                message,
                conversation: state.conversation.slice(-8),
                context_scope: state.scope
            });
            const formattedReply = formatAiReplyText(response.reply);
            typingBubble.remove();
            appendBubble('assistant', formattedReply);
            pushConversation('assistant', formattedReply);
        } catch (error) {
            typingBubble.remove();
            appendBubble('assistant', error.message || 'AI 助手暂时不可用，请稍后再试。');
        } finally {
            state.sending = false;
            sendBtn.disabled = false;
            input.focus();
        }
    }

    async function explainReport() {
        if (state.sending) {
            return;
        }

        setScope('report');
        state.sending = true;
        sendBtn.disabled = true;

        const typingBubble = appendBubble('assistant', '正在提取你的最新量表、认知测试和追踪结果...');

        try {
            const response = await window.API.AI.explainReport({ focus: 'patient_ai_page' });
            typingBubble.remove();
            appendBubble('assistant', buildReportCard(response), { html: true });
            pushConversation('assistant', `${response.headline}。${response.plain_summary}`);
        } catch (error) {
            typingBubble.remove();
            appendBubble('assistant', error.message || '报告解读暂时不可用。');
        } finally {
            state.sending = false;
            sendBtn.disabled = false;
        }
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        sendMessage(input.value);
    });

    scopePills.forEach((pill) => {
        pill.addEventListener('click', () => setScope(pill.dataset.aiScope));
    });

    quickButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.dataset.aiQuick;
            if (action === 'report') {
                explainReport();
                return;
            }
            if (action === 'tracking') {
                sendMessage('请结合我的 14 天追踪，告诉我最近最值得注意的变化。', 'tracking');
                return;
            }
            if (action === 'plan') {
                sendMessage('请根据我最近的情况，给我一个今天就能开始的简单计划。', 'general');
            }
        });
    });

    resetBtn.addEventListener('click', () => {
        clearMessages();
        setScope('general');
    });

    clearMessages();
    setScope(initialScope);
    await loadStatus();

    if (initialPrompt) {
        input.value = initialPrompt;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        renderPrefillHint(initialPrompt);
    }
});
