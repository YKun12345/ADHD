import argparse
import csv
from pathlib import Path


SKIP_SITE_NAMES = {"templates"}


def normalize_subject_id(raw_value: str) -> str:
    text = str(raw_value).strip()
    digits_only = "".join(ch for ch in text if ch.isdigit())
    if not digits_only:
        raise ValueError(f"Could not extract digits from subject identifier: {raw_value}")
    return digits_only.zfill(7)


def normalize_dx(raw_value: str) -> int:
    text = str(raw_value).strip()
    if text == "":
        raise ValueError("DX value is empty")
    return int(float(text))


def find_site_csv(site_dir: Path) -> Path | None:
    preferred_name = site_dir / f"{site_dir.name}_phenotypic.csv"
    if preferred_name.exists():
        return preferred_name

    csv_files = sorted(path for path in site_dir.glob("*.csv") if path.is_file())
    if not csv_files:
        return None
    return csv_files[0]


def load_subject_ids_from_adhd_all(adhd_all_dir: Path) -> set[str]:
    if not adhd_all_dir.exists():
        return set()

    subject_ids = set()
    for subject_dir in sorted(adhd_all_dir.iterdir()):
        if not subject_dir.is_dir():
            continue
        try:
            subject_ids.add(normalize_subject_id(subject_dir.name))
        except ValueError:
            continue
    return subject_ids


def _resolve_column_indices(header: list[str]) -> tuple[int, int]:
    normalized_to_index = {name.strip(): idx for idx, name in enumerate(header)}

    id_candidates = ["ScanDir ID", "ScanDirID", "ID"]
    dx_candidates = ["DX", "Label", "label"]

    id_index = next((normalized_to_index[name] for name in id_candidates if name in normalized_to_index), None)
    dx_index = next((normalized_to_index[name] for name in dx_candidates if name in normalized_to_index), None)

    if id_index is not None and dx_index is not None:
        return id_index, dx_index

    if len(header) < 6:
        raise ValueError("Phenotypic CSV has fewer than 6 columns and target columns were not found by name")

    return 0, 5


def collect_labels(pheno_root: Path, allowed_subject_ids: set[str]) -> tuple[list[dict[str, str]], int]:
    rows: list[dict[str, str]] = []
    skipped_rows = 0
    seen_labels: dict[str, tuple[int, str]] = {}

    for site_dir in sorted(pheno_root.iterdir()):
        if not site_dir.is_dir():
            continue
        if site_dir.name.lower() in SKIP_SITE_NAMES:
            continue

        csv_path = find_site_csv(site_dir)
        if csv_path is None:
            print(f"[missing-csv] no phenotypic csv found under {site_dir}")
            continue

        print(f"[read] {csv_path}")
        with csv_path.open("r", newline="", encoding="utf-8-sig") as csvfile:
            reader = csv.reader(csvfile)
            try:
                header = next(reader)
            except StopIteration:
                print(f"[empty-csv] {csv_path}")
                continue

            id_index, dx_index = _resolve_column_indices(header)

            for line_number, row in enumerate(reader, start=2):
                if not row:
                    continue
                max_index = max(id_index, dx_index)
                if len(row) <= max_index:
                    skipped_rows += 1
                    print(f"[skip-short-row] {csv_path}:{line_number}")
                    continue

                try:
                    subject_id = normalize_subject_id(row[id_index])
                    dx = normalize_dx(row[dx_index])
                except ValueError as exc:
                    skipped_rows += 1
                    print(f"[skip-invalid-row] {csv_path}:{line_number} {exc}")
                    continue

                if allowed_subject_ids and subject_id not in allowed_subject_ids:
                    continue

                previous = seen_labels.get(subject_id)
                if previous is not None:
                    previous_dx, previous_site = previous
                    if previous_dx != dx:
                        raise ValueError(
                            f"Conflicting DX for subject {subject_id}: "
                            f"{previous_dx} from {previous_site}, {dx} from {site_dir.name}"
                        )
                    print(
                        f"[skip-duplicate-label] subject {subject_id} already loaded from "
                        f"{previous_site}, skipping duplicate in {site_dir.name}"
                    )
                    continue

                seen_labels[subject_id] = (dx, site_dir.name)
                rows.append(
                    {
                        "ScanDir ID": subject_id,
                        "DX": str(dx),
                        "Site": site_dir.name,
                    }
                )

    rows.sort(key=lambda item: item["ScanDir ID"])
    return rows, skipped_rows


def write_labels_csv(rows: list[dict[str, str]], output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with output_file.open("w", newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=["ScanDir ID", "DX", "Site"])
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract ADHD labels from site phenotypic CSV files into a single ADHD_labels.csv."
    )
    parser.add_argument(
        "--pheno-root",
        type=Path,
        required=True,
        help="Root directory containing site folders such as KKI/KKI_phenotypic.csv.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        required=True,
        help="Target root directory where ADHD_labels.csv will be written.",
    )
    parser.add_argument(
        "--adhd-all-dir",
        type=Path,
        default=None,
        help="Optional ADHD_all directory used to filter labels to collected subjects only.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    pheno_root = args.pheno_root.expanduser().resolve()
    output_root = args.output_root.expanduser().resolve()
    adhd_all_dir = (
        args.adhd_all_dir.expanduser().resolve()
        if args.adhd_all_dir is not None
        else output_root / "ADHD_all"
    )

    if not pheno_root.exists():
        raise FileNotFoundError(f"Phenotypic root does not exist: {pheno_root}")

    allowed_subject_ids = load_subject_ids_from_adhd_all(adhd_all_dir)
    if allowed_subject_ids:
        print(f"[filter] loaded {len(allowed_subject_ids)} subject IDs from {adhd_all_dir}")
    else:
        print(f"[filter] no ADHD_all subject filter found at {adhd_all_dir}, exporting all labels")

    rows, skipped_rows = collect_labels(pheno_root, allowed_subject_ids)
    output_file = output_root / "ADHD_labels.csv"
    write_labels_csv(rows, output_file)

    print(
        "[done] "
        f"labels={len(rows)}, skipped_rows={skipped_rows}, output={output_file}"
    )


if __name__ == "__main__":
    main()
