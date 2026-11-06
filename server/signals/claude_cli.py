"""Structured answers from Claude through the Claude Code CLI, on the user's own subscription.

All tools are disabled and customizations are off (--safe-mode), so text from documents passed in the
prompt can't make Claude act; the answer must match the JSON schema.
"""
import json
import shutil
import subprocess

from .store import ROOT


class ClaudeError(Exception):
    pass


def available() -> bool:
    return shutil.which("claude") is not None


def ask(prompt: str, schema: dict, model: str = "haiku", timeout: int = 240) -> dict:
    if not available():
        raise ClaudeError("the claude command is not installed or not on PATH")
    cmd = ["claude", "-p", "--safe-mode", "--tools", "", "--model", model, "--no-session-persistence",
           "--output-format", "json", "--json-schema", json.dumps(schema)]
    try:
        res = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, cwd=ROOT / "data")
    except subprocess.TimeoutExpired as e:
        raise ClaudeError(f"no answer within {timeout}s") from e
    if res.returncode != 0:
        raise ClaudeError((res.stderr or res.stdout).strip()[:300] or f"claude exited {res.returncode}")
    try:
        out = json.loads(res.stdout)
        if out.get("is_error"):
            raise ClaudeError(str(out.get("result"))[:300])
        return out.get("structured_output") or json.loads(out["result"])
    except (json.JSONDecodeError, KeyError) as e:
        raise ClaudeError(f"unreadable answer: {e}") from e
