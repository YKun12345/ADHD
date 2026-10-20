"""Focused synthetic-only checks for project node DP and durable accounting."""
import copy
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import numpy as np
import torch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

from federated_runtime.privacy_store import PrivacyStore, PrivacyBudgetError
from federated_runtime.project_node import make_private_training, public_initial_arrays, weighted_loss
from federated_runtime.project_round import DEFAULT_PRIVACY, verify_signed_envelope
from federated_runtime.hgst_features import canonical_json


class PrivacyTests(unittest.TestCase):
    def test_reservations_survive_restart_and_new_experiment(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Ed25519PrivateKey.generate()
            path = Path(directory) / "privacy.sqlite3"
            store = PrivacyStore(path, "stable-scope", "node-a", key)
            first = store.reserve("project-a", 1, str(uuid4()), DEFAULT_PRIVACY)
            self.assertEqual(sum(item[2] for item in first["reserved_history"]), 2)
            store = PrivacyStore(path, "stable-scope", "node-a", key)
            second = store.reserve("project-b", 1, str(uuid4()), DEFAULT_PRIVACY)
            self.assertEqual(sum(item[2] for item in second["reserved_history"]), 4)
            self.assertGreater(second["epsilon"], first["epsilon"])
            with self.assertRaises(PrivacyBudgetError):
                store.reserve("project-c", 1, str(uuid4()), {**DEFAULT_PRIVACY, "max_epsilon": .01})
            self.assertEqual(store.snapshot(DEFAULT_PRIVACY["delta"])["reserved_history"], second["reserved_history"])
            with self.assertRaises(PrivacyBudgetError):
                PrivacyStore(path, "replacement-scope", "node-a", key)

    def test_same_attempt_is_never_retrained_for_free(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PrivacyStore(Path(directory) / "privacy.sqlite3", "scope", "a", Ed25519PrivateKey.generate())
            attempt = str(uuid4())
            store.reserve("experiment", 1, attempt, DEFAULT_PRIVACY)
            with self.assertRaises(PrivacyBudgetError):
                store.reserve("experiment", 1, attempt, DEFAULT_PRIVACY)


class SamplingTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)
        self.base = public_initial_arrays(720)

    def training(self):
        return make_private_training(self.base, np.ones((1, 720), np.float32), np.array([1], np.int64), DEFAULT_PRIVACY)

    def test_zero_loss_placeholders_have_exact_zero_sample_gradient(self):
        model, optimizer, loader, engine = self.training()
        self.assertEqual(len(loader.dataset), 64)
        self.assertEqual(loader.sample_rate, .125)
        self.assertEqual(optimizer.expected_batch_size, 8)
        self.assertEqual(model.loss_reduction, "sum")
        self.assertEqual(optimizer.loss_reduction, "mean")
        optimizer.zero_grad()
        features = torch.ones((2, 720))
        weighted_loss(model(features), torch.tensor([1, 0]), torch.tensor([1., 0.])).backward()
        for parameter in model.parameters():
            self.assertEqual(parameter.grad_sample.shape[0], 2)
            self.assertEqual(torch.count_nonzero(parameter.grad_sample[1]).item(), 0)
        # A zero-noise mathematical control checks actual Opacus clipping and
        # public denominator; production construction above always uses sigma>=2.
        optimizer.noise_multiplier = 0
        gradients = [parameter.grad_sample[0].clone() for parameter in model.parameters()]
        norm = torch.sqrt(sum(value.square().sum() for value in gradients))
        factor = min(1., 1. / (float(norm) + 1e-6))
        before = [parameter.detach().clone() for parameter in model.parameters()]
        optimizer.step()
        for parameter, prior, gradient in zip(model.parameters(), before, gradients):
            expected = prior - .05 * gradient * factor / 8
            self.assertTrue(torch.allclose(parameter, expected, atol=2e-7, rtol=1e-6))

    def test_empty_batch_still_adds_noise_and_records_one_step(self):
        model, optimizer, loader, engine = self.training()
        before = [value.detach().clone() for value in model.parameters()]
        optimizer.zero_grad()
        weighted_loss(model(torch.empty((0, 720))), torch.empty(0, dtype=torch.int64), torch.empty(0)).backward()
        optimizer.step()
        self.assertEqual(sum(item[2] for item in engine.accountant.history), 1)
        self.assertTrue(all(torch.isfinite(value).all() for value in model.parameters()))
        self.assertTrue(any(not torch.equal(prior, value) for prior, value in zip(before, model.parameters())))


class SignatureTests(unittest.TestCase):
    def test_reply_cannot_cross_node_round_attempt_request_or_sequence(self):
        key = Ed25519PrivateKey.generate()
        node = {"node_id": "a", "institution_id": 1, "index": 1,
                "public_key_pem": key.public_key().public_bytes(serialization.Encoding.PEM,
                    serialization.PublicFormat.SubjectPublicKeyInfo).decode()}
        manifest = {"experiment_id": "experiment", "round": 1, "attempt": str(uuid4()), "base_parameters_sha256": "a" * 64}
        payload = {"schema": "federated-node-reply/v1", **{name: node[name] for name in ("node_id", "institution_id", "index")},
                   **manifest, "seq": 1, "previous_reply_sha256": "0" * 64, "request_sha256": "b" * 64}
        envelope = {"payload": payload, "signature_hex": key.sign(canonical_json(payload)).hex()}
        options = {"sequence": 1, "previous_sha256": "0" * 64, "request_sha256": "b" * 64}
        verify_signed_envelope(envelope, node, manifest, **options)
        for field, replacement in (("node_id", "b"), ("round", 2), ("attempt", str(uuid4())),
                                   ("request_sha256", "c" * 64), ("seq", 2), ("base_parameters_sha256", "d" * 64),
                                   ("pid", 12345)):
            changed = copy.deepcopy(envelope)
            changed["payload"][field] = replacement
            with self.assertRaises(ValueError):
                verify_signed_envelope(changed, node, manifest, **options)


if __name__ == "__main__":
    unittest.main()
