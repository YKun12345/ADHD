document.addEventListener('DOMContentLoaded', () => {
    const COMMON_WEAK_PASSWORDS = new Set([
        '12345678',
        '123456789',
        '1234567890',
        '00000000',
        '11111111',
        '123123123',
        '87654321',
        'password',
        'password123',
        'admin123',
        'qwerty123',
        'qwertyuiop',
        'asdfghjk',
        'abcd1234',
        'welcome123',
        'iloveyou',
        '1q2w3e4r',
        'aa123456',
    ]);

    const rolePills = document.querySelectorAll('.segment-pill');
    const submitBtn = document.getElementById('submitBtn');
    const mainForm = document.getElementById('mainForm');
    const formFeedback = document.getElementById('formFeedback');
    const patientConsentCheckbox = document.getElementById('patientConsentCheckbox');
    const researcherConsentCheckbox = document.getElementById('researcherConsentCheckbox');
    const emailInput = document.getElementById('emailInput');
    const fullNameInput = document.getElementById('fullNameInput');
    const staffIdInput = document.getElementById('staffIdInput');
    const passwordInput = document.getElementById('passwordInput');
    const confirmPasswordInput = document.getElementById('confirmPasswordInput');
    const patientTypeInput = document.getElementById('patientTypeInput');
    const patientTypeSection = document.getElementById('patientTypeSection');
    const passwordRules = document.getElementById('passwordRules');
    const togglePasswordBtn = document.getElementById('togglePasswordBtn');
    const toRegisterBtn = document.getElementById('toRegisterBtn');
    const toLoginBtn = document.getElementById('toLoginBtn');
    const synapseFlash = document.getElementById('synapseFlash');
    const splitLeft = document.querySelector('.split-left');
    const neuronBg = document.querySelector('.neuron-bg');

    let currentRole = 'patient';
    let isSubmitting = false;

    const isRegisterMode = () => document.body.classList.contains('mode-register');
    const getConsentChecked = () =>
        currentRole === 'patient' ? patientConsentCheckbox.checked : researcherConsentCheckbox.checked;

    function evaluatePasswordRules(password) {
        return {
            length: password.length >= 8,
            numeric: password.length > 0 && !/^\d+$/.test(password),
            common: password.length > 0 && !COMMON_WEAK_PASSWORDS.has(password.toLowerCase()),
        };
    }

    function isPasswordStrongEnough(password) {
        const result = evaluatePasswordRules(password);
        return result.length && result.numeric && result.common;
    }

    function updatePasswordRules() {
        if (!passwordRules) return;
        const password = passwordInput.value.trim();
        const results = evaluatePasswordRules(password);

        passwordRules.querySelectorAll('.password-rule').forEach((rule) => {
            const ruleKey = rule.dataset.rule;
            const icon = rule.querySelector('ion-icon');
            const passed = results[ruleKey];

            rule.classList.remove('is-pass', 'is-fail');
            if (!password) {
                icon.setAttribute('name', 'remove-circle-outline');
                return;
            }

            if (passed) {
                rule.classList.add('is-pass');
                icon.setAttribute('name', 'checkmark-circle-outline');
            } else {
                rule.classList.add('is-fail');
                icon.setAttribute('name', 'close-circle-outline');
            }
        });
    }

    function getRedirectPath(role, user = null) {
        if (role === 'patient') return 'patient_home.html';
        if (user?.subrole === 'dac') return 'dac_dashboard.html';
        return 'doctor_analysis.html';
    }

    function setFeedback(message, type = 'error') {
        formFeedback.innerHTML = `<ion-icon name="${type === 'success' ? 'checkmark-circle-outline' : 'alert-circle-outline'}"></ion-icon> ${message}`;
        formFeedback.className = `form-feedback ${type === 'success' ? 'feedback-success' : 'feedback-error'}`;
    }

    function clearFeedback() {
        formFeedback.className = 'form-feedback hidden';
        formFeedback.innerHTML = '';
    }

    function getDefaultFullName() {
        const emailPrefix = emailInput.value.trim().split('@')[0];
        return staffIdInput.value.trim() || emailPrefix || '未命名用户';
    }

    function syncRoleUI() {
        document.body.classList.toggle('theme-researcher', currentRole === 'researcher');

        emailInput.required = isRegisterMode() || currentRole === 'patient';
        patientTypeSection.style.display =
            isRegisterMode() && currentRole === 'patient' ? 'block' : 'none';

        validateForm();
    }

    function setRegisterMode(enabled) {
        document.body.classList.toggle('mode-register', enabled);
        fullNameInput.required = enabled;
        confirmPasswordInput.required = enabled;
        patientTypeInput.required = enabled && currentRole === 'patient';
        syncRoleUI();
        updatePasswordRules();
        clearFeedback();
    }

    function validateForm() {
        const email = emailInput.value.trim();
        const staffId = staffIdInput.value.trim();
        const password = passwordInput.value.trim();
        const fullName = fullNameInput.value.trim();
        const confirmPassword = confirmPasswordInput.value.trim();
        const consentChecked = getConsentChecked();
        const registerMode = isRegisterMode();

        const hasIdentifier = currentRole === 'patient'
            ? email.length > 0
            : email.length > 0 || staffId.length > 0;

        let valid = hasIdentifier && password.length > 0 && consentChecked && !isSubmitting;

        if (registerMode) {
            const hasFullName = fullName.length > 0;
            const hasMatchedPassword = confirmPassword.length > 0 && password === confirmPassword;
            const hasPatientType = currentRole !== 'patient' || patientTypeInput.value.trim().length > 0;
            const passwordPassedRules = isPasswordStrongEnough(password);
            valid = valid && email.length > 0 && hasFullName && hasMatchedPassword && hasPatientType && passwordPassedRules;
        }

        submitBtn.classList.toggle('disabled', !valid);
        submitBtn.disabled = !valid;
    }

    function saveSession(result) {
        localStorage.setItem('smartbrain_token', result.access_token);
        localStorage.setItem('smartbrain_user', JSON.stringify(result.user));
    }

    function clearSession() {
        localStorage.removeItem('smartbrain_token');
        localStorage.removeItem('smartbrain_user');
    }

    async function redirectAfterAuth(role, user) {
        if (synapseFlash) {
            synapseFlash.classList.add('flash-trigger');
            setTimeout(() => synapseFlash.classList.remove('flash-trigger'), 800);
        }
        setFeedback('验证成功，正在进入系统...', 'success');
        submitBtn.textContent = '跳转中...';
        setTimeout(() => {
            window.location.href = getRedirectPath(role, user);
        }, 500);
    }

    function handleRegisterSuccess() {
        clearSession();
        if (synapseFlash) {
            synapseFlash.classList.add('flash-trigger');
            setTimeout(() => synapseFlash.classList.remove('flash-trigger'), 800);
        }
        passwordInput.value = '';
        confirmPasswordInput.value = '';
        setRegisterMode(false);
        setFeedback('注册成功，请使用刚刚创建的账号登录。', 'success');
        submitBtn.innerHTML =
            '<span class="login-only">Login / 登录</span><span class="register-only">Register / 注册</span>';
        validateForm();
    }

    rolePills.forEach((pill) => {
        pill.addEventListener('click', () => {
            rolePills.forEach((item) => item.classList.remove('active'));
            pill.classList.add('active');
            currentRole = pill.dataset.role;
            patientTypeInput.required = isRegisterMode() && currentRole === 'patient';
            clearFeedback();
            syncRoleUI();
        });

        pill.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                pill.click();
            }
        });
    });

    togglePasswordBtn.addEventListener('click', () => {
        const type = passwordInput.type === 'password' ? 'text' : 'password';
        passwordInput.type = type;
        const icon = togglePasswordBtn.querySelector('ion-icon');
        icon.setAttribute('name', type === 'text' ? 'eye-off-outline' : 'eye-outline');
    });

    toRegisterBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        setRegisterMode(true);
    });

    toLoginBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        setRegisterMode(false);
    });

    mainForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitBtn.classList.contains('disabled') || isSubmitting) {
            return;
        }
        if (!window.API?.Auth) {
            setFeedback('前端 API 配置未加载，请检查 js/api.js 是否已正确引入。');
            return;
        }

        clearFeedback();

        if ((isRegisterMode() || currentRole === 'patient') && !emailInput.value.includes('@')) {
            setFeedback('邮箱格式似乎有些问题，请再核对一下。');
            return;
        }

        if (!isRegisterMode() && currentRole !== 'patient' && !staffIdInput.value.trim() && !emailInput.value.trim()) {
            setFeedback('请输入邮箱或工号进行登录。');
            return;
        }

        if (!getConsentChecked()) {
            setFeedback(
                currentRole === 'patient'
                    ? '请先勾选隐私政策和用户协议后再继续。'
                    : '请先勾选科研协议与系统使用规范后再继续。'
            );
            return;
        }

        if (isRegisterMode() && passwordInput.value !== confirmPasswordInput.value) {
            setFeedback('两次输入的密码不一致，请重试。');
            return;
        }

        isSubmitting = true;
        validateForm();
        submitBtn.textContent = isRegisterMode() ? '注册中...' : '登录中...';

        try {
            if (isRegisterMode()) {
                const payload = {
                    email: emailInput.value.trim(),
                    password: passwordInput.value,
                    full_name: fullNameInput.value.trim() || getDefaultFullName(),
                    role: currentRole,
                    subrole: currentRole === 'researcher' ? 'normal' : null,
                    staff_id: staffIdInput.value.trim() || null,
                    consent_agreed: getConsentChecked(),
                    patient_profile:
                        currentRole === 'patient'
                            ? { patient_type: patientTypeInput.value || 'adult' }
                            : null,
                };
                await window.API.Auth.register(payload);
                handleRegisterSuccess();
            } else {
                const payload = {
                    identifier:
                        currentRole === 'patient'
                            ? emailInput.value.trim()
                            : (emailInput.value.trim() || staffIdInput.value.trim()),
                    password: passwordInput.value,
                    role: currentRole,
                };
                const result = await window.API.Auth.login(payload);
                saveSession(result);
                await redirectAfterAuth(result.user.role, result.user);
            }
        } catch (error) {
            setFeedback(error.message || '请求失败，请检查后端是否已启动。');
            submitBtn.innerHTML =
                '<span class="login-only">Login / 登录</span><span class="register-only">Register / 注册</span>';
        } finally {
            isSubmitting = false;
            validateForm();
        }
    });

    [emailInput, fullNameInput, staffIdInput, passwordInput, confirmPasswordInput, patientTypeInput].forEach((input) => {
        input?.addEventListener('input', () => {
            clearFeedback();
            updatePasswordRules();
            validateForm();
        });
        input?.addEventListener('change', () => {
            clearFeedback();
            updatePasswordRules();
            validateForm();
        });
    });

    patientConsentCheckbox.addEventListener('change', () => {
        clearFeedback();
        validateForm();
    });
    researcherConsentCheckbox.addEventListener('change', () => {
        clearFeedback();
        validateForm();
    });

    if (splitLeft && neuronBg) {
        splitLeft.addEventListener('mousemove', (event) => {
            const rect = splitLeft.getBoundingClientRect();
            const x = (event.clientX - rect.left - rect.width / 2) / 25;
            const y = (event.clientY - rect.top - rect.height / 2) / 25;
            neuronBg.style.transform = `translate(${x}px, ${y}px) scale(1.05)`;
        });

        splitLeft.addEventListener('mouseleave', () => {
            neuronBg.style.transform = 'translate(0, 0) scale(1)';
        });
    }

    validateForm();
    updatePasswordRules();
    syncRoleUI();
});
