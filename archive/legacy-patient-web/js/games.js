document.addEventListener('DOMContentLoaded', () => {
    const storedUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    const userName = document.getElementById('userName');
    if (userName && storedUser?.full_name) {
        userName.textContent = storedUser.full_name;
    }
});

const reactionState = {
    active: false,
    clickable: false,
    startTime: 0,
    timeoutId: null
};

const stroopPalette = [
    { word: 'RED', color: 'red', css: '#EF4444' },
    { word: 'GREEN', color: 'green', css: '#10B981' },
    { word: 'BLUE', color: 'blue', css: '#3B82F6' },
    { word: 'YELLOW', color: 'yellow', css: '#F59E0B' }
];

const stroopState = {
    active: false,
    currentColor: 'yellow',
    correct: 0,
    wrong: 0,
    trials: 0,
    timings: [],
    startTime: 0
};

const trailState = {
    active: false,
    next: 1,
    errors: 0,
    startTime: 0
};

const flankerState = {
    active: false,
    target: '>',
    correct: 0,
    wrong: 0,
    trials: 0,
    timings: [],
    startTime: 0
};

const nbackState = {
    active: false,
    currentIndex: 0,
    sequence: [],
    correct: 0,
    wrong: 0
};

const digitState = {
    active: false,
    target: '',
    input: '',
    correct: 0,
    length: 5
};

function average(list) {
    if (!list.length) return 0;
    return Math.round(list.reduce((sum, value) => sum + value, 0) / list.length);
}

function randomInt(max) {
    return Math.floor(Math.random() * max);
}

window.startReactionTest = function startReactionTest() {
    const circle = document.getElementById('reactionCircle');
    const time = document.getElementById('reactionTime');
    if (!circle || !time) return;

    clearTimeout(reactionState.timeoutId);
    reactionState.active = true;
    reactionState.clickable = false;
    circle.style.background = '#F59E0B';
    circle.innerHTML = '<span style="font-size: 1.25rem; color: white;">等待变绿</span>';
    time.textContent = '准备中...';

    reactionState.timeoutId = setTimeout(() => {
        reactionState.clickable = true;
        reactionState.startTime = performance.now();
        circle.style.background = '#10B981';
        circle.innerHTML = '<span style="font-size: 1.4rem; color: white;">立即点击</span>';
    }, 1200 + randomInt(1800));
};

document.addEventListener('click', (event) => {
    const circle = document.getElementById('reactionCircle');
    const time = document.getElementById('reactionTime');
    if (!circle || !time || event.target.closest('#reactionCircle') === null) {
        return;
    }

    if (!reactionState.active) return;

    if (!reactionState.clickable) {
        clearTimeout(reactionState.timeoutId);
        reactionState.active = false;
        circle.style.background = '#EF4444';
        circle.innerHTML = '<span style="font-size: 1.1rem; color: white;">太快了</span>';
        time.textContent = '请重新开始';
        return;
    }

    const reactionTime = Math.round(performance.now() - reactionState.startTime);
    reactionState.active = false;
    reactionState.clickable = false;
    circle.style.background = '#3B82F6';
    circle.innerHTML = '<span style="font-size: 1.1rem; color: white;">完成</span>';
    time.textContent = `${reactionTime} ms`;
});

function updateStroopPrompt() {
    const wordEl = document.getElementById('stroopWord');
    if (!wordEl) return;
    const word = stroopPalette[randomInt(stroopPalette.length)];
    const color = stroopPalette[randomInt(stroopPalette.length)];
    wordEl.textContent = word.word;
    wordEl.style.color = color.css;
    stroopState.currentColor = color.color;
    stroopState.startTime = performance.now();
}

window.startStroopTest = function startStroopTest() {
    stroopState.active = true;
    stroopState.correct = 0;
    stroopState.wrong = 0;
    stroopState.trials = 0;
    stroopState.timings = [];
    document.getElementById('stroopCorrect').textContent = '0';
    document.getElementById('stroopWrong').textContent = '0';
    document.getElementById('stroopAvgTime').textContent = '0';
    updateStroopPrompt();
};

window.handleStroopAnswer = function handleStroopAnswer(answer) {
    if (!stroopState.active) return;
    const elapsed = Math.round(performance.now() - stroopState.startTime);
    stroopState.trials += 1;
    stroopState.timings.push(elapsed);

    if (answer === stroopState.currentColor) {
        stroopState.correct += 1;
    } else {
        stroopState.wrong += 1;
    }

    document.getElementById('stroopCorrect').textContent = String(stroopState.correct);
    document.getElementById('stroopWrong').textContent = String(stroopState.wrong);
    document.getElementById('stroopAvgTime').textContent = String(average(stroopState.timings));

    if (stroopState.trials >= 8) {
        stroopState.active = false;
        return;
    }

    updateStroopPrompt();
};

window.startTrailTest = function startTrailTest() {
    trailState.active = true;
    trailState.next = 1;
    trailState.errors = 0;
    trailState.startTime = performance.now();
    document.getElementById('trailProgress').textContent = '0';
    document.getElementById('trailErrors').textContent = '0';
    document.getElementById('trailTime').textContent = '0';

    document.querySelectorAll('.trail-number').forEach((item) => {
        item.classList.remove('is-hit', 'is-error');
    });
};

