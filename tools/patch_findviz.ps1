$uploadModalPath = 'D:\ADHD_Web\fmri-findviz-main\findviz\templates\components\modals\uploadModal.html'
$fileUploaderPath = 'D:\ADHD_Web\fmri-findviz-main\findviz\static\js\upload\FileUploader.js'
$indexPath = 'D:\ADHD_Web\fmri-findviz-main\findviz\templates\index.html'
$analysisPath = 'D:\ADHD_Web\fmri-findviz-main\findviz\templates\analysis.html'
$stylesPath = 'D:\ADHD_Web\fmri-findviz-main\findviz\static\css\styles.css'

$uploadModal = @'
<div class="container mt-5">
    <div class="row justify-content-center">
        <div class="jumbotron">
          <div class='row justify-content-center'>
            <div class="brand-pill">智绘脑图</div>
            <h1 class="display-4">脑影像可视化工作台</h1>
          </div>
          <p class="lead">比赛版仅保留 Nifti 与 Gifti 影像上传及可视化能力</p>
          <hr class="my-4">
          <div class='row'>
            <div class='col'>
              <button type="button" class="btn btn-primary btn-lg mt-4" data-toggle="modal" id='upload-file' data-target="#upload-modal">
                上传影像文件
              </button>
            </div>
          </div>
        </div>
    </div>
    <div class="modal fade" id="upload-modal" tabindex="-1" aria-labelledby="upload-modal-label" aria-hidden="true">
      <div class='spinner-overlay' id="file-load-spinner-overlay"></div>
      <div id='upload-modal-dialog' class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <div class="container-fluid">
              <div class='row'>
                <div class='col-5'>
                  <h5 class="modal-title" id="upload-modal-dialog">上传影像文件</h5>
                </div>
                <div class='col-4 offset-2'>
                  <button id='upload-scene' type="button" class="btn btn-outline-secondary">上传场景</button>
                  <input type="file" id="file-scene" style="display: none;">
                </div>
                <div class='col-1'>
                  <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                    <span aria-hidden="true">&times;</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <nav class="navbar navbar-expand-lg navbar-light bg-light">
            <a class="navbar-brand">影像文件类型</a>
            <ul class="nav nav-pills mb-3">
              <li class="nav-item">
                <a class="nav-link active" id="nifti-tab" data-toggle="pill" href="#nifti" role="tab" aria-selected="true">Nifti</a>
              </li>
              <li class="nav-item">
                <a class="nav-link" id="gifti-tab" data-toggle="pill" href="#gifti" role="tab" aria-selected="false">Gifti</a>
              </li>
            </ul>
          </nav>
          <form id="upload-form" enctype="multipart/form-data">
            <div class="modal-body">
              <div class="spinner-container d-flex justify-content-center">
                <div id='file-load-spinner-wheel' class="spinner-wheel" role="status"></div>
              </div>
              <div class="tab-content" id="fileupload-content">
                <div class="tab-pane fade show active" id="nifti" role="tabpanel" aria-labelledby="nifti-tab">
                  <div class='card'>
                    <div class="card-header">
                      <h5 class="card-title">Nifti 文件</h5>
                    </div>
                    <div class='card-body'>
                      <div class='row justify-content-start'>
                        <div class="form-group ml-1">
                          <label for="nifti-func" class="text-secondary">Functional File (.nii, .nii.gz)</label>
                          <i class="fa-solid fa-triangle-exclamation" id="nifti-func-error" style="color: #e93407; display: none;"></i>
                          <input type="file" class="form-control-file" id="nifti-func">
                        </div>
                      </div>
                      <div class='row justify-content-start'>
                        <div class="form-group ml-1">
                          <label for="nifti-anat" class="d-inline-block text-secondary">Anatomical File (.nii, .nii.gz, optional)</label>
                          <i class="fa-solid fa-triangle-exclamation" id="nifti-anat-error" style="color: #e93407; display: none;"></i>
                          <span class="fa-solid fa-circle-info d-inline-block toggle-immediate" data-toggle="tooltip" data-placement="top" title="可选：用于功能影像与解剖影像叠加显示。" aria-hidden="true"></span>
                          <input type="file" class="form-control-file" id="nifti-anat">
                        </div>
                      </div>
                      <div class='row justify-content-start'>
                        <div class="form-group ml-1">
                          <label for="nifti-mask" class="d-inline-block text-secondary">Brain Mask File (.nii, .nii.gz, optional)</label>
                          <i class="fa-solid fa-triangle-exclamation" id="nifti-mask-error" style="color: #e93407; display: none;"></i>
                          <span class="fa-solid fa-circle-info d-inline-block toggle-immediate" data-toggle="tooltip" data-placement="top" title="可选：用于限制脑组织范围，便于更清晰地显示有效体素。" aria-hidden="true"></span>
                          <input type="file" class="form-control-file" id="nifti-mask">
                        </div>
                        <div class="alert alert-warning alert-dismissible fade show" role="alert">
                          <div class="fa fa-exclamation-triangle d-inline-block"></div>
                          <div class="d-inline-block">比赛版建议同时上传 Brain Mask 以启用更完整的预处理与分析能力</div>
                          <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="tab-pane fade" id="gifti" role="tabpanel" aria-labelledby="gifti-tab">
                  <div class='card'>
                    <div class="card-header">
                      <h5 class="card-title">Gifti 文件</h5>
                    </div>
                    <div class='card-body'>
                      <div class='row justify-content-start'>
                        <div class='col pl-0'>
                          <p class="pl-2 mt-0 mb-1"><strong>Left Hemisphere Files</strong></p>
                          <div class='row'>
                            <div class="form-group pl-4">
                              <label for="left-hemisphere-gifti-func" class="text-secondary">Functional File (func.gii)</label>
                              <i class="fa-solid fa-triangle-exclamation" id="left-hemisphere-gifti-func-error" style="color: #e93407; display: none;"></i>
                              <input type="file" class="form-control-file" id="left-hemisphere-gifti-func">
                            </div>
                          </div>
                          <div class='row'>
                            <div class="form-group pl-4">
                              <label for="left-hemisphere-gifti-mesh" class="text-secondary">Surface Geometry File (surf.gii)</label>
                              <i class="fa-solid fa-triangle-exclamation" id="left-hemisphere-gifti-mesh-error" style="color: #e93407; display: none;"></i>
                              <span class="fa-solid fa-circle-info d-inline-block toggle-immediate" data-toggle="tooltip" data-placement="top" title="左半球表面几何文件，用于 3D 脑表面展示。" aria-hidden="true"></span>
                              <input type="file" class="form-control-file" id="left-hemisphere-gifti-mesh">
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class='row justify-content-start mt-3'>
                        <div class='col pl-0'>
                          <p class="pl-2 mt-0 mb-1"><strong>Right Hemisphere Files</strong></p>
                          <div class='row'>
                            <div class="form-group pl-4">
                              <label for="right-hemisphere-gifti-func" class="text-secondary">Functional File (func.gii)</label>
                              <i class="fa-solid fa-triangle-exclamation" id="right-hemisphere-gifti-func-error" style="color: #e93407; display: none;"></i>
                              <input type="file" class="form-control-file" id="right-hemisphere-gifti-func">
                            </div>
                          </div>
                          <div class='row'>
                            <div class="form-group pl-4">
                              <label for="right-hemisphere-gifti-mesh" class="text-secondary">Surface Geometry File (surf.gii)</label>
                              <i class="fa-solid fa-triangle-exclamation" id="right-hemisphere-gifti-mesh-error" style="color: #e93407; display: none;"></i>
                              <span class="fa-solid fa-circle-info d-inline-block toggle-immediate" data-toggle="tooltip" data-placement="top" title="右半球表面几何文件，用于 3D 脑表面展示。" aria-hidden="true"></span>
                              <input type="file" class="form-control-file" id="right-hemisphere-gifti-mesh">
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div id="error-message-upload" class="alert alert-danger" role='alert' style="display: none;"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-dismiss="modal">关闭</button>
              <button type="submit" class="btn btn-primary" id='submit-file' data-dismiss="static">上传并可视化</button>
            </div>
          </form>
        </div>
      </div>
    </div>
    <div class="modal fade" id="error-scene-modal" tabindex="-1" role="dialog" aria-labelledby="error-scene-modal-label" aria-hidden="true">
      <div class="modal-dialog" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="error-scene-modal-label">场景文件上传失败</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          <div class="modal-body">
            <div class="alert alert-danger" role="alert">
              场景文件上传失败，请确认该场景文件来自同版本的可视化工作台并由“保存场景”功能导出。
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">关闭</button>
          </div>
        </div>
      </div>
    </div>
