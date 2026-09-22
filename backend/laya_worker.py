#!/usr/bin/env python3
"""Offline JSONL worker that uses Laya for typed model-routing decisions."""

from __future__ import annotations

import contextlib
import json
import math
import os
from pathlib import Path
import sys
from typing import Any, Mapping


os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

MAX_QUESTION_CHARS = 8_000
MAX_CONTEXT_CHARS = 18_000

QUESTIONS = {
    "route": {
        "type": "choice",
        "instructions": (
            "Which generative-model lane should answer `question` using the supplied page context? "
            "Choose fast for direct facts, extraction, rewriting, definitions, and short one-step questions. "
            "Choose deep for ambiguous requests, multi-step reasoning, proofs, debugging, synthesis, or high-stakes advice."
        ),
        "criteria": {
            "fast": "a quick, capable model optimized for low latency",
            "deep": "the strongest model for difficult or consequential reasoning",
        },
    },
    "context_scope": {
        "type": "choice",
        "instructions": "How much supplied website text is needed to answer `question` accurately?",
        "criteria": {
            "question_only": "the question is self-contained",
            "nearby": "the local question block or answer choices are needed",
            "page": "broader page text is needed",
        },
    },
}


def _is_checkpoint(path: Path) -> bool:
    return path.is_dir() and all((path / name).exists() for name in ("rl_agent_config.json", "model.safetensors", "tokenizer"))


def resolve_checkpoint() -> Path:
    configured = os.environ.get("LAYA_MODEL_PATH")
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if _is_checkpoint(candidate):
            return candidate
        raise FileNotFoundError("LAYA_MODEL_PATH is not a root Laya checkpoint")

    cache_root = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    snapshots = cache_root / "hub" / "models--convaiinnovations--laya" / "snapshots"
    if snapshots.is_dir():
        candidates = sorted(snapshots.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True)
        for candidate in candidates:
            if _is_checkpoint(candidate):
                return candidate
    raise FileNotFoundError("cached root Laya checkpoint not found")


def _text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def sanitize_context(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise ValueError("context must be an object")
    return {
        "question": _text(value.get("question"), MAX_QUESTION_CHARS),
        "selection": _text(value.get("selection"), 4_000),
        "nearby_text": _text(value.get("nearbyText"), 8_000),
        "page_title": _text(value.get("pageTitle"), 500),
        "page_text": _text(value.get("fullPageContext") or value.get("pageText"), MAX_CONTEXT_CHARS),
    }


def _probability(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite probability")
    return round(min(1.0, max(0.0, number)), 4)


def route_with(agent: Any, context: Mapping[str, Any]) -> dict[str, Any]:
    state = sanitize_context(context)
    if not state["question"].strip():
        raise ValueError("question is empty")
    with contextlib.redirect_stdout(sys.stderr):
        result = agent.predict(state, QUESTIONS)
    route = result["answers"]["route"]
    scope = result["answers"]["context_scope"]
    probabilities = {
        "fast": _probability(route["probabilities"]["fast"]),
        "deep": _probability(route["probabilities"]["deep"]),
    }
    choice = str(route["choice"])
    lane = "deep" if choice == "deep" or probabilities["deep"] >= 0.46 else "fast"
    return {
        "lane": lane,
        "choice": choice,
        "confidence": _probability(route["confidence"]),
        "probabilities": probabilities,
        "contextChoice": str(scope["choice"]),
        "contextConfidence": _probability(scope["confidence"]),
        "source": "laya",
    }


def load_agent() -> Any:
    with contextlib.redirect_stdout(sys.stderr):
        from laya import Agent

        return Agent(str(resolve_checkpoint()), device="cpu")


def emit(payload: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        agent = load_agent()
    except Exception as error:
        print(f"Laya load failed: {type(error).__name__}", file=sys.stderr, flush=True)
        return 1

    emit({"type": "ready"})
    for line in sys.stdin:
        request_id: str | None = None
        try:
            request = json.loads(line)
            request_id = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request_id, str) or request.get("method") != "route":
                raise ValueError("invalid request")
            response = route_with(agent, request.get("context"))
            emit({"id": request_id, **response})
        except Exception as error:
            print(f"Laya route failed: {type(error).__name__}", file=sys.stderr, flush=True)
            emit({"id": request_id, "error": "routing_failed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
