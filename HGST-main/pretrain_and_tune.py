import argparse
import logging
import numpy as np
import torch
import math
from torch import optim as optim
from dhg import Hypergraph
from model import PreModel
from src.getData import get_data_adhd,get_data_mdd
from src.data_process import permute_edges
from src.wasserstein_dis import cot_numpy
from src.utils import set_seed
from train_engine import create_optimizer, pretrain_fmri, graph_classification_evaluation
from backend.app.services.hgst_runtime.evaluation import fit_training_encoder, stratified_partitions
from tqdm import tqdm
from sklearn.model_selection import StratifiedKFold
import json
import time
import os

if __name__ == "__main__":


    parser = argparse.ArgumentParser(description='Hypergraph SSL for fMRI data')

    parser.add_argument('--sample_num', type=int, default=None, help='Sample size, use None for all data')
    parser.add_argument('--data_name', type=str, default='ADHD', help='Name of the dataset')
    parser.add_argument('--k_fold', type=int, default=5, help='Number of folds for cross-validation')
    parser.add_argument('--seed', type=int, default=2020, help='Random seed')
    parser.add_argument('--validation_fraction', '--validation-fraction', type=float, default=0.2, help='Fraction of each outer training fold reserved for validation')
    parser.add_argument('--loss_fn', type=str, default='sce', help='Loss function')
    parser.add_argument('--replace_rate', type=float, default=0.05, help='Replacement rate')
    parser.add_argument('--mask_rate', type=float, default=0.5, help='Masking rate')
    parser.add_argument('--aug_ratio', type=float, default=0.5, help='Node deletion ratio for data augmentation')
    parser.add_argument('--num_hidden', type=int, default=512, help='Dimension of hidden layers')
    parser.add_argument('--lr', type=float, default=0.001, help='Learning rate of pretraining')
    parser.add_argument('--max_epoch', type=int, default=150, help='Maximum number of preraining epochs')
    parser.add_argument('--weight_decay', type=float, default=0, help='Weight decay')
    parser.add_argument('--lr_f', type=float, default=0.1, help='Learning rate for linear evaluation')
    parser.add_argument('--max_epoch_f', type=int, default=500, help='Maximum epochs for linear evaluation')
    parser.add_argument('--weight_decay_f', type=float, default=1e-4, help='Weight decay for linear evaluation')
    parser.add_argument('--encoder_type', type=str, default='hgnnp', help='Type of encoder')
    parser.add_argument('--decoder_type', type=str, default='hgnnp', help='Type of decoder')
    parser.add_argument('--dropout', type=float, default=0.0, help='Dropout rate')
    parser.add_argument('--optim_type', type=str, default='adam', help='Type of optimizer')
    parser.add_argument('--cl', type=float, default=1, help='Weight for contrastive loss')
    parser.add_argument('--attr', type=float, default=3, help='Weight for attribute loss')
    parser.add_argument('--lamda', type=float, default=0.2, help='Lambda parameter for Wasserstein distance')
    parser.add_argument('--edge_constru_lambda', type=float, default=0.2, help='Lambda parameter for hyperedge construction')
    parser.add_argument('--log_dir', type=str, default='logs', help='Directory for log files')
    parser.add_argument('--pretrain', type=str, default='True', help='Path to pretrained model weights')
    parser.add_argument('--pre_model', type=str, default=None, help='Path to pretrained model weights')
    parser.add_argument('--save_model_name', type=str, default=None, help='Optional checkpoint file name for the pretrained model')
    parser.add_argument('--comment', type=str, default='', help='Comments for the experiment')

    args = parser.parse_args()
    if args.max_epoch_f < 1 or (args.pretrain.lower() == 'true' and args.max_epoch < 1):
        parser.error('Training epochs must be positive')
    if not 0 < args.validation_fraction < 1:
        parser.error('validation_fraction must be between zero and one')

    comment=args.comment
    sample_num = args.sample_num
    data_name = args.data_name
    k_fold = args.k_fold
    seed = args.seed
    loss_fn = args.loss_fn
    replace_rate = args.replace_rate
    mask_rate = args.mask_rate
    num_hidden = args.num_hidden
    lr = args.lr
    max_epoch = args.max_epoch
    weight_decay = args.weight_decay
    lr_f = args.lr_f
    max_epoch_f = args.max_epoch_f
    weight_decay_f = args.weight_decay_f
    encoder_type = args.encoder_type
    decoder_type = args.decoder_type
    dropout = args.dropout
    optim_type = args.optim_type
    cl = args.cl
    attr = args.attr
    lamda = args.lamda
    aug_ratio = args.aug_ratio
    edge_constru_lambda = args.edge_constru_lambda
    pretrain = True if args.pretrain.lower() == 'true' else False
    pre_model = args.pre_model
    save_model_name = args.save_model_name
    hyperedge_file_template = './src/hyperedges/{}_sparse_lambda_{:.1f}.json'
    log_dir = args.log_dir

    hyperedge_file = hyperedge_file_template.format(data_name, edge_constru_lambda)
    
    
    available_datasets=["ADHD","MDD"]
    
    if data_name not in available_datasets:
        raise ValueError(f"Invalid dataset name: {data_name}. Must be one of {available_datasets}")
    
    log_dir=os.path.join(log_dir, data_name)
    log_dir = os.path.join(log_dir, "sparse_"+ time.strftime('%Y-%m-%d-%H-%M-%S'))
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    log_filename = os.path.join(log_dir, f"{data_name}_date_{time.strftime('%Y-%m-%d-%H-%M-%S')}.log")

    logger = logging.getLogger(__name__)
    logger.setLevel(logging.INFO)

    c_handler = logging.StreamHandler()
    f_handler = logging.FileHandler(log_filename)
    c_handler.setLevel(logging.INFO)
    f_handler.setLevel(logging.INFO)

    c_format = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    f_format = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    c_handler.setFormatter(c_format)
    f_handler.setFormatter(f_format)

    logger.addHandler(c_handler)
    logger.addHandler(f_handler)

    logger.info(f"comment: {comment}")
    logger.info(f"=================================")
    logger.info(f"seed: {seed}")
    logger.info(f"sample_num: {sample_num}")
    logger.info(f"k_fold: {k_fold}")
    logger.info(f"validation_fraction: {args.validation_fraction}")
    logger.info(f"loss_fn: {loss_fn}")
    logger.info(f"replace_rate: {replace_rate}")
    logger.info(f"mask_rate: {mask_rate}")
    logger.info(f"num_hidden: {num_hidden}")
    logger.info(f"lr: {lr}")
    logger.info(f"max_epoch: {max_epoch}")
    logger.info(f"weight_decay: {weight_decay}")
    logger.info(f"lr_f: {lr_f}")
    logger.info(f"max_epoch_f: {max_epoch_f}")
    logger.info(f"weight_decay_f: {weight_decay_f}")
    logger.info(f"encoder_type: {encoder_type}")
    logger.info(f"decoder_type: {decoder_type}")
    logger.info(f"dropout: {dropout}")
    logger.info(f"optim_type: {optim_type}")
    logger.info(f"cl: {cl}")
    logger.info(f"attr: {attr}")
    logger.info(f"lamda: {lamda}")
    logger.info(f"aug_ratio: {aug_ratio}")
    logger.info(f"edge_constru_lambda: {edge_constru_lambda}")
    logger.info(f"pretrain: {pretrain}")
    logger.info(f"pre_model: {pre_model}")
    logger.info(f"save_model_name: {save_model_name}")
    logger.info(f"hyperedge_file: {hyperedge_file}")
    logger.info(f"=================================")

    set_seed(seed)
    device = torch.device("cuda:0") if torch.cuda.is_available() else torch.device("cpu")
    logger.info(f"CUDA available: {torch.cuda.is_available()}")

    logger.info(f"===============================================")
    logger.info(f"Loading dataset: {data_name}")
    
    labels, features, timesseries_all = None, None, None
    if data_name == "ADHD":
        labels, features, timesseries_all = get_data_adhd()
    elif data_name == "MDD":
        labels, features, timesseries_all = get_data_mdd()
        
    lbl = torch.Tensor(labels)

    feature_dim = features[0].shape[1]
    num_classes = len(np.unique(labels))
    num_nodes = features[0].shape[0]

    logger.info(f"Number of samples: {len(features)}")
    logger.info(f"Number of classes: {num_classes}")
    logger.info(f"Number of nodes: {num_nodes}")
    logger.info(f"Input feature dimension: {feature_dim}")

    # ------- Data preprocessing -------
    logger.info(f"===============================================")
    logger.info("Constructing hypergraphs...")
    n_data = len(features)
    preprocessed_data = []

    hyperedges_each_sample = {}
    if not os.path.exists(hyperedge_file):
        raise FileNotFoundError(
            f"Hyperedge file not found: {hyperedge_file}. "
            f"Run `python constr_edges_sparse.py --data_name {data_name} "
            f"--lambda_value {edge_constru_lambda} --save` first."
        )
    with open(hyperedge_file, 'r') as f:
        hyperedges_each_sample = json.load(f)

    for i in tqdm(range(n_data)):
        X = torch.tensor(features[i], dtype=torch.float32)
        HG = Hypergraph(num_nodes)
        hyperedges = hyperedges_each_sample[str(i)]
        HG.add_hyperedges(hyperedges)
        G = HG.to(device)
        y = torch.tensor(labels[i], dtype=torch.long)
        preprocessed_data.append((X, G, y))

    if sample_num is not None:
        logger.info(f"Randomly selecting {sample_num} samples")
        ids = np.random.choice(n_data, sample_num, replace=False)
        preprocessed_data = [preprocessed_data[i] for i in ids]
        n_data = len(preprocessed_data)
        lbl = lbl[ids]
    else:
        ids = np.arange(n_data)

    # Every fold starts with a fresh model. Augmentation and SSL see training samples only.
    def model_factory():
        fold_model = PreModel(
            in_dim=feature_dim,
            hid_dim=num_hidden,
            edge_dim=num_nodes,
            feat_drop=dropout,
            use_bn=True,
            mask_rate=mask_rate,
            encoder_type=encoder_type,
            decoder_type=decoder_type,
            loss_fn=loss_fn,
            replace_rate=replace_rate,
        ).to(device)
        if not pretrain and pre_model is not None:
            fold_model.load_state_dict(torch.load(pre_model, map_location=device))
        return fold_model

    def fit_fold_encoder(fold_model, training_data):
        if not pretrain:
            return fold_model
        logger.info(f"Preparing augmentation for {len(training_data)} training samples only")
        hg_augmentations = []
        for index, (_, graph, _) in enumerate(tqdm(training_data)):
            first = permute_edges(index, graph.H.coalesce().indices(), aug_ratio)
            second = permute_edges(index, graph.H.coalesce().indices(), aug_ratio)
            hg_augmentations.append((
                Hypergraph(num_nodes, list(first.values())).to(device),
                Hypergraph(num_nodes, list(second.values())).to(device),
            ))
        topology_similarities = []
        for first, second in tqdm(hg_augmentations):
            similarities = []
            for edge_index, first_edge in enumerate(first.e[0]):
                first_degrees = np.array([[first.deg_v[node]] for node in first_edge])
                second_degrees = np.array([[second.deg_v[node]] for node in second.e[0][edge_index]])
                _, _, cost = cot_numpy(first_degrees, second_degrees)
                similarities.append(math.exp(-lamda * cost) + 1e-15)
            topology_similarities.append(torch.tensor(similarities).to(device))
        optimizer = create_optimizer(optim_type, fold_model, lr, weight_decay)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, max_epoch, eta_min=1e-5)
        best_encoder, _ = pretrain_fmri(
            fold_model, training_data, hg_augmentations, optimizer, scheduler,
            max_epoch, device, topology_similarities, cl, attr, use_sim=True, logger=logger,
        )
        return best_encoder

    # ------- Tuning -------
    logger.info(f"===============================================")
    logger.info("Starting tuning...")
    
    acc_list = []
    recall_list = []
    precision_list = []
    f1_list = []
    auc_list = []
    specificity_list = []
    
    pretraining_scope = "fold_train_only" if pretrain else ("external_unverified" if pre_model else "none")
    logger.info(f"Evaluation protocol: disjoint train/validation/test; pretraining_scope={pretraining_scope}")
    if pretraining_scope == "external_unverified":
        logger.warning("External encoder provenance is unverified: results are classifier holdout metrics, not verified end-to-end independent test performance")
    skf = StratifiedKFold(n_splits=k_fold, shuffle=True, random_state=seed)
    y_labels = lbl.numpy()
    fold_manifest = []
    for fold, (outer_train_index, outer_test_index) in enumerate(skf.split(np.zeros(n_data), y_labels)):
        logger.info(f"############################ Fold {fold + 1}/{k_fold} #####################")
        train_index, val_index, test_index = stratified_partitions(
            y_labels, outer_train=outer_train_index, outer_test=outer_test_index,
            validation_fraction=args.validation_fraction, seed=seed + fold,
        )
        set_seed(seed + fold)
        model = fit_training_encoder(model_factory, fit_fold_encoder, preprocessed_data, train_index)
        if pretrain:
            checkpoint_name = save_model_name if save_model_name else f"pretrained_model_{seed}.pth"
            stem, extension = os.path.splitext(checkpoint_name)
            checkpoint_name = f"{stem}_fold_{fold + 1}{extension or '.pth'}"
            torch.save(model.state_dict(), os.path.join(log_dir, checkpoint_name))
        train_mask = torch.zeros(n_data, dtype=torch.bool, device=device)
        val_mask = torch.zeros(n_data, dtype=torch.bool, device=device)
        test_mask = torch.zeros(n_data, dtype=torch.bool, device=device)
        train_mask[train_index] = True
        val_mask[val_index] = True
        test_mask[test_index] = True
        logger.info(f"Samples: train={len(train_index)}, validation={len(val_index)}, test={len(test_index)}")

        metric_dict = graph_classification_evaluation(fold,
            model, preprocessed_data, num_classes,
            lr_f, weight_decay_f, max_epoch_f, device,
            train_mask, val_mask, test_mask, lbl, logger=logger, linear_prob=True
        )

        fold_manifest.append({
            "fold": fold + 1,
            "train_sample_ids": ids[train_index].tolist(),
            "validation_sample_ids": ids[val_index].tolist(),
            "test_sample_ids": ids[test_index].tolist(),
            "metrics": {key: (float(value) if np.isfinite(value) else None) for key, value in metric_dict.items()},
        })
        with open(os.path.join(log_dir, "evaluation_manifest.json"), "w", encoding="utf-8") as manifest_file:
            json.dump({
                "seed": seed, "pretraining_scope": pretraining_scope,
                "end_to_end_test_verified": pretraining_scope != "external_unverified",
                "selection_metric": "validation_accuracy", "tie_break": "earliest_epoch",
                "folds": fold_manifest,
            }, manifest_file, indent=2, allow_nan=False)

        acc_list.append(100 * metric_dict["test_acc"])
        recall_list.append(100 * metric_dict["test_recall"])
        precision_list.append(100 * metric_dict["test_precision"])
        f1_list.append(100 * metric_dict["test_f1"])
        auc_list.append(100 * metric_dict["test_auc"])
        specificity_list.append(100 * metric_dict["test_specificity"])



    
    logger.info(f"===============================================")
    logger.info("Training completed. All reported metrics use the validation-selected checkpoint on held-out test samples.")
    final_acc, final_acc_std = np.mean(acc_list), np.std(acc_list)
    final_recall, final_recall_std = np.mean(recall_list), np.std(recall_list)
    final_precision, final_precision_std = np.mean(precision_list), np.std(precision_list)
    final_f1, final_f1_std = np.mean(f1_list), np.std(f1_list)
    final_auc, final_auc_std = np.mean(auc_list), np.std(auc_list)
    final_specificity, final_specificity_std = np.mean(specificity_list), np.std(specificity_list)

    logger.info(f"# final_test_acc: {final_acc:.2f} ± {final_acc_std:.2f}")
    logger.info(f"# final_test_recall: {final_recall:.2f} ± {final_recall_std:.2f}")
    logger.info(f"# final_test_precision: {final_precision:.2f} ± {final_precision_std:.2f}")
    logger.info(f"# final_test_f1: {final_f1:.2f} ± {final_f1_std:.2f}")
    logger.info(f"# final_test_auc: {final_auc:.2f} ± {final_auc_std:.2f}")
    logger.info(f"# final_test_specificity: {final_specificity:.2f} ± {final_specificity_std:.2f}")
