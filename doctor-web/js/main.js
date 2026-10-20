document.addEventListener('DOMContentLoaded', async () => {
    const SELECTED_PATIENT_STORAGE_KEY = 'smartbrain_selected_patient_id';
    const queryPatientId = new URLSearchParams(window.location.search).get('patient_id');

    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('timeseriesFileInput');
    const fileStatusBadge = document.getElementById('fileStatusBadge');
    const connectivityStatusBadge = document.getElementById('connectivityStatusBadge');
    const predictionStatusBadge = document.getElementById('predictionStatusBadge');
    const brainGraph = document.getElementById('brainGraph');
    const graphText = brainGraph?.querySelector('.placeholder-text');
    const riskCircle = document.getElementById('riskCircle');
    const riskText = document.getElementById('riskText');
    const predictionLabelText = document.getElementById('predictionLabelText');
    const adhdProbabilityBar = document.getElementById('adhdProbabilityBar');
    const controlProbabilityBar = document.getElementById('controlProbabilityBar');
    const predictionSummary = document.getElementById('predictionSummary');
    const predictionMeta = document.getElementById('predictionMeta');
    const generateBtn = document.getElementById('generateReportBtn');
    const nodeAttention = document.getElementById('nodeAttention');
    const edgeConnectivity = document.getElementById('edgeConnectivity');
    const patientHint = document.getElementById('timeseriesPatientHint');
    const patientMeta = document.getElementById('timeseriesPatientMeta');
    const userProfileName = document.getElementById('researcherName') || document.querySelector('.user-profile span');
    const backToWorkspaceLink = document.getElementById('backToPatientReportImagingLink');
    const openPatientReportLink = document.getElementById('openPatientReportImagingLink');
    const childNavImaging = document.getElementById('childNavImaging');
    const childNavVisualization = document.getElementById('childNavVisualization');
    const admissionStatus = document.getElementById('modelAdmissionStatus');

    let boundPatients = [];
    let currentSelectedPatient = null;
    let selectedFile = null;
    let running = false;
    let admission = null, active = true, epoch = 0;
    const fixedIdentity = ['smartbrain_user', 'smartbrain_token'].map(key => localStorage.getItem(key));
    const session = window.SessionGuard?.captureSession();
    const usable = () => active && fixedIdentity.every((value, index) => value === localStorage.getItem(['smartbrain_user', 'smartbrain_token'][index]))
        && (!session || window.SessionGuard.isCurrentSession(session));
    const current = operation => usable() && operation === epoch;
    const allowed = () => admission?.inference_mode === 'mock' ||
        (['admitted', 'legacy_accepted'].includes(admission?.status) && admission?.real_inference_allowed === true);
    function updateControls() {
        if (generateBtn) {
            generateBtn.disabled = !usable() || running || !currentSelectedPatient || !allowed();
            generateBtn.textContent = running ? '处理中...' : admission?.inference_mode === 'mock' ? '开始演示分析'
                : allowed() ? '开始分类推理' : admission ? '模型待准入，暂不能分析' : '模型状态待核对';
        }
    }
    function renderAdmission() {
        if (admissionStatus) admissionStatus.textContent = admission?.inference_mode === 'mock'
            ? '当前为演示模式，结果由合成规则生成，只供界面演示，不用于临床判断。'
            : typeof admission?.message === 'string' ? admission.message : '模型状态暂不可核对，不能开始新分析。';
        updateControls();
    }

    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if (userProfileName && currentUser?.full_name) {
        userProfileName.textContent = `${currentUser.full_name} · 研究人员`;
    }

    function storePatientId(patientId) {
        if (!patientId) {
            localStorage.removeItem(SELECTED_PATIENT_STORAGE_KEY);
            return;
        }
        localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patientId));
    }

    function formatPercent(value) {
        return `${(Number(value || 0) * 100).toFixed(1)}%`;
    }

    function updateChildLinks(patient) {
        const patientId = patient ? String(patient.patient_id) : '';
        const workspaceUrl = patientId ? `doctor_patients.html?focus_patient_id=${patientId}` : 'doctor_patients.html';
        const reportUrl = patientId ? `doctor_report.html?patient_id=${patientId}` : 'doctor_patients.html';
        const imagingUrl = patientId ? `doctor_imaging.html?patient_id=${patientId}` : 'doctor_imaging.html';
        let baseUrl = '';
        if (window.location.protocol === 'file:') {
            baseUrl = 'http://127.0.0.1:8000/doctor-web/';
        }
        const visualizationUrl = patientId ? `${baseUrl}doctor_visualization.html?patient_id=${encodeURIComponent(patientId)}` : `${baseUrl}doctor_visualization.html`;

        if (backToWorkspaceLink) backToWorkspaceLink.href = workspaceUrl;
        if (openPatientReportLink) openPatientReportLink.href = reportUrl;
        if (childNavImaging) childNavImaging.href = imagingUrl;
        if (childNavVisualization) childNavVisualization.href = visualizationUrl;
    }

    function renderSelectedPatient(patient) {
        currentSelectedPatient = patient || null;
        if (patientMeta) {
            patientMeta.innerHTML = '';
        }

        if (!patient) {
            if (patientHint) {
                patientHint.textContent = '请先从患者工作台进入本页，系统会自动沿用当前就诊者上下文。';
            }
            updateChildLinks(null);
            return;
        }

        if (patientHint) {
            patientHint.textContent = `当前已锁定 ${patient.patient_name}。本页上传的时间序列文件和推理结果会自动关联到这位就诊者。`;
        }

        [
            `邮箱：${patient.patient_email}`,
            `类型：${patient.patient_type === 'adult' ? '成人就诊者' : '儿童就诊者'}`,
            `量表：${patient.latest_scale_type || '暂无量表'}`,
            `风险：${patient.latest_scale_risk_level || '待评估'}`
        ].forEach((text) => {
            if (!patientMeta) return;
            const chip = document.createElement('span');
            chip.className = 'selected-chip';
            chip.textContent = text;
            patientMeta.appendChild(chip);
        });

        updateChildLinks(patient);
    }

    function setStatus(badge, status, text) {
        if (!badge) return;
        badge.className = `badge ${status}`;
        badge.textContent = text;
    }

    function buildMetaChip(text) {
        const chip = document.createElement('span');
        chip.className = 'prediction-chip';
        chip.textContent = text;
        return chip;
    }

    function resetResultUi() {
        setStatus(fileStatusBadge, 'waiting', '等待中');
        setStatus(connectivityStatusBadge, 'waiting', '等待中');
        setStatus(predictionStatusBadge, 'waiting', '等待中');

        if (graphText) {
            graphText.textContent = '等待上传时间序列文件，系统会自动解析时间点数、ROI 维度并构建连接矩阵。';
            graphText.style.color = '';
        }

        if (nodeAttention) nodeAttention.textContent = 'N/A';
        if (edgeConnectivity) edgeConnectivity.textContent = 'N/A';
        if (predictionMeta) predictionMeta.innerHTML = '';
        if (predictionLabelText) predictionLabelText.textContent = '等待开始推理';
        if (predictionSummary) {
            predictionSummary.innerHTML = '<strong>提示：</strong> 当前还没有推理结果。上传时间序列文件后，系统会返回分类标签、模型输出概率和简短解释，仅供辅助参考。';
        }
        if (riskText) riskText.textContent = '--';
        if (riskCircle) {
            riskCircle.setAttribute('stroke-dasharray', '0, 100');
            riskCircle.className.baseVal = 'circle';
        }
        if (adhdProbabilityBar) adhdProbabilityBar.style.width = '0%';
        if (controlProbabilityBar) controlProbabilityBar.style.width = '0%';
    }

    function renderSelectedFile(file) {
        if (!usable()) return;
        selectedFile = file;
        if (!file) {
            setStatus(fileStatusBadge, 'waiting', '等待中');
            return;
        }

        setStatus(fileStatusBadge, 'success', '已选择');
        setStatus(connectivityStatusBadge, 'waiting', '待构建');
        setStatus(predictionStatusBadge, 'waiting', '待推理');
        if (graphText) {
            graphText.textContent = allowed() ? `已在本机选择文件：${file.name}。请核对模型使用状态后开始。`
                : `已在本机选择文件：${file.name}。模型尚未准入，未开始分析。`;
        }
    }

    async function ensureLockedPatient(operation) {
        if (!window.API?.Doctor?.getMyPatients) return;

        try {
            const response = await window.API.Doctor.getMyPatients();
            if (!current(operation)) return;
            boundPatients = response.items || [];
            const targetId = queryPatientId || localStorage.getItem(SELECTED_PATIENT_STORAGE_KEY);
            const patient = boundPatients.find((item) => String(item.patient_id) === String(targetId));

            if (patient) {
                storePatientId(patient.patient_id);
                renderSelectedPatient(patient);
            } else {
                renderSelectedPatient(null);
            }
        } catch (error) {
            if (current(operation)) renderSelectedPatient(null);
        }
    }

    async function readAdmission(operation) {
        try {
            const result = await window.API.Model.getAdmission();
            if (!current(operation)) return false;
            if (!['real', 'auto', 'mock'].includes(result?.inference_mode) || typeof result.real_inference_allowed !== 'boolean') throw new Error('模型状态不完整。');
            admission = result; renderAdmission(); return true;
        } catch (error) {
            if (current(operation)) { admission = null; renderAdmission(); }
            return false;
        }
    }
    async function refreshWorkspace() {
        if (!usable()) return false;
        const operation = ++epoch;
        await Promise.allSettled([ensureLockedPatient(operation), readAdmission(operation)]);
        if (!current(operation)) return false;
        updateControls(); return true;
    }
    function hideWorkspace() {
        active = false; epoch++; running = false; admission = null;
        boundPatients = []; selectedFile = null;
        if (fileInput) fileInput.value = '';
        renderSelectedPatient(null); resetResultUi();
        if (userProfileName) userProfileName.textContent = '';
        renderAdmission();
    }
    async function showWorkspace() {
        if (active) return;
        active = true;
        if (!usable()) { hideWorkspace(); return; }
        if (userProfileName && currentUser?.full_name) userProfileName.textContent = `${currentUser.full_name} · 研究人员`;
        await refreshWorkspace();
    }
    window.addEventListener('pagehide', hideWorkspace);
    window.addEventListener('pageshow', showWorkspace);
    document.addEventListener('visibilitychange', () => document.hidden ? hideWorkspace() : showWorkspace());
    window.SessionGuard?.onInvalidated(hideWorkspace);

    async function runPrediction() {
        if (!usable() || running) return;
        if (!allowed()) { renderAdmission(); return; }
        if (!currentSelectedPatient) {
            renderSelectedPatient(null);
            return;
        }
        if (!selectedFile) {
            setStatus(fileStatusBadge, 'warning', '未选择');
            if (graphText) {
                graphText.textContent = '请先上传一个 .1D 或 .csv 时间序列文件。';
            }
            return;
        }
        const operation = epoch, patientId = currentSelectedPatient.patient_id, originalMode = admission.inference_mode;
        running = true;
        updateControls();
        setStatus(fileStatusBadge, 'success', '已读取');
        setStatus(connectivityStatusBadge, 'processing', '处理中');
        setStatus(predictionStatusBadge, 'waiting', '等待中');

        const formData = new FormData();
        formData.append('timeseries_file', selectedFile);

        try {
            if (!await readAdmission(operation) || !current(operation)) return;
            if (!allowed() || admission.inference_mode !== originalMode) {
                if (graphText) graphText.textContent = '模型使用状态已变化，请核对后重新开始。';
                return;
            }
            const result = await window.API.Doctor.predictTimeseries(patientId, formData);
            if (!current(operation)) return;
            const demo = result.is_demo === true && result.source_type === 'mock';
            if ((originalMode === 'mock') !== demo) throw new Error('结果来源与已核对的模式不一致，请重新核对。');
            setStatus(connectivityStatusBadge, demo ? 'waiting' : 'success', demo ? '演示未计算' : '已构建');
            setStatus(predictionStatusBadge, 'success', demo ? '演示完成' : '已完成');

            if (nodeAttention) nodeAttention.textContent = String(result.timepoints);
            if (edgeConnectivity) edgeConnectivity.textContent = `${result.roi_dim_used} ROI`;

            if (predictionMeta) {
                predictionMeta.innerHTML = '';
                [
                    `文件：${result.file_name}`,
                    `模型：${result.model_name}`,
                    `版本：${result.model_version}`,
                    `结果ID：${result.prediction_id}`,
                    `来源：${demo ? '演示结果，不用于临床' : '模型分析，需专业审核'}`
                ].forEach((text) => predictionMeta.appendChild(buildMetaChip(text)));
            }

            if (predictionLabelText) {
                predictionLabelText.textContent = `${demo ? '演示' : '模型'}结果：${result.prediction_label} · 输出概率 ${formatPercent(result.probability)}`;
            }

            if (predictionSummary) {
                predictionSummary.replaceChildren(SafeRender.html`<strong>${demo ? '演示摘要' : '推理摘要'}：</strong> ${result.summary_text}<br><strong>说明：</strong> ${demo ? '演示结果不用于临床判断。' : '模型输出不代表诊断，需由医生结合规定证据审核。'}`);
            }

            if (graphText) {
                graphText.textContent = `${demo ? '演示' : '时间序列推理'}已完成。当前文件为 ${result.file_name}，输出标签为 ${result.prediction_label}，输出概率为 ${formatPercent(result.probability)}。`;
                graphText.style.color = 'var(--success)';
            }

            if (riskText) {
                riskText.textContent = formatPercent(result.probability);
            }
            if (riskCircle) {
                const percent = Number(result.probability || 0) * 100;
                riskCircle.setAttribute('stroke-dasharray', `${percent}, 100`);
                riskCircle.className.baseVal = percent < 40 ? 'circle low' : percent < 75 ? 'circle medium' : 'circle high';
            }

            if (adhdProbabilityBar) {
                adhdProbabilityBar.style.width = `${Number(result.probability || 0) * 100}%`;
            }
            if (controlProbabilityBar) {
                controlProbabilityBar.style.width = `${Number(result.probability_control || 0) * 100}%`;
            }
        } catch (error) {
            if (!current(operation)) return;
            console.error('推理失败详情:', error);
            setStatus(connectivityStatusBadge, 'warning', '失败');
            setStatus(predictionStatusBadge, 'warning', '失败');

            let errorMessage = error.message || '请检查时间序列格式、推理权重和运行依赖。';

            // 根据错误类型提供更具体的提示
            if (error.message.includes('未认证') || error.message.includes('Not authenticated')) {
                errorMessage = '认证失败，请重新登录后再试。';
            } else if (
                error.message.includes('torch') ||
                error.message.includes('dhg') ||
                error.message.includes('依赖尚未安装') ||
                error.message.includes('依赖未安装')
            ) {
                errorMessage = '当前后端环境缺少 HGST 运行依赖（torch / dhg），因此无法执行时间序列推理。';
            } else if (error.message.includes('HGST') || error.message.includes('模型服务')) {
                errorMessage = '模型服务异常，请联系管理员检查HGST部署状态。';
            } else if (error.message.includes('格式') || error.message.includes('format')) {
                errorMessage = '文件格式错误，请上传.1D或.csv格式的fMRI时间序列文件。';
            } else if (error.message.includes('网络') || error.message.includes('Network')) {
                errorMessage = '网络连接失败，请检查后端服务是否正常运行。';
            }

            if (predictionSummary) {
                predictionSummary.replaceChildren(SafeRender.html`<strong>推理失败：</strong> ${errorMessage}`);
            }
            if (graphText) {
                graphText.textContent = errorMessage;
                graphText.style.color = '#B91C1C';
            }
        } finally {
            if (current(operation)) { running = false; updateControls(); }
        }
    }

    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0] || null;
        renderSelectedFile(file);
    });

    uploadZone?.addEventListener('click', () => {
        fileInput?.click();
    });

    uploadZone?.addEventListener('dragover', (event) => {
        event.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone?.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
    });

    uploadZone?.addEventListener('drop', (event) => {
        event.preventDefault();
        uploadZone.classList.remove('dragover');
        const file = event.dataTransfer?.files?.[0] || null;
        if (!file) return;
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        if (fileInput) {
            fileInput.files = dataTransfer.files;
        }
        renderSelectedFile(file);
    });

    generateBtn?.addEventListener('click', runPrediction);

    resetResultUi();
    await refreshWorkspace();
});
