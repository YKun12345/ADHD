from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def compose_api_environment(values: dict[str, str]) -> dict[str, str]:
    compose = yaml.safe_load((ROOT / "deploy/docker-compose.yml").read_text(encoding="utf-8"))

    def resolve(value: object) -> str:
        def substitute(match: re.Match[str]) -> str:
            name, default = match.groups()
            return values.get(name) or default or ""
        return re.sub(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}", substitute, str(value))

    return {name: resolve(value) for name, value in compose["services"]["api"]["environment"].items()}


class DeploymentConfigurationTests(unittest.TestCase):
    def test_template_ai_configuration_reaches_backend_settings(self) -> None:
        values = {
            "DEEPSEEK_API_KEY": "deployment-test-token",
            "DEEPSEEK_BASE_URL": "https://example.invalid/chat/completions",
            "DEEPSEEK_CHAT_MODEL": "deployment-test-chat",
            "DEEPSEEK_REMINDER_MODEL": "deployment-test-reminder",
            "DEEPSEEK_TIMEOUT_SECONDS": "19",
        }
        deployed = compose_api_environment(values)
        for name, expected in values.items():
            self.assertTrue(deployed.get(name) == expected, f"Compose did not forward {name}")
        child_env = {**os.environ, **deployed, "APP_ENV": "test", "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            [sys.executable, "-c", "from backend.app.core.config import settings; "
             "assert settings.DEEPSEEK_API_KEY == 'deployment-test-token'; "
             "assert settings.DEEPSEEK_CHAT_MODEL == 'deployment-test-chat'; "
             "assert settings.DEEPSEEK_TIMEOUT_SECONDS == 19"],
            cwd=ROOT, env=child_env, capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(0, result.returncode, result.stderr)

    def test_demo_image_explicitly_selects_mock_inference(self) -> None:
        deployed = compose_api_environment({})
        child_env = {**os.environ, **deployed, "APP_ENV": "test", "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(
            [sys.executable, "-c", "from backend.app.services.hgst_runtime.service import resolve_inference_mode; "
             "assert resolve_inference_mode() == 'mock', 'demo image selected real inference'"],
            cwd=ROOT, env=child_env, capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(0, result.returncode, result.stderr)

    def test_encryption_configuration_and_generated_key_storage_survive_container_restart(self) -> None:
        test_key = base64.urlsafe_b64encode(b"x" * 32).decode("ascii")
        deployed = compose_api_environment({"DATA_ENCRYPTION_KEY": test_key})
        self.assertTrue(deployed.get("DATA_ENCRYPTION_KEY") == test_key, "encryption key was not forwarded")
        key_path = deployed.get("SECURITY_MASTER_KEY_PATH", "")
        self.assertTrue(key_path.startswith("/app/backend/.keys/"), "generated key path is outside the key volume")
        compose = yaml.safe_load((ROOT / "deploy/docker-compose.yml").read_text(encoding="utf-8"))
        volumes = compose["services"]["api"].get("volumes", [])
        self.assertIn("api_keys:/app/backend/.keys", volumes)
        self.assertIn("api_keys", compose["volumes"])


    def test_encrypted_migration_backups_survive_container_replacement(self) -> None:
        compose = yaml.safe_load((ROOT / "deploy/docker-compose.yml").read_text(encoding="utf-8"))
        mounts = compose["services"]["api"].get("volumes", [])
        backup_mounts = [item for item in mounts if item.endswith(":/app/backend/migration-backups")]
        self.assertEqual(1, len(backup_mounts), "migration backups live only in the disposable container layer")
        volume_name = backup_mounts[0].split(":", 1)[0]
        self.assertIn(volume_name, compose["volumes"], "migration backup volume is not declared")


@unittest.skipUnless(shutil.which("bash"), "Bash is required to execute Ubuntu deployment script regressions")
class DeploymentScriptTests(unittest.TestCase):
    def run_deployment(self, *, certbot_fails: bool = False) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace = Path(temp_dir)
            deploy = workspace / "deploy"
            (deploy / "nginx").mkdir(parents=True)
            (deploy / "deploy.sh").write_text((ROOT / "deploy/deploy.sh").read_text(encoding="utf-8"), encoding="utf-8")
            (deploy / "nginx/backend.conf").write_text("server { proxy_pass http://127.0.0.1:8000; }", encoding="utf-8")
            (deploy / ".env").write_text("API_PORT=9123\n", encoding="utf-8")
            commands = workspace / "commands"
            commands.mkdir()
            scripts = {
                "docker": "case \"$*\" in *'port api 8000'*) echo '127.0.0.1:9123';; *'--version'*|*'version'*) echo 'test-version';; esac\n",
                "curl": "printf '%s\\n' \"$*\" >> \"$DEPLOY_TEST_TRACE\"\n",
                "nginx": "exit 0\n",
                "certbot": "exit " + ("1" if certbot_fails else "0") + "\n",
                "sudo": "printf '%s\\n' \"$*\" >> \"$DEPLOY_TEST_TRACE\"\nif [ \"$1\" = certbot ]; then shift; exec certbot \"$@\"; fi\n",
            }
            for name, body in scripts.items():
                command = commands / name
                command.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
                command.chmod(0o755)
            trace = workspace / "trace.txt"
            env = dict(os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"],
                       DOMAIN="example.invalid", EMAIL="test@example.invalid", DEPLOY_TEST_TRACE=str(trace))
            result = subprocess.run([shutil.which("bash"), str(deploy / "deploy.sh")], cwd=workspace,
                                    env=env, capture_output=True, text=True, encoding="utf-8", timeout=15)
            return result, trace.read_text(encoding="utf-8")

    def test_health_check_and_proxy_use_the_published_api_port(self) -> None:
        result, trace = self.run_deployment()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("http://127.0.0.1:9123/api/v1/health", trace)
        self.assertIn("127.0.0.1:9123", trace)
        self.assertNotIn("curl -fsS http://127.0.0.1:8000/api/v1/health", result.stdout)

    def test_failed_certificate_request_exits_without_https_success_claim(self) -> None:
        result, _ = self.run_deployment(certbot_fails=True)
        self.assertNotEqual(0, result.returncode)
        self.assertNotIn("HTTPS 就绪", result.stdout)


if __name__ == "__main__":
    unittest.main()