</div>
'@

$fileUploader = @'
import { DOM_IDS } from '../constants/DomIds.js';
import { API_ENDPOINTS } from '../constants/APIEndpoints.js';
import NiftiFileManager from './components/NiftiFileManager.js';
import GiftiFileManager from './components/GiftiFileManager.js';
import UploadScene from './components/UploadScene.js';
import UploadErrorHandler from './UploadErrorHandler.js';
import Spinner from '../Spinner.js';

class FileUploader {
	constructor(onUploadComplete) {
		this.onUploadComplete = onUploadComplete;
		this.uploadModal = $(`#${DOM_IDS.FILE_UPLOAD.MODAL}`);
		this.submitButton = $(`#${DOM_IDS.FILE_UPLOAD.SUBMIT_BUTTON}`);
		this.errorHandler = new UploadErrorHandler(
			DOM_IDS.FILE_UPLOAD.ERROR_MESSAGE,
			DOM_IDS.FILE_UPLOAD.ERROR_MODAL_SERVER,
			DOM_IDS.FILE_UPLOAD.ERROR_MODAL_SCENE
		);
		this.spinner = new Spinner(
			DOM_IDS.FILE_UPLOAD.SPINNERS.OVERLAY,
			DOM_IDS.FILE_UPLOAD.SPINNERS.WHEEL
		);

		this.niftiFileManager = new NiftiFileManager(
			DOM_IDS.FILE_UPLOAD.FMRI.NIFTI.FUNC,
			DOM_IDS.FILE_UPLOAD.FMRI.NIFTI.ANAT,
			DOM_IDS.FILE_UPLOAD.FMRI.NIFTI.MASK,
		);

		this.giftiFileManager = new GiftiFileManager(
			DOM_IDS.FILE_UPLOAD.FMRI.GIFTI.LEFT_FUNC,
			DOM_IDS.FILE_UPLOAD.FMRI.GIFTI.RIGHT_FUNC,
			DOM_IDS.FILE_UPLOAD.FMRI.GIFTI.LEFT_MESH,
			DOM_IDS.FILE_UPLOAD.FMRI.GIFTI.RIGHT_MESH
		);

		this.sceneFileUploader = new UploadScene(
			DOM_IDS.FILE_UPLOAD.SCENE.BUTTON,
			DOM_IDS.FILE_UPLOAD.SCENE.FILE,
			this.spinner,
			this.errorHandler
		);

		this.initializeModalListeners();
	}

