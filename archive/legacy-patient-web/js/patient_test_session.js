const TEST_INFO = {
    reaction: {
        key: 'reaction',
        type: '反应时测试',
        category: '即时反应与误触控制',
        resultMode: '平均反应时 + 最快反应 + 误触次数',
        instructions: [
            '等待圆形由橙色变为绿色后立即点击。',
            '测试共 5 轮，过早点击会记为误触并重置当前轮次。',
            '结果主要用于观察基础反应速度和冲动控制情况。'
        ]
    },
    stroop: {
        key: 'stroop',
        type: 'Stroop 测试',
        category: '注意选择与抑制控制',
        resultMode: '正确率 + 平均反应时 + 冲突判断',
        instructions: [
            '请判断文字的颜色，而不是文字本身的含义。',
            '点击对应颜色按钮后进入下一题。',
            '测试共 8 题，结果用于观察冲突信息下的选择性注意能力。'
        ]
    },
    trail: {
        key: 'trail',
        type: '连线测试',
        category: '视觉搜索与顺序执行',
        resultMode: '完成用时 + 错误次数 + 完成状态',
        instructions: [
            '请按 1 到 8 的顺序依次点击圆点。',
            '点击错误目标会增加错误次数，但不会中断测试。',
            '结果可用于观察视觉搜索速度和执行稳定性。'
        ]
    },
    flanker: {
        key: 'flanker',
        type: 'Flanker 任务',
        category: '目标聚焦与干扰抑制',
        resultMode: '正确率 + 平均反应时 + 错误次数',
        instructions: [
            '请判断中间目标箭头的方向。',
            '左右两侧箭头有时一致，有时会形成干扰。',
            '测试共 10 轮，结果用于观察干扰条件下的注意控制表现。'
        ]
    },
    nback: {
        key: 'nback',
        type: '2-back 测试',
        category: '工作记忆更新',
        resultMode: '正确率 + 正确次数 + 有效轮次',
        instructions: [
            '观察 3×3 方格中高亮位置，并判断是否与前 2 次相同。',
            '前 2 轮用于建立记忆参照，不计入正确率。',
            '结果用于观察工作记忆维持与位置匹配判断能力。'
        ]
    },
    digit: {
        key: 'digit',
        type: '数字广度测试',
        category: '短时记忆容量',
        resultMode: '正确轮次 + 最高跨度 + 失败跨度',
        instructions: [
            '先记住屏幕中的数字序列，再按原顺序输入。',
            '每成功一轮会自动提升跨度长度。',
            '结果用于观察短时记忆容量与顺序保持能力。'
        ]
    }
};

const sessionState = {
    testType: 'reaction',
    running: false,
    completed: false,
    timeouts: [],
    finalResult: null,
    runtime: null
};

let canvas;
let ctx;
let canvasClickHandler = null;

function $(id) {
    return document.getElementById(id);
}

function getTestType() {
    const params = new URLSearchParams(window.location.search);
    const testType = params.get('test') || 'reaction';
    return TEST_INFO[testType] ? testType : 'reaction';
}

function updateTestInfo() {
    const info = TEST_INFO[sessionState.testType];
    $('testTypeDisplay').textContent = info.type;
    $('testCategoryDisplay').textContent = info.category;
    $('testResultMode').textContent = info.resultMode;
    $('testInstructions').innerHTML = info.instructions.map((item) => `<li>${item}</li>`).join('');
}

function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    if (!sessionState.running) {
        drawPlaceholder();
    }
}

function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function fillCanvasBackground() {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#FBFDFF');
    gradient.addColorStop(1, '#F8FAFC');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawCenterText(text, offsetY, fontSize, color, font) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = font || `600 ${fontSize}px Inter`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + offsetY);
    ctx.restore();
}

function drawCircle(x, y, radius, fill, stroke) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 4;
        ctx.stroke();
    }
}

function drawButton(rect, text, fill, stroke, textColor = '#FFFFFF') {
    ctx.fillStyle = fill;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = textColor;
    ctx.font = '700 18px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 1);
}

function drawPlaceholder() {
    clearCanvas();
    fillCanvasBackground();
    ctx.save();
    ctx.strokeStyle = '#D7E1EC';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
    ctx.restore();
    drawCenterText('点击开始测试', 0, 30, '#0F172A', '700 30px Inter');
    drawCenterText('系统将加载当前测试的交互画布并开始记录结果', 46, 16, '#64748B', '400 16px Inter');
}

