import argparse
import csv
from collections import Counter
from pathlib import Path

import pandas as pd


SKIP_SITE_NAMES = {"templates"}


def normalize_subject_id(raw_value: str) -> str:
    text = str(raw_value).strip()
    digits_only = "".join(ch for ch in text if ch.isdigit())
    if not digits_only:
        raise ValueError(f"Could not extract digits from subject folder name: {raw_value}")
    return digits_only.zfill(7)


def _rank_candidate(file_path: Path, subject_id: str) -> tuple[int, str]:
    name = file_path.name
    preferred_names = [
        f"sfnwmrda{subject_id}_session_1_rest_1_aal_TCs.1D",
        f"snwmrda{subject_id}_session_1_rest_1_aal_TCs.1D",
    ]
    if name == preferred_names[0]:
        return (0, name)
    if name == preferred_names[1]:
        return (1, name)
    if "session_1_rest_1_aal_TCs" in name and name.endswith(".1D"):
        return (2, name)
    if "rest_1" in name and "aal_TCs" in name and name.endswith(".1D"):
        return (3, name)
    return (4, name)


def find_best_timeseries_file(subject_dir: Path, subject_id: str) -> Path | None:
    candidates = [path for path in subject_dir.glob("*.1D") if path.is_file()]
    if not candidates:
        return None
    candidates.sort(key=lambda path: _rank_candidate(path, subject_id))
    return candidates[0]


def list_candidate_timeseries_files(subject_dir: Path, subject_id: str) -> list[Path]:
    candidates = [path for path in subject_dir.glob("*.1D") if path.is_file()]
    candidates.sort(key=lambda path: _rank_candidate(path, subject_id))
    return candidates


def _parse_numeric_tokens(line: str) -> list[float]:
    values: list[float] = []
    for token in line.strip().split():
        try:
            values.append(float(token))
        except ValueError:
            continue
    return values


def load_numeric_timeseries(source_file: Path) -> pd.DataFrame:
    if source_file.stat().st_size == 0:
        raise ValueError(f"Source file is empty: {source_file}")

    candidate_rows: list[list[float]] = []
    for line in source_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        numeric_tokens = _parse_numeric_tokens(line)
        if len(numeric_tokens) >= 90:
            candidate_rows.append(numeric_tokens)

    if not candidate_rows:
        raise ValueError(f"Could not extract a numeric ROI matrix from {source_file}")

    row_lengths = [len(row) for row in candidate_rows]
    common_length = Counter(row_lengths).most_common(1)[0][0]

    if common_length in (116, 117) or common_length > 116:
        target_dim = 116
    elif common_length in (90, 91) or common_length > 90:
        target_dim = 90
    else:
        raise ValueError(
            f"Unexpected numeric token counts in {source_file}: {sorted(set(row_lengths))}"
        )

    roi_rows = [row[-target_dim:] for row in candidate_rows if len(row) >= target_dim]
    if not roi_rows:
        raise ValueError(f"Could not extract trailing ROI columns from {source_file}")

    roi_df = pd.DataFrame(roi_rows, dtype=float)
    if roi_df.isna().any().any():
        raise ValueError(f"ROI matrix still contains NaN values after cleanup: {source_file}")

    return roi_df


def crop_roi_timeseries(roi_df: pd.DataFrame, target_roi_dim: int) -> pd.DataFrame:
    current_dim = roi_df.shape[1]
    if target_roi_dim == current_dim:
        return roi_df

    if current_dim == 116 and target_roi_dim == 90:
        # Follow the paper's preprocessing description: remove the 26 cerebellar
        # regions from the original AAL-116 parcellation and keep the first 90 ROIs.
        return roi_df.iloc[:, :90].copy()

    if target_roi_dim > current_dim:
        raise ValueError(
            f"Cannot expand ROI dimension from {current_dim} to {target_roi_dim}."
        )

    raise ValueError(
        f"Unsupported ROI crop: source has {current_dim} columns, target is {target_roi_dim}."
    )


def write_numeric_timeseries(numeric_df: pd.DataFrame, destination_file: Path) -> None:
    destination_file.parent.mkdir(parents=True, exist_ok=True)
    numeric_df.to_csv(destination_file, sep=" ", header=False, index=False, float_format="%.10f")


def collect_subject_dirs(source_root: Path) -> list[tuple[str, Path, str]]:
    subject_dirs: list[tuple[str, Path, str]] = []
    for site_dir in sorted(source_root.iterdir()):
        if not site_dir.is_dir():
            continue
        if site_dir.name.lower() in SKIP_SITE_NAMES:
            continue
        for subject_dir in sorted(site_dir.iterdir()):
            if not subject_dir.is_dir():
                continue
            try:
                subject_id = normalize_subject_id(subject_dir.name)
            except ValueError:
                continue
            subject_dirs.append((site_dir.name, subject_dir, subject_id))
    return subject_dirs