	async uploadFiles(event, fmriFileType) {
		this.spinner.show();
		try {
			const uploadData = this.getFiles();
			uploadData.append('fmri_file_type', fmriFileType);
			const response = await fetch(API_ENDPOINTS.UPLOAD.FILES, {
				method: 'POST',
				body: uploadData
			});

			if (response.ok) {
				const data = await response.json();
				document.getElementById(DOM_IDS.FMRI.VISUALIZATION_CONTAINER).style.display = 'block';
				this.onUploadComplete(data.file_type);
				this.uploadModal.modal('hide');
			} else if (response.status === 400) {
				await this.errorHandler.handleServerError(response, fmriFileType);
			} else {
				this.errorHandler.showServerErrorModal();
			}
		} catch (error) {
			console.error('Unexpected error during file upload:', error);
			this.errorHandler.showServerErrorModal();
		} finally {
			this.spinner.hide();
		}
	}

	async uploadSceneFile(event) {
		const data = await this.sceneFileUploader.uploadFile(event);
		if (data) {
			document.getElementById(DOM_IDS.FMRI.VISUALIZATION_CONTAINER).style.display = 'block';
			this.onUploadComplete(data.file_type);
			this.uploadModal.modal('hide');
		}
	}

	clearfMRIFiles(fmriType) {
		if (fmriType === 'nifti') {
			this.niftiFileManager.clearFiles();
		} else if (fmriType === 'gifti') {
			this.giftiFileManager.clearFiles();
		}
	}