function averageOf(values) {
    if (!values || !values.length) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function pointInRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function clearSessionTimers() {
    sessionState.timeouts.forEach((id) => clearTimeout(id));
    sessionState.timeouts = [];
}

function schedule(fn, delay) {
    const id = setTimeout(fn, delay);
    sessionState.timeouts.push(id);
    return id;
}

function setCanvasHandler(handler) {
    canvasClickHandler = handler;
}

function resetResultCard() {
    $('resultCard').classList.remove('visible');
    $('resultMetrics').innerHTML = '';
    $('submitStatus').textContent = '结果生成后会自动写入本地摘要，并尝试同步到认知测试接口。';
}

function renderResultCard(result) {
    $('resultCard').classList.add('visible');
    $('resultStatus').innerHTML = `<ion-icon name="checkmark-circle-outline"></ion-icon>${result.statusText}`;
    $('resultSummary').textContent = result.summary;
    $('resultMetrics').innerHTML = result.metrics.map((item) => `
        <div class="metric-item">
            <span class="metric-label">${item.label}</span>
            <span class="metric-value">${item.value}</span>
        </div>
    `).join('');
    $('submitStatus').textContent = '结果已生成，正在保存本次测试记录。';
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function persistResultLocally(result) {
    const latest = {
        test_key: result.testKey,
        test_name: result.testName,
        status_text: result.statusText,
        summary: result.summary,
        metrics: result.metrics,
        raw_result: result.rawResult || {},
        finished_at: result.finishedAt
    };

    localStorage.setItem('smartbrain_latest_cognitive_test', JSON.stringify(latest));
    const history = JSON.parse(localStorage.getItem('smartbrain_cognitive_test_history') || '[]');
    history.unshift(latest);
    localStorage.setItem('smartbrain_cognitive_test_history', JSON.stringify(history.slice(0, 12)));
}

async function syncResultIfPossible(result) {
    const payload = {
        test_type: result.testKey,
        result_json: {
            test_name: result.testName,
            summary: result.summary,
            status_text: result.statusText,
            metrics: result.metrics,
            raw_result: result.rawResult || {},
            finished_at: result.finishedAt
        }
    };

    try {
        if (!window.API?.Patient?.submitCognitiveTest) {
            $('submitStatus').textContent = '结果已保存到本地，当前页和报告页都可以读取这次测试摘要。';
            return;
        }
        await window.API.Patient.submitCognitiveTest(payload);
        $('submitStatus').textContent = '结果已保存，并已成功同步到认知测试接口。';
    } catch (error) {
        console.error('Failed to sync cognitive test result:', error);
        $('submitStatus').textContent = '结果已保存到本地。当前后端认知测试接口未返回成功，但不会影响本页查看结果。';
    }
}

function buildPartialResult() {
    const info = TEST_INFO[sessionState.testType];
    const runtime = sessionState.runtime;
    if (!runtime) {
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: '测试已提前结束，未生成完整结果。',
            metrics: [{ label: '当前状态', value: '未完成' }],
            rawResult: {}
        };
    }

    if (runtime.kind === 'reaction') {
        const avg = averageOf(runtime.reactionTimes);
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: '反应时间测试已提前结束，以下为当前已完成轮次的临时结果。',
            metrics: [
                { label: '已完成轮次', value: `${runtime.completedRounds}/${runtime.targetRounds}` },
                { label: '平均反应时', value: runtime.reactionTimes.length ? `${avg} ms` : '--' },
                { label: '误触次数', value: `${runtime.falseStarts}` }
            ],
            rawResult: {
                completed_rounds: runtime.completedRounds,
                target_rounds: runtime.targetRounds,
                average_reaction_time_ms: avg,
                false_starts: runtime.falseStarts
            }
        };
    }

    if (runtime.kind === 'stroop') {
        const avg = averageOf(runtime.timings);
        const accuracy = runtime.currentTrial ? Math.round((runtime.correct / runtime.currentTrial) * 100) : 0;
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: 'Stroop 测试已提前结束，以下为当前已作答题目的临时结果。',
            metrics: [
                { label: '当前进度', value: `${runtime.currentTrial}/${runtime.totalTrials}` },
                { label: '正确率', value: `${accuracy}%` },
                { label: '平均反应时', value: avg ? `${avg} ms` : '--' }
            ],
            rawResult: {
                total_trials: runtime.totalTrials,
                answered_trials: runtime.currentTrial,
                correct: runtime.correct,
                wrong: runtime.wrong,
                accuracy,
                average_reaction_time_ms: avg
            }
        };
    }

    if (runtime.kind === 'trail') {
        const elapsed = Math.round(performance.now() - runtime.startTime);
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: '连线测试已提前结束，以下为当前进度和错误统计。',
            metrics: [
                { label: '当前进度', value: `${runtime.next - 1}/${runtime.totalPoints}` },
                { label: '错误次数', value: `${runtime.errors}` },
                { label: '当前用时', value: `${elapsed} ms` }
            ],
            rawResult: {
                completed_points: runtime.next - 1,
                total_points: runtime.totalPoints,
                errors: runtime.errors,
                elapsed_ms: elapsed
            }
        };
    }

    if (runtime.kind === 'flanker') {
        const avg = averageOf(runtime.timings);
        const accuracy = runtime.currentTrial ? Math.round((runtime.correct / runtime.currentTrial) * 100) : 0;
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: 'Flanker 任务已提前结束，以下为当前已完成轮次的临时结果。',
            metrics: [
                { label: '当前进度', value: `${runtime.currentTrial}/${runtime.totalTrials}` },
                { label: '正确率', value: `${accuracy}%` },
                { label: '平均反应时', value: avg ? `${avg} ms` : '--' }
            ],
            rawResult: {
                total_trials: runtime.totalTrials,
                answered_trials: runtime.currentTrial,
                correct: runtime.correct,
                wrong: runtime.wrong,
                accuracy,
                average_reaction_time_ms: avg
            }
        };
    }

    if (runtime.kind === 'nback') {
        const scoredTrials = Math.max(runtime.currentIndex - 2, 0);
        const accuracy = scoredTrials ? Math.round((runtime.correct / scoredTrials) * 100) : 0;
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: '2-back 测试已提前结束，以下为当前记忆匹配表现。',
            metrics: [
                { label: '当前进度', value: `${runtime.currentIndex}/${runtime.totalTrials}` },
                { label: '有效轮次', value: `${scoredTrials}` },
                { label: '正确率', value: `${accuracy}%` }
            ],
            rawResult: {
                total_trials: runtime.totalTrials,
                scored_trials: scoredTrials,
                correct: runtime.correct,
                wrong: runtime.wrong,
                accuracy
            }
        };
    }

    if (runtime.kind === 'digit') {
        return {
            testKey: info.key,
            testName: info.type,
            statusText: '已结束测试',
            summary: '数字广度测试已提前结束，以下为当前记忆跨度结果。',
            metrics: [
                { label: '正确轮次', value: `${runtime.correctRounds}` },
                { label: '最高跨度', value: `${runtime.highestSpan}` },
                { label: '当前跨度', value: `${runtime.currentLength}` }
            ],
            rawResult: {
                correct_rounds: runtime.correctRounds,
                highest_span: runtime.highestSpan,
                current_length: runtime.currentLength,
                phase: runtime.phase
            }
        };
    }

    return {
        testKey: info.key,
        testName: info.type,
        statusText: '演示模式',
        summary: '当前测试模块处于演示模式，正式结果回传逻辑仍在接入中。',
        metrics: [{ label: '当前状态', value: '演示中' }],
        rawResult: {}
    };
}

