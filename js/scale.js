const SCALE_CONFIG = {
    adult: {
        apiType: 'ASRS',
        title: 'ASRS 成人自评量表',
        respondentType: 'self',
        options: ['从不', '很少', '有时', '经常', '非常频繁'],
        maxScore: 4,
        estimatedMinutes: 5,
        questions: [
            '你是否经常在任务临近结束时，难以把最后的细节收尾完善？',
            '当事情需要按步骤规划时，你是否经常难以把安排整理清楚？',
            '你是否经常忘记预约、截止时间或已经答应别人的事情？',
            '面对需要长时间动脑的任务时，你是否常常拖延开始？',
            '当你需要长时间坐着时，是否常常不自觉地扭动或坐立不安？',
            '你是否常常感到自己像被什么推动着一样，很难真正慢下来？',
            '在阅读、开会或上课时，你是否很容易被周围声音或想法打断？',
            '你是否经常同时开始很多事，但难以把它们完整收尾？',
            '你是否常常把钥匙、手机、证件或其他必需品放错地方？',
            '当事情需要持续投入一段时间时，你是否很难一直保持注意力？',
            '你是否常常因为分心而在做事中途切换到别的事情？',
            '你是否经常把需要完成的事情拖到最后一刻才动手？',
            '你是否在本该安静的场合仍然会不自觉说很多话或动个不停？',
            '你是否常常在需要排队或等待时感到特别难熬？',
            '别人还没说完时，你是否经常急着插话或先把答案说出来？',
            '你是否常因一时冲动答应、购买或决定一些事，之后再后悔？',
            '当任务枯燥但重要时，你是否很难启动并坚持到底？',
            '你是否觉得自己经常“知道该做什么”，但就是很难真正去做？'
        ]
    },
    child: {
        apiType: 'SNAP_IV',
        title: 'SNAP-IV 儿童量表',
        respondentType: 'parent',
        options: ['从不', '偶尔', '经常', '非常频繁'],
        maxScore: 3,
        estimatedMinutes: 6,
        questions: [
            '孩子做作业或完成任务时是否经常不注意细节、容易出错？',
            '孩子在课堂、游戏或活动中是否常常难以持续保持注意力？',
            '别人直接和孩子说话时，孩子是否经常像没在听一样？',
            '孩子是否常常无法按照指令把事情做完整？',
            '孩子是否经常难以整理学习用品、任务顺序或生活安排？',
            '孩子是否经常回避需要持续动脑的学习任务？',
            '孩子是否常把文具、作业本或生活用品弄丢？',
            '孩子是否容易被周围无关刺激吸引而分心？',
            '孩子是否经常忘记本来该做的事情？',
            '孩子是否经常手脚不停，坐着时也扭来扭去？',
            '在需要坐好的场合，孩子是否常常离开座位？',
            '孩子是否常常在不合适的场合跑来跑去或爬上爬下？',
            '孩子是否很难安静地参加游戏或休闲活动？',
            '孩子是否经常像停不下来一样，总在活动？',
            '孩子是否说话特别多，难以停下来？',
            '别人问题还没说完时，孩子是否经常抢着回答？',
            '孩子是否很难等待轮到自己？',
            '孩子是否经常打断别人或插入他人的活动？',
            '孩子被提醒时是否经常发脾气或顶嘴？',
            '孩子是否经常与成人争辩？',
            '孩子是否常常故意不配合规则或要求？',
            '孩子是否故意做让别人烦恼的事？',
            '孩子是否常常把自己的错误归咎于别人？',
            '孩子是否容易因为小事就被激怒？',
            '孩子是否经常处于生气、怨恨的状态？',
            '孩子是否表现出明显记仇或报复倾向？'
        ]
    }
};

const RADAR_LABELS = {
    attention_control: '注意控制',
    organization: '组织计划',
    task_activation: '任务启动',
    hyperactivity: '多动水平',
    impulsivity: '冲动反应',
    emotional_regulation: '情绪调节'
};

const RISK_LABELS = {
    low: '低风险',
    medium: '中等风险',
    high: '高风险'
};