	getFiles() {
		const masterFormData = new FormData();
		const niftiData = this.niftiFileManager.getFiles();
		const giftiData = this.giftiFileManager.getFiles();

		Object.entries(niftiData).forEach(([key, value]) => {
			masterFormData.append(key, value);
		});

		Object.entries(giftiData).forEach(([key, value]) => {
			masterFormData.append(key, value);
		});

		masterFormData.append('ts_input', false);
		masterFormData.append('task_input', false);

		return masterFormData;
	}

	initializeModalListeners() {
		const self = this;

		this.submitButton.on('click', async (event) => {
			event.preventDefault();
			const activeTab = document.querySelector('.nav-pills .active').getAttribute('href');
			const fmriFileType = activeTab === '#gifti' ? 'gifti' : 'nifti';
			this.uploadFiles(event, fmriFileType);
		});

		document.querySelectorAll('.nav-pills .nav-link').forEach(tab => {
			tab.addEventListener('click', function () {
				document.getElementById(DOM_IDS.FILE_UPLOAD.ERROR_MESSAGE).style.display = 'none';
				const activeTab = document.querySelector('.nav-pills .active').getAttribute('href');
				const fileType = activeTab === '#gifti' ? 'gifti' : 'nifti';
				self.clearfMRIFiles(fileType);
			});
		});

		const sceneFileDiv = document.getElementById(DOM_IDS.FILE_UPLOAD.SCENE.FILE);
		sceneFileDiv.addEventListener('change', (event) => {
			this.uploadSceneFile(event);
		});

		this.uploadModal.on('hidden.bs.modal', function () {
			document.getElementById(DOM_IDS.FILE_UPLOAD.ERROR_MESSAGE).style.display = 'none';
		});

		this.uploadModal.on('shown.bs.modal', (evt) => {
			evt.target.setAttribute('data-cy', 'modal');
		});

		this.uploadModal.on('hidden.bs.modal', (evt) => {
			evt.target.removeAttribute('data-cy');
		});
	}
}

export default FileUploader;
'@

$customStyles = @'

/* SmartBrainMap Competition Overrides */
.jumbotron {
  background: linear-gradient(135deg, #e8f1ff 0%, #ffffff 100%);
  border: 1px solid rgba(147, 197, 253, 0.55);
  border-radius: 28px;
  text-align: center;
  padding: 4rem 2rem;
  box-shadow: 0 20px 45px rgba(37, 99, 235, 0.08);
}

.jumbotron img {
  display: none;
}

.brand-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 0.95rem;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.1);
  color: #1d4ed8;
  font-size: 0.95rem;
  font-weight: 700;
  margin-bottom: 1rem;
}

.jumbotron h1 {
  font-size: 2.5rem;
  font-weight: 800;
  color: #0f172a;
}

.jumbotron p {
  font-size: 1.1rem;
  color: #64748b;
}
'@

$index = Get-Content $indexPath -Raw -Encoding UTF8
$index = $index.Replace('<title>FIND Viewer</title>', '<title>智绘脑图 · 脑影像可视化</title>')
Set-Content -Path $indexPath -Value $index -Encoding UTF8

$analysis = Get-Content $analysisPath -Raw -Encoding UTF8
$analysis = $analysis.Replace('<title>FIND Viewer</title>', '<title>智绘脑图 · 脑影像可视化</title>')
Set-Content -Path $analysisPath -Value $analysis -Encoding UTF8

$styles = Get-Content $stylesPath -Raw -Encoding UTF8
if (-not $styles.Contains('SmartBrainMap Competition Overrides')) {
    $styles += $customStyles
}
Set-Content -Path $stylesPath -Value $styles -Encoding UTF8

Set-Content -Path $uploadModalPath -Value $uploadModal -Encoding UTF8
Set-Content -Path $fileUploaderPath -Value $fileUploader -Encoding UTF8

Write-Output 'Updated findviz files:'
Write-Output $uploadModalPath
Write-Output $fileUploaderPath
Write-Output $indexPath
Write-Output $analysisPath
Write-Output $stylesPath