async function finalizeTestSession(result) {
    clearSessionTimers();
    setCanvasHandler(null);
    sessionState.running = false;
    sessionState.completed = true;
    sessionState.finalResult = { ...result, finishedAt: new Date().toISOString() };
    $('startTestBtn').textContent = '重新开始测试';

    renderResultCard(sessionState.finalResult);
    persistResultLocally(sessionState.finalResult);
    
    // Set achievement trigger for patient_test.html
    const achPayload = {
        test_type: result.testKey,
        accuracy: result.rawResult?.accuracy !== undefined ? result.rawResult.accuracy / 100 : undefined,
        gonogo_rt: result.testKey === 'reaction' ? result.rawResult?.fastest_reaction_time_ms : undefined,
        nback_accuracy: result.testKey === 'nback' ? (result.rawResult?.accuracy / 100) : undefined,
        summary: result.summary
    };
    sessionStorage.setItem('achievement_trigger', JSON.stringify(achPayload));

    await syncResultIfPossible(sessionState.finalResult);
}

function startReactionTest() {
    sessionState.runtime = { kind: 'reaction', targetRounds: 5, completedRounds: 0, falseStarts: 0, reactionTimes: [], clickable: false, startTime: 0 };
    const runtime = sessionState.runtime;

    function drawWaiting() {
        clearCanvas();
        fillCanvasBackground();
        drawCircle(canvas.width / 2, canvas.height / 2, 82, '#F59E0B', '#D97706');
        drawCenterText('等待变绿', 0, 26, '#FFFFFF', '700 26px Inter');
        drawCenterText(`第 ${runtime.completedRounds + 1} / ${runtime.targetRounds} 轮`, 112, 16, '#64748B', '500 16px Inter');
        drawCenterText('请不要提前点击', 138, 15, '#94A3B8', '400 15px Inter');
    }

    function drawGo() {
        clearCanvas();
        fillCanvasBackground();
        drawCircle(canvas.width / 2, canvas.height / 2, 82, '#10B981', '#059669');
        drawCenterText('立即点击', 0, 26, '#FFFFFF', '800 26px Inter');
        drawCenterText(`第 ${runtime.completedRounds + 1} / ${runtime.targetRounds} 轮`, 112, 16, '#64748B', '500 16px Inter');
    }

    function drawFeedback(text, color, border, detail) {
        clearCanvas();
        fillCanvasBackground();
        drawCircle(canvas.width / 2, canvas.height / 2, 82, color, border);
        drawCenterText(text, -6, 24, '#FFFFFF', '700 24px Inter');
        drawCenterText(detail, 118, 16, '#64748B', '500 16px Inter');
    }

    function nextRound() {
        if (!sessionState.running) return;
        runtime.clickable = false;
        drawWaiting();
        schedule(() => {
            if (!sessionState.running) return;
            runtime.clickable = true;
            runtime.startTime = performance.now();
            drawGo();
        }, 1000 + Math.floor(Math.random() * 1800));
    }

    setCanvasHandler(() => {
        if (!sessionState.running) return;
        if (!runtime.clickable) {
            runtime.falseStarts += 1;
            drawFeedback('过早点击', '#EF4444', '#DC2626', '本轮重置，请稍后再试');
            clearSessionTimers();
            schedule(nextRound, 1100);
            return;
        }

        runtime.clickable = false;
        const reactionTime = Math.round(performance.now() - runtime.startTime);
        runtime.reactionTimes.push(reactionTime);
        runtime.completedRounds += 1;
        drawFeedback('记录成功', '#2563EB', '#1D4ED8', `本轮反应时 ${reactionTime} ms`);

        if (runtime.completedRounds >= runtime.targetRounds) {
            const average = averageOf(runtime.reactionTimes);
            const fastest = Math.min(...runtime.reactionTimes);
            finalizeTestSession({
                testKey: 'reaction',
                testName: TEST_INFO.reaction.type,
                statusText: '已完成测试',
                summary: '反应时间测试已完成。系统已根据 5 轮有效作答生成结果，可用于观察即时反应速度与误触控制情况。',
                metrics: [
                    { label: '平均反应时', value: `${average} ms` },
                    { label: '最快反应', value: `${fastest} ms` },
                    { label: '有效轮次', value: `${runtime.completedRounds}/${runtime.targetRounds}` },
                    { label: '误触次数', value: `${runtime.falseStarts}` }
                ],
                rawResult: {
                    completed_rounds: runtime.completedRounds,
                    target_rounds: runtime.targetRounds,
                    average_reaction_time_ms: average,
                    fastest_reaction_time_ms: fastest,
                    false_starts: runtime.falseStarts
                }
            });
            return;
        }

        schedule(nextRound, 900);
    });

    nextRound();
}