window.handleTrailNumberClick = function handleTrailNumberClick(element, value) {
    if (!trailState.active) return;

    if (value === trailState.next) {
        element.classList.remove('is-error');
        element.classList.add('is-hit');
        trailState.next += 1;
        document.getElementById('trailProgress').textContent = String(trailState.next - 1);
        document.getElementById('trailTime').textContent = String(Math.round(performance.now() - trailState.startTime));

        if (trailState.next > 8) {
            trailState.active = false;
        }
    } else {
        trailState.errors += 1;
        element.classList.add('is-error');
        document.getElementById('trailErrors').textContent = String(trailState.errors);
    }
};

function updateFlankerPrompt() {
    const congruent = Math.random() > 0.4;
    const target = Math.random() > 0.5 ? '>' : '<';
    const flank = congruent ? target : target === '>' ? '<' : '>';

    document.getElementById('flankerArrow1').textContent = flank;
    document.getElementById('flankerArrow2').textContent = flank;
    document.getElementById('flankerTarget').textContent = target;
    document.getElementById('flankerArrow4').textContent = flank;
    document.getElementById('flankerArrow5').textContent = flank;
    document.getElementById('flankerModeLabel').textContent = congruent ? 'Congruent' : 'Incongruent';

    flankerState.target = target;
    flankerState.startTime = performance.now();
}

window.startFlankerTest = function startFlankerTest() {
    flankerState.active = true;
    flankerState.correct = 0;
    flankerState.wrong = 0;
    flankerState.trials = 0;
    flankerState.timings = [];
    document.getElementById('flankerCorrect').textContent = '0';
    document.getElementById('flankerWrong').textContent = '0';
    document.getElementById('flankerAvgTime').textContent = '0';
    updateFlankerPrompt();
};

window.handleFlankerAnswer = function handleFlankerAnswer(answer) {
    if (!flankerState.active) return;
    const elapsed = Math.round(performance.now() - flankerState.startTime);
    flankerState.trials += 1;
    flankerState.timings.push(elapsed);

    if (answer === flankerState.target) {
        flankerState.correct += 1;
    } else {
        flankerState.wrong += 1;
    }

    document.getElementById('flankerCorrect').textContent = String(flankerState.correct);
    document.getElementById('flankerWrong').textContent = String(flankerState.wrong);
    document.getElementById('flankerAvgTime').textContent = String(average(flankerState.timings));

    if (flankerState.trials >= 10) {
        flankerState.active = false;
        return;
    }

    updateFlankerPrompt();
};

function updateNBackGrid(position) {
    for (let i = 0; i < 9; i += 1) {
        document.getElementById(`nbackCell${i}`).classList.toggle('active', i === position);
    }
}

window.startNBackTest = function startNBackTest() {
    nbackState.active = true;
    nbackState.currentIndex = 0;
    nbackState.correct = 0;
    nbackState.wrong = 0;
    nbackState.sequence = Array.from({ length: 20 }, () => randomInt(9));
    updateNBackGrid(nbackState.sequence[0]);
    document.getElementById('nbackCorrect').textContent = '0';
    document.getElementById('nbackWrong').textContent = '0';
    document.getElementById('nbackProgress').textContent = '1';
};

window.handleNBackAnswer = function handleNBackAnswer(match) {
    if (!nbackState.active) return;

    const current = nbackState.sequence[nbackState.currentIndex];
    const target = nbackState.currentIndex >= 2 ? nbackState.sequence[nbackState.currentIndex - 2] : null;
    const actualMatch = target !== null && current === target;

    if (match === actualMatch) {
        nbackState.correct += 1;
    } else {
        nbackState.wrong += 1;
    }

    nbackState.currentIndex += 1;
    document.getElementById('nbackCorrect').textContent = String(nbackState.correct);
    document.getElementById('nbackWrong').textContent = String(nbackState.wrong);
    document.getElementById('nbackProgress').textContent = String(Math.min(nbackState.currentIndex + 1, 20));

    if (nbackState.currentIndex >= nbackState.sequence.length) {
        nbackState.active = false;
        return;
    }

    updateNBackGrid(nbackState.sequence[nbackState.currentIndex]);
};

function renderDigitPrompt(sequence) {
    const prompt = document.getElementById('digitSpanPrompt');
    prompt.innerHTML = sequence
        .split('')
        .map((digit) => `<div class="digit-box">${digit}</div>`)
        .join('');
}

window.startDigitSpanTest = function startDigitSpanTest() {
    digitState.active = true;
    digitState.input = '';
    digitState.target = Array.from({ length: digitState.length }, () => String(1 + randomInt(9))).join('');
    renderDigitPrompt(digitState.target);
    document.getElementById('digitInput').textContent = '-';
    document.getElementById('digitLength').textContent = String(digitState.length);
};

window.handleDigitInput = function handleDigitInput(digit) {
    if (!digitState.active) return;

    digitState.input += digit;
    document.getElementById('digitInput').textContent = digitState.input;

    if (digitState.input.length >= digitState.target.length) {
        if (digitState.input === digitState.target) {
            digitState.correct += 1;
            digitState.length += 1;
        } else if (digitState.length > 3) {
            digitState.length -= 1;
        }

        document.getElementById('digitCorrect').textContent = String(digitState.correct);
        digitState.active = false;
    }
};
