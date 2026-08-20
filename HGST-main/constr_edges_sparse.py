import argparse
import json
import os

import numpy as np
from tqdm import tqdm

from src.getData import construct_hyperedges_from_time_series, get_data_adhd, get_data_mdd


def construct_hyperedges_ADHD(lambda_value: float = 0.2, is_save: bool = False):
    np.random.seed(0)

    _, features, timeseries_all = get_data_adhd()

    print("Constructing hypergraphs...")
    n_data = len(features)
    hyperedges_each_sample = {}

    for i in tqdm(range(n_data)):
        time_series = timeseries_all[i]
        hyperedges = construct_hyperedges_from_time_series(time_series, lambda_value)
        hyperedges_each_sample[i] = hyperedges

    if is_save:
        output_dir = "./src/hyperedges"
        os.makedirs(output_dir, exist_ok=True)
        filename = os.path.join(output_dir, f"ADHD_sparse_lambda_{lambda_value:.1f}.json")
        with open(filename, "w") as f:
            json.dump(hyperedges_each_sample, f, default=default_converter)
        print(f"Saved hyperedges to {filename}")
    return hyperedges_each_sample


def construct_hyperedges_MDD(lambda_value: float = 0.2, is_save: bool = False):
    np.random.seed(0)

    _, features, timeseries_all = get_data_mdd()

    print("Constructing hypergraphs...")
    n_data = len(features)
    hyperedges_each_sample = {}

    for i in tqdm(range(n_data)):
        time_series = timeseries_all[i]
        hyperedges = construct_hyperedges_from_time_series(time_series, lambda_value)
        hyperedges_each_sample[i] = hyperedges

    if is_save:
        output_dir = "./src/hyperedges"
        os.makedirs(output_dir, exist_ok=True)
        filename = os.path.join(output_dir, f"MDD_sparse_lambda_{lambda_value:.1f}.json")
        with open(filename, "w") as f:
            json.dump(hyperedges_each_sample, f, default=default_converter)
        print(f"Saved hyperedges to {filename}")
    return hyperedges_each_sample


def default_converter(o):
    if isinstance(o, np.int64):
        return int(o)
    raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")


def parse_args():
    parser = argparse.ArgumentParser(description="Construct sparse hyperedges for HGST.")
    parser.add_argument("--data_name", type=str, default="ADHD", choices=["ADHD", "MDD"])
    parser.add_argument("--lambda_value", type=float, default=0.2, help="L1 regularization strength.")
    parser.add_argument("--save", action="store_true", help="Save the hyperedges to src/hyperedges.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.data_name == "ADHD":
        construct_hyperedges_ADHD(lambda_value=args.lambda_value, is_save=args.save)
    else:
        construct_hyperedges_MDD(lambda_value=args.lambda_value, is_save=args.save)
