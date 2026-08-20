// log.js
// Utility class for displaying logs in the viewer

export class LogDisplay {
    constructor(
        logToggleButtonId,
        logContainerId,
        logContentId,
        logStatusId,
        copyLogButtonId
    ) {
        this.logToggleButtonId = logToggleButtonId;
        this.logContainerId = logContainerId;
        this.logContentId = logContentId;
        this.logStatusId = logStatusId;
        this.copyLogButtonId = copyLogButtonId;
        this.logData = [];
        this.refreshElements();
    }

    refreshElements() {
        this.logToggleButton = document.getElementById(this.logToggleButtonId);
        this.logContainer = document.getElementById(this.logContainerId);
        this.logContent = document.getElementById(this.logContentId);
        this.logStatus = document.getElementById(this.logStatusId);
        this.copyLogButton = document.getElementById(this.copyLogButtonId);
    }

    toggleLogDisplay() {
        this.refreshElements();
        if (!this.logContainer) {
            return;
        }

        if (this.logContainer.classList.contains('d-none')) {
            this.showLogContainer();
        } else {
            this.hideLogContainer();
        }
    }

    showLogContainer() {
        this.refreshElements();
        if (!this.logContainer || !this.copyLogButton || !this.logToggleButton) {
            return;
        }

        this.logContainer.classList.remove('d-none');
        this.copyLogButton.classList.remove('d-none');
        this.logToggleButton.textContent = '隐藏错误日志';

        if (this.logData.length === 0) {
            this.fetchLogs();
        }
    }

    hideLogContainer() {
        this.refreshElements();
        if (!this.logContainer || !this.copyLogButton || !this.logToggleButton) {
            return;
        }

        this.logContainer.classList.add('d-none');
        this.copyLogButton.classList.add('d-none');
        this.logToggleButton.textContent = '查看错误日志';
    }

    fetchLogs() {
        this.refreshElements();
        if (!this.logStatus || !this.logContent) {
            return;
        }

        this.logStatus.textContent = '正在获取错误日志...';
        this.logStatus.classList.remove('d-none');

        const basePath = window.FINDVIZ_BASE_PATH || '';
        const url = `${basePath}/get_log_entries`;

        fetch(url)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch logs: ${response.status} ${response.statusText}`);
                }
                return response.json();
            })
            .then((data) => {
                this.logData = data;
                this.renderLogs();
                this.logStatus.classList.add('d-none');
            })
            .catch((error) => {
                if (this.logContent) {
                    this.logContent.innerHTML = `<div class="text-danger">获取错误日志失败：${error.message}</div>`;
                }
                if (this.logStatus) {
                    this.logStatus.classList.add('d-none');
                }
            });
    }

    renderLogs() {
        this.refreshElements();
        if (!this.logContent) {
            return;
        }

        if (!this.logData || this.logData.length === 0) {
            this.logContent.innerHTML = '<div class="text-info">当前没有可显示的错误日志。</div>';
            return;
        }

        const logHtml = this.logData.map((log) => {
            let levelClass = '';
            switch (log.level) {
                case 'CRITICAL':
                case 'ERROR':
                    levelClass = 'text-danger';
                    break;
                case 'WARNING':
                    levelClass = 'text-warning';
                    break;
                case 'INFO':
                    levelClass = 'text-info';
                    break;
                case 'DEBUG':
                    levelClass = 'text-secondary';
                    break;
                default:
                    levelClass = 'text-light';
            }

            const timestamp = new Date(log.timestamp).toLocaleString();
            return `<div class="log-entry mb-1">
                <span class="log-timestamp text-muted">${timestamp}</span>
                <span class="log-level ${levelClass}">[${log.level}]</span>
                <span class="log-source text-primary">${log.source}</span>
                <span class="log-message">${this.formatLogMessage(log.message)}</span>
            </div>`;
        }).join('');

        this.logContent.innerHTML = logHtml;
        this.logContent.scrollTop = this.logContent.scrollHeight;
    }

    formatLogMessage(message) {
        const escapedMessage = this.escapeHtml(message);
        return escapedMessage
            .replace(/Error/g, '<span class="text-danger">Error</span>')
            .replace(/Exception/g, '<span class="text-danger">Exception</span>')
            .replace(/Warning/g, '<span class="text-warning">Warning</span>')
            .replace(/(File ".+?", line \\d+)/, '<span class="text-info">$1</span>');
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    copyLogToClipboard() {
        this.refreshElements();
        if (!this.copyLogButton) {
            return;
        }

        const plainText = this.logData.map((log) => {
            const timestamp = new Date(log.timestamp).toLocaleString();
            return `${timestamp} [${log.level}] ${log.source}: ${log.message}`;
        }).join('\n');

        navigator.clipboard.writeText(plainText)
            .then(() => {
                const originalText = this.copyLogButton.textContent;
                this.copyLogButton.textContent = '已复制';
                setTimeout(() => {
                    if (this.copyLogButton) {
                        this.copyLogButton.textContent = originalText;
                    }
                }, 2000);
            })
            .catch((error) => {
                console.error('Failed to copy logs to clipboard:', error);
            });
    }
}
