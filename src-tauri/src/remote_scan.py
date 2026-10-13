import datetime
import json
import os
import re
import sys


UNKNOWN_MODEL = "未知模型"


def token_values(value):
    value = value if isinstance(value, dict) else {}
    return {
        "inputTokens": int(value.get("input_tokens") or 0),
        "cachedInputTokens": int(value.get("cached_input_tokens") or 0),
        "cacheWriteInputTokens": int(value.get("cache_write_input_tokens") or 0),
        "outputTokens": int(value.get("output_tokens") or 0),
        "reasoningOutputTokens": int(value.get("reasoning_output_tokens") or 0),
        "totalTokens": int(value.get("total_tokens") or 0),
    }


def recover_token_breakdown(reported, previous_total, current_total):
    if reported["totalTokens"] <= reported["inputTokens"] + reported["outputTokens"]:
        return reported
    if current_total is None:
        return reported
    previous = previous_total or token_values({})
    delta = {key: current_total[key] - previous[key] for key in current_total}
    if (
        all(value >= 0 for value in delta.values())
        and delta["totalTokens"] == reported["totalTokens"]
        and delta["totalTokens"] <= delta["inputTokens"] + delta["outputTokens"]
    ):
        return delta
    return reported


def add_count(counts, name):
    name = (name or "").strip().strip("/")
    if name:
        counts[name] = counts.get(name, 0) + 1


def plugin_for_path(path):
    checks = [
        ("openai-bundled/browser", "Browser"),
        ("build-web-apps", "Build Web Apps"),
        ("build-web-data-visualization", "Data Visualization"),
        ("codex-security", "Codex Security"),
        ("/figma/", "Figma"),
        ("/hugging-face/", "Hugging Face"),
        ("/notion/", "Notion"),
        ("openai-primary-runtime", "Artifact Tools"),
    ]
    return next((name for needle, name in checks if needle in path), None)


def plugin_for_tool(name):
    if name.startswith("mcp__node_repl__"):
        return "Browser"
    if name.startswith("image_gen__"):
        return "ImageGen"
    if name.startswith("web__"):
        return "Web"
    if "figma" in name:
        return "Figma"
    return None


def analyze_tool_text(raw, skills, plugins):
    normalized = raw.replace("\\", "/")
    for match in re.finditer(r"/([^/]+)/SKILL\.md", normalized):
        prefix = normalized[: match.start()]
        skill = match.group(1)
        add_count(skills, skill)
        plugin = plugin_for_path(prefix)
        if plugin:
            add_count(plugins, plugin)
    for match in re.finditer(r"tools\.([A-Za-z0-9_]+)", normalized):
        plugin = plugin_for_tool(match.group(1))
        if plugin:
            add_count(plugins, plugin)


def project_name(cwd):
    parts = [part for part in (cwd or "").replace("\\", "/").rstrip("/").split("/") if part]
    return parts[-1] if parts else "未知專案"


def counts(values):
    return [{"name": name, "count": count} for name, count in sorted(values.items())]