function startStroopTest() {
    const palette = [
        { text: '红', key: 'red', css: '#EF4444' },
        { text: '绿', key: 'green', css: '#10B981' },
        { text: '蓝', key: 'blue', css: '#3B82F6' },
        { text: '黄', key: 'yellow', css: '#F59E0B' }
    ];

    sessionState.runtime = { kind: 'stroop', totalTrials: 8, currentTrial: 0, correct: 0, wrong: 0, timings: [], startTime: 0, currentPrompt: null };
    const runtime = sessionState.runtime;

    function randomItem(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    function drawPrompt() {
        clearCanvas();
        fillCanvasBackground();
        ctx.save();
        ctx.fillStyle = '#0F172A';
        ctx.font = '700 18px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`第 ${runtime.currentTrial + 1} / ${runtime.totalTrials} 题`, canvas.width / 2, 42);
        ctx.restore();

        ctx.save();
        ctx.fillStyle = runtime.currentPrompt.color.css;
        ctx.font = '800 54px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(runtime.currentPrompt.word.text, canvas.width / 2, canvas.height / 2 - 40);
        ctx.restore();

        drawCenterText('请判断文字的颜色，而不是文字的含义', 24, 16, '#64748B', '500 16px Inter');

        const startX = canvas.width / 2 - 190;
        const y = canvas.height / 2 + 70;
        palette.forEach((item, index) => {
            const x = startX + index * 95;
            ctx.fillStyle = item.css;
            ctx.fillRect(x, y, 80, 42);
            ctx.strokeStyle = '#1E293B';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, 80, 42);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = '700 16px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(item.text, x + 40, y + 27);
        });
    }

    function nextPrompt() {
        if (!sessionState.running) return;
        runtime.currentPrompt = { word: randomItem(palette), color: randomItem(palette) };
        runtime.startTime = performance.now();
        drawPrompt();
    }

    setCanvasHandler((event) => {
        if (!sessionState.running || !runtime.currentPrompt) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const startX = canvas.width / 2 - 190;
        const buttonY = canvas.height / 2 + 70;

        for (let index = 0; index < palette.length; index += 1) {
            const item = palette[index];
            const buttonX = startX + index * 95;
            const hit = x >= buttonX && x <= buttonX + 80 && y >= buttonY && y <= buttonY + 42;
            if (!hit) continue;

            const elapsed = Math.round(performance.now() - runtime.startTime);
            runtime.timings.push(elapsed);
            runtime.currentTrial += 1;
            if (item.key === runtime.currentPrompt.color.key) runtime.correct += 1;
            else runtime.wrong += 1;

            if (runtime.currentTrial >= runtime.totalTrials) {
                const avgTime = averageOf(runtime.timings);
                const accuracy = Math.round((runtime.correct / runtime.totalTrials) * 100);
                finalizeTestSession({
                    testKey: 'stroop',
                    testName: TEST_INFO.stroop.type,
                    statusText: '已完成测试',
                    summary: 'Stroop 测试已完成。本次结果主要反映你在冲突信息下的注意选择能力和抑制控制表现。',
                    metrics: [
                        { label: '正确率', value: `${accuracy}%` },
                        { label: '平均反应时', value: `${avgTime} ms` },
                        { label: '正确次数', value: `${runtime.correct}` },
                        { label: '错误次数', value: `${runtime.wrong}` }
                    ],
                    rawResult: {
                        total_trials: runtime.totalTrials,
                        correct: runtime.correct,
                        wrong: runtime.wrong,
                        accuracy,
                        average_reaction_time_ms: avgTime
                    }
                });
                return;
            }

            nextPrompt();
            return;
        }
    });

    nextPrompt();
}

