import torch
import logging
from tqdm import tqdm
from copy import deepcopy
import torch.nn.functional as F
from torch import optim as optim
from model import MLP_classifier
import torch.nn.functional as F
import numpy as np
from pathlib import Path
import sys

# Allow this research script to run directly from HGST-main as well as the project root.
_project_root = str(Path(__file__).resolve().parents[1])
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)
from backend.app.services.hgst_runtime.evaluation import (
    ValidationCheckpoint, classification_metrics, snapshot_state_dict, validate_partitions,
)
from sklearn.metrics import confusion_matrix


def pretrain_fmri(model, preprocessed_data, HG_aug_list, optimizer, scheduler, max_epoch, device, topo_sim_all, cl, attr, use_sim,logger):
    """
    input:
        model: model
        preprocessed_data: data list
        HG_aug_list: list of (HG_aug1, HG_aug2)
        optimizer: optimizer
        scheduler: learning rate scheduler
        max_epoch: int
        device: torch.device
        topo_sim_all: list of topo_sim
        cl: bool
        attr: bool
        use_sim: bool
        
    """
    if not cl:
        logger.info("Without Contrastive Learning")
    if not attr:
        logger.info("Without Attribute Learning")
    
    preprocessed_data = preprocessed_data
    HG_aug_list = [(HG_aug1.to(device), HG_aug2.to(device)) for HG_aug1, HG_aug2 in HG_aug_list]
    
    epoch_iter = range(max_epoch)
    best_loss = 1000    
    best_model = None
    last_model = None
    for epoch in epoch_iter:
        logger.info(f"---- Epoch {epoch+1}/{max_epoch} ----")
        
        losses = []
        for i, (HG_aug1, HG_aug2) in enumerate(tqdm(HG_aug_list)):
            model.train()
            x, hg, y = preprocessed_data[i]
            topo_sim = topo_sim_all[i]
            x = x.to(device)
            hg = hg.to(device)
            y = y.to(device)
            HG_aug1 = HG_aug1.to(device)
            HG_aug2 = HG_aug2.to(device)
            topo_sim = topo_sim.to(device)
            if cl:
                loss_cl = model.forward_cl(x, HG_aug1, HG_aug2, topo_sim, use_sim)  # topo
            else:
                loss_cl = 0
            if attr:
                loss_attr, _ = model.forward_attr(x, hg)    # seman
            else:
                loss_attr = 0
            loss = loss_attr * attr + loss_cl * cl
            losses.append(loss.item())
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        scheduler.step()
        loss_epoch = sum(losses) / len(losses)
        logger.info(f"# Epoch {epoch+1}: train_loss: {loss_epoch:.4f}")
        if loss_epoch < best_loss:
            best_loss = loss_epoch
            best_model = deepcopy(model)
        last_model = deepcopy(model)
        
    return best_model, last_model



def compute_specificity(y_true, y_pred):
    tn, fp, _, _ = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return float(tn / (tn + fp)) if tn + fp else float("nan")


def graph_classification_evaluation(k, model, preprocessed_data, num_classes, 
                                    lr_f, weight_decay_f, max_epoch_f, device, 
                                    train_mask, val_mask, test_mask, lbl, logger, linear_prob=True):
    model = model.to(device)
    model.eval()
    hg_emb_list = []

    with torch.no_grad():
        for i, (x, hg, y) in enumerate(preprocessed_data):
            x = x.to(device)
            hg = hg.to(device)
            node_embs = model.embed(x, hg)  
            graph_emb = node_embs.view(-1)
            graph_emb = graph_emb.unsqueeze(0) 
            hg_emb_list.append(graph_emb)
            
        
        all_hg_emb = torch.cat(hg_emb_list, dim=0)  

    labels = lbl.to(device)
    train_mask = train_mask.to(device)
    val_mask = val_mask.to(device)
    test_mask = test_mask.to(device)

    metric_dict = MLP_tune(
        all_hg_emb, max_epoch_f, num_classes, lr_f, weight_decay_f,
        device, train_mask, val_mask, test_mask, labels, logger,mute=True
    )
    return metric_dict


