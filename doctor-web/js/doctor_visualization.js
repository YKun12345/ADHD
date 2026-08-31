window.__doctorVizModuleBooted = true;

const LOCAL_FINDVIZ_ORIGIN = 'http://127.0.0.1:8000';
const SELECTED_PATIENT_STORAGE_KEY = 'smartbrain_selected_patient_id';

function resolveFindvizBasePath() {
    const override = window.FINDVIZ_BASE_PATH;
    if (typeof override === 'string' && override.trim()) {
        return override.replace(/\/$/, '');
    }

    const { protocol, hostname, port, origin } = window.location;
    const isLocalDevHost = hostname === 'localhost' || hostname === '127.0.0.1';
    const isHttpOrigin = protocol === 'http:' || protocol === 'https:';

    if (isHttpOrigin && (!isLocalDevHost || port === '8000')) {
        return `${origin}/findviz`;
    }

    return `${LOCAL_FINDVIZ_ORIGIN}/findviz`;
}

window.FINDVIZ_BASE_PATH = resolveFindvizBasePath();

import { initBootstrapComponents } from '../../findviz/static/js/utils.js';
import { DOM_IDS } from '../../findviz/static/js/constants/DomIds.js';

let boundPatients = [];
let currentSelectedPatient = null;
let fragmentsInjected = false;
let MainViewerClass = null;
let lastVisualizationPayload = null;
let screenshotState = {
    slice: { name: null, dataUrl: null },
    surface: { name: null, dataUrl: null },
};

function $(id) {
    return document.getElementById(id);
}

function setStartupAlert(message = '', type = 'error') {
    const alert = $('visualizationStartupAlert');
    if (!alert) return;

    if (!message) {
        alert.className = 'startup-alert';
        alert.innerHTML = '';
        return;
    }

    alert.className = `startup-alert visible ${type}`.trim();
    alert.innerHTML = `
        <ion-icon name="${type === 'info' ? 'information-circle-outline' : 'warning-outline'}"></ion-icon>
        <div>${message}</div>
    `;
}

async function fetchFragment(path) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`加载 findviz 片段失败：${path}`);
    }
    return response.text();
}

async function ensureFindvizFragments() {
    if (fragmentsInjected) return;

    const [
        uploadErrorModal,
        viewerErrorModal,
        fmriOptions,
        fmriPreprocess,
        fmriCard,
        tsOptions,
        tsMarkers,
        tsPreprocess,
        tsCard,
        analyticsToolbox,
        distanceModal,
        saveSceneModal,
        averageModal,
        correlationModal
    ] = await Promise.all([
        fetchFragment('../findviz/templates/components/modals/uploadErrorModal.html'),
        fetchFragment('../findviz/templates/components/modals/viewerErrorModal.html'),
        fetchFragment('../findviz/templates/components/fmriVisualizationOptions.html'),
        fetchFragment('../findviz/templates/components/fmriPreprocessingOptions.html'),
        fetchFragment('../findviz/templates/components/fmriVisualizationCard.html'),
        fetchFragment('../findviz/templates/components/timeCourseVisualizationOptions.html'),
        fetchFragment('../findviz/templates/components/timeCourseMarkerOptions.html'),
        fetchFragment('../findviz/templates/components/timeCoursePreprocessingOptions.html'),
        fetchFragment('../findviz/templates/components/timeCourseVisualizationCard.html'),
        fetchFragment('../findviz/templates/components/analyticsToolbox.html'),
        fetchFragment('../findviz/templates/components/modals/distanceModal.html'),
        fetchFragment('../findviz/templates/components/modals/saveSceneModal.html'),
        fetchFragment('../findviz/templates/components/modals/averageModal.html'),
        fetchFragment('../findviz/templates/components/modals/correlationModal.html')
    ]);

    const analyticsResolved = analyticsToolbox
        .replace("{% include 'components/modals/distanceModal.html' %}", distanceModal)
        .replace("{% include 'components/modals/saveSceneModal.html' %}", saveSceneModal);

    const timeCourseResolved = tsCard
        .replace("{% include 'components/modals/averageModal.html' %}", averageModal)
        .replace("{% include 'components/modals/correlationModal.html' %}", correlationModal);

    $('findvizUploadErrorRoot').innerHTML = uploadErrorModal;
    $('findvizViewerErrorRoot').innerHTML = viewerErrorModal;
    $('analytics-toolbox-container').innerHTML = analyticsResolved;
    $('fmri-user-options-container').innerHTML = `${fmriOptions}${fmriPreprocess}`;
    $('fmri-visualization-container').innerHTML = fmriCard;
    $('time-course-user-options-container').innerHTML = `${tsOptions}${tsMarkers}${tsPreprocess}`;
    $('time-course-visualization-container').innerHTML = timeCourseResolved;

    initBootstrapComponents();
    fragmentsInjected = true;
}