function startTrailTest() {
    const pointLayout = [
        { x: 0.18, y: 0.22 },
        { x: 0.38, y: 0.17 },
        { x: 0.62, y: 0.28 },
        { x: 0.24, y: 0.48 },
        { x: 0.41, y: 0.41 },
        { x: 0.71, y: 0.28 },
        { x: 0.33, y: 0.63 },
        { x: 0.62, y: 0.63 }
    ];

    sessionState.runtime = {
        kind: 'trail',
        totalPoints: pointLayout.length,
        next: 1,
        errors: 0,
        startTime: performance.now(),
        flashErrorIndex: null,
        points: pointLayout
    };

    const runtime = sessionState.runtime;

    function getRadius() {
        return Math.max(24, Math.min(canvas.width, canvas.height) * 0.05);
    }

    function getCanvasPoint(point) {
        return { x: point.x * canvas.width, y: point.y * canvas.height };
    }

    function drawBoard() {
        clearCanvas();
        fillCanvasBackground();

        const radius = getRadius();
        const completedCount = runtime.next - 1;

        ctx.save();
        ctx.strokeStyle = '#93C5FD';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (let index = 1; index < completedCount; index += 1) {
            const prev = getCanvasPoint(runtime.points[index - 1]);
            const current = getCanvasPoint(runtime.points[index]);
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(current.x, current.y);
            ctx.stroke();
        }
        ctx.restore();

        runtime.points.forEach((point, index) => {
            const value = index + 1;
            const pos = getCanvasPoint(point);
            const isCompleted = value < runtime.next;
            const isCurrent = value === runtime.next;
            const isError = runtime.flashErrorIndex === index;

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = isCompleted ? '#DBEAFE' : '#FFFFFF';
            ctx.fill();
            ctx.strokeStyle = isError ? '#EF4444' : (isCurrent ? '#2563EB' : '#60A5FA');
            ctx.lineWidth = isCurrent ? 4 : 3;
            ctx.stroke();

            ctx.fillStyle = isError ? '#B91C1C' : (isCompleted ? '#1D4ED8' : '#3B82F6');
            ctx.font = '700 22px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(value), pos.x, pos.y);
        });

        const elapsed = Math.round(performance.now() - runtime.startTime);
        drawCenterText(`当前进度 ${completedCount}/${runtime.totalPoints}`, 150, 16, '#475569', '600 16px Inter');
        drawCenterText(`错误次数 ${runtime.errors} · 用时 ${elapsed} ms`, 178, 15, '#64748B', '500 15px Inter');
    }

    setCanvasHandler((event) => {
        if (!sessionState.running) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const radius = getRadius();

        for (let index = 0; index < runtime.points.length; index += 1) {
            const pos = getCanvasPoint(runtime.points[index]);
            const distance = Math.hypot(x - pos.x, y - pos.y);
            if (distance > radius) continue;

            const value = index + 1;
            if (value === runtime.next) {
                runtime.next += 1;
                runtime.flashErrorIndex = null;
                drawBoard();

                if (runtime.next > runtime.totalPoints) {
                    const elapsed = Math.round(performance.now() - runtime.startTime);
                    finalizeTestSession({
                        testKey: 'trail',
                        testName: TEST_INFO.trail.type,
                        statusText: '已完成测试',
                        summary: '连线测试已完成。本次结果可以帮助观察视觉搜索速度、顺序执行稳定性和错误控制情况。',
                        metrics: [
                            { label: '完成进度', value: `${runtime.totalPoints}/${runtime.totalPoints}` },
                            { label: '总用时', value: `${elapsed} ms` },
                            { label: '错误次数', value: `${runtime.errors}` },
                            { label: '完成状态', value: '已完成' }
                        ],
                        rawResult: {
                            completed_points: runtime.totalPoints,
                            total_points: runtime.totalPoints,
                            errors: runtime.errors,
                            elapsed_ms: elapsed
                        }
                    });
                }
            } else {
                runtime.errors += 1;
                runtime.flashErrorIndex = index;
                drawBoard();
                schedule(() => {
                    runtime.flashErrorIndex = null;
                    if (sessionState.running) drawBoard();
                }, 350);
            }
            return;
        }
    });

    drawBoard();
}

function startFlankerTest() {
    sessionState.runtime = {
        kind: 'flanker',
        totalTrials: 10,
        currentTrial: 0,
        correct: 0,
        wrong: 0,
        timings: [],
        startTime: 0,
        target: '>',
        congruent: true,
        leftRect: null,
        rightRect: null
    };

    const runtime = sessionState.runtime;

    function preparePrompt() {
        const congruent = Math.random() > 0.4;
        const target = Math.random() > 0.5 ? '>' : '<';
        const flank = congruent ? target : (target === '>' ? '<' : '>');
        runtime.target = target;
        runtime.congruent = congruent;
        runtime.prompt = [flank, flank, target, flank, flank];
        runtime.startTime = performance.now();
        drawPrompt();
    }

    function drawPrompt() {
        clearCanvas();
        fillCanvasBackground();

        ctx.fillStyle = '#0F172A';
        ctx.font = '700 18px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`第 ${runtime.currentTrial + 1} / ${runtime.totalTrials} 轮`, canvas.width / 2, 38);

        const spacing = Math.min(62, canvas.width * 0.095);
        const startX = canvas.width / 2 - spacing * 2;
        runtime.prompt.forEach((symbol, index) => {
            const isTarget = index === 2;
            ctx.fillStyle = isTarget ? '#3B82F6' : '#475569';
            ctx.font = `${isTarget ? 800 : 700} 48px Inter`;
            ctx.fillText(symbol, startX + spacing * index, canvas.height / 2 - 40);
        });

        drawCenterText(runtime.congruent ? 'Congruent' : 'Incongruent', 34, 18, runtime.congruent ? '#10B981' : '#F59E0B', '700 18px Inter');

        const buttonY = canvas.height - 118;
        runtime.leftRect = { x: canvas.width / 2 - 120, y: buttonY, width: 90, height: 48 };
        runtime.rightRect = { x: canvas.width / 2 + 30, y: buttonY, width: 90, height: 48 };
        drawButton(runtime.leftRect, '<', '#2563EB', '#1D4ED8');
        drawButton(runtime.rightRect, '>', '#2563EB', '#1D4ED8');

        const avg = averageOf(runtime.timings);
        ctx.fillStyle = '#475569';
        ctx.font = '600 16px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`正确 ${runtime.correct} · 错误 ${runtime.wrong}`, canvas.width / 2, buttonY + 72);

        ctx.fillStyle = '#64748B';
        ctx.font = '500 15px Inter';
        ctx.fillText(`平均反应时间 ${avg ? `${avg} ms` : '--'}`, canvas.width / 2, buttonY + 100);
    }

    setCanvasHandler((event) => {
        if (!sessionState.running) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        let answer = null;
        if (runtime.leftRect && pointInRect(x, y, runtime.leftRect)) answer = '<';
        if (runtime.rightRect && pointInRect(x, y, runtime.rightRect)) answer = '>';
        if (!answer) return;

        const elapsed = Math.round(performance.now() - runtime.startTime);
        runtime.timings.push(elapsed);
        runtime.currentTrial += 1;
        if (answer === runtime.target) runtime.correct += 1;
        else runtime.wrong += 1;

        if (runtime.currentTrial >= runtime.totalTrials) {
            const accuracy = Math.round((runtime.correct / runtime.totalTrials) * 100);
            const avgTime = averageOf(runtime.timings);
            finalizeTestSession({
                testKey: 'flanker',
                testName: TEST_INFO.flanker.type,
                statusText: '已完成测试',
                summary: 'Flanker 任务已完成。本次结果主要反映你在干扰刺激存在时的目标聚焦能力和抑制控制表现。',
                metrics: [
                    { label: '正确率', value: `${accuracy}%` },
                    { label: '平均反应时', value: `${avgTime} ms` },
                    { label: '正确次数', value: `${runtime.correct}` },
                    { label: '错误次数', value: `${runtime.wrong}` }
                ],
                rawResult: {
                    total_trials: runtime.totalTrials,
                    correct: runtime.correct,
                    wrong: runtime.wrong,
                    accuracy,
                    average_reaction_time_ms: avgTime
                }
            });
            return;
        }

        preparePrompt();
    });

    preparePrompt();
}

