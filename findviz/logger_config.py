import logging
import os
from pathlib import Path
import time
import ast
import hashlib
import re
from functools import lru_cache
from findviz.workspace import current_workspace


@lru_cache(maxsize=128)
def _literal_diagnostics(filename):
    """Only source-code literals are eligible for standalone CLI diagnostic text."""
    source = Path(filename).resolve()
    package = Path(__file__).resolve().parent
    if not source.is_relative_to(package):
        return {}
    try:
        tree = ast.parse(source.read_text(encoding='utf-8-sig'))
    except (OSError, SyntaxError, UnicodeError):
        return {}
    messages = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args or not isinstance(node.func, ast.Attribute):
            continue
        if not isinstance(node.func.value, ast.Name) or node.func.value.id != 'logger':
            continue
        if node.func.attr not in ('debug', 'info', 'warning', 'error', 'critical', 'exception', 'log'):
            continue
        value = node.args[0]
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            messages[node.lineno] = value.value
        elif isinstance(value, ast.JoinedStr) and all(isinstance(part, ast.Constant) for part in value.values):
            messages[node.lineno] = ''.join(str(part.value) for part in value.values)
    return messages


class ClinicalDiagnosticFilter(logging.Filter):
    clinical_redaction = True

    def filter(self, record):
        namespace = current_workspace()
        workspace = hashlib.sha256(namespace.encode()).hexdigest()[:12]
        event = re.sub(r'[^a-zA-Z0-9_.]', '', record.funcName) + ':' + str(record.lineno)
        diagnostic = None
        if namespace == 'standalone-cli':
            diagnostic = _literal_diagnostics(record.pathname).get(record.lineno)
            if diagnostic:
                # Formatting values may contain names, arrays or arbitrary clinical text.
                diagnostic = re.sub(r'%(?:\([^)]*\))?[#0 +\-]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?[hlL]?[diouxXeEfFgGcrsa]', '<redacted>', diagnostic)
        error_type = record.exc_info[0].__name__ if record.exc_info else None
        record.msg = (diagnostic + '; ' if diagnostic else '') + f'event={event}; workspace={workspace}'
        if error_type:
            record.msg += '; exception=' + re.sub(r'[^a-zA-Z0-9_]', '', error_type)
        record.args = ()
        # Tracebacks and cached exception text may quote the original clinical value.
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True

def setup_logger(name=__name__, disable_file_logging=False):
    """
    Logger set up for findviz app
    
    Parameters
    ----------
    name : str
        Logger name
    disable_file_logging : bool
        If True, only console logging will be enabled (useful for testing)
    """
    # Create a logger
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    if not any(getattr(item, "clinical_redaction", False) for item in logger.filters):
        logger.addFilter(ClinicalDiagnosticFilter())
    
    # Prevent duplicate handlers
    if not logger.handlers:
        # Create a formatter
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        # Create a console handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        console_handler.setLevel(logging.DEBUG)
        logger.addHandler(console_handler)

        # Create a file handler if not disabled
        if not disable_file_logging:
            # Get the current working directory and ensure logs directory exists
            current_dir = os.getcwd()
            log_dir = os.path.join(current_dir, 'logs')
            os.makedirs(log_dir, exist_ok=True)
            
            # Create a run-specific log file with timestamp
            run_timestamp = time.strftime("%Y%m%d-%H%M%S")
            log_file_path = os.path.join(log_dir, f'app-run-{run_timestamp}.log')
            
            # Set up a file handler for this run
            file_handler = logging.FileHandler(
                filename=log_file_path,
                encoding='utf-8'
            )
            
            file_handler.setFormatter(formatter)
            file_handler.setLevel(logging.INFO)
            logger.addHandler(file_handler)
    
    return logger