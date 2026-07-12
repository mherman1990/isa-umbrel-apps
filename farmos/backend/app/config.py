"""Runtime configuration.

Everything mutable lives under DATA_DIR (the Umbrel app volume) so container
upgrades never lose state. Secrets (the farmer's Anthropic key, restic key)
are files under DATA_DIR/secrets — never database rows, never env vars baked
into the image.
"""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FARMOS_", extra="ignore")

    data_dir: Path = Path("/data")
    database_url: str = "postgresql+psycopg://farmos:farmos@localhost:5432/farmos"
    port: int = 8585

    # Model routing tiers. Cheap tier does extraction/classification; the
    # reasoning tier is reserved for genuine reasoning (stacking, chat).
    model_cheap: str = "claude-haiku-4-5"
    model_reasoning: str = "claude-sonnet-5"

    # Whisper subprocess
    whisper_bin: str = "whisper-cli"
    whisper_model: Path = Path("/opt/whisper/ggml-base.en.bin")
    whisper_threads: int = 2
    whisper_nice: int = 15
    whisper_timeout_s: int = 300

    # Default monthly LLM spend hard cap (USD); farmer can change it in Settings.
    default_spend_cap_usd: float = 20.0

    # SANDBOX ONLY: replaces the LLM with a canned local stub (clearly
    # labeled "[sandbox model]" in every output, $0 metered). Never enable
    # in production — it exists so a demo box can exercise the full
    # capture→parse→inbox and chat loops without an API key.
    dev_fake_llm: bool = False

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"

    @property
    def secrets_dir(self) -> Path:
        return self.data_dir / "secrets"

    @property
    def backup_staging_dir(self) -> Path:
        return self.data_dir / "backup_staging"

    def anthropic_key(self) -> str | None:
        p = self.secrets_dir / "anthropic_key"
        try:
            key = p.read_text().strip()
            return key or None
        except FileNotFoundError:
            return None

    def set_anthropic_key(self, key: str) -> None:
        self.secrets_dir.mkdir(parents=True, exist_ok=True)
        p = self.secrets_dir / "anthropic_key"
        p.write_text(key.strip() + "\n")
        p.chmod(0o600)


settings = Settings()