async function clearFindvizCache() {
    try {
        await fetch(`${window.FINDVIZ_BASE_PATH}/clear_cache`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.warn('Failed to clear findviz cache before reloading workspace:', error);
    }
}

function resetFindvizWorkspaceUi() {
    const parentContainer = $(DOM_IDS.PARENT_CONTAINER);
    if (parentContainer) {
        parentContainer.style.display = 'none';
    }

    const emptyState = $('findvizEmptyState');
    if (emptyState) {
        emptyState.style.display = 'flex';
    }

    [
        'analytics-toolbox-container',
        'fmri-user-options-container',
        'fmri-visualization-container',
        'time-course-user-options-container',
        'time-course-visualization-container'
    ].forEach((id) => {
        const element = $(id);
        if (element) {
            element.innerHTML = '';
        }
    });

    fragmentsInjected = false;
    MainViewerClass = null;
}

async function waitForFindvizCacheReady(expectedType, maxAttempts = 40, delayMs = 500) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const response = await fetch(`${window.FINDVIZ_BASE_PATH}/check_cache`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            const payload = await response.json();
            if (payload?.has_cache && (!expectedType || payload.plot_type === expectedType)) {
                return payload;
            }
        } catch (error) {
            console.warn('Failed to poll findviz cache readiness:', error);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('findviz 可视化工作区加载超时，请确认后端服务已启动并正常运行。如果问题持续，请尝试刷新页面或重新上传文件。');
}

async function ensureMainViewerLoaded() {
    if (!MainViewerClass) {
        const module = await import('../findviz/static/js/viewer/MainViewer.js');
        MainViewerClass = module.default;
    }
    return MainViewerClass;
}

function setUploadFeedback(message = '', type = '') {
    const feedback = $('uploadActionFeedback');
    feedback.textContent = message;
    feedback.className = `action-feedback ${type}`.trim();
}

function setSaveFeedback(message = '', type = '') {
    const feedback = $('saveVisualizationStatus');
    feedback.textContent = message;
    feedback.className = `action-feedback ${type}`.trim();
}

function resetSavePanel() {
    lastVisualizationPayload = null;
    screenshotState = {
        slice: { name: null, dataUrl: null },
        surface: { name: null, dataUrl: null },
    };
    $('saveVisualizationPanel').style.display = 'none';
    $('saveVisualizationFiles').innerHTML = '';
    $('saveVisualizationButton').disabled = true;
    $('saveVisualizationSummary').textContent = '完成可视化后，可以把当前文件信息和可视化结果直接保存回患者综合报告，供患者端和研究端共同查看。';
    setSaveFeedback('');
    renderScreenshotPreview('slice');
    renderScreenshotPreview('surface');
}

function formatFileChip(label, value) {
    return `<span class="save-file-chip">${label}：${value}</span>`;
}

function getSelectedFileName(inputId) {
    const file = $(inputId)?.files?.[0];
    return file ? file.name : null;
}

function buildVisualizationPayload(fileType) {
    if (fileType === 'nifti') {
        return {
            visualization_type: 'nifti',
            func_file_name: getSelectedFileName('nifti-func'),
            anat_file_name: getSelectedFileName('nifti-anat'),
            mask_file_name: getSelectedFileName('nifti-mask'),
            slice_screenshot_name: screenshotState.slice.name,
            slice_screenshot_data: screenshotState.slice.dataUrl,
            surface_screenshot_name: screenshotState.surface.name,
            surface_screenshot_data: screenshotState.surface.dataUrl,
            slice_interpretation: $('sliceInterpretationInput')?.value.trim() || null,
            surface_interpretation: $('surfaceInterpretationInput')?.value.trim() || null,
        };
    }

    return {
        visualization_type: 'gifti',
        left_func_file_name: getSelectedFileName('left-hemisphere-gifti-func'),
        left_mesh_file_name: getSelectedFileName('left-hemisphere-gifti-mesh'),
        right_func_file_name: getSelectedFileName('right-hemisphere-gifti-func'),
        right_mesh_file_name: getSelectedFileName('right-hemisphere-gifti-mesh'),
        slice_screenshot_name: screenshotState.slice.name,
        slice_screenshot_data: screenshotState.slice.dataUrl,
        surface_screenshot_name: screenshotState.surface.name,
        surface_screenshot_data: screenshotState.surface.dataUrl,
        slice_interpretation: $('sliceInterpretationInput')?.value.trim() || null,
        surface_interpretation: $('surfaceInterpretationInput')?.value.trim() || null,
    };
}

function renderSavePanel(payload) {
    const chips = [];
    if (payload.visualization_type === 'nifti') {
        if (payload.func_file_name) chips.push(formatFileChip('功能影像', payload.func_file_name));
        if (payload.anat_file_name) chips.push(formatFileChip('脑剖面', payload.anat_file_name));
        if (payload.mask_file_name) chips.push(formatFileChip('掩膜', payload.mask_file_name));
        if (payload.slice_screenshot_name) chips.push(formatFileChip('脑剖面截图', payload.slice_screenshot_name));
        if (payload.surface_screenshot_name) chips.push(formatFileChip('3D表面截图', payload.surface_screenshot_name));
        $('saveVisualizationSummary').textContent = '当前为 NIfTI 脑剖面可视化结果，保存后会直接挂到当前患者的影像摘要里。';
    } else {
        if (payload.left_func_file_name) chips.push(formatFileChip('左半球功能', payload.left_func_file_name));
        if (payload.left_mesh_file_name) chips.push(formatFileChip('左半球表面', payload.left_mesh_file_name));
        if (payload.right_func_file_name) chips.push(formatFileChip('右半球功能', payload.right_func_file_name));
        if (payload.right_mesh_file_name) chips.push(formatFileChip('右半球表面', payload.right_mesh_file_name));
        if (payload.slice_screenshot_name) chips.push(formatFileChip('脑剖面截图', payload.slice_screenshot_name));
        if (payload.surface_screenshot_name) chips.push(formatFileChip('3D表面截图', payload.surface_screenshot_name));
        $('saveVisualizationSummary').textContent = '当前为 GIfTI 3D 表面可视化结果，保存后会直接挂到当前患者的影像摘要里。';
    }

    $('saveVisualizationFiles').innerHTML = chips.join('');
    $('saveVisualizationPanel').style.display = 'block';
    $('saveVisualizationButton').disabled = false;
    setSaveFeedback('');
}

function renderScreenshotPreview(kind) {
    const preview = kind === 'slice' ? $('sliceScreenshotPreview') : $('surfaceScreenshotPreview');
    if (!preview) return;

    const item = screenshotState[kind];
    if (!item?.dataUrl) {
        preview.innerHTML = kind === 'slice' ? '脑剖面截图预览区' : '3D 表面截图预览区';
        return;
    }

    preview.innerHTML = `<img src="${item.dataUrl}" alt="${item.name || 'screenshot'}">`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('截图文件读取失败。'));
        reader.readAsDataURL(file);
    });
}