def MLP_tune(
        all_hg_emb, max_epoch, num_classes, lr_f, weight_decay_f,
        device, train_mask, val_mask, test_mask, labels, logger, mute=False):
    if max_epoch < 1:
        raise ValueError("Classifier training needs at least one epoch")
    all_hg_emb = all_hg_emb.to(device)
    labels = labels.to(device).long()
    train_mask, val_mask, test_mask = [mask.to(device) for mask in (train_mask, val_mask, test_mask)]
    validate_partitions(
        *(np.flatnonzero(mask.detach().cpu().numpy()) for mask in (train_mask, val_mask, test_mask)),
        n_samples=len(labels),
    )
    selection = ValidationCheckpoint()
    classifier = MLP_classifier(all_hg_emb.shape[1], num_classes).to(device)
    num_finetune_params = sum(p.numel() for p in classifier.parameters() if p.requires_grad)
    logger.info(f"num parameters for finetuning: {num_finetune_params}")
    optimizer_f = create_optimizer("adam", classifier, lr_f, weight_decay_f)

    epoch_iter = tqdm(range(max_epoch))
    for epoch in epoch_iter:
        classifier.train()
        out = classifier(all_hg_emb[train_mask], None)
        loss = F.cross_entropy(out, labels[train_mask])
        optimizer_f.zero_grad()
        loss.backward()
        optimizer_f.step()
        classifier.eval()
        with torch.no_grad():
            val_logits = classifier(all_hg_emb[val_mask], None)
            val_loss = F.cross_entropy(val_logits, labels[val_mask])
            val_probabilities = F.softmax(val_logits, dim=1).cpu().numpy()
        val_metrics = classification_metrics(labels[val_mask].cpu().numpy(), val_probabilities)
        selection.consider(epoch, val_metrics, lambda: snapshot_state_dict(classifier.state_dict()))
        epoch_iter.set_description(
            f"# Epoch: {epoch}, train_loss:{loss.item():.4f}, val_loss:{val_loss.item():.4f}, "
            f"val_acc:{val_metrics['acc']:.4f}, val_f1:{val_metrics['f1']:.4f}"
        )

    def evaluate_test():
        classifier.eval()
        with torch.no_grad():
            test_logits = classifier(all_hg_emb[test_mask], None)
            test_probabilities = F.softmax(test_logits, dim=1).cpu().numpy()
        return classification_metrics(labels[test_mask].cpu().numpy(), test_probabilities)

    metrics = selection.evaluate_test(classifier.load_state_dict, evaluate_test)
    logger.info(f"Selected epoch {selection.epoch + 1} by validation accuracy only")
    for split in ("val", "test"):
        logger.info(f"--- {split.title()} Results at selected checkpoint ---")
        for name in ("acc", "recall", "precision", "f1", "auc", "specificity"):
            logger.info(f"{split}_{name}: {metrics[split + '_' + name]:.4f}")
    return metrics


def create_optimizer(opt, model, lr, weight_decay, get_num_layer=None, get_layer_scale=None):
    opt_lower = opt.lower()
    parameters = model.parameters()
    opt_args = dict(lr=lr, weight_decay=weight_decay)
    opt_split = opt_lower.split("_")
    opt_lower = opt_split[-1]
    if opt_lower == "adam":
        optimizer = optim.Adam(parameters, **opt_args)
    elif opt_lower == "adamw":
        optimizer = optim.AdamW(parameters, **opt_args)
    elif opt_lower == "adadelta":
        optimizer = optim.Adadelta(parameters, **opt_args)
    elif opt_lower == "radam":
        optimizer = optim.RAdam(parameters, **opt_args)
    elif opt_lower == "sgd":
        opt_args["momentum"] = 0.9
        return optim.SGD(parameters, **opt_args)
    else:
        assert False and "Invalid optimizer"

    return optimizer

