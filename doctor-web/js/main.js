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

    let boundPatients = [];
    let currentSelectedPatient = null;
    let selectedFile = null;
    let running = false;

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

    function getConfidenceLevel(probability) {
        const score = Number(probability || 0);
        if (score >= 0.9) return '高置信';
        if (score >= 0.75) return '中等置信';
        return '低置信';
    }

    function updateChildLinks(patient) {
        const patientId = patient ? String(patient.patient_id) : '';
        const workspaceUrl = patientId ? `doctor_patients.html?focus_patient_id=${patientId}` : 'doctor_patients.html';
        const reportUrl = patientId ? `doctor_report.html?patient_id=${patientId}` : 'doctor_patients.html';
        const imagingUrl = patientId ? `doctor_imaging.html?patient_id=${patientId}` : 'doctor_imaging.html';
        let baseUrl = '';
        let authParams = '';
        if (window.location.protocol === 'file:') {
            baseUrl = 'http://127.0.0.1:8000/doctor-web/';
            authParams = `&_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;
        }
        const visualizationUrl = patientId ? `${baseUrl}doctor_visualization.html?patient_id=${patientId}${authParams}` : `${baseUrl}doctor_visualization.html?_token=${localStorage.getItem('smartbrain_token') || ''}&_user=${encodeURIComponent(localStorage.getItem('smartbrain_user') || '')}`;

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
        selectedFile = file;
        if (!file) {
            setStatus(fileStatusBadge, 'waiting', '等待中');
            return;
        }

        setStatus(fileStatusBadge, 'success', '已选择');
        setStatus(connectivityStatusBadge, 'waiting', '待构建');
        setStatus(predictionStatusBadge, 'waiting', '待推理');
        if (graphText) {
            graphText.textContent = `已选择文件：${file.name}。点击“开始分类推理”后，系统将解析时间序列并运行 HGST 模型。`;
        }
    }

    async function ensureLockedPatient() {
        if (!window.API?.Doctor?.getMyPatients) return;

        try {
            const response = await window.API.Doctor.getMyPatients();
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
            renderSelectedPatient(null);
        }
    }

    async function runPrediction() {
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
        if (running) return;

        running = true;
        generateBtn.disabled = true;
        generateBtn.textContent = '推理中...';
        setStatus(fileStatusBadge, 'success', '已读取');
        setStatus(connectivityStatusBadge, 'processing', '处理中');
        setStatus(predictionStatusBadge, 'waiting', '等待中');

        const formData = new FormData();
        formData.append('timeseries_file', selectedFile);

        try {
            const result = await window.API.Doctor.predictTimeseries(currentSelectedPatient.patient_id, formData);
            setStatus(connectivityStatusBadge, 'success', '已构建');
            setStatus(predictionStatusBadge, 'success', '已完成');

            if (nodeAttention) nodeAttention.textContent = String(result.timepoints);
            if (edgeConnectivity) edgeConnectivity.textContent = `${result.roi_dim_used} ROI`;

            const confidenceLevel = getConfidenceLevel(result.probability);

            if (predictionMeta) {
                predictionMeta.innerHTML = '';
                [
                    `文件：${result.file_name}`,
                    `模型：${result.model_name}`,
                    `版本：${result.model_version}`,
                    `结果ID：${result.prediction_id}`,
                    `置信等级：${confidenceLevel}`
                ].forEach((text) => predictionMeta.appendChild(buildMetaChip(text)));
            }

            if (predictionLabelText) {
                predictionLabelText.textContent = `分类结果：${result.prediction_label} · 模型输出概率 ${formatPercent(result.probability)}`;
            }

            if (predictionSummary) {
                predictionSummary.innerHTML = `<strong>推理摘要：</strong> ${result.summary_text}<br><strong>说明：</strong> 当前展示的是模型输出概率，仅供辅助参考，不代表绝对诊断结论。`;
            }

            if (graphText) {
                graphText.textContent = `时间序列推理已完成。当前文件为 ${result.file_name}，输出标签为 ${result.prediction_label}，模型输出概率为 ${formatPercent(result.probability)}。`;
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
                predictionSummary.innerHTML = `<strong>推理失败：</strong> ${errorMessage}`;
            }
            if (graphText) {
                graphText.textContent = errorMessage;
                graphText.style.color = '#B91C1C';
            }
        } finally {
            running = false;
            generateBtn.disabled = false;
            generateBtn.textContent = '开始分类推理';
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
    await ensureLockedPatient();
});