def parse_file(path):
    session_id = ""
    legacy_session_id = ""
    history_start = None
    excluded_turns = []
    origin = "Codex"
    started_at = ""
    ended_at = ""
    project = "未知專案"
    model = UNKNOWN_MODEL
    service_tier = "default"
    reasoning_effort = "unknown"
    totals = token_values({})
    turns = []
    rate_used_percent = None
    rate_window_minutes = None
    skills, plugins, efforts = {}, {}, {}
    previous_total_snapshot = None
    scan_complete = True

    try:
        stream = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return None
    with stream:
        for line in stream:
            try:
                value = json.loads(line)
            except (ValueError, TypeError):
                if line.replace("\x00", "").strip():
                    scan_complete = False
                continue
            if not isinstance(value, dict):
                continue
            timestamp = value.get("timestamp") or ""
            kind = value.get("type")
            payload = value.get("payload") or {}
            ordinal = value.get("ordinal")
            if history_start is not None and kind != "session_meta" and not isinstance(ordinal, int):
                scan_complete = False
            if history_start is not None and isinstance(ordinal, int) and ordinal < history_start and kind != "session_meta":
                if payload.get("type") == "token_count":
                    usage = (payload.get("info") or {}).get("last_token_usage") or {}
                    if isinstance(usage.get("total_tokens"), int):
                        excluded_turns.append({"timestamp": timestamp, "totalTokens": usage["total_tokens"]})
                continue
            if kind == "session_meta":
                identity = payload.get("id") or payload.get("session_id") or ""
                if not identity:
                    continue
                legacy_session_id = identity
                if session_id:
                    continue
                session_id = identity
                history_start = payload.get("subagent_history_start_ordinal")
                started_at = payload.get("timestamp") or timestamp
                ended_at = started_at
                origin = payload.get("originator") or "Codex"
                project = project_name(payload.get("cwd"))
            elif kind == "turn_context":
                model = payload.get("model") or model
                if payload.get("cwd"):
                    project = project_name(payload.get("cwd"))
                if payload.get("effort"):
                    reasoning_effort = str(payload.get("effort")).strip() or reasoning_effort
                    add_count(efforts, reasoning_effort)
            elif kind == "event_msg" and payload.get("type") == "thread_settings_applied":
                settings = payload.get("thread_settings") or {}
                next_model = settings.get("model")
                if isinstance(next_model, str) and next_model.strip():
                    model = next_model
                if settings.get("service_tier") is not None:
                    reported_tier = settings["service_tier"].strip().lower()
                    service_tier = "priority" if reported_tier in ("priority", "fast") else "default"
            elif kind == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                duplicate_snapshot = False
                current_total_snapshot = None
                if info.get("total_token_usage") is not None:
                    current_total_snapshot = token_values(info.get("total_token_usage"))
                    duplicate_snapshot = current_total_snapshot == previous_total_snapshot
                if not duplicate_snapshot and info.get("last_token_usage") is not None:
                    usage = recover_token_breakdown(
                        token_values(info.get("last_token_usage")),
                        previous_total_snapshot,
                        current_total_snapshot,
                    )
                    cache_rate = usage["cachedInputTokens"] / usage["inputTokens"] * 100 if usage["inputTokens"] else 0
                    turns.append({
                        "ordinal": len(turns) + 1,
                        "timestamp": timestamp,
                        "model": model,
                        "serviceTier": service_tier,
                        "reasoningEffort": reasoning_effort,
                        "tokens": usage,
                        "estimateMicrousd": None,
                        "cacheRate": cache_rate,
                    })
                elif not duplicate_snapshot and current_total_snapshot is not None:
                    previous = (previous_total_snapshot or {}).get("totalTokens", 0)
                    current = current_total_snapshot["totalTokens"]
                    missing = current - previous if current >= previous else current
                    if missing > 0:
                        usage = token_values({"total_tokens": missing})
                        turns.append({"ordinal": len(turns) + 1, "timestamp": timestamp,
                                      "model": UNKNOWN_MODEL, "serviceTier": "default", "reasoningEffort": "unknown",
                                      "tokens": usage, "estimateMicrousd": None, "cacheRate": 0})
                if current_total_snapshot is not None:
                    previous_total_snapshot = current_total_snapshot
                primary = ((payload.get("rate_limits") or {}).get("primary") or {})
                rate_used_percent = primary.get("used_percent")
                rate_window_minutes = primary.get("window_minutes")
                if timestamp:
                    ended_at = timestamp
            elif kind == "response_item" and payload.get("type") in ("custom_tool_call", "function_call"):
                plugin = plugin_for_tool(payload.get("name") or "")
                if plugin:
                    add_count(plugins, plugin)
                raw = payload.get("input") or payload.get("arguments")
                if isinstance(raw, str):
                    analyze_tool_text(raw, skills, plugins)

    if not session_id:
        return None
    if not started_at:
        started_at = ended_at
    first_known_model = next((turn["model"] for turn in turns if turn["model"] != UNKNOWN_MODEL), None)
    first_known_model = first_known_model or (model if model != UNKNOWN_MODEL else None)
    if first_known_model:
        for turn in turns:
            if turn["model"] != UNKNOWN_MODEL:
                break
            turn["model"] = first_known_model
    totals = {key: sum(turn["tokens"][key] for turn in turns) for key in totals}
    return {
        "scanComplete": scan_complete,
        "aggregationVersion": 6,
        "sessionId": session_id,
        "importIdentity": {"legacySessionId": legacy_session_id, "excludedTurns": excluded_turns}
            if history_start is not None or legacy_session_id != session_id else None,
        "sourceId": "",
        "sourceName": "",
        "sourceKind": "ssh",
        "project": project,
        "model": model,
        "startedAt": started_at,
        "endedAt": ended_at,
        "origin": origin,
        "tokens": totals,
        "activityTokens": totals["totalTokens"],
        "estimateMicrousd": None,
        "tokenEventCount": len(turns),
        "rateUsedPercent": rate_used_percent,
        "rateWindowMinutes": rate_window_minutes,
        "activity": {"skills": counts(skills), "plugins": counts(plugins), "efforts": counts(efforts)},
        "turns": turns,
    }


