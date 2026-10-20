"""Node-local conservative RDP reservations and signed SQLite event chain.

Reservations are never refunded. Actual step histories are additional evidence,
not a second privacy charge. A local signature chain cannot witness deletion or
rollback by its own administrator; the coordinator must retain independent heads.
"""
from __future__ import annotations

import contextlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from federated_runtime.hgst_features import canonical_json, sha256_bytes


class PrivacyBudgetError(ValueError):
    pass


def merged_history(histories):
    result = []
    for history in histories:
        for noise, rate, steps in history:
            if (type(steps) is not int or steps <= 0 or not 0 < float(rate) <= 1
                    or not float(noise) > 0):
                raise PrivacyBudgetError("Invalid RDP history")
            item = [float(noise), float(rate), steps]
            if result and result[-1][:2] == item[:2]:
                result[-1][2] += steps
            else:
                result.append(item)
    return result


def epsilon_for_history(history, delta):
    from opacus.accountants import RDPAccountant
    if not 0 < delta <= 1e-5:
        raise PrivacyBudgetError("Delta exceeds the frozen research contract")
    accountant = RDPAccountant()
    accountant.history = [tuple(item) for item in merged_history([history])]
    return float(accountant.get_epsilon(delta=delta)) if history else 0.0


class PrivacyStore:
    def __init__(self, path, namespace, node_id, private_key):
        from cryptography.hazmat.primitives import serialization
        self.path = Path(path)
        self.namespace = namespace
        self.node_id = node_id
        self.key = private_key
        raw_public = private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.identity = {"namespace": namespace, "node_id": node_id, "public_key_sha256": sha256_bytes(raw_public)}
        if not isinstance(namespace, str) or not namespace.strip() or len(namespace) > 200:
            raise PrivacyBudgetError("Stable protection namespace is required")
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reservations (
                    token TEXT PRIMARY KEY, experiment TEXT NOT NULL, round INTEGER NOT NULL,
                    attempt TEXT NOT NULL, plan TEXT NOT NULL, actual TEXT NOT NULL,
                    UNIQUE(experiment,round,attempt));
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL,
                    signature TEXT NOT NULL, digest TEXT NOT NULL);
            """)
            row = connection.execute("SELECT value FROM metadata WHERE id=1").fetchone()
            if row is None:
                self.metadata = {**self.identity, "ledger_epoch": str(uuid4())}
                connection.execute("INSERT INTO metadata VALUES (1,?)", (canonical_json(self.metadata).decode(),))
            else:
                self.metadata = json.loads(row[0])
                if any(self.metadata.get(name) != value for name, value in self.identity.items()):
                    raise PrivacyBudgetError("Existing ledger protection namespace or identity cannot change")
            self._verify(connection)

    @contextlib.contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            with connection:
                yield connection
        finally:
            connection.close()

    def _verify(self, connection):
        previous = "0" * 64
        expected = {}
        events = []
        for sequence, raw, signature, digest in connection.execute("SELECT * FROM events ORDER BY sequence"):
            payload = json.loads(raw)
            signed = {"payload": payload, "signature_hex": signature}
            if (sequence != len(events) + 1 or payload.get("sequence") != sequence
                    or payload.get("previous_sha256") != previous
                    or payload.get("ledger_epoch") != self.metadata["ledger_epoch"]
                    or payload.get("namespace") != self.namespace or payload.get("node_id") != self.node_id
                    or sha256_bytes(canonical_json(signed)) != digest):
                raise PrivacyBudgetError("Privacy ledger event chain is inconsistent")
            self.key.public_key().verify(bytes.fromhex(signature), canonical_json(payload))
            if payload["event"] == "reserved":
                if payload["token"] in expected:
                    raise PrivacyBudgetError("Duplicate signed reservation")
                expected[payload["token"]] = [payload["experiment_id"], payload["round"], payload["attempt"], payload["history"], []]
            elif payload["event"] == "spent":
                if payload["token"] not in expected:
                    raise PrivacyBudgetError("Spent event has no signed reservation")
                expected[payload["token"]][-1] = payload["history"]
            else:
                raise PrivacyBudgetError("Unknown signed privacy event")
            previous = digest
            events.append(signed)
        actual = {token: [experiment, number, attempt, json.loads(plan), json.loads(spent)]
                  for token, experiment, number, attempt, plan, spent in connection.execute("SELECT * FROM reservations")}
        if actual != expected:
            raise PrivacyBudgetError("Privacy ledger rows differ from signed event history")
        return events, previous

    def _append(self, connection, event, token, experiment, number, attempt, history):
        count = connection.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        last = connection.execute("SELECT digest FROM events ORDER BY sequence DESC LIMIT 1").fetchone()
        payload = {"schema": "federated-privacy-event/v1", **self.metadata,
                   "sequence": count + 1, "previous_sha256": last[0] if last else "0" * 64,
                   "event": event, "token": token, "experiment_id": experiment,
                   "round": number, "attempt": attempt, "history": history}
        signed = {"payload": payload, "signature_hex": self.key.sign(canonical_json(payload)).hex()}
        connection.execute("INSERT INTO events VALUES (?,?,?,?)",
                           (count + 1, canonical_json(payload).decode(), signed["signature_hex"], sha256_bytes(canonical_json(signed))))

    def _snapshot(self, connection, delta):
        events, head = self._verify(connection)
        rows = connection.execute("SELECT plan,actual FROM reservations ORDER BY rowid").fetchall()
        reserved = merged_history(json.loads(row[0]) for row in rows)
        actual = merged_history(json.loads(row[1]) for row in rows)
        return {"accountant": "rdp", "namespace": self.namespace,
                "ledger_epoch": self.metadata["ledger_epoch"], "ledger_sequence": len(events),
                "ledger_head_sha256": head, "reserved_history": reserved, "actual_history": actual,
                "epsilon": epsilon_for_history(reserved, delta), "delta": delta,
                "signed_events": events, "external_rollback_witnessed": False}

    def snapshot(self, delta):
        with self._connect() as connection:
            return self._snapshot(connection, delta)

    def reserve(self, experiment_id, number, attempt, privacy):
        history = [[privacy["noise_multiplier"], privacy["sample_rate"], privacy["logical_steps"]]]
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            prior = self._snapshot(connection, privacy["delta"])
            if connection.execute("SELECT 1 FROM reservations WHERE experiment=? AND round=? AND attempt=?",
                                  (experiment_id, number, attempt)).fetchone():
                raise PrivacyBudgetError("An existing attempt cannot execute again or reset its reservation")
            if epsilon_for_history(merged_history([prior["reserved_history"], history]), privacy["delta"]) > privacy["max_epsilon"]:
                raise PrivacyBudgetError("Persistent privacy budget would be exceeded")
            token = str(uuid4())
            connection.execute("INSERT INTO reservations VALUES (?,?,?,?,?,?)",
                               (token, experiment_id, number, attempt, canonical_json(history).decode(), "[]"))
            self._append(connection, "reserved", token, experiment_id, number, attempt, history)
            result = self._snapshot(connection, privacy["delta"])
            result["reservation_token"] = token
            return result

    def record_step(self, token, actual_history, delta):
        history = merged_history([actual_history])
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._verify(connection)
            row = connection.execute("SELECT experiment,round,attempt,plan,actual FROM reservations WHERE token=?", (token,)).fetchone()
            if row is None:
                raise PrivacyBudgetError("A logical step requires its durable reservation")
            experiment, number, attempt, plan_raw, prior_raw = row
            plan, prior = json.loads(plan_raw), json.loads(prior_raw)
            steps = sum(item[2] for item in history)
            if (steps != sum(item[2] for item in prior) + 1 or steps > sum(item[2] for item in plan)
                    or any(item[:2] != plan[0][:2] for item in history)):
                raise PrivacyBudgetError("Actual step history differs from its conservative reservation")
            connection.execute("UPDATE reservations SET actual=? WHERE token=?", (canonical_json(history).decode(), token))
            self._append(connection, "spent", token, experiment, number, attempt, history)
            return self._snapshot(connection, delta)
