# Download one local model for Hindsight into the standard Hugging Face cache, then check that it loads offline.
# Run by the daemon (deploy/hindsight-models.ts) inside Hindsight's own Python environment:
#   uvx ... --from hindsight-api@<version> python -I hindsight-download.py <repo_id> <embedding|reranker> [<revision>]
# It writes one JSON object per line to stdout: start, progress (at most once a second), verified, error.
# "verified" carries the commit (revision) and the snapshot directory (path). Hindsight loads the model from
# that directory with no network, so it runs exactly the files that were downloaded and checked here.
#
# Why a separate download: Hindsight downloads missing models at startup, but its model init has a
# 300 s timeout, and a first download of a 2 GB model takes longer, so the service fails to start
# (2026-10-16 smoke test). The user also decided that a local model downloads only after they pick it.
#
# Why a pinned revision: the default models are pinned to a commit (hindsight-models.ts). For a model the
# user names, main is resolved to a commit once, here, and that commit is what gets used.
#
# Why safetensors only (2026-10-16 release review): pytorch_model.bin is a pickle, and loading a pickle can
# run code. A repo whose weights exist only as .bin is refused.
#
# Why a file list: model repos carry several copies of the weights (ONNX, OpenVINO, pytorch_model.bin).
# sentence-transformers needs one copy, plus the config and tokenizer files. Downloading the repo
# would fetch 2-6 times the data. Python files are never downloaded, and remote code stays off.
import json
import os
import re
import subprocess
import sys
import time

REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SKIP_DIRS = ("onnx/", "openvino/", "imgs/", "images/", "assets/")
SKIP_EXT = (".onnx", ".onnx_data", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".md", ".pt", ".msgpack", ".h5", ".ot", ".gitattributes", ".py")
KEEP_EXT = (".json", ".txt", ".model")
# sentence-transformers module folders, such as 1_Pooling or 2_Dense.
MODULE_DIR = re.compile(r"^\d+_[A-Za-z]+/")
SHARD = re.compile(r"^model-\d+-of-\d+\.safetensors$")


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def wanted_files(entries):
    """Pick the files sentence-transformers loads: configs, tokenizer files, and the safetensors weights.

    Returns (files, problem). problem names a folder whose weights exist only as pytorch_model.bin.
    """
    sizes = {e.path: e.size for e in entries if getattr(e, "size", None) is not None}
    picked = {}
    folders = {""} | {m.group(0) for p in sizes if (m := MODULE_DIR.match(p))}
    for folder in sorted(folders):
        here = {p: s for p, s in sizes.items() if p.startswith(folder) and "/" not in p[len(folder):]}
        for path, size in here.items():
            name = path[len(folder):]
            if path.startswith(SKIP_DIRS) or name.endswith(SKIP_EXT):
                continue
            if name.endswith(KEEP_EXT) or name.startswith("tokenizer"):
                picked[path] = size
        safetensors = [p for p in here if p[len(folder):] == "model.safetensors" or SHARD.match(p[len(folder):])]
        for path in safetensors:
            picked[path] = here[path]
        if not safetensors and f"{folder}pytorch_model.bin" in here:
            return picked, f"{folder or 'the repo root'} has only pytorch_model.bin (a pickle); only safetensors weights are accepted"
    return picked, None


def main():
    args = sys.argv[1:]
    if not (2 <= len(args) <= 3) or not REPO.match(args[0]) or args[1] not in ("embedding", "reranker") \
            or (len(args) == 3 and not REVISION.match(args[2])):
        emit("error", message="usage: hindsight-download.py <owner/name> <embedding|reranker> [<40-hex commit>]")
        return 2
    repo, kind = args[0], args[1]

    from huggingface_hub import HfApi, hf_hub_download
    from tqdm.auto import tqdm

    api = HfApi()
    revision = args[2] if len(args) == 3 else api.model_info(repo).sha
    if not revision or not REVISION.match(revision):
        emit("error", message=f"{repo}: could not resolve the main branch to a commit")
        return 1
    files, problem = wanted_files(api.list_repo_tree(repo, recursive=True, revision=revision))
    if problem:
        emit("error", message=f"{repo}: {problem}")
        return 1
    if not any(p.endswith(".safetensors") for p in files):
        emit("error", message=f"{repo} has no safetensors weights")
        return 1
    total = sum(files.values())
    emit("start", repo=repo, revision=revision, total=total, files=len(files))

    state = {"done": 0, "sent": 0.0}

    class Progress(tqdm):
        def update(self, n=1):
            state["done"] += n or 0
            now = time.monotonic()
            if now - state["sent"] >= 1.0:
                state["sent"] = now
                emit("progress", bytes=min(state["done"], total), total=total)
            return super().update(n)

    snapshot = None
    for path, size in sorted(files.items(), key=lambda item: item[1]):
        before = state["done"]
        local = hf_hub_download(repo, path, revision=revision, tqdm_class=Progress)
        if "/" not in path:
            snapshot = os.path.dirname(local)
        # A cached file reports no progress. Count it as done.
        state["done"] = max(state["done"], before + size)
    emit("progress", bytes=total, total=total)
    if snapshot is None:
        emit("error", message=f"{repo} has no files at the repo root")
        return 1

    # Load it the way Hindsight does: from the snapshot directory, with no network and no remote code.
    loader = "SentenceTransformer" if kind == "embedding" else "CrossEncoder"
    check = subprocess.run(
        [sys.executable, "-I", "-c",
         f"from sentence_transformers import {loader}; {loader}({snapshot!r}, device='cpu', trust_remote_code=False)"],
        env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
        capture_output=True, text=True,
    )
    if check.returncode != 0:
        emit("error", message=f"{repo} does not load offline: {check.stderr.strip().splitlines()[-1] if check.stderr.strip() else 'unknown error'}"[:400])
        return 1
    emit("verified", repo=repo, revision=revision, path=snapshot, total=total)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - report every failure as one JSON line
        emit("error", message=f"{type(error).__name__}: {error}"[:400])
        sys.exit(1)