const OPTION_TONE_PALETTES = {
    5: [
        {
            bg: '#FFF9F4',
            border: '#F4E8DA',
            hoverBg: '#FFF2E7',
            hoverBorder: '#E9D0B4',
            selectedBg: '#FCE8D7',
            selectedBorder: '#DDB791',
            text: '#876645',
            selectedText: '#99602A'
        },
        {
            bg: '#FFF5ED',
            border: '#F0DCC4',
            hoverBg: '#FEECDD',
            hoverBorder: '#E5C6A1',
            selectedBg: '#F9E2CB',
            selectedBorder: '#D6AC7C',
            text: '#845F3E',
            selectedText: '#925922'
        },
        {
            bg: '#FDEEDC',
            border: '#E9CCA7',
            hoverBg: '#FBE4CC',
            hoverBorder: '#DEB580',
            selectedBg: '#F6D9B8',
            selectedBorder: '#CE9C62',
            text: '#7D5838',
            selectedText: '#8A511A'
        },
        {
            bg: '#FBE7D0',
            border: '#E1BC92',
            hoverBg: '#F6DDBE',
            hoverBorder: '#D3A471',
            selectedBg: '#F0D0A4',
            selectedBorder: '#C48E50',
            text: '#775131',
            selectedText: '#7F4914'
        },
        {
            bg: '#F8E0C6',
            border: '#D9AF82',
            hoverBg: '#F2D3AF',
            hoverBorder: '#CA9A66',
            selectedBg: '#EABF93',
            selectedBorder: '#B97E42',
            text: '#704A2B',
            selectedText: '#77400E'
        }
    ],
    4: [
        {
            bg: '#FFF8F2',
            border: '#F3E4D5',
            hoverBg: '#FFF0E3',
            hoverBorder: '#E8CDB0',
            selectedBg: '#FBE7D5',
            selectedBorder: '#DBB289',
            text: '#866544',
            selectedText: '#985F28'
        },
        {
            bg: '#FDEEDB',
            border: '#E8CAA4',
            hoverBg: '#FBE4CB',
            hoverBorder: '#DDB27B',
            selectedBg: '#F6D8B7',
            selectedBorder: '#CD9B5F',
            text: '#7D5838',
            selectedText: '#89511A'
        },
        {
            bg: '#FAE3CB',
            border: '#DEB68E',
            hoverBg: '#F4D7B9',
            hoverBorder: '#CF9E6A',
            selectedBg: '#ECC79E',
            selectedBorder: '#BE864B',
            text: '#744F30',
            selectedText: '#7E4814'
        },
        {
            bg: '#F6DCC0',
            border: '#D4A97D',
            hoverBg: '#EFCFAC',
            hoverBorder: '#C5905B',
            selectedBg: '#E6BA8D',
            selectedBorder: '#B5763F',
            text: '#6D482A',
            selectedText: '#733D0E'
        }
    ]
};

let currentScaleKey = null;
let currentQuestionIndex = 0;
let answers = [];

const scaleLanding = document.getElementById('viewLanding');
const scaleTesting = document.getElementById('viewTesting');
const scaleResult = document.getElementById('viewResult');
const questionText = document.getElementById('questionText');
const optionsGrid = document.getElementById('optionsGrid');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const timeEstimate = document.querySelector('.time-est');
const userName = document.getElementById('userName');
const resultHeading = document.getElementById('resultHeading');
const resultSummary = document.getElementById('resultSummary');
const scoreChips = document.getElementById('scoreChips');
const recommendationList = document.getElementById('recommendationList');
const resultDisclaimer = document.getElementById('resultDisclaimer');

function getCurrentScale() {
    return currentScaleKey ? SCALE_CONFIG[currentScaleKey] : null;
}

function getDraftKey(scaleKey) {
    return `tempScaleAnswers_${scaleKey}`;
}

function getOptionTone(optionIndex, optionCount) {
    const palette = OPTION_TONE_PALETTES[optionCount] || OPTION_TONE_PALETTES[5];
    return palette[Math.min(optionIndex, palette.length - 1)] || palette[0];
}

function applyOptionTone(button, optionIndex, optionCount) {
    const tone = getOptionTone(optionIndex, optionCount);
    button.style.setProperty('--option-bg', tone.bg);
    button.style.setProperty('--option-border', tone.border);
    button.style.setProperty('--option-hover-bg', tone.hoverBg);
    button.style.setProperty('--option-hover-border', tone.hoverBorder);
    button.style.setProperty('--option-selected-bg', tone.selectedBg);
    button.style.setProperty('--option-selected-border', tone.selectedBorder);
    button.style.setProperty('--option-text', tone.text);
    button.style.setProperty('--option-selected-text', tone.selectedText);
}

function isValidAnswerValue(value, scale) {
    return Number.isInteger(value) && value >= 0 && value <= scale.maxScore;
}

function normalizeDraftAnswers(scale, draftAnswers) {
    if (!Array.isArray(draftAnswers)) {
        return [];
    }

    const normalized = [];
    const maxLength = Math.min(draftAnswers.length, scale.questions.length);

    for (let index = 0; index < maxLength; index += 1) {
        const numericValue = Number(draftAnswers[index]);
        if (!isValidAnswerValue(numericValue, scale)) {
            break;
        }
        normalized.push(numericValue);
    }

    return normalized;
}

function getFirstInvalidAnswerIndex(scale) {
    for (let index = 0; index < scale.questions.length; index += 1) {
        const numericValue = Number(answers[index]);
        if (!isValidAnswerValue(numericValue, scale)) {
            return index;
        }
    }

    return -1;
}

function setUserName() {
    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if (storedUser?.full_name && userName) {
        userName.textContent = storedUser.full_name;
    }
}

function switchView(fromElement, toElement, callback) {
    fromElement.classList.add('hidden');
    setTimeout(() => {
        fromElement.style.display = 'none';
        toElement.style.display = 'block';
        toElement.getBoundingClientRect();
        toElement.classList.remove('hidden');
        if (callback) callback();
    }, 300);
}

function renderQuestion() {
    const scale = getCurrentScale();
    if (!scale) return;

    if (currentQuestionIndex >= scale.questions.length) {
        completeScale();
        return;
    }

    progressText.textContent = `当前进度: ${currentQuestionIndex + 1} / ${scale.questions.length}`;
    progressFill.style.width = `${((currentQuestionIndex + 1) / scale.questions.length) * 100}%`;
    questionText.style.opacity = '0';
    optionsGrid.style.opacity = '0';

    setTimeout(() => {
        questionText.textContent = `${currentQuestionIndex + 1}. ${scale.questions[currentQuestionIndex]}`;
        optionsGrid.innerHTML = '';

        scale.options.forEach((label, score) => {
            const button = document.createElement('button');
            button.className = 'btn-option';
            button.type = 'button';
            button.textContent = label;
            applyOptionTone(button, score, scale.options.length);
            button.addEventListener('click', () => handleAnswer(score, button));
            optionsGrid.appendChild(button);
        });

        questionText.style.opacity = '1';
        optionsGrid.style.opacity = '1';
    }, 180);
}

function handleAnswer(score, buttonElement) {
    optionsGrid.querySelectorAll('.btn-option').forEach((button) => button.classList.remove('selected'));
    buttonElement.classList.add('selected');

    answers[currentQuestionIndex] = score;
    localStorage.setItem(getDraftKey(currentScaleKey), JSON.stringify(answers));

    setTimeout(() => {
        currentQuestionIndex += 1;
        renderQuestion();
    }, 220);
}

function renderScoreChips(result) {
    scoreChips.innerHTML = '';

    const chips = [
        `总分 ${result.total_score}`,
        `${result.scale_type}`,
        `${RISK_LABELS[result.risk_level] || result.risk_level}`
    ];

    Object.entries(result.sub_scores || {}).forEach(([key, value]) => {
        chips.push(`${formatMetricLabel(key)} ${value}`);
    });

    chips.forEach((text) => {
        const chip = document.createElement('span');
        chip.textContent = text;
        chip.style.cssText = 'padding:0.45rem 0.8rem;border-radius:999px;background:#EFF6FF;color:#1D4ED8;font-size:0.9rem;font-weight:600;';
        scoreChips.appendChild(chip);
    });
}

function renderRecommendations(result) {
    recommendationList.innerHTML = '';
    (result.recommendations || []).forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:0.6rem;align-items:flex-start;color:#475569;line-height:1.6;';
        row.innerHTML = `<ion-icon name="checkmark-circle-outline" style="color:#10B981;font-size:1.1rem;margin-top:0.2rem;"></ion-icon><span>${item}</span>`;
        recommendationList.appendChild(row);
    });
}

function formatMetricLabel(key) {
    const map = {
        part_a_positive: 'Part A 阳性数',
        attention_deficit: '注意缺陷分',
        hyperactivity_impulsivity: '多动冲动分',
        attention_mean: '注意均值',
        hyperactivity_mean: '多动均值',
        oppositional_mean: '对立均值'
    };
    return map[key] || key;
}

