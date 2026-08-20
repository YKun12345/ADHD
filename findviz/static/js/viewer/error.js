// error.js
// Error handling for viewer

import { LogDisplay } from '../log.js';

export class ErrorHandler {
    constructor(
        modalId = 'error-viewer-modal',
        modalTextId = 'error-viewer-modal-message'
    ) {
        this.modalId = modalId;
        this.modalTextId = modalTextId;
        this.logDisplay = new LogDisplay(
            'toggle-error-viewer-log-btn',
            'error-viewer-log-container',
            'error-viewer-log-content',
            'error-viewer-log-status',
            'copy-error-viewer-log-btn'
        );
        this.activeErrors = [];
        this.contextId = null;
        this.eventsBound = false;
        this.refreshElements();
        this.initializeModalEvents();
    }

    refreshElements() {
        this.errorDiv = document.getElementById(this.modalId);
        this.errorTextDiv = document.getElementById(this.modalTextId);
        this.logDisplay.refreshElements();
    }

    initializeModalEvents() {
        this.refreshElements();
        if (
            this.eventsBound ||
            !this.errorDiv ||
            !this.errorTextDiv ||
            !this.logDisplay.logToggleButton ||
            !this.logDisplay.copyLogButton
        ) {
            return;
        }

        $(`#${this.modalId}`).on('hidden.bs.modal', () => {
            this.clearErrors();
            this.logDisplay.hideLogContainer();
        });

        this.logDisplay.logToggleButton.addEventListener('click', () => {
            this.logDisplay.toggleLogDisplay();
        });

        this.logDisplay.copyLogButton.addEventListener('click', () => {
            this.logDisplay.copyLogToClipboard();
        });

        this.eventsBound = true;
    }

    displayError(errorMessage) {
        this.initializeModalEvents();
        this.refreshElements();

        if (!this.errorDiv || !this.errorTextDiv) {
            console.error('Viewer error modal is not available:', errorMessage);
            return;
        }

        this.activeErrors.push(errorMessage);
        const formattedErrors = this.activeErrors
            .map((msg) => `- ${msg}`)
            .join('<br>');

        this.errorTextDiv.innerHTML = formattedErrors;
        this.errorDiv.style.display = 'block';
        $(`#${this.modalId}`).modal('show');

        this.logDisplay.logData = [];
        this.logDisplay.showLogContainer();
        this.logDisplay.fetchLogs();
    }

    clearErrors() {
        this.refreshElements();
        this.activeErrors = [];

        if (this.errorTextDiv) {
            this.errorTextDiv.innerHTML = '';
        }

        if (this.errorDiv) {
            $(`#${this.modalId}`).modal('hide');
        }
    }

    getErrorCount() {
        return this.activeErrors.length;
    }
}

export function displayInlineError(errorMessage, elementId) {
    const errorDiv = document.getElementById(elementId);
    if (!errorDiv) {
        console.error(`Inline error element not found: ${elementId}`, errorMessage);
        return;
    }
    errorDiv.textContent = errorMessage;
    errorDiv.style.display = 'block';
}

export function clearInlineError(elementId) {
    const errorDiv = document.getElementById(elementId);
    if (!errorDiv) {
        return;
    }
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
}

export const modalErrorHandler = new ErrorHandler();
