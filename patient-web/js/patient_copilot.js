(function () {
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

    function appendBubble(container, role, content) {
        const row = document.createElement('div');
        row.className = `ai-message ${role}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        bubble.textContent = role === 'assistant' ? formatAiReplyText(content) : content;

        row.appendChild(bubble);
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
        return row;
    }

    function createQuickButtonsMarkup(actions) {
        return actions
            .map(
                (action, index) => `
                <button class="ai-quick-btn" type="button" data-copilot-quick="${index}">
                    <strong>${action.label}</strong>
                    <span>${action.description}</span>
                </button>
            `
            )
            .join('');
    }

    function buildPromptLink(prompt, scope) {
        return `patient_ai.html?scope=${encodeURIComponent(scope)}&prompt=${encodeURIComponent(prompt)}`;
    }

    async function getPageData() {
        const [dashboardStatus, reportSnapshot] = await Promise.all([
            window.API?.Patient?.getDashboardStatus ? window.API.Patient.getDashboardStatus().catch(() => null) : Promise.resolve(null),
            window.API?.Patient?.getComprehensiveReport ? window.API.Patient.getComprehensiveReport().catch(() => null) : Promise.resolve(null)
        ]);

        return { dashboardStatus, reportSnapshot };
    }

    function buildCopilotConfig(pageKey, data) {
        const tracking = data.reportSnapshot?.tracking_summary;
        const latestScale = data.reportSnapshot?.latest_scale;
        const cognitiveProfile = data.reportSnapshot?.cognitive_profile;

        const common = {
            title: 'AI 助手提醒',
            scope: 'general',
            bubbleText: '我会结合你的已完成任务、报告和追踪数据，给你一个更贴近当前状态的建议。',
            drawerHint: '我会结合你当前页面和已积累的数据，帮你串联下一步动作。',
            prompt: '请结合我当前页面和已完成的数据，告诉我接下来更适合先做什么。',
            quickActions: [
                {
                    label: '我现在先做什么？',
                    description: '结合我当前页面和已完成进度，推荐最值得先完成的一步。',
                    prompt: '请结合我当前页面和已完成的数据，告诉我现在最值得先完成的一步。',
                    scope: 'general'
                },
                {
                    label: '解释我的当前状态',
                    description: '把这页内容和我的已有结果翻译成更容易理解的话。',
                    prompt: '请结合我当前页面和已有结果，用通俗的话解释我现在处于什么状态。',
                    scope: 'general'
                }
            ]
        };

        if (pageKey === 'scale') {
            return {
                ...common,
                bubbleText: latestScale
                    ? '你已经有量表结果了，如果想弄清每个维度是什么意思，我可以继续帮你拆解。'
                    : '这份量表像是在帮你描一张基础画像。如果某一题拿不准，我可以用生活化的例子帮你理解。',
                drawerHint: '量表是基础画像的起点。我可以帮你理解题目，也可以告诉你做完量表后下一步该接哪条链路。',
                prompt: latestScale
                    ? '请结合我已有的量表结果，告诉我下一步更适合补什么数据。'
                    : '请结合当前量表页，告诉我为什么现在建议先完成量表。',
                quickActions: [
                    {
                        label: '量表怎么填？',
                        description: '如果题目有点模糊，我可以用生活化场景帮你理解。',
                        prompt: '请结合行为量表页面，用生活化的例子解释这些题目应该怎么理解。',
                        scope: 'general'
                    },
                    {
                        label: '为什么先做量表',
                        description: '告诉我量表在整个评估链路里起什么作用。',
                        prompt: '请告诉我为什么在这条评估链路里建议先完成行为量表。',
                        scope: 'general'
                    }
                ]
            };
        }

        if (pageKey === 'test') {
            return {
                ...common,
                bubbleText: cognitiveProfile
                    ? '你已经有认知结果了。如果想继续补测或者看懂这些能力维度，我可以继续帮你解释。'
                    : '这组测试更像小游戏，但背后在观察注意、抑制和工作记忆。我可以先帮你讲清它在测什么。',
                drawerHint: '认知测试页更偏客观证据层。我可以帮你理解每类测试在看什么，也能告诉你补测价值。',
                prompt: cognitiveProfile
                    ? '请结合我已有认知结果，告诉我下一步更适合继续补什么。'
                    : '请解释认知测试页里的这些测试主要在测什么。',
                quickActions: [
                    {
                        label: '这些测试测什么？',
                        description: '把 Stroop、Flanker、工作记忆这些概念讲成人话。',
                        prompt: '请结合认知测试页，用通俗的话解释这些测试分别在测什么能力。',
                        scope: 'general'
                    },
                    {
                        label: '今天要不要补测',
                        description: '结合我已有数据，判断今天是否值得继续做认知测试。',
                        prompt: '请结合我当前的数据，告诉我今天是否值得继续做认知测试，以及为什么。',
                        scope: 'general'
                    }
                ]
            };
        }

        if (pageKey === 'tracking') {
            return {
                ...common,
                scope: 'tracking',
                bubbleText: tracking?.completed_count
                    ? `你已经完成了 ${tracking.completed_count}/${tracking.total_days} 天追踪。我可以帮你看看趋势里最值得注意的变化。`
                    : '连续记录比单次结果更有价值。如果今天还没开始，我可以帮你从最轻的一步开始。',
                drawerHint: '追踪页更像你的动态行为日志。我可以帮你解释波动，也可以陪你决定今天先记哪一条。',
                prompt: tracking?.completed_count
                    ? '请结合我的14天追踪，告诉我最近最值得注意的变化和下一步建议。'
                    : '请结合14天追踪页面，告诉我为什么建议我从今天开始先记第一条记录。',
                quickActions: [
                    {
                        label: '解读最近趋势',
                        description: '把最近追踪里的变化和可能的意义讲清楚。',
                        prompt: '请结合我的14天追踪记录，解读最近的趋势和变化。',
                        scope: 'tracking'
                    },
                    {
                        label: '今天先记什么',
                        description: '如果我不想写很多，告诉我今天最值得先补的一条。',
                        prompt: '请结合我当前的追踪情况，告诉我今天最值得先记录的一条内容。',
                        scope: 'tracking'
                    }
                ]
            };
        }

        if (pageKey === 'education') {
            return {
                ...common,
                bubbleText: latestScale?.risk_level === 'high'
                    ? '如果你想知道“高风险”到底意味着什么，我可以把这些知识点和你的情况一起讲明白。'
                    : '如果某个知识点看不太懂，我可以把它翻译成更生活化的话，也可以告诉你哪部分最值得先看。',
                drawerHint: '科普页更适合做“知识翻译”和“个性化阅读推荐”。我会结合你的数据，告诉你这页哪部分最值得先看。',
                prompt: '请结合我的当前情况，推荐我在科普页里最值得先看的内容。',
                quickActions: [
                    {
                        label: '把知识讲人话',
                        description: '如果专业概念太密，我可以帮你翻译成更容易理解的话。',
                        prompt: '请把这页的 ADHD 知识点讲得更通俗一点，适合普通用户快速理解。',
                        scope: 'general'
                    },
                    {
                        label: '推荐我先看什么',
                        description: '结合我的当前情况，挑出最值得先读的知识内容。',
                        prompt: '请结合我的当前数据，推荐我在这页最值得优先阅读的知识点。',
                        scope: 'general'
                    }
                ]
            };
        }

        if (pageKey === 'report') {
            return {
                ...common,
                scope: 'report',
                bubbleText: tracking?.completed_count
                    ? `已完成 ${tracking.completed_count}/${tracking.total_days} 天追踪，把已有结果交给我，我可以继续帮你解读重点和下一步建议。`
                    : '报告已经生成，但如果你想把结果和追踪联系起来看，我可以继续帮你把重点讲明白。',
                drawerHint: '我会结合你的报告、14天追踪和认知结果继续给你解释重点，也能陪你判断下一步最值得先做什么。',
                prompt: '请结合我的报告和14天追踪，告诉我接下来最值得先完成的任务。',
                quickActions: [
                    {
                        label: '报告重点在哪',
                        description: '把这份报告里最值得关注的发现讲清楚。',
                        prompt: '请结合我的报告，告诉我这份报告里最值得关注的重点是什么。',
                        scope: 'report'
                    },
                    {
                        label: '下一步做什么',
                        description: '结合报告和追踪告诉我接下来最适合先做的一步。',
                        prompt: '请结合我的报告和14天追踪，告诉我接下来最适合先做的一步。',
                        scope: 'report'
                    }
                ]
            };
        }

        if (pageKey === 'home') {
            if (!latestScale) {
                return {
                    ...common,
                    bubbleText: '如果你还没开始，我建议先从行为量表开始。量表像是在帮你建立一张基础画像。',
                    drawerHint: '首页更适合帮你理清“今天先做什么”。我会结合你已有的数据，把下一步最值得完成的任务找出来。',
                    prompt: '请结合我的首页进度，告诉我今天最值得先完成的任务。',
                    quickActions: [
                        {
                            label: '今天先做什么？',
                            description: '帮我找出今天最值得先完成的一步。',
                            prompt: '请结合我的首页进度，告诉我今天最值得先完成的任务。',
                            scope: 'general'
                        },
                        {
                            label: '为什么先做量表',
                            description: '解释量表为什么是当前链路的起点。',
                            prompt: '请告诉我为什么现在建议先完成行为量表。',
                            scope: 'general'
                        }
                    ]
                };
            }

            if (!cognitiveProfile) {
                return {
                    ...common,
                    bubbleText: '你的基础画像已经有了，接下来更适合补充认知测试，让我能把主观和客观证据一起看。',
                    drawerHint: '首页现在更适合往“补充客观证据”推进。我可以告诉你为什么建议先做认知测试。',
                    prompt: '请结合我的首页进度和量表结果，告诉我为什么现在更适合继续做认知测试。',
                    quickActions: [
                        {
                            label: '为什么继续做认知测试',
                            description: '解释认知测试在整条评估链路中的作用。',
                            prompt: '请结合我的首页进度和量表结果，告诉我为什么现在更适合继续做认知测试。',
                            scope: 'general'
                        },
                        {
                            label: '认知测试测什么',
                            description: '把注意、抑制和工作记忆这些概念讲成人话。',
                            prompt: '请结合认知测试页，用通俗的话解释这些测试分别在测什么能力。',
                            scope: 'general'
                        }
                    ]
                };
            }

            if (!tracking?.completed_count || tracking.completed_count < tracking.total_days) {
                return {
                    ...common,
                    scope: 'tracking',
                    bubbleText: tracking?.completed_count
                        ? `你已经完成了 ${tracking.completed_count}/${tracking.total_days} 天追踪，再补几天，整条链路会更完整。`
                        : '如果最近还没开始连续记录，今天先写第一条就够了，我可以陪你把这件事拆小一点。',
                    drawerHint: '首页更适合决定“今天先完成哪条追踪”。我会结合你的已有结果，给你一个轻量但有帮助的建议。',
                    prompt: '请结合我的首页进度和14天追踪情况，告诉我现在最值得先完成的一步。',
                    quickActions: [
                        {
                            label: '今天先记什么',
                            description: '帮我决定今天最值得先补的一条记录。',
                            prompt: '请结合我的追踪情况，告诉我今天最值得先记录的一条内容。',
                            scope: 'tracking'
                        },
                        {
                            label: '最近趋势说明什么',
                            description: '把最近追踪中的变化讲明白。',
                            prompt: '请结合我的14天追踪，告诉我最近的趋势说明了什么。',
                            scope: 'tracking'
                        }
                    ]
                };
            }

            return {
                ...common,
                bubbleText: '你的量表、认知测试和14天追踪已经比较完整了，现在更适合进入综合解读。',
                drawerHint: '首页现在更适合做“总结和下一步判断”。我可以结合已有结果帮你梳理最关键的方向。',
                prompt: '请结合我当前首页状态和已有数据，告诉我接下来最值得先完成什么。',
                quickActions: [
                    {
                        label: '查看整体重点',
                        description: '快速总结已有量表、认知和追踪结果。',
                        prompt: '请结合我的已有数据，快速总结我当前最值得关注的重点。',
                        scope: 'general'
                    },
                    {
                        label: '下一步先做什么',
                        description: '如果链路已经完整，帮我决定接下来先看什么、调什么。',
                        prompt: '请结合我的已有数据，告诉我下一步更适合先做什么。',
                        scope: 'general'
                    }
                ]
            };
        }

        return common;
    }

    document.addEventListener('DOMContentLoaded', async () => {
        const pageKey = document.body.dataset.copilotPage;
        if (!pageKey) {
            return;
        }

        const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
        const userName = document.getElementById('userName');
        if (userName && storedUser?.full_name) {
            userName.textContent = storedUser.full_name;
        }

        const historyKey = storedUser?.id
            ? `smartbrain_patient_copilot_history_${storedUser.id}`
            : `smartbrain_patient_copilot_history_${storedUser?.email || 'guest'}`;

        function loadHistory() {
            try {
                const parsed = JSON.parse(localStorage.getItem(historyKey) || '[]');
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }

        function saveHistory(history) {
            localStorage.setItem(historyKey, JSON.stringify(history.slice(-16)));
        }

        const pageData = await getPageData();
        const config = buildCopilotConfig(pageKey, pageData);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="floating-ai${document.getElementById('fabAddLog') ? ' lifted' : ''}" id="pageCopilotBubble">
                <div class="ai-avatar" id="pageCopilotAvatar" title="打开 AI 助手">
                    <ion-icon name="sparkles"></ion-icon>
                </div>
                <div class="ai-tooltip" id="pageCopilotTooltip">
                    <div class="ai-tooltip-head">
                        <strong id="pageCopilotTitle">${config.title}</strong>
                        <button class="btn-close" id="closePageCopilotTooltip"><ion-icon name="close"></ion-icon></button>
                    </div>
                    <p id="pageCopilotText">${config.bubbleText}</p>
                    <div class="ai-tooltip-actions">
                        <button class="ai-tooltip-btn" id="openPageCopilotDrawerBtn" type="button">和我聊聊</button>
                        <a href="${buildPromptLink(config.prompt, config.scope)}" id="pageCopilotFullLink" class="ai-tooltip-link">完整助手</a>
                    </div>
                </div>
            </div>

            <div class="floating-ai-overlay hidden" id="pageCopilotOverlay"></div>
            <aside class="floating-ai-drawer" id="pageCopilotDrawer" aria-hidden="true">
                <div class="floating-ai-drawer-header">
                    <div>
                        <h3>AI 助手</h3>
                        <p id="pageCopilotDrawerHint" class="floating-ai-drawer-subtitle">${config.drawerHint}</p>
                    </div>
                    <button class="icon-btn" id="closePageCopilotDrawerBtn" type="button" title="关闭">
                        <ion-icon name="close-outline"></ion-icon>
                    </button>
                </div>

                <div class="floating-ai-quick-actions">
                    ${createQuickButtonsMarkup(config.quickActions)}
                </div>

                <div id="pageCopilotMessages" class="ai-messages ai-messages-compact"></div>

                <form id="pageCopilotForm" class="ai-composer ai-composer-compact">
                    <textarea id="pageCopilotInput" class="ai-input" rows="3" placeholder="例如：请结合我当前页面和已有数据，告诉我下一步最值得先完成什么。"></textarea>
                    <div class="ai-composer-actions">
                        <a href="${buildPromptLink(config.prompt, config.scope)}" id="pageCopilotDrawerLink" class="ai-tooltip-link">去完整 AI 页继续聊</a>
                        <button id="pageCopilotSendBtn" class="btn-primary-orange" type="submit">发送</button>
                    </div>
                </form>
            </aside>
        `;
        document.body.appendChild(wrapper);

        const avatar = document.getElementById('pageCopilotAvatar');
        const tooltip = document.getElementById('pageCopilotTooltip');
        const closeTooltipBtn = document.getElementById('closePageCopilotTooltip');
        const openDrawerBtn = document.getElementById('openPageCopilotDrawerBtn');
        const overlay = document.getElementById('pageCopilotOverlay');
        const drawer = document.getElementById('pageCopilotDrawer');
        const closeDrawerBtn = document.getElementById('closePageCopilotDrawerBtn');
        const messagesEl = document.getElementById('pageCopilotMessages');
        const form = document.getElementById('pageCopilotForm');
        const input = document.getElementById('pageCopilotInput');
        const sendBtn = document.getElementById('pageCopilotSendBtn');
        const quickButtons = drawer.querySelectorAll('[data-copilot-quick]');

        const state = {
            open: false,
            sending: false,
            conversation: loadHistory()
        };

        function pushConversation(role, content) {
            state.conversation.push({ role, content });
            if (state.conversation.length > 12) {
                state.conversation = state.conversation.slice(-12);
            }
            saveHistory(state.conversation);
        }

        function renderHistory() {
            messagesEl.innerHTML = '';
            if (!state.conversation.length) {
                return false;
            }

            state.conversation.forEach((turn) => {
                appendBubble(messagesEl, turn.role, turn.content);
            });
            return true;
        }

        function ensureWelcome() {
            if (!messagesEl || messagesEl.children.length > 0) {
                return;
            }

            if (renderHistory()) {
                return;
            }

            const intro = [
                config.bubbleText,
                '如果你愿意，我也可以直接结合你已经完成的数据，告诉你下一步更值得先做什么。'
            ].join(' ');
            appendBubble(messagesEl, 'assistant', intro);
            pushConversation('assistant', intro);
        }

        function openDrawer() {
            if (!drawer || state.open) {
                return;
            }

            ensureWelcome();
            state.open = true;
            document.body.classList.add('ai-drawer-open');
            overlay.classList.remove('hidden');
            requestAnimationFrame(() => {
                drawer.classList.add('open');
                drawer.setAttribute('aria-hidden', 'false');
            });
            input.focus();
        }

        function closeDrawer() {
            if (!drawer || !state.open) {
                return;
            }

            state.open = false;
            drawer.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('ai-drawer-open');
            setTimeout(() => {
                if (!state.open) {
                    overlay.classList.add('hidden');
                }
            }, 280);
        }

        async function sendMessage(rawText, scopeOverride) {
            const message = String(rawText || '').trim();
            if (!message || state.sending) {
                return;
            }

            state.sending = true;
            input.value = '';
            sendBtn.disabled = true;

            appendBubble(messagesEl, 'user', message);
            pushConversation('user', message);

            const typingBubble = appendBubble(messagesEl, 'assistant', '正在结合你的页面和已积累数据整理回答...');

            try {
                const response = await window.API.AI.chatMessage({
                    message,
                    conversation: state.conversation.slice(-8),
                    context_scope: scopeOverride || config.scope
                });
                const formattedReply = formatAiReplyText(response.reply);
                typingBubble.remove();
                appendBubble(messagesEl, 'assistant', formattedReply);
                pushConversation('assistant', formattedReply);
            } catch (error) {
                typingBubble.remove();
                appendBubble(messagesEl, 'assistant', error.message || 'AI 助手暂时不可用，请稍后再试。');
            } finally {
                state.sending = false;
                sendBtn.disabled = false;
                input.focus();
            }
        }

        closeTooltipBtn?.addEventListener('click', (event) => {
            event.stopPropagation();
            tooltip.classList.add('hidden');
        });
        avatar?.addEventListener('click', openDrawer);
        openDrawerBtn?.addEventListener('click', () => {
            openDrawer();
        });
        overlay?.addEventListener('click', closeDrawer);
        closeDrawerBtn?.addEventListener('click', closeDrawer);

        form?.addEventListener('submit', (event) => {
            event.preventDefault();
            sendMessage(input.value, config.scope);
        });

        quickButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const action = config.quickActions[Number(button.dataset.copilotQuick)];
                if (!action) {
                    return;
                }
                openDrawer();
                sendMessage(action.prompt, action.scope);
            });
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && state.open) {
                closeDrawer();
            }
        });
    });
})();
