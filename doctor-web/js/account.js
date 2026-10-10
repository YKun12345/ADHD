(() => {
    const LOGIN_PAGE = '../patient-web/login.html';
    let loggingOut = false;

    function readUser() {
        try { return JSON.parse(localStorage.getItem('smartbrain_user') || 'null'); }
        catch (_) { return null; }
    }

    function profilePath(user) {
        return user?.role === 'patient'
            ? '../patient-web/patient_profile.html'
            : '../doctor-web/doctor_profile.html';
    }

    function goToLogin() { window.location.replace(LOGIN_PAGE); }

    async function logout() {
        if (loggingOut) return;
        loggingOut = true;
        const button = document.getElementById('accountLogout');
        if (button) { button.disabled = true; button.textContent = '正在退出…'; }
        try { await window.API?.Auth?.logout?.(); }
        catch (_) { console.warn('退出会话请求未完成，正在清理浏览器登录状态。'); }
        finally {
            ['smartbrain_token', 'smartbrain_user', 'smartbrain_selected_patient_id']
                .forEach(key => localStorage.removeItem(key));
            goToLogin();
        }
    }

    function setText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    async function loadProfile() {
        const profile = document.getElementById('accountProfile');
        if (!profile) return;
        if (!localStorage.getItem('smartbrain_token')) { goToLogin(); return; }
        const retry = document.getElementById('accountRetry');
        if (retry) { retry.hidden = true; retry.disabled = true; }
        setText('accountStatus', '正在读取账号信息…');
        try {
            const user = await window.API.Auth.getMe();
            if (!user?.id) throw new Error('账号信息读取失败，请重新登录。');
            if (profile.dataset.accountRole && user.role !== profile.dataset.accountRole) {
                window.location.replace(profilePath(user));
                return;
            }
            localStorage.setItem('smartbrain_user', JSON.stringify(user));
            const isPatient = user.role === 'patient';
            const isDac = user.subrole === 'dac';
            const role = isPatient ? '就诊者' : isDac ? 'DAC 审计员' : '医生 / 研究人员';
            setText('accountName', user.full_name);
            setText('accountUid', 'UID: ' + (isPatient ? 'PT-' : 'DR-') + user.id);
            setText('accountEmail', user.email);
            setText('accountRole', role);
            setText('accountStaffId', user.staff_id || '未设置');
            setText('accountConsent', user.consent_agreed ? '已确认' : '未确认');
            setText('accountScope', isPatient ? '查看自己的评估、追踪与报告。' : isDac
                ? '在 DAC 审计台管理安全配置与审计；患者业务访问仍受绑定检查约束。'
                : '查看与自己绑定的就诊者，完成综合分析、影像可视化和任务推送。');
            const audit = document.getElementById('accountAuditLink');
            if (audit) audit.hidden = !isDac;
            setText('accountStatus', '');
        } catch (error) {
            setText('accountStatus', error.message || '账号信息加载失败，请重试。');
            if (retry) retry.hidden = false;
        } finally {
            if (retry) retry.disabled = false;
        }
    }

    async function initialize() {
        document.querySelectorAll('.user-profile').forEach(trigger => {
            if (trigger.dataset.accountLinkBound) return;
            trigger.dataset.accountLinkBound = 'true';
            trigger.setAttribute('role', 'link');
            trigger.setAttribute('tabindex', '0');
            trigger.setAttribute('aria-label', '打开个人中心');
            const open = event => {
                event.preventDefault();
                const user = readUser();
                if (!user || !localStorage.getItem('smartbrain_token')) { goToLogin(); return; }
                window.location.href = profilePath(user);
            };
            const anchor = trigger.querySelector('a');
            if (anchor) anchor.href = profilePath(readUser());
            trigger.addEventListener('click', open);
            trigger.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') open(event);
            });
        });
        const logoutButton = document.getElementById('accountLogout');
        if (logoutButton && !logoutButton.dataset.accountBound) {
            logoutButton.dataset.accountBound = 'true';
            logoutButton.addEventListener('click', logout);
        }
        const retry = document.getElementById('accountRetry');
        if (retry && !retry.dataset.accountBound) {
            retry.dataset.accountBound = 'true';
            retry.addEventListener('click', loadProfile);
        }
        await loadProfile();
    }
    window.Account = { logout, refreshProfile: loadProfile };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