function generateNBackSequence(length) {
    const sequence = [];
    for (let i = 0; i < 2; i += 1) {
        sequence.push(Math.floor(Math.random() * 9));
    }
    for (let i = 2; i < length; i += 1) {
        if (Math.random() < 0.35) {
            sequence.push(sequence[i - 2]);
        } else {
            let newVal;
            do {
                newVal = Math.floor(Math.random() * 9);
            } while (newVal === sequence[i - 2]);
            sequence.push(newVal);
        }
    }
    return sequence;
}

function startDigitTest() {
    sessionState.runtime = {
        kind: 'digit',
        round: 1,
        correctRounds: 0,
        highestSpan: 0,
        currentLength: 5,
        phase: 'show',
        target: '',
        input: '',
        digitButtons: [],
        clearRect: null,
        deleteRect: null
    };

    const runtime = sessionState.runtime;

    function generateSequence(length) {
        return Array.from({ length }, () => String(Math.floor(Math.random() * 10))).join('');
    }

    function drawBoard() {
        clearCanvas();
        fillCanvasBackground();

        ctx.fillStyle = '#0F172A';
        ctx.font = '700 18px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`第 ${runtime.round} 轮 · 当前跨度 ${runtime.currentLength}`, canvas.width / 2, 38);

        const boxWidth = Math.min(52, canvas.width / Math.max(runtime.currentLength + 3, 8));
        const gap = 12;
        const totalWidth = runtime.currentLength * boxWidth + (runtime.currentLength - 1) * gap;
        const startX = (canvas.width - totalWidth) / 2;
        const boxY = 88;

        for (let index = 0; index < runtime.currentLength; index += 1) {
            const x = startX + index * (boxWidth + gap);
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#CBD5E1';
            ctx.lineWidth = 2;
            ctx.fillRect(x, boxY, boxWidth, 56);
            ctx.strokeRect(x, boxY, boxWidth, 56);

            let value = '';
            if (runtime.phase === 'show') value = runtime.target[index] || '';
            if (runtime.phase === 'input') value = runtime.input[index] || '';

            ctx.fillStyle = value ? '#3B82F6' : '#94A3B8';
            ctx.font = '700 28px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(value || '·', x + boxWidth / 2, boxY + 30);
        }

        const helperText = runtime.phase === 'show'
            ? '请记住这串数字，稍后按原顺序输入'
            : `当前输入：${runtime.input || '-'}`;
        drawCenterText(helperText, -10, 16, '#64748B', '500 16px Inter');
        drawCenterText(`已答对 ${runtime.correctRounds} 轮 · 最高跨度 ${runtime.highestSpan || '--'}`, 18, 15, '#475569', '600 15px Inter');

        runtime.digitButtons = [];
        const buttonWidth = 52;
        const buttonHeight = 42;
        const buttonGap = 10;
        const rowWidth = 5 * buttonWidth + 4 * buttonGap;
        const rowStartX = (canvas.width - rowWidth) / 2;
        const firstRowY = canvas.height - 125;
        const secondRowY = canvas.height - 72;

        for (let digit = 1; digit <= 9; digit += 1) {
            const rowIndex = digit <= 5 ? 0 : 1;
            const columnIndex = digit <= 5 ? digit - 1 : digit - 6;
            const rect = {
                x: rowStartX + columnIndex * (buttonWidth + buttonGap),
                y: rowIndex === 0 ? firstRowY : secondRowY,
                width: buttonWidth,
                height: buttonHeight,
                value: String(digit)
            };
            runtime.digitButtons.push(rect);
            drawButton(rect, String(digit), runtime.phase === 'input' ? '#2563EB' : '#94A3B8', runtime.phase === 'input' ? '#1D4ED8' : '#94A3B8');
        }

        const zeroRect = {
            x: rowStartX + 4 * (buttonWidth + buttonGap),
            y: secondRowY,
            width: buttonWidth,
            height: buttonHeight,
            value: '0'
        };
        runtime.digitButtons.push(zeroRect);
        drawButton(zeroRect, '0', runtime.phase === 'input' ? '#2563EB' : '#94A3B8', runtime.phase === 'input' ? '#1D4ED8' : '#94A3B8');

        runtime.clearRect = { x: rowStartX - 100, y: secondRowY, width: 86, height: buttonHeight };
        runtime.deleteRect = { x: rowStartX + rowWidth + 14, y: secondRowY, width: 86, height: buttonHeight };
        drawButton(runtime.clearRect, '清空', runtime.phase === 'input' ? '#F59E0B' : '#CBD5E1', runtime.phase === 'input' ? '#D97706' : '#CBD5E1');
        drawButton(runtime.deleteRect, '删除', runtime.phase === 'input' ? '#EF4444' : '#CBD5E1', runtime.phase === 'input' ? '#DC2626' : '#CBD5E1');
    }

    function evaluateInput() {
        const isCorrect = runtime.input === runtime.target;
        if (isCorrect) {
            runtime.correctRounds += 1;
            runtime.highestSpan = Math.max(runtime.highestSpan, runtime.currentLength);
            runtime.currentLength += 1;
            runtime.round += 1;

            if (runtime.correctRounds >= 3) {
                finalizeTestSession({
                    testKey: 'digit',
                    testName: TEST_INFO.digit.type,
                    statusText: '已完成测试',
                    summary: '数字广度测试已完成。结果反映了你在顺序保持、短时记忆容量和工作记忆维持方面的表现。',
                    metrics: [
                        { label: '正确轮次', value: `${runtime.correctRounds}` },
                        { label: '最高跨度', value: `${runtime.highestSpan}` },
                        { label: '最终跨度', value: `${runtime.currentLength - 1}` },
                        { label: '完成状态', value: '已完成' }
                    ],
                    rawResult: {
                        correct_rounds: runtime.correctRounds,
                        highest_span: runtime.highestSpan,
                        final_span: runtime.currentLength - 1
                    }
                });
                return;
            }

            beginRound();
            return;
        }

        finalizeTestSession({
            testKey: 'digit',
            testName: TEST_INFO.digit.type,
            statusText: '已完成测试',
            summary: '数字广度测试已结束。系统已根据当前正确轮次和最高跨度生成结果摘要，用于观察短时记忆容量表现。',
            metrics: [
                { label: '正确轮次', value: `${runtime.correctRounds}` },
                { label: '最高跨度', value: `${runtime.highestSpan}` },
                { label: '本轮目标长度', value: `${runtime.currentLength}` },
                { label: '完成状态', value: '已结束' }
            ],
            rawResult: {
                correct_rounds: runtime.correctRounds,
                highest_span: runtime.highestSpan,
                failed_span: runtime.currentLength,
                target_sequence: runtime.target
            }
        });
    }

    function beginRound() {
        if (!sessionState.running) return;
        runtime.phase = 'show';
        runtime.input = '';
        runtime.target = generateSequence(runtime.currentLength);
        drawBoard();

        schedule(() => {
            if (!sessionState.running) return;
            runtime.phase = 'input';
            drawBoard();
        }, 1600 + runtime.currentLength * 260);
    }

    setCanvasHandler((event) => {
        if (!sessionState.running || runtime.phase !== 'input') return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        if (runtime.clearRect && pointInRect(x, y, runtime.clearRect)) {
            runtime.input = '';
            drawBoard();
            return;
        }

        if (runtime.deleteRect && pointInRect(x, y, runtime.deleteRect)) {
            runtime.input = runtime.input.slice(0, -1);
            drawBoard();
            return;
        }

        for (const button of runtime.digitButtons) {
            if (!pointInRect(x, y, button)) continue;
            if (runtime.input.length >= runtime.target.length) return;
            runtime.input += button.value;
            drawBoard();
            if (runtime.input.length === runtime.target.length) {
                schedule(() => {
                    if (sessionState.running) evaluateInput();
                }, 200);
            }
            return;
        }
    });

    beginRound();
}

