from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from backend.app.core.config import settings
from backend.app.services.hgst_runtime import service as hgst


def _sample_1d_bytes() -> bytes:
    """90 ROI × 12 时间点的合法 .1D 文本。"""
    rows, cols = 12, 90
    t = np.linspace(0.0, 6.0, rows)[:, None]
    x = np.sin(t + np.arange(cols)[None, :])
    text = "\n".join(" ".join(f"{v:.4f}" for v in row) for row in x)
    return text.encode("ascii")


def _boom_raiser(*_args, **_kwargs):
    raise hgst.HGSTUnavailableError("deps not installed")


class TestModeResolution:
    def test_default_and_false_map_to_real(self, monkeypatch) -> None:
        for token in ("", "false", "0", "no", "off", "real", "strict"):
            monkeypatch.setattr(settings, "USE_MOCK_MODEL", token)
            assert hgst.resolve_inference_mode() == "real", token

    def test_true_tokens_map_to_mock(self, monkeypatch) -> None:
        for token in ("true", "1", "yes", "on", "mock"):
            monkeypatch.setattr(settings, "USE_MOCK_MODEL", token)
            assert hgst.resolve_inference_mode() == "mock", token

    def test_auto_token(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "USE_MOCK_MODEL", "auto")
        assert hgst.resolve_inference_mode() == "auto"


class TestPredictWithMode:
    def test_forced_mock_returns_demo_without_calling_real(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "USE_MOCK_MODEL", "true")
        monkeypatch.setattr(hgst, "predict_timeseries_file", _boom_raiser)

        result = hgst.predict_with_mode(_sample_1d_bytes(), "sample.1D")

        assert result.source_type == "mock"
        assert result.prediction_label in {"ADHD", "Control"}
        assert 0.0 < result.probability < 1.0
        assert result.roi_dim_used == 90 and result.timepoints == 12

    def test_auto_degrades_to_mock_when_real_unavailable(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "USE_MOCK_MODEL", "auto")
        monkeypatch.setattr(hgst, "predict_timeseries_file", _boom_raiser)

        result = hgst.predict_with_mode(_sample_1d_bytes(), "sample.1D")

        assert result.source_type == "mock"

    def test_real_mode_does_not_silently_degrade(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "USE_MOCK_MODEL", "")
        monkeypatch.setattr(hgst, "predict_timeseries_file", _boom_raiser)

        with pytest.raises(hgst.HGSTUnavailableError):
            hgst.predict_with_mode(_sample_1d_bytes(), "sample.1D")

    def test_invalid_content_is_422_error_even_in_mock(self, monkeypatch) -> None:
        monkeypatch.setattr(settings, "USE_MOCK_MODEL", "true")
        garbage = b"not a numeric timeseries at all\n"  # 无法解析出有效数值矩阵
        with pytest.raises(hgst.HGSTInferenceError):
            hgst.predict_with_mode(garbage, "bad.1D")


def test_deployment_bundle_default_lives_under_backend_models() -> None:
    bundle = Path(settings.HGST_DEPLOYMENT_BUNDLE_PATH)
    assert bundle.name == "hgst_adhd_bundle.pt"
    assert "models" in bundle.parts