function initRadarChart(result) {
    const chartDom = document.getElementById('radarChart');
    if (!chartDom || !window.echarts) return;

    const chart = echarts.init(chartDom);
    const radarKeys = Object.keys(result.radar_scores || {});
    const option = {
        color: ['#0EA5E9'],
        radar: {
            indicator: radarKeys.map((key) => ({
                name: RADAR_LABELS[key] || key,
                max: 20
            })),
            splitArea: {
                areaStyle: {
                    color: ['rgba(14, 165, 233, 0.02)', 'rgba(14, 165, 233, 0.05)', 'rgba(14, 165, 233, 0.1)', 'rgba(14, 165, 233, 0.15)']
                }
            },
            axisName: {
                color: '#475569',
                fontSize: 13,
                fontWeight: 600
            },
            axisLine: { lineStyle: { color: 'rgba(14, 165, 233, 0.3)' } },
            splitLine: { lineStyle: { color: 'rgba(14, 165, 233, 0.3)' } }
        },
        series: [{
            type: 'radar',
            data: [{
                value: radarKeys.map((key) => result.radar_scores[key]),
                name: result.scale_type,
                areaStyle: { color: 'rgba(14, 165, 233, 0.4)' },
                lineStyle: { width: 3 },
                itemStyle: { color: '#0EA5E9', borderColor: '#fff', borderWidth: 2 }
            }]
        }]
    };
    chart.setOption(option);
    window.addEventListener('resize', () => chart.resize(), { once: true });
}

function renderResult(result) {
    const scale = getCurrentScale();
    resultHeading.innerHTML = `<ion-icon name="analytics-outline" style="color: var(--primary-blue);"></ion-icon> ${scale.title} 结果解读`;
    resultSummary.textContent = result.summary;
    resultDisclaimer.innerHTML = '<strong>医学免责声明：</strong> 本量表结果用于辅助筛查与后续追踪，不替代医生正式诊断。建议结合认知测试、14天追踪和专业访谈进行综合评估。';
    renderScoreChips(result);
    renderRecommendations(result);

    switchView(scaleTesting, scaleResult, () => {
        setTimeout(() => initRadarChart(result), 250);
    });
}

async function completeScale() {
    const scale = getCurrentScale();
    if (!scale) return;

    const firstInvalidAnswerIndex = getFirstInvalidAnswerIndex(scale);
    if (firstInvalidAnswerIndex !== -1) {
        answers = answers.slice(0, firstInvalidAnswerIndex);
        currentQuestionIndex = firstInvalidAnswerIndex;
        localStorage.setItem(getDraftKey(currentScaleKey), JSON.stringify(answers));
        alert('检测到当前量表草稿里有未完成或无效的题目，已保留有效答案，请从缺失题继续作答。');
        renderQuestion();
        return;
    }

    const payloadAnswers = scale.questions.map((_, index) => Number(answers[index]));
    questionText.textContent = '正在提交量表结果...';
    optionsGrid.innerHTML = '<p style="text-align:center;color:#64748B;">正在生成评估结果，请稍候。</p>';

    try {
        const result = await window.API.Patient.submitScale({
            scale_type: scale.apiType,
            respondent_type: scale.respondentType,
            answers: payloadAnswers
        });
        localStorage.removeItem(getDraftKey(currentScaleKey));
        renderResult(result);
    } catch (error) {
        alert(error.message || '量表提交失败，请确认后端是否已启动。');
        switchView(scaleTesting, scaleLanding);
    }
}

window.startScale = function startScale(type) {
    currentScaleKey = type;
    currentQuestionIndex = 0;
    answers = [];

    const scale = getCurrentScale();
    if (!scale) return;

    timeEstimate.innerHTML = `<ion-icon name="time-outline"></ion-icon> 预计 ${scale.estimatedMinutes} 分钟`;

    const draft = localStorage.getItem(getDraftKey(type));
    if (draft) {
        const parsed = JSON.parse(draft);
        const normalizedDraft = normalizeDraftAnswers(scale, parsed);
        if (normalizedDraft.length > 0) {
            const resume = confirm('系统检测到该量表有未完成草稿，是否继续上次进度？');
            if (resume) {
                answers = normalizedDraft;
                currentQuestionIndex = normalizedDraft.length;
                localStorage.setItem(getDraftKey(type), JSON.stringify(normalizedDraft));
            }
        }
    }

    switchView(scaleLanding, scaleTesting, renderQuestion);
};

window.quitScale = function quitScale() {
    const shouldQuit = confirm('当前量表进度已自动保存到本地，确定暂时退出吗？');
    if (shouldQuit) {
        switchView(scaleTesting, scaleLanding);
    }
};

function initFaq() {
    const faqQuestions = document.querySelectorAll('.faq-question');
    faqQuestions.forEach((question) => {
        question.addEventListener('click', () => {
            const parent = question.parentElement;
            const isActive = parent.classList.contains('active');
            document.querySelectorAll('.faq-item').forEach((item) => item.classList.remove('active'));
            if (!isActive) {
                parent.classList.add('active');
            }
        });
    });
}

if (scaleLanding) {
    setUserName();
    initFaq();
}
