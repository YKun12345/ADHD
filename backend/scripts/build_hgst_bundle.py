from __future__ import annotations

import argparse
from pathlib import Path

from backend.app.core.config import settings
from backend.app.services.hgst_runtime.service import build_hgst_deployment_bundle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build an HGST deployment bundle inside the current project.")
    parser.add_argument("--data-dir", type=Path, default=Path(settings.HGST_DEFAULT_DATA_DIR) if settings.HGST_DEFAULT_DATA_DIR else None)
    parser.add_argument("--labels-path", type=Path, default=Path(settings.HGST_DEFAULT_LABELS_PATH) if settings.HGST_DEFAULT_LABELS_PATH else None)
    parser.add_argument("--pretrained", type=Path, default=Path(settings.HGST_PRETRAINED_WEIGHTS_PATH))
    parser.add_argument("--output", type=Path, default=Path(settings.HGST_DEPLOYMENT_BUNDLE_PATH))
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--seed", type=int, default=2020)
    parser.add_argument("--train-on-full-dataset", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.data_dir is None or args.labels_path is None:
        raise SystemExit("Please provide --data-dir and --labels-path, or set HGST_DEFAULT_DATA_DIR / HGST_DEFAULT_LABELS_PATH.")

    output_path = build_hgst_deployment_bundle(
        data_dir=args.data_dir,
        labels_path=args.labels_path,
        pretrained_weights_path=args.pretrained,
        output_path=args.output,
        max_epoch_f=args.epochs,
        seed=args.seed,
        train_on_full_dataset=args.train_on_full_dataset,
    )
    print(f"HGST deployment bundle saved to: {output_path}")


if __name__ == "__main__":
    main()
