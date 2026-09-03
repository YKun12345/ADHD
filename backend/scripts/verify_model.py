#!/usr/bin/env python
"""验证真实 HGST 模型集成链路（模型文件、可加载、可推理）与当前推理模式。

用法（在仓库根执行）::

    python scripts/verify_model.py                  # 按 USE_MOCK_MODEL 语义校验
    python scripts/verify_model.py --mode auto      # 临时覆盖模式跑一次
    python -m backend.scripts.verify_model          # 等价模块式

它会：
  1. 打印当前推理模式（USE_MOCK_MODEL -> real/mock/auto）与模型文件路径；
  2. 检查真实依赖 torch/dhg 是否可导入、部署权重 hgst_adhd_bundle.pt 是否存在；
  3. 用一段合成的 90-ROI 时间序列做一次端到端试推理（predict_with_mode），打印
     label / 概率 / source_type / model_name，并按模式给出结论。

退出码：
  0  当前配置下链路可用（含 auto/mock 模式的明确演示结果）
  1  发生未预期错误
  2  真实模式（real）必需项缺失：torch/dhg 依赖或模型权重文件不存在
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

from backend.app.core.config import settings

MODE_LABEL = {"real": "真实推理（缺依赖/权重时返回 503，不降级）",
              "mock": "恒演示 Mock（真上传假结果，is_demo=true）",
              "auto": "真实优先，HGST 不可用时自动降级为带标识 Mock"}


def _synthetic_timeseries_bytes() -> bytes:
    """90 个 ROI × 16 个时间点的合法 .1D 文本（ASCII），用于试推理。"""
    import numpy as np

    rows, cols = 16, 90
    t = np.linspace(0.0, 6 * np.pi, rows)[:, None]
    x = np.sin(t + np.arange(cols)[None, :] * 0.5) * (1.0 + 0.01 * np.arange(cols))
    text = "\n".join(" ".join(f"{v:.5f}" for v in row) for row in x)
    return text.encode("ascii")


def _check_dependencies() -> tuple[bool, list[str]]:
    missing: list[str] = []
    for name in ("torch", "dhg"):
        try:
            importlib.import_module(name)
        except ModuleNotFoundError:
            missing.append(name)
    return (not missing), missing


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=sorted(MODE_LABEL), default=None,
                        help="临时覆盖推理模式（仅本次运行，不改配置）")
    args = parser.parse_args(argv)

    # 解析/覆盖模式
    from backend.app.services.hgst_runtime.service import (
        HGSTBundleMissingError,
        HGSTInferenceError,
        HGSTUnavailableError,
        _bundle_path,
        predict_with_mode,
        resolve_inference_mode,
    )

    effective_mode = args.mode or resolve_inference_mode()
    if args.mode and args.mode != resolve_inference_mode():
        print(f"[覆盖] 临时以 --mode {args.mode} 校验（设置 USE_MOCK_MODEL={args.mode}）")
        settings.USE_MOCK_MODEL = args.mode
        effective_mode = args.mode

    bundle = _bundle_path()
    deps_ok, missing_deps = _check_dependencies()

    print("=" * 64)
    print(f"推理模式        : {effective_mode}")
    print(f"模式语义        : {MODE_LABEL[effective_mode]}")
    print(f"模型文件        : {bundle}")
    print(f"模型文件存在    : {'是' if bundle.exists() else '否'}")
    print(f"真实依赖(torch/dhg): {'齐全' if deps_ok else '缺失: ' + ', '.join(missing_deps)}")
    print("-" * 64)

    missing_requirements: list[str] = []
    if not deps_ok:
        missing_requirements.append("缺少 torch/dhg 依赖（请按 requirements-hgst.txt 安装；注意 torch 1.13 / dhg 0.9.5 需 Python<=3.10）")
    if not bundle.exists():
        missing_requirements.append(f"未找到模型权重：{bundle}（真实模型需放置该文件，或用 build_hgst_bundle.py 生成）")

    if missing_requirements and effective_mode == "real":
        for item in missing_requirements:
            print(f"[ERROR] {item}")
        print("[说明] 当前为默认真实模式且真实链路不完备。答辩/联调可设 USE_MOCK_MODEL=true 或 auto，"
              "或把模型放到上述路径后重试。")
        return 2

    try:
        result = predict_with_mode(_synthetic_timeseries_bytes(), "verify_model_sample.1D")
    except HGSTUnavailableError as exc:
        print(f"[ERROR] 真实 HGST 依赖缺失：{exc}")
        print("[说明] 请安装 requirements-hgst.txt（torch+dhg，需 Python<=3.10）；演示可设 USE_MOCK_MODEL=true/auto。")
        return 2
    except HGSTBundleMissingError as exc:
        print(f"[ERROR] 真实模型权重缺失：{exc}")
        print("[说明] 请将 hgst_adhd_bundle.pt 放到模型目录；演示可设 USE_MOCK_MODEL=true/auto。")
        return 2
    except HGSTInferenceError as exc:
        print(f"[ERROR] 推理输入校验失败（试推理样例异常）：{exc}")
        return 1
    except Exception as exc:  # pragma: no cover - 未预期错误
        print(f"[ERROR] 未预期错误：{exc!r}")
        return 1

    is_demo = result.source_type == "mock"
    print("-" * 64)
    print(f"试推理通过      : source_type={result.source_type}  is_demo={is_demo}")
    print(f"label           : {result.prediction_label}")
    print(f"ADHD 概率       : {result.probability:.4f}  Control 概率: {result.probability_control:.4f}")
    print(f"模型/版本       : {result.model_name} / {result.model_version}")
    print(f"ROI x 时间点    : {result.roi_dim_used} x {result.timepoints}")
    print("=" * 64)

    if is_demo:
        print("[结论] 当前输出为演示 Mock（带明确 is_demo 标识，不构成医学诊断）。")
    else:
        print("[结论] 当前输出为真实 HGST 推理（Screening support only）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