def copy_subject_timeseries(
    source_root: Path,
    output_root: Path,
    output_subdir: str = "ADHD_all_new",
    target_roi_dim: int = 90,
    overwrite: bool = False,
    dry_run: bool = False,
) -> tuple[int, int, int]:
    adhd_all_dir = output_root / output_subdir
    manifest_path = output_root / f"adhd200_aal_manifest_{output_subdir}.csv"

    seen_subjects: dict[str, Path] = {}
    copied_rows: list[dict[str, str]] = []
    copied_count = 0
    skipped_count = 0
    missing_count = 0

    subject_dirs = collect_subject_dirs(source_root)
    if not dry_run:
        adhd_all_dir.mkdir(parents=True, exist_ok=True)

    for site_name, subject_dir, subject_id in subject_dirs:
        if subject_id in seen_subjects:
            print(
                f"[skip-duplicate] subject {subject_id} already collected from "
                f"{seen_subjects[subject_id]}, skipping {subject_dir}"
            )
            skipped_count += 1
            continue

        candidate_files = list_candidate_timeseries_files(subject_dir, subject_id)
        if not candidate_files:
            print(f"[missing] no .1D file found for subject {subject_id} under {subject_dir}")
            missing_count += 1
            continue

        source_file = None
        numeric_df = None
        last_error = None
        for candidate_file in candidate_files:
            try:
                numeric_df = load_numeric_timeseries(candidate_file)
                source_file = candidate_file
                break
            except ValueError as exc:
                last_error = exc
                print(f"[skip-unparseable] {candidate_file} ({exc})")

        if source_file is None or numeric_df is None:
            print(f"[missing-usable] no parsable .1D file found for subject {subject_id} under {subject_dir}")
            if last_error is not None:
                print(f"[last-error] {last_error}")
            missing_count += 1
            continue

        destination_dir = adhd_all_dir / subject_id
        destination_file = destination_dir / f"sfnwmrda{subject_id}_session_1_rest_1_aal_TCs.1D"

        if destination_file.exists() and not overwrite:
            print(f"[skip-existing] {destination_file}")
            skipped_count += 1
            seen_subjects[subject_id] = subject_dir
            continue

        print(f"[copy] {source_file} -> {destination_file}")
        if not dry_run:
            cropped_df = crop_roi_timeseries(numeric_df, target_roi_dim)
            write_numeric_timeseries(cropped_df, destination_file)

        copied_rows.append(
            {
                "subject_id": subject_id,
                "site": site_name,
                "source_subject_dir": str(subject_dir),
                "source_file": str(source_file),
                "destination_file": str(destination_file),
                "output_subdir": output_subdir,
                "target_roi_dim": str(target_roi_dim),
            }
        )
        seen_subjects[subject_id] = subject_dir
        copied_count += 1

    if not dry_run and copied_rows:
        with manifest_path.open("w", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(
                csvfile,
                fieldnames=[
                    "subject_id",
                    "site",
                    "source_subject_dir",
                    "source_file",
                    "destination_file",
                    "output_subdir",
                    "target_roi_dim",
                ],
            )
            writer.writeheader()
            writer.writerows(copied_rows)
        print(f"[manifest] wrote {manifest_path}")

    return copied_count, skipped_count, missing_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect ADHD-200 AAL .1D files from multiple site folders into HGST layout."
    )
    parser.add_argument(
        "--source-root",
        type=Path,
        required=True,
        help="Root directory containing site folders such as KKI, NYU, Peking_1, WashU.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        required=True,
        help="Target root directory. The script will create ADHD_all_new under this directory by default.",
    )
    parser.add_argument(
        "--output-subdir",
        type=str,
        default="ADHD_all_new",
        help="Output subdirectory name under output-root.",
    )
    parser.add_argument(
        "--target-roi-dim",
        type=int,
        default=90,
        choices=[90, 116],
        help="Target number of ROI columns to write. Default 90 to match the paper setting.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite destination files if they already exist.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview the copy plan without writing files.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_root = args.source_root.expanduser().resolve()
    output_root = args.output_root.expanduser().resolve()

    if not source_root.exists():
        raise FileNotFoundError(f"Source root does not exist: {source_root}")

    copied_count, skipped_count, missing_count = copy_subject_timeseries(
        source_root=source_root,
        output_root=output_root,
        output_subdir=args.output_subdir,
        target_roi_dim=args.target_roi_dim,
        overwrite=args.overwrite,
        dry_run=args.dry_run,
    )
    print(
        "[done] "
        f"copied={copied_count}, skipped={skipped_count}, missing={missing_count}, "
        f"output={output_root / args.output_subdir}"
    )


if __name__ == "__main__":
    main()
