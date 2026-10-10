export function validateUploadSize(files, maxBodyBytes) {
    const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
        throw new Error('无法确认影像上传容量，请刷新页面后重试。');
    }
    if (total > maxBodyBytes) {
        const sizeMb = (maxBodyBytes / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '');
        throw new Error('影像文件过大，本次上传总大小上限为 ' + sizeMb + ' MB。可压缩为 .nii.gz 后重试。');
    }
}

export async function readUploadResponse(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = payload?.detail || payload?.error;
        if (typeof detail === 'string' && detail.trim()) throw new Error(detail);
        if (response.status === 413) {
            throw new Error('影像文件过大，超过服务允许的上传大小。请压缩为 .nii.gz 或检查影像上传容量配置。');
        }
        throw new Error('影像上传失败（HTTP ' + response.status + '），请检查文件格式或后端服务状态。');
    }
    if (!payload || !['nifti', 'gifti'].includes(payload.file_type)) {
        throw new Error('影像服务返回的数据不完整，请刷新后重试。');
    }
    return payload;
}
