/**
 * achievement.js - 游戏化成就系统
 * 管理患者认知测试的成就解锁、连续天数奖励和视觉正反馈弹层
 */
(function () {

    // ==============================
    // 成就定义表
    // ==============================
    const ACHIEVEMENTS = [
        {
            id: 'first_test',
            icon: '🧠',
            title: '初次启动',
            desc: '完成了你的第一次认知测试',
            condition: (stats) => stats.totalSessions >= 1,
            rarity: 'common'
        },
        {
            id: 'three_streak',
            icon: '🔥',
            title: '三连专注',
            desc: '连续3天完成认知测试',
            condition: (stats) => stats.streak >= 3,
            rarity: 'uncommon'
        },
        {
            id: 'seven_streak',
            icon: '⚡',
            title: '一周闯关',
            desc: '连续7天完成认知测试',
            condition: (stats) => stats.streak >= 7,
            rarity: 'rare'
        },
        {
            id: 'fourteen_streak',
            icon: '🏆',
            title: '14天传奇',
            desc: '连续14天完成认知测试，达成完整追踪',
            condition: (stats) => stats.streak >= 14,
            rarity: 'legendary'
        },
        {
            id: 'nback_master',
            icon: '🎯',
            title: 'N-back 专家',
            desc: 'N-back 正确率达到 80% 以上',
            condition: (stats) => stats.bestNbackAccuracy >= 0.8,
            rarity: 'rare'
        },
        {
            id: 'speed_demon',
            icon: '💨',
            title: '反应达人',
            desc: 'Go/No-Go 平均反应时低于 300ms',
            condition: (stats) => stats.bestGoNoGoRT > 0 && stats.bestGoNoGoRT < 300,
            rarity: 'uncommon'
        },
        {
            id: 'all_tests',
            icon: '🌟',
            title: '全能测试员',
            desc: '完成 N-back、Go/No-Go 和 Stroop 全部三项测试',
            condition: (stats) => stats.completedTypes && stats.completedTypes.size >= 3,
            rarity: 'rare'
        },
        {
            id: 'ten_sessions',
            icon: '💎',
            title: '十次突破',
            desc: '累计完成10次认知测试',
            condition: (stats) => stats.totalSessions >= 10,
            rarity: 'uncommon'
        }
    ];

    const RARITY_COLORS = {
        common: { bg: '#F1F5F9', border: '#CBD5E1', text: '#475569', badge: '#64748B' },
        uncommon: { bg: '#EFF6FF', border: '#93C5FD', text: '#1D4ED8', badge: '#2563EB' },
        rare: { bg: '#F5F3FF', border: '#C4B5FD', text: '#6D28D9', badge: '#7C3AED' },
        legendary: { bg: 'linear-gradient(135deg, #FEF3C7, #FEF9EE)', border: '#FCD34D', text: '#B45309', badge: '#F59E0B' }
    };

    const RARITY_LABELS = { common: '普通', uncommon: '稀有', rare: '史诗', legendary: '传说' };

    // ==============================
    // 持久化
    // ==============================
    function getStorageKey() {
        const user = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
        return user?.id ? `smartbrain_achievements_${user.id}` : 'smartbrain_achievements_guest';
    }

    function getStatsKey() {
        const user = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
        return user?.id ? `smartbrain_ach_stats_${user.id}` : 'smartbrain_ach_stats_guest';
    }

    function loadUnlocked() {
        try {
            return new Set(JSON.parse(localStorage.getItem(getStorageKey()) || '[]'));
        } catch { return new Set(); }
    }

    function saveUnlocked(set) {
        localStorage.setItem(getStorageKey(), JSON.stringify([...set]));
    }

    function loadStats() {
        try {
            const raw = JSON.parse(localStorage.getItem(getStatsKey()) || '{}');
            if (raw.completedTypes) raw.completedTypes = new Set(raw.completedTypes);
            return raw;
        } catch { return {}; }
    }

    function saveStats(stats) {
        const toSave = { ...stats };
        if (toSave.completedTypes instanceof Set) {
            toSave.completedTypes = [...toSave.completedTypes];
        }
        localStorage.setItem(getStatsKey(), JSON.stringify(toSave));
    }

    // ==============================
    // 更新统计 & 检查新成就
    // ==============================
    function updateStatsAfterTest(testResult) {
        const stats = loadStats();
        const today = new Date().toDateString();

        // 总次数
        stats.totalSessions = (stats.totalSessions || 0) + 1;

        // 连续天数
        if (stats.lastTestDate === today) {
            // 今天已记录，不增加streak
        } else if (stats.lastTestDate === new Date(Date.now() - 86400000).toDateString()) {
            stats.streak = (stats.streak || 0) + 1;
        } else {
            stats.streak = 1;
        }
        stats.lastTestDate = today;

        // 测试类型
        if (!stats.completedTypes) stats.completedTypes = new Set();
        if (testResult?.test_type) stats.completedTypes.add(testResult.test_type);

        // 最佳成绩
        if (testResult?.nback_accuracy !== undefined) {
            stats.bestNbackAccuracy = Math.max(stats.bestNbackAccuracy || 0, testResult.nback_accuracy);
        }
        if (testResult?.gonogo_rt !== undefined && testResult.gonogo_rt > 0) {
            stats.bestGoNoGoRT = stats.bestGoNoGoRT
                ? Math.min(stats.bestGoNoGoRT, testResult.gonogo_rt)
                : testResult.gonogo_rt;
        }

        saveStats(stats);
        return stats;
    }

    function checkNewAchievements(stats) {
        const unlocked = loadUnlocked();
        const newOnes = [];

        ACHIEVEMENTS.forEach(ach => {
            if (!unlocked.has(ach.id) && ach.condition(stats)) {
                unlocked.add(ach.id);
                newOnes.push(ach);
            }
        });

        if (newOnes.length > 0) saveUnlocked(unlocked);
        return newOnes;
    }

    // ==============================
    // 测试完成正反馈弹层
    // ==============================
    function showCompletionModal(testResult, newAchievements) {
        // 移除旧弹层
        document.getElementById('achCompletionModal')?.remove();

        const stats = loadStats();
        const streak = stats.streak || 1;
        const streakMsg = streak >= 14 ? '🏆 连续14天！传奇成就！'
            : streak >= 7 ? '⚡ 连续7天！你在创造纪录！'
            : streak >= 3 ? '🔥 连续3天！保持住！'
            : streak > 1 ? `🔥 连续${streak}天打卡！`
            : '🧠 很棒！今日任务完成！';

        const achHtml = newAchievements.length > 0 ? `
            <div style="margin-top:1.2rem; border-top: 1px solid rgba(255,255,255,0.2); padding-top:1rem;">
                <p style="font-size:0.84rem; opacity:0.85; margin-bottom:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;">🎖 新成就解锁</p>
                <div style="display:flex; flex-wrap:wrap; gap:0.6rem; justify-content:center;">
                    ${newAchievements.map(a => {
                        const c = RARITY_COLORS[a.rarity];
                        return `<div style="
                            background:${typeof c.bg === 'string' ? c.bg : '#fff'};
                            border:2px solid ${c.border};
                            border-radius:14px; padding:0.55rem 0.9rem;
                            display:flex; align-items:center; gap:0.5rem;">
                            <span style="font-size:1.3rem;">${a.icon}</span>
                            <div style="text-align:left;">
                                <strong style="display:block; font-size:0.82rem; color:${c.text};">${a.title}</strong>
                                <span style="font-size:0.74rem; color:${c.text}; opacity:0.8;">${RARITY_LABELS[a.rarity]}</span>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>` : '';

        const scoreDisplay = testResult?.accuracy !== undefined
            ? `<div style="font-size:3rem; font-weight:800; color:white; line-height:1; margin: 0.5rem 0;">${Math.round(testResult.accuracy * 100)}<span style="font-size:1.2rem;">%</span></div><p style="opacity:0.85; font-size:0.88rem; margin:0 0 0.3rem;">本次正确率</p>`
            : '';

        const modal = document.createElement('div');
        modal.id = 'achCompletionModal';
        modal.style.cssText = `
            position:fixed; inset:0; z-index:9999;
            display:flex; align-items:center; justify-content:center;
            background:rgba(15,23,42,0.55); backdrop-filter:blur(6px);
            animation: fadeIn 0.3s ease;
        `;
        modal.innerHTML = `
            <div style="
                background: linear-gradient(135deg, #1E3A8A 0%, #4F46E5 50%, #7C3AED 100%);
                border-radius: 28px;
                padding: 2.2rem 2rem;
                max-width: 420px;
                width: calc(100% - 2rem);
                text-align: center;
                color: white;
                box-shadow: 0 32px 80px rgba(79, 70, 229, 0.5);
                animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
                position: relative;
            ">
                <button id="achModalClose" style="
                    position:absolute; top:1rem; right:1rem;
                    background:rgba(255,255,255,0.15); border:none;
                    width:32px; height:32px; border-radius:50%;
                    color:white; cursor:pointer; font-size:1.1rem;
                    display:flex; align-items:center; justify-content:center;
                ">✕</button>

                <div style="font-size:3.5rem; margin-bottom:0.5rem;">🎉</div>
                <h2 style="color:white; font-size:1.4rem; margin:0 0 0.3rem;">${streakMsg}</h2>
                ${scoreDisplay}
                <p style="opacity:0.8; font-size:0.88rem; line-height:1.6; margin:0.5rem 0 0;">
                    ${testResult?.summary || '你的认知数据已记录，继续坚持！'}
                </p>
                ${achHtml}
                <div style="display:flex; gap:0.8rem; justify-content:center; margin-top:1.4rem; flex-wrap:wrap;">
                    <a href="patient_tracking.html" style="
                        background:white; color:#4F46E5; border-radius:12px;
                        padding:0.72rem 1.2rem; font-weight:800; font-size:0.9rem;
                        text-decoration:none; display:inline-flex; align-items:center; gap:0.4rem;
                        transition: transform 0.2s ease;
                    " onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
                        记录今日日志
                    </a>
                    <button id="achModalContinue" style="
                        background:rgba(255,255,255,0.18); border:1.5px solid rgba(255,255,255,0.4);
                        color:white; border-radius:12px; padding:0.72rem 1.2rem;
                        font-weight:700; font-size:0.9rem; cursor:pointer;
                        transition: background 0.2s ease;
                    " onmouseover="this.style.background='rgba(255,255,255,0.25)'" onmouseout="this.style.background='rgba(255,255,255,0.18)'">
                        继续探索
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Auto-close after 8s or on button click
        const close = () => { modal.style.animation = 'fadeOut 0.3s ease forwards'; setTimeout(() => modal.remove(), 300); };
        document.getElementById('achModalClose')?.addEventListener('click', close);
        document.getElementById('achModalContinue')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        setTimeout(close, 8000);
    }

    // ==============================
    // 成就面板 (内嵌到页面中)
    // ==============================
    function renderAchievementPanel(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const unlocked = loadUnlocked();
        const stats = loadStats();

        const unlockedAchs = ACHIEVEMENTS.filter(a => unlocked.has(a.id));
        const lockedAchs = ACHIEVEMENTS.filter(a => !unlocked.has(a.id));

        container.innerHTML = `
            <div style="display:grid; gap:0.8rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.3rem;">
                    <strong style="color:#0F172A; font-size:1rem;">✨ 我的成就</strong>
                    <span style="font-size:0.82rem; color:#64748B; font-weight:700;">${unlockedAchs.length}/${ACHIEVEMENTS.length} 已解锁</span>
                </div>
                <div style="height:6px; background:#E2E8F0; border-radius:999px; overflow:hidden; margin-bottom:0.5rem;">
                    <div style="height:100%; width:${Math.round(unlockedAchs.length/ACHIEVEMENTS.length*100)}%; background:linear-gradient(90deg,#4F46E5,#7C3AED); border-radius:999px; transition:width 1s ease;"></div>
                </div>
                ${[...unlockedAchs, ...lockedAchs].map(a => {
                    const isUnlocked = unlocked.has(a.id);
                    const c = RARITY_COLORS[a.rarity];
                    return `
                    <div style="
                        display:flex; align-items:center; gap:0.75rem;
                        padding:0.85rem; border-radius:16px;
                        background:${isUnlocked ? (typeof c.bg === 'string' && c.bg.startsWith('linear') ? c.bg : c.bg) : '#F8FAFC'};
                        border:1.5px solid ${isUnlocked ? c.border : '#E2E8F0'};
                        opacity:${isUnlocked ? '1' : '0.55'};
                        transition: all 0.2s ease;
                    ">
                        <span style="font-size:1.8rem; ${isUnlocked ? '' : 'filter:grayscale(1);'}">${a.icon}</span>
                        <div style="flex:1; min-width:0;">
                            <strong style="display:block; font-size:0.88rem; color:${isUnlocked ? c.text : '#94A3B8'};">${a.title}</strong>
                            <span style="font-size:0.78rem; color:${isUnlocked ? c.text : '#94A3B8'}; opacity:0.8; line-height:1.5;">${a.desc}</span>
                        </div>
                        <span style="
                            padding:0.22rem 0.6rem; border-radius:999px;
                            background:${isUnlocked ? c.badge : '#CBD5E1'};
                            color:white; font-size:0.7rem; font-weight:700; white-space:nowrap;
                        ">${RARITY_LABELS[a.rarity]}</span>
                    </div>`;
                }).join('')}
            </div>
        `;
    }

    // ==============================
    // 连续天数 Mini Widget
    // ==============================
    function renderStreakWidget(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const stats = loadStats();
        const streak = stats.streak || 0;

        const flames = Math.min(streak, 7);
        const flameHtml = Array.from({length: 7}, (_, i) =>
            `<span style="font-size:1.4rem; opacity:${i < flames ? '1' : '0.2'}; transition: opacity 0.3s ease ${i*0.05}s;">🔥</span>`
        ).join('');

        container.innerHTML = `
            <div style="display:flex; align-items:center; gap:1rem; padding:0.95rem 1.1rem;
                background:linear-gradient(135deg, #FFF7ED, #FEF9EE);
                border:1.5px solid #FDE68A; border-radius:18px;">
                <div style="text-align:center;">
                    <span style="font-size:2.2rem; font-weight:800; color:#B45309; line-height:1;">${streak}</span>
                    <span style="display:block; font-size:0.75rem; color:#D97706; font-weight:700;">连续天</span>
                </div>
                <div>
                    <div style="display:flex; gap:0.15rem; margin-bottom:0.3rem;">${flameHtml}</div>
                    <p style="font-size:0.82rem; color:#92400E; margin:0; line-height:1.5;">
                        ${streak >= 14 ? '🏆 传说！保持这个节奏！' :
                          streak >= 7 ? '⚡ 完美！离14天还差一步！' :
                          streak >= 3 ? '🔥 热身中！继续坚持！' :
                          streak > 0 ? '刚开始！坚持就是胜利！' : '今天开始你的第一次测试！'}
                    </p>
                </div>
            </div>
        `;
    }

    // ==============================
    // 公共 API
    // ==============================
    window.Achievement = {
        /**
         * 测试完成后调用，传入 testResult 对象
         * testResult: { test_type, accuracy, gonogo_rt, nback_accuracy, summary }
         */
        onTestComplete(testResult) {
            const stats = updateStatsAfterTest(testResult);
            const newAchs = checkNewAchievements(stats);
            showCompletionModal(testResult, newAchs);
            return { stats, newAchievements: newAchs };
        },

        /** 在指定容器渲染成就面板 */
        renderPanel(containerId) {
            renderAchievementPanel(containerId);
        },

        /** 在指定容器渲染连续天数 widget */
        renderStreak(containerId) {
            renderStreakWidget(containerId);
        },

        /** 获取当前解锁成就列表 */
        getUnlocked() {
            const unlocked = loadUnlocked();
            return ACHIEVEMENTS.filter(a => unlocked.has(a.id));
        },

        /** 获取当前统计 */
        getStats() {
            return loadStats();
        },

        /** 手动触发正反馈（用于调试或演示） */
        demo() {
            showCompletionModal(
                { test_type: 'nback', accuracy: 0.87, summary: '工作记忆表现优秀，反应时稳定。' },
                [ACHIEVEMENTS[0], ACHIEVEMENTS[2]]
            );
        },

        syncWithBackend(reportData) {
            if (!reportData) return;
            const stats = loadStats();
            let updated = false;

            if (reportData.tracking_summary) {
                const completed = reportData.tracking_summary.completed_count || 0;
                if (!stats.totalSessions || stats.totalSessions < completed) {
                    stats.totalSessions = completed;
                    updated = true;
                }
                const missed = reportData.tracking_summary.consecutive_missed_days || 0;
                if (missed === 0 && completed > 0) {
                    const trackingStreak = reportData.tracking_summary.current_day - 1;
                    if (!stats.streak || stats.streak < trackingStreak) {
                        stats.streak = trackingStreak;
                        updated = true;
                    }
                }
            }

            if (reportData.cognitive_profile && reportData.cognitive_profile.latest_tests) {
                if (!stats.completedTypes) stats.completedTypes = new Set();
                reportData.cognitive_profile.latest_tests.forEach(test => {
                    stats.completedTypes.add(test.test_type);
                    if (!stats.totalSessions || stats.totalSessions === 0) stats.totalSessions = 1;
                });
                updated = true;
            }

            if (updated) {
                saveStats(stats);
                checkNewAchievements(stats);
            }
        }
    };

    // ==============================
    // CSS 注入
    // ==============================
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
    `;
    document.head.appendChild(style);

})();
