"""Resolve viewer state from the current request, never at module import time."""
from werkzeug.local import LocalProxy
from findviz.viz.viewer.data_manager import DataManager

data_manager = LocalProxy(DataManager)