function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('截图图片解析失败。'));
        image.src = dataUrl;
    });
}

async function compressScreenshotFile(file) {
    const originalDataUrl = await readFileAsDataUrl(file);
    const image = await loadImageElement(originalDataUrl);

    const maxWidth = 1400;
    const scale = image.width > maxWidth ? maxWidth / image.width : 1;
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    let quality = 0.86;
    let compressed = canvas.toDataURL('image/jpeg', quality);
    while (compressed.length > 350000 && quality > 0.45) {
        quality -= 0.08;
        compressed = canvas.toDataURL('image/jpeg', quality);
    }

    return compressed;
}

async function handleScreenshotUpload(kind, file) {
    if (!file) {
        screenshotState[kind] = { name: null, dataUrl: null };
        renderScreenshotPreview(kind);
        return;
    }

    const dataUrl = await compressScreenshotFile(file);
    screenshotState[kind] = {
        name: file.name,
        dataUrl,
    };
    renderScreenshotPreview(kind);
    if (lastVisualizationPayload) {
        lastVisualizationPayload = buildVisualizationPayload(lastVisualizationPayload.visualization_type);
        renderSavePanel(lastVisualizationPayload);
    }
}

function buildAssetOnlyPayload(kind) {
    if (kind === 'slice') {
        return {
            visualization_type: 'nifti',
            slice_screenshot_name: screenshotState.slice.name,
            slice_screenshot_data: screenshotState.slice.dataUrl,
            slice_interpretation: $('sliceInterpretationInput')?.value.trim() || null,
            notes: $('sliceInterpretationInput')?.value.trim() || null,
        };
    }

    return {
        visualization_type: 'gifti',
        surface_screenshot_name: screenshotState.surface.name,
        surface_screenshot_data: screenshotState.surface.dataUrl,
        surface_interpretation: $('surfaceInterpretationInput')?.value.trim() || null,
        notes: $('surfaceInterpretationInput')?.value.trim() || null,
    };
}

async function saveAssetBlock(kind) {
    if (!currentSelectedPatient) {
        setSaveFeedback('请先确保当前页面已经锁定一位患者。', 'error');
        return;
    }

    const payload = buildAssetOnlyPayload(kind);
    const hasScreenshot = kind === 'slice' ? payload.slice_screenshot_data : payload.surface_screenshot_data;
    const hasInterpretation = kind === 'slice' ? payload.slice_interpretation : payload.surface_interpretation;

    if (!hasScreenshot && !hasInterpretation) {
        setSaveFeedback(kind === 'slice' ? '请先上传脑剖面截图或填写文字解读。' : '请先上传 3D 表面截图或填写文字解读。', 'error');
        return;
    }

    const button = kind === 'slice' ? $('saveSliceAssetBtn') : $('saveSurfaceAssetBtn');
    if (button) button.disabled = true;
    setSaveFeedback(kind === 'slice' ? '正在保存脑剖面结果...' : '正在保存 3D 表面结果...', '');

    try {
        await window.API.Doctor.saveImagingVisualization(currentSelectedPatient.patient_id, payload);
        setSaveFeedback(kind === 'slice' ? '脑剖面截图和解读已保存到患者报告。' : '3D 表面截图和解读已保存到患者报告。', 'success');
    } catch (error) {
        setSaveFeedback(error.message || '保存截图或解读失败，请稍后重试。', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

function updatePatientLinks(patient) {
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

    const backToWorkspace = $('backToPatientReportLink');
    const openPatientReport = $('openPatientReportLink');
    const childNavImaging = $('childNavImaging');
    const childNavVisualization = $('childNavVisualization');

    if (backToWorkspace) backToWorkspace.href = workspaceUrl;
    if (openPatientReport) openPatientReport.href = reportUrl;
    if (childNavImaging) childNavImaging.href = imagingUrl;
    if (childNavVisualization) childNavVisualization.href = visualizationUrl;
}

function renderSelectedPatient(patient) {
    currentSelectedPatient = patient || null;
    const patientHint = $('timeseriesPatientHint');
    const patientMeta = $('timeseriesPatientMeta');
    const workspaceNote = $('workspacePatientNote');

    if (patientMeta) patientMeta.innerHTML = '';

    if (!patient) {
        const emptyMessage = '请先从患者工作台进入本页。系统会自动带入患者上下文，避免在子页里重复绑定患者。';
        if (patientHint) patientHint.textContent = emptyMessage;
        if (workspaceNote) workspaceNote.textContent = emptyMessage;
        updatePatientLinks(null);
        return;
    }

    const selectedMessage = `当前已锁定 ${patient.patient_name}。本页上传、可视化和保存的结果都会和这位患者绑定。`;
    if (patientHint) patientHint.textContent = selectedMessage;
    if (workspaceNote) workspaceNote.textContent = selectedMessage;

    [
        `邮箱：${patient.patient_email}`,
        `类型：${patient.patient_type === 'adult' ? '成人患者' : '儿童患者'}`,
        `量表：${patient.latest_scale_type || '暂无量表'}`,
        `风险：${patient.latest_scale_risk_level || '待评估'}`
    ].forEach((text) => {
        if (!patientMeta) return;
        const chip = document.createElement('span');
        chip.className = 'selected-chip';
        chip.textContent = text;
        patientMeta.appendChild(chip);
    });

    updatePatientLinks(patient);
}

function resetViewerShell() {
    $('findvizEmptyState').style.display = 'none';
    $(DOM_IDS.PARENT_CONTAINER).style.display = 'block';
}

function buildUploadFormData(fileType) {
    const formData = new FormData();
    formData.append('fmri_file_type', fileType);
    formData.append('ts_input', 'false');
    formData.append('task_input', 'false');

    if (fileType === 'nifti') {
        const func = $('nifti-func').files[0];
        const anat = $('nifti-anat').files[0];
        const mask = $('nifti-mask').files[0];

        if (!func) {
            throw new Error('请先上传 NIfTI 功能影像文件。');
        }

        formData.append('nii_func', func);
        if (anat) formData.append('nii_anat', anat);
        if (mask) formData.append('nii_mask', mask);
    } else {
        const leftFunc = $('left-hemisphere-gifti-func').files[0];
        const leftMesh = $('left-hemisphere-gifti-mesh').files[0];
        const rightFunc = $('right-hemisphere-gifti-func').files[0];
        const rightMesh = $('right-hemisphere-gifti-mesh').files[0];

        if (!leftFunc || !leftMesh || !rightFunc || !rightMesh) {
            throw new Error('请把左右半球的 GIfTI 功能文件和表面文件都上传完整。');
        }

        formData.append('left_gii_func', leftFunc);
        formData.append('left_gii_mesh', leftMesh);
        formData.append('right_gii_func', rightFunc);
        formData.append('right_gii_mesh', rightMesh);
    }

    return formData;
}

async function uploadAndVisualize(fileType) {
    if (!currentSelectedPatient) {
        setUploadFeedback('请先从患者工作台进入本页，系统需要知道当前影像属于哪位患者。', 'error');
        return;
    }

    resetSavePanel();

    let formData;
    try {
        formData = buildUploadFormData(fileType);
    } catch (error) {
        setUploadFeedback(error.message, 'error');
        return;
    }

    setUploadFeedback('正在上传影像文件并启动可视化工作区...', '');

    try {
        await clearFindvizCache();
        resetFindvizWorkspaceUi();
        await ensureFindvizFragments();

        const response = await fetch(`${window.FINDVIZ_BASE_PATH}/upload`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || '影像上传失败，请检查文件格式或后端服务状态。');
        }

        const resolvedFileType = result.file_type || fileType;
        setUploadFeedback('影像已上传，正在初始化可视化工作区...', '');

        try {
            await waitForFindvizCacheReady(resolvedFileType, 10, 300);
        } catch (cacheError) {
            console.warn('Findviz cache readiness check timed out, continuing with direct metadata:', cacheError);
        }
        resetViewerShell();

        const MainViewer = await ensureMainViewerLoaded();
        const viewer = new MainViewer(resolvedFileType);
        await viewer.init();

        lastVisualizationPayload = buildVisualizationPayload(fileType);
        renderSavePanel(lastVisualizationPayload);
        setUploadFeedback(`已为 ${currentSelectedPatient.patient_name} 成功载入 ${fileType.toUpperCase()} 可视化工作区。`, 'success');
    } catch (error) {
        console.error('Failed to upload and visualize:', error);
        setUploadFeedback(error.message || '影像上传或工作区初始化失败。', 'error');
    }
}

async function saveVisualizationToReport() {
    if (!currentSelectedPatient || !lastVisualizationPayload) {
        setSaveFeedback('请先完成一次有效的影像可视化，再保存到患者报告。', 'error');
        return;
    }

    const button = $('saveVisualizationButton');
    button.disabled = true;
    setSaveFeedback('正在保存到患者综合报告...', '');

    try {
        const result = await window.API.Doctor.saveImagingVisualization(
            currentSelectedPatient.patient_id,
            lastVisualizationPayload
        );
        setSaveFeedback(`已成功保存 ${result.visualization_type.toUpperCase()} 可视化摘要到患者报告。`, 'success');
    } catch (error) {
        setSaveFeedback(error.message || '保存失败，请稍后重试。', 'error');
    } finally {
        button.disabled = false;
    }
}

async function loadPatientContext() {
    const currentUser = JSON.parse(localStorage.getItem('smartbrain_user') || 'null');
    if ($('researcherName') && currentUser?.full_name) {
        $('researcherName').textContent = currentUser.full_name;
    }

    const response = await window.API.Doctor.getMyPatients();
    boundPatients = response.items || [];

    const params = new URLSearchParams(window.location.search);
    const queryPatientId = params.get('patient_id');
    const storedPatientId = localStorage.getItem(SELECTED_PATIENT_STORAGE_KEY);
    const targetId = queryPatientId || storedPatientId;

    if (targetId) {
        const patient = boundPatients.find((item) => String(item.patient_id) === String(targetId));
        if (patient) {
            localStorage.setItem(SELECTED_PATIENT_STORAGE_KEY, String(patient.patient_id));
            renderSelectedPatient(patient);
            return;
        }
    }

    renderSelectedPatient(null);
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await ensureFindvizFragments();
        await loadPatientContext();
        setStartupAlert('', '');
    } catch (error) {
        console.error('Failed to initialize doctor visualization page:', error);
        setStartupAlert(
            `影像可视化初始化失败：${error.message || '请确认后端已启动。'} 若本地后端尚未启动，请先运行 <code>uvicorn backend.app.main:app --reload</code>，再通过 <code>http://127.0.0.1:8000/doctor-web/doctor_visualization.html</code> 访问本页。`
        );
        return;
    }

    $('submit-file')?.addEventListener('click', () => uploadAndVisualize('nifti'));
    $('submit-file-gifti')?.addEventListener('click', () => uploadAndVisualize('gifti'));
    $('upload-file')?.addEventListener('click', () => $('nifti-func')?.click());
    $('saveVisualizationButton')?.addEventListener('click', saveVisualizationToReport);
    $('saveSliceAssetBtn')?.addEventListener('click', () => saveAssetBlock('slice'));
    $('saveSurfaceAssetBtn')?.addEventListener('click', () => saveAssetBlock('surface'));
    $('upload-slice-screenshot-btn')?.addEventListener('click', () => $('slice-screenshot-input')?.click());
    $('upload-surface-screenshot-btn')?.addEventListener('click', () => $('surface-screenshot-input')?.click());
    $('slice-screenshot-input')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0] || null;
        try {
            await handleScreenshotUpload('slice', file);
        } catch (error) {
            setUploadFeedback(error.message || '脑剖面截图上传失败。', 'error');
        }
    });
    $('surface-screenshot-input')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0] || null;
        try {
            await handleScreenshotUpload('surface', file);
        } catch (error) {
            setUploadFeedback(error.message || '3D 表面截图上传失败。', 'error');
        }
    });
    renderScreenshotPreview('slice');
    renderScreenshotPreview('surface');
});