since = None
if SINCE_ISO:
    try:
        # Re-read a six-hour overlap so clock skew and a file still being appended cannot create gaps.
        since = datetime.datetime.fromisoformat(SINCE_ISO.replace("Z", "+00:00")).timestamp() - 21600
    except ValueError:
        pass

roots = []
seen_roots = set()

def add_root(path):
    if not path:
        return
    path = os.path.expandvars(path.strip()).rstrip("/\\")
    key = os.path.normcase(path)
    if key not in seen_roots and any(os.path.isdir(os.path.join(path, folder)) for folder in ("sessions", "archived_sessions")):
        seen_roots.add(key)
        roots.append(path)

if "CODEX_HOME" in globals() and CODEX_HOME:
    add_root(CODEX_HOME)
elif os.name == "nt":
    add_root(os.environ.get("CODEX_HOME"))
    add_root(os.path.expanduser("~/.codex"))
    # Match PowerShell discovery without starting stopped WSL distributions.
    for provider in (r"\\wsl.localhost", r"\\wsl$"):
        try:
            with os.scandir(provider) as entries:
                distributions = [entry.path for entry in entries if entry.is_dir()]
            for distribution in distributions:
                try:
                    with os.scandir(os.path.join(distribution, "home")) as homes:
                        for home in homes:
                            if home.is_dir():
                                add_root(os.path.join(home.path, ".codex"))
                except OSError:
                    pass
                add_root(os.path.join(distribution, "root", ".codex"))
        except OSError:
            pass
else:
    add_root(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"))

if not roots:
    sys.stderr.write("CODEX_SESSIONS_NOT_FOUND")
    raise SystemExit(3)
skipped_files = 0
def walk_error(_error):
    global skipped_files
    skipped_files += 1

for base in (os.path.join(root, folder) for root in roots for folder in ("sessions", "archived_sessions")):
    if not os.path.isdir(base):
        continue
    for current, _, files in os.walk(base, onerror=walk_error):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(current, name)
            try:
                if since is not None and os.path.getmtime(path) <= since:
                    continue
            except OSError:
                skipped_files += 1
                continue
            try:
                parsed = parse_file(path)
            except (OSError, ValueError, TypeError, AttributeError):
                parsed = None
            if parsed:
                # ASCII JSON escapes preserve Unicode even when stdout uses a legacy encoding.
                print(json.dumps(parsed, ensure_ascii=True, separators=(",", ":")))
                if not parsed["scanComplete"]:
                    skipped_files += 1
            else:
                skipped_files += 1
print(json.dumps({"scanSummary": {"skippedFiles": skipped_files}}))
