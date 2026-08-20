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