function startNBackTest() {
    sessionState.runtime = {
        kind: 'nback',
        totalTrials: 12,
        currentIndex: 0,
        sequence: generateNBackSequence(12),
        correct: 0,
        wrong: 0
    };
    const runtime = sessionState.runtime;

    function drawGrid() {
        clearCanvas();
        fillCanvasBackground();

        const gridSize = 3;
        const cellSize = Math.min(canvas.width, canvas.height - 80) * 0.22;
        const startX = (canvas.width - gridSize * cellSize - 2 * 14) / 2;
        const startY = 60;
        const activeIndex = runtime.sequence[runtime.currentIndex];

        ctx.save();
        ctx.fillStyle = '#0F172A';
        ctx.font = '700 18px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(`第 ${runtime.currentIndex + 1} / ${runtime.totalTrials} 轮`, canvas.width / 2, 34);
        ctx.restore();

        for (let row = 0; row < gridSize; row += 1) {
            for (let col = 0; col < gridSize; col += 1) {
                const cellIndex = row * gridSize + col;
                const x = startX + col * (cellSize + 14);
                const y = startY + row * (cellSize + 14);
                ctx.fillStyle = cellIndex === activeIndex ? '#3B82F6' : '#E2E8F0';
                ctx.fillRect(x, y, cellSize, cellSize);
                ctx.strokeStyle = cellIndex === activeIndex ? '#1D4ED8' : '#CBD5E1';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, cellSize, cellSize);
            }
        }

        drawCenterText('当前位置是否与前 2 次相同？', 118, 16, '#64748B', '500 16px Inter');
        drawCenterText(runtime.currentIndex < 2 ? '前两轮用于建立参照，不计入得分' : '请选择“是”或“否”', 146, 15, '#94A3B8', '400 15px Inter');

        const yesX = canvas.width / 2 - 110;
        const noX = canvas.width / 2 + 20;
        const buttonY = canvas.height - 84;

        ctx.fillStyle = '#10B981';
        ctx.fillRect(yesX, buttonY, 90, 42);
        ctx.strokeStyle = '#059669';
        ctx.strokeRect(yesX, buttonY, 90, 42);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 16px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('是', yesX + 45, buttonY + 27);

        ctx.fillStyle = '#EF4444';
        ctx.fillRect(noX, buttonY, 90, 42);
        ctx.strokeStyle = '#DC2626';
        ctx.strokeRect(noX, buttonY, 90, 42);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('否', noX + 45, buttonY + 27);
    }

    function nextStep() {
        if (!sessionState.running) return;
        drawGrid();
    }

    setCanvasHandler((event) => {
        if (!sessionState.running) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const yesX = canvas.width / 2 - 110;
        const noX = canvas.width / 2 + 20;
        const buttonY = canvas.height - 84;

        let answer = null;
        if (x >= yesX && x <= yesX + 90 && y >= buttonY && y <= buttonY + 42) answer = true;
        if (x >= noX && x <= noX + 90 && y >= buttonY && y <= buttonY + 42) answer = false;
        if (answer === null) return;

        if (runtime.currentIndex >= 2) {
            const actualMatch = runtime.sequence[runtime.currentIndex] === runtime.sequence[runtime.currentIndex - 2];
            if (answer === actualMatch) runtime.correct += 1;
            else runtime.wrong += 1;
        }

        runtime.currentIndex += 1;

        if (runtime.currentIndex >= runtime.totalTrials) {
            const scoredTrials = runtime.totalTrials - 2;
            const accuracy = scoredTrials > 0 ? Math.round((runtime.correct / scoredTrials) * 100) : 0;
            finalizeTestSession({
                testKey: 'nback',
                testName: TEST_INFO.nback.type,
                statusText: '已完成测试',
                summary: '2-back 测试已完成。本次结果可以帮助观察工作记忆维持、更新以及位置匹配判断的稳定性。',
                metrics: [
                    { label: '正确率', value: `${accuracy}%` },
                    { label: '正确次数', value: `${runtime.correct}` },
                    { label: '错误次数', value: `${runtime.wrong}` },
                    { label: '有效轮次', value: `${scoredTrials}` }
                ],
                rawResult: {
                    total_trials: runtime.totalTrials,
                    scored_trials: scoredTrials,
                    correct: runtime.correct,
                    wrong: runtime.wrong,
                    accuracy
                }
            });
            return;
        }

        nextStep();
    });

    nextStep();
}

