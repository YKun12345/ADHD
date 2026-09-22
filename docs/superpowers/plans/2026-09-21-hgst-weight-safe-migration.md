# HGST Weight Safe Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely copy the verified legacy HGST deployment bundle into the current project's configured model location without changing application behavior or claiming that the real runtime is ready.

**Architecture:** Treat the model as a local, Git-ignored deployment asset. Verify the source identity before copying, copy only when the target is absent, verify byte size and SHA-256 afterward, and document the asset identity in the existing model README. Keep the current real/mock/auto guardrails unchanged.

**Tech Stack:** PowerShell file operations, SHA-256, PyTorch ZIP bundle structure, existing Python model verification script, pytest, Node.js mini-program tests.

---

### Task 1: Preflight and expected failure

**Files:**
- Read: `backend/app/core/config.py`
- Read: adjacent legacy workspace `backend/artifacts/hgst_adhd_bundle.pt`
- Expected missing target: `backend/models/hgst_adhd_bundle.pt`

- [x] **Step 1: Run the target-identity assertion before copying**

Run a PowerShell assertion requiring the target to exist with SHA-256 `74575AFA48EF423461CA463F8C57CC2F1B767C3CF320C94367C00E02ABA7F95A`.

Expected: FAIL because the target does not exist. This proves the migration verification detects the missing asset.

- [x] **Step 2: Verify the source and configured destination**

Confirm the source exists, is `59,203,363` bytes, has the expected SHA-256, and the current default configuration resolves to `backend/models/hgst_adhd_bundle.pt`.

Expected: all preflight checks pass.

### Task 2: Copy and verify the model asset

**Files:**
- Create: `backend/models/hgst_adhd_bundle.pt`

- [x] **Step 1: Copy without overwriting**

Use `Copy-Item` only after confirming the destination is absent. Do not change or delete the source.

- [x] **Step 2: Re-run the target-identity assertion**

Expected: PASS with exact size and matching SHA-256.

- [x] **Step 3: Inspect the bundle container read-only**

Open the PyTorch ZIP container and check its metadata for `encoder_state_dict`, `classifier_state_dict`, and `classifier_input_dim`.

Expected: all three identifiers are present.

### Task 3: Record the local asset identity

**Files:**
- Modify: `backend/models/README.md`

- [x] **Step 1: Verify the README lacks this migrated checksum**

Expected: checksum search returns no match before documentation is added.

- [x] **Step 2: Add a migration record**

Document the expected filename, size, SHA-256, legacy source location, Git-ignore behavior, and the fact that runtime dependencies are outside this migration.

- [x] **Step 3: Verify the record**

Expected: README contains the expected checksum and does not claim real inference is operational.

### Task 4: Regression and runtime-boundary verification

**Files:**
- Read: `scripts/verify_model.py`
- Read: `backend/scripts/verify_model.py`

- [x] **Step 1: Run explicit Mock verification**

Run: `.venv\Scripts\python.exe scripts\verify_model.py --mode mock`

Expected: exit code `0`, `is_demo=True`, and a clearly marked Mock result.

- [x] **Step 2: Run default real verification**

Run: `.venv\Scripts\python.exe scripts\verify_model.py`

Expected on this machine: the bundle is found, but verification stops on missing/incompatible `torch`/`dhg`; it must not silently fall back to Mock.

- [x] **Step 3: Run existing regression suites**

Run the repository's backend, repository-audit, and mini-program test commands as documented by the project.

Expected: all previously passing tests remain green.

- [x] **Step 4: Inspect final Git status**

Expected: the `.pt` asset remains ignored, only the intended README/plan documentation changes are tracked, and the pre-existing `.codex-ppt-build/` directory remains untouched.