function startTest() {
    clearSessionTimers();
    setCanvasHandler(null);
    sessionState.running = true;
    sessionState.completed = false;
    sessionState.finalResult = null;
    sessionState.runtime = null;
    $('canvasPlaceholder').classList.add('hidden');
    $('startTestBtn').textContent = '重新开始测试';
    resetResultCard();

    switch (sessionState.testType) {
        case 'reaction':
            startReactionTest();
            break;
        case 'stroop':
            startStroopTest();
            break;
        case 'trail':
            startTrailTest();
            break;
        case 'flanker':
            startFlankerTest();
            break;
        case 'nback':
            startNBackTest();
            break;
        case 'digit':
            startDigitTest();
            break;
        default:
            drawPlaceholder();
    }
}

function stopTest() {
    if (!sessionState.running) {
        if (sessionState.finalResult) {
            $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        goBackToTests();
        return;
    }

    const partialResult = buildPartialResult();
    finalizeTestSession(partialResult);
}

function goBackToTests() {
    window.location.href = 'patient_test.html';
}

function goToReport() {
    window.location.href = 'patient_report.html';
}

window.startTest = startTest;
window.stopTest = stopTest;
window.goBackToTests = goBackToTests;
window.goToReport = goToReport;

document.addEventListener('DOMContentLoaded', () => {
    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if ($('userName') && storedUser?.full_name) {
        $('userName').textContent = storedUser.full_name;
    }

    canvas = $('testCanvas');
    ctx = canvas.getContext('2d');
    sessionState.testType = getTestType();

    updateTestInfo();
    resizeCanvas();
    drawPlaceholder();

    canvas.addEventListener('click', (event) => {
        if (typeof canvasClickHandler === 'function') {
            canvasClickHandler(event);
        }
    });

    window.addEventListener('resize', resizeCanvas);
});
