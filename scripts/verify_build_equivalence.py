"""Run resource-bounded old/new build equivalence checks on a real subset."""

from __future__ import annotations

import argparse
import importlib
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow.parquet as pq
from build_equivalence_subset import SubsetLimits, build_representative_subset

ROOT = Path(__file__).resolve().parent.parent
CURRENT_SCRIPTS = ROOT / "scripts"
DEFAULT_MAX_RSS_MIB = 768
DEFAULT_MIN_AVAILABLE_MIB = 1_024
PHYSICAL_REORDER_ARTIFACTS = {"facts.idx", "facts.pack", "pages.pack"}


@dataclass(frozen=True)
class ResourceSample:
    rss_bytes: int
    cpu_percent: float


@dataclass(frozen=True)
class PhaseResult:
    name: str
    command: list[str]
    elapsed_seconds: float
    peak_rss_bytes: int
    mean_cpu_percent: float
    max_cpu_percent: float
    exit_code: int
    termination_reason: str | None
    log_path: str


class ResourceLimitError(RuntimeError):
    def __init__(
        self, message: str, result: PhaseResult | None = None
    ) -> None:
        super().__init__(message)
        self.result = result


class PhaseExecutionError(RuntimeError):
    def __init__(self, message: str, result: PhaseResult) -> None:
        super().__init__(message)
        self.result = result


_PHYSICAL_MANIFEST_FIELDS = {
    "version",
    "files",
    "total_bytes",
    "core_bytes",
    "n_files",
}


def semantic_manifest_differences(
    reference: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, tuple[Any, Any]]:
    """Return contract differences while ignoring physical packing details."""
    reference_semantic = {
        key: value
        for key, value in reference.items()
        if key not in _PHYSICAL_MANIFEST_FIELDS
    }
    candidate_semantic = {
        key: value
        for key, value in candidate.items()
        if key not in _PHYSICAL_MANIFEST_FIELDS
    }
    for manifest in (reference_semantic, candidate_semantic):
        layout = manifest.get("layout")
        if isinstance(layout, dict):
            manifest["layout"] = {
                key: value
                for key, value in layout.items()
                if key != "shape_digest"
            }
    return {
        key: (reference_semantic.get(key), candidate_semantic.get(key))
        for key in sorted(set(reference_semantic) | set(candidate_semantic))
        if reference_semantic.get(key) != candidate_semantic.get(key)
    }


def parse_ps_sample(output: str) -> ResourceSample | None:
    """Sum portable ``ps -o rss=,%cpu=`` process-group output."""
    rows = [line.split() for line in output.splitlines() if line.split()]
    if not rows:
        return None
    if any(len(fields) != 2 for fields in rows):
        raise ValueError(f"unexpected ps resource samples: {output!r}")
    return ResourceSample(
        rss_bytes=sum(int(fields[0]) for fields in rows) * 1024,
        cpu_percent=sum(float(fields[1]) for fields in rows),
    )


def _sample_process(pid: int) -> ResourceSample | None:
    sampled = subprocess.run(
        ["ps", "-o", "rss=,%cpu=", "-g", str(pid)],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "LC_ALL": "C"},
    )
    return parse_ps_sample(sampled.stdout)


def available_memory_bytes() -> int | None:
    """Return reclaimable memory on Linux/macOS when the OS exposes it."""
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        for line in meminfo.read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    if sys.platform == "darwin":
        sampled = subprocess.run(
            ["vm_stat"], check=False, capture_output=True, text=True
        )
        if sampled.returncode:
            return None
        lines = sampled.stdout.splitlines()
        if not lines:
            return None
        page_size = 4096
        marker = "page size of "
        if marker in lines[0]:
            page_size = int(lines[0].split(marker, 1)[1].split()[0])
        pages = 0
        reclaimable = (
            "Pages free",
            "Pages inactive",
            "Pages speculative",
            "Pages purgeable",
        )
        for line in lines[1:]:
            if line.startswith(reclaimable):
                pages += int(line.split(":", 1)[1].strip().rstrip("."))
        return pages * page_size
    return None


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        return
    process.wait()


def run_monitored(
    name: str,
    command: Sequence[str],
    *,
    log_path: Path,
    max_rss_bytes: int,
    min_available_bytes: int,
    timeout_seconds: float,
    poll_seconds: float = 0.25,
    cwd: Path | None = None,
    environment: dict[str, str] | None = None,
) -> PhaseResult:
    """Run one phase serially and terminate it before memory pressure wins."""
    available = available_memory_bytes() if min_available_bytes else None
    if min_available_bytes and available is None:
        raise ResourceLimitError(
            f"{name}: cannot read available memory; refusing to run "
            "without the requested system-memory guard"
        )
    if available is not None and available < min_available_bytes:
        raise ResourceLimitError(
            f"{name}: available memory {available / 2**20:.0f} MiB is below "
            f"the {min_available_bytes / 2**20:.0f} MiB start floor"
        )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    peak_rss = 0
    cpu_samples: list[float] = []
    termination_reason: str | None = None
    child_environment = {
        **os.environ,
        "PYTHONUNBUFFERED": "1",
        "LC_ALL": "C",
        **(environment or {}),
    }
    with log_path.open("wb") as log:
        process = subprocess.Popen(  # noqa: S603
            list(command),
            cwd=cwd,
            env=child_environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            next_available_check = started
            while process.poll() is None:
                sample = _sample_process(process.pid)
                if sample is not None:
                    peak_rss = max(peak_rss, sample.rss_bytes)
                    cpu_samples.append(sample.cpu_percent)
                    if sample.rss_bytes > max_rss_bytes:
                        termination_reason = (
                            "RSS budget exceeded: "
                            f"{sample.rss_bytes / 2**20:.0f} > "
                            f"{max_rss_bytes / 2**20:.0f} MiB"
                        )
                now = time.monotonic()
                if (
                    termination_reason is None
                    and now - started > timeout_seconds
                ):
                    termination_reason = (
                        f"timeout exceeded: {timeout_seconds:.0f}s"
                    )
                if (
                    termination_reason is None
                    and min_available_bytes
                    and now >= next_available_check
                ):
                    available = available_memory_bytes()
                    next_available_check = now + 2
                    if available is None:
                        termination_reason = (
                            "cannot read available memory during execution"
                        )
                    elif available < min_available_bytes:
                        termination_reason = (
                            "system available-memory floor crossed: "
                            f"{available / 2**20:.0f} < "
                            f"{min_available_bytes / 2**20:.0f} MiB"
                        )
                if termination_reason is not None:
                    _terminate_process_group(process)
                    break
                time.sleep(poll_seconds)
            exit_code = process.wait()
        except BaseException:
            if process.poll() is None:
                _terminate_process_group(process)
            raise
    elapsed = time.monotonic() - started
    result = PhaseResult(
        name=name,
        command=list(command),
        elapsed_seconds=elapsed,
        peak_rss_bytes=peak_rss,
        mean_cpu_percent=(
            sum(cpu_samples) / len(cpu_samples) if cpu_samples else 0.0
        ),
        max_cpu_percent=max(cpu_samples, default=0.0),
        exit_code=exit_code,
        termination_reason=termination_reason,
        log_path=str(log_path),
    )
    if termination_reason is not None:
        raise ResourceLimitError(f"{name}: {termination_reason}", result)
    if exit_code:
        raise PhaseExecutionError(
            f"{name}: command exited {exit_code}; see {log_path}", result
        )
    return result


def materialize_git_scripts(
    repository: Path, reference: str, destination: Path
) -> str:
    """Materialize tracked Python scripts at a Git ref without a worktree."""
    resolved = subprocess.run(
        ["git", "rev-parse", "--verify", f"{reference}^{{commit}}"],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    listed = subprocess.run(
        ["git", "ls-tree", "-rz", "--name-only", resolved, "--", "scripts"],
        cwd=repository,
        check=True,
        capture_output=True,
    ).stdout
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError(
            f"baseline script destination is not empty: {destination}"
        )
    for raw_path in listed.split(b"\0"):
        if not raw_path:
            continue
        relative = Path(raw_path.decode())
        if relative.parts[0] != "scripts" or relative.suffix != ".py":
            continue
        target = destination / relative.relative_to("scripts")
        target.parent.mkdir(parents=True, exist_ok=True)
        content = subprocess.run(
            ["git", "show", f"{resolved}:{relative.as_posix()}"],
            cwd=repository,
            check=True,
            capture_output=True,
        ).stdout
        target.write_bytes(content)
    return resolved


def _import_candidate(source_dir: Path, module_name: str) -> Any:
    sys.path.insert(0, str(source_dir))
    importlib.invalidate_caches()
    return importlib.import_module(module_name)


def _run_layout_phase(
    source_dir: Path, subset_root: Path, run_root: Path
) -> None:
    layout = _import_candidate(source_dir, "layout")
    layout.PARQUET = subset_root / "parquet"
    layout.OUT = run_root / "layout"
    sys.argv = [str(source_dir / "layout.py")]
    layout.main()


def _run_bake_phase(
    source_dir: Path, subset_root: Path, run_root: Path
) -> None:
    bake = _import_candidate(source_dir, "bake_site")
    bake.PARQUET = subset_root / "parquet"
    bake.LAYOUT = run_root / "layout" / "coords.parquet"
    bake.LAYOUT_REPORT = run_root / "layout" / "report.json"
    bake.DUMP_VERSION = subset_root / "dump" / "VERSION"
    bake.DUMP_ZIP = subset_root / "dump.zip"
    bake.SITE = run_root / "site" / "data"
    sys.argv = [str(source_dir / "bake_site.py")]
    bake.main()


def _run_verify_phase(
    source_dir: Path, subset_root: Path, run_root: Path
) -> None:
    verify = _import_candidate(source_dir, "verify_site")
    verify.PARQUET = subset_root / "parquet"
    verify.SITE = run_root / "site" / "data"
    verify.SITE_ROOT = run_root / "site"
    sys.argv = [str(source_dir / "verify_site.py")]
    verify.main()


def _phase_main(arguments: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "phase", choices=("prepare", "layout", "bake", "verify")
    )
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--source-parquet", type=Path)
    parser.add_argument("--subset-root", type=Path, required=True)
    parser.add_argument("--run-root", type=Path)
    parser.add_argument("--subjects", type=int, default=2_048)
    parser.add_argument("--people", type=int, default=1_024)
    parser.add_argument("--characters", type=int, default=2_048)
    parser.add_argument("--nice", type=int, default=10)
    args = parser.parse_args(arguments)
    if args.nice and hasattr(os, "nice"):
        os.nice(args.nice)
    if args.phase == "prepare":
        if args.source_parquet is None:
            parser.error("prepare requires --source-parquet")
        report = build_representative_subset(
            args.source_parquet,
            args.subset_root,
            SubsetLimits(args.subjects, args.people, args.characters),
        )
        print(orjson.dumps(report).decode(), flush=True)
        return 0
    if args.source_dir is None or args.run_root is None:
        parser.error(f"{args.phase} requires --source-dir and --run-root")
    if args.phase == "layout":
        _run_layout_phase(args.source_dir, args.subset_root, args.run_root)
    elif args.phase == "bake":
        _run_bake_phase(args.source_dir, args.subset_root, args.run_root)
    else:
        _run_verify_phase(args.source_dir, args.subset_root, args.run_root)
    return 0


def compare_layout_outputs(
    reference: Path, candidate: Path, *, coordinate_atol: float
) -> dict[str, Any]:
    """Require identical layout semantics apart from the source digest."""
    reference_table = pq.read_table(reference / "coords.parquet")
    candidate_table = pq.read_table(candidate / "coords.parquet")
    if reference_table.column_names != candidate_table.column_names:
        raise RuntimeError("layout coordinate columns differ")
    max_coordinate_delta = 0.0
    for column in reference_table.column_names:
        expected = np.asarray(reference_table.column(column))
        actual = np.asarray(candidate_table.column(column))
        if column in {"x", "y", "z"}:
            if expected.shape != actual.shape:
                raise RuntimeError(f"layout {column} shape differs")
            delta = (
                float(np.max(np.abs(expected - actual)))
                if len(expected)
                else 0.0
            )
            max_coordinate_delta = max(max_coordinate_delta, delta)
            if not np.allclose(
                expected, actual, rtol=0.0, atol=coordinate_atol
            ):
                raise RuntimeError(
                    f"layout {column} differs by {delta:g}, "
                    f"above tolerance {coordinate_atol:g}"
                )
        elif not np.array_equal(expected, actual):
            raise RuntimeError(f"layout {column} differs")
    reference_report = orjson.loads((reference / "report.json").read_bytes())
    candidate_report = orjson.loads((candidate / "report.json").read_bytes())
    reference_digest = reference_report.pop("shape_digest")
    candidate_digest = candidate_report.pop("shape_digest")
    if reference_report != candidate_report:
        raise RuntimeError("layout reports differ beyond shape_digest")
    return {
        "nodes": reference_table.num_rows,
        "max_coordinate_delta": max_coordinate_delta,
        "reference_shape_digest": reference_digest,
        "candidate_shape_digest": candidate_digest,
    }


def compare_site_outputs(reference: Path, candidate: Path) -> dict[str, Any]:
    """Compare logical manifests after both sites pass independent decoding."""
    reference_manifest = orjson.loads(
        (reference / "manifest.json").read_bytes()
    )
    candidate_manifest = orjson.loads(
        (candidate / "manifest.json").read_bytes()
    )
    differences = semantic_manifest_differences(
        reference_manifest, candidate_manifest
    )
    if differences:
        raise RuntimeError(
            f"semantic site manifest fields differ: {sorted(differences)}"
        )
    reference_files = reference_manifest["files"]
    candidate_files = candidate_manifest["files"]
    if set(reference_files) != set(candidate_files):
        raise RuntimeError("logical site artifact names differ")
    changed = sorted(
        logical_name
        for logical_name in reference_files
        if reference_files[logical_name][1] != candidate_files[logical_name][1]
    )
    unexpected = sorted(set(changed) - PHYSICAL_REORDER_ARTIFACTS)
    if unexpected:
        raise RuntimeError(
            f"unexpected byte-level artifact differences: {unexpected}"
        )
    return {
        "logical_artifacts": len(reference_files),
        "byte_identical_artifacts": len(reference_files) - len(changed),
        "allowed_repacked_artifacts": changed,
        "counts": reference_manifest["counts"],
    }


def _phase_command(
    phase: str,
    *,
    subset_root: Path,
    nice: int,
    source_dir: Path | None = None,
    source_parquet: Path | None = None,
    run_root: Path | None = None,
    limits: SubsetLimits | None = None,
) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "_phase",
        phase,
        "--subset-root",
        str(subset_root),
        "--nice",
        str(nice),
    ]
    if source_dir is not None:
        command.extend(["--source-dir", str(source_dir)])
    if source_parquet is not None:
        command.extend(["--source-parquet", str(source_parquet)])
    if run_root is not None:
        command.extend(["--run-root", str(run_root)])
    if limits is not None:
        command.extend(
            [
                "--subjects",
                str(limits.subjects),
                "--people",
                str(limits.people),
                "--characters",
                str(limits.characters),
            ]
        )
    return command


def _write_equivalence_report(path: Path, report: dict[str, Any]) -> None:
    path.write_bytes(orjson.dumps(report, option=orjson.OPT_INDENT_2))


def run_equivalence(
    *,
    baseline_ref: str,
    source_parquet: Path,
    output: Path,
    limits: SubsetLimits,
    max_rss_mib: int,
    min_available_mib: int,
    timeout_seconds: float,
    nice: int,
    coordinate_atol: float,
) -> dict[str, Any]:
    """Execute the complete differential workflow serially."""
    if not 0 <= nice <= 19:
        raise ValueError("nice must be between 0 and 19")
    limits.validate()
    output.mkdir(parents=True, exist_ok=False)
    logs = output / "logs"
    baseline_scripts = output / "baseline-scripts"
    subset_root = output / "subset"
    reference_root = output / "reference"
    candidate_root = output / "candidate"
    report_path = output / "report.json"
    resources: list[PhaseResult] = []
    report: dict[str, Any] = {
        "status": "running",
        "baseline_ref": baseline_ref,
        "candidate": "working-tree",
        "output": str(output),
        "limits": {
            "max_rss_mib": max_rss_mib,
            "min_available_mib": min_available_mib,
            "timeout_seconds": timeout_seconds,
            "nice": nice,
        },
        "resources": [],
    }
    _write_equivalence_report(report_path, report)

    try:
        resolved_ref = materialize_git_scripts(
            ROOT, baseline_ref, baseline_scripts
        )
        report["baseline_commit"] = resolved_ref
        phase_environment = {
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "VECLIB_MAXIMUM_THREADS": "1",
            "NUMEXPR_NUM_THREADS": "1",
        }

        def run_phase(name: str, command: list[str]) -> None:
            print(f"[{name}] running serially; log={logs / f'{name}.log'}")
            try:
                result = run_monitored(
                    name,
                    command,
                    log_path=logs / f"{name}.log",
                    max_rss_bytes=max_rss_mib * 2**20,
                    min_available_bytes=min_available_mib * 2**20,
                    timeout_seconds=timeout_seconds,
                    cwd=ROOT,
                    environment=phase_environment,
                )
            except (ResourceLimitError, PhaseExecutionError) as error:
                if error.result is not None:
                    resources.append(error.result)
                raise
            resources.append(result)
            report["resources"] = [asdict(item) for item in resources]
            _write_equivalence_report(report_path, report)
            print(
                f"[{name}] {result.elapsed_seconds:.1f}s, peak RSS "
                f"{result.peak_rss_bytes / 2**20:.1f} MiB, max CPU "
                f"{result.max_cpu_percent:.0f}%"
            )

        run_phase(
            "prepare-subset",
            _phase_command(
                "prepare",
                subset_root=subset_root,
                source_parquet=source_parquet,
                limits=limits,
                nice=nice,
            ),
        )
        report["subset"] = orjson.loads(
            (subset_root / "subset-report.json").read_bytes()
        )
        run_phase(
            "reference-layout",
            _phase_command(
                "layout",
                subset_root=subset_root,
                source_dir=baseline_scripts,
                run_root=reference_root,
                nice=nice,
            ),
        )
        run_phase(
            "candidate-layout",
            _phase_command(
                "layout",
                subset_root=subset_root,
                source_dir=CURRENT_SCRIPTS,
                run_root=candidate_root,
                nice=nice,
            ),
        )
        report["layout_equivalence"] = compare_layout_outputs(
            reference_root / "layout",
            candidate_root / "layout",
            coordinate_atol=coordinate_atol,
        )
        _write_equivalence_report(report_path, report)
        print("[layout-equivalence] passed")

        for name, source_dir, run_root in (
            ("reference-bake", baseline_scripts, reference_root),
            ("candidate-bake", CURRENT_SCRIPTS, candidate_root),
        ):
            run_phase(
                name,
                _phase_command(
                    "bake",
                    subset_root=subset_root,
                    source_dir=source_dir,
                    run_root=run_root,
                    nice=nice,
                ),
            )
        for name, run_root in (
            ("reference-verify", reference_root),
            ("candidate-verify", candidate_root),
        ):
            run_phase(
                name,
                _phase_command(
                    "verify",
                    subset_root=subset_root,
                    source_dir=CURRENT_SCRIPTS,
                    run_root=run_root,
                    nice=nice,
                ),
            )
        report["site_equivalence"] = compare_site_outputs(
            reference_root / "site" / "data",
            candidate_root / "site" / "data",
        )
        report["status"] = "passed"
        report["resources"] = [asdict(item) for item in resources]
        _write_equivalence_report(report_path, report)
        print(f"equivalence passed; report={report_path}")
        return report
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        report["resources"] = [asdict(item) for item in resources]
        _write_equivalence_report(report_path, report)
        raise


def main(arguments: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compare a Git baseline and the working tree on a bounded real "
            "Parquet subset."
        )
    )
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument(
        "--source-parquet", type=Path, default=ROOT / "data" / "parquet"
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--subjects", type=int, default=2_048)
    parser.add_argument("--people", type=int, default=1_024)
    parser.add_argument("--characters", type=int, default=2_048)
    parser.add_argument("--max-rss-mib", type=int, default=DEFAULT_MAX_RSS_MIB)
    parser.add_argument(
        "--min-available-mib",
        type=int,
        default=DEFAULT_MIN_AVAILABLE_MIB,
    )
    parser.add_argument("--timeout-seconds", type=float, default=600)
    parser.add_argument("--nice", type=int, default=10)
    parser.add_argument("--coordinate-atol", type=float, default=1e-6)
    args = parser.parse_args(arguments)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = args.output or (
        ROOT / "data" / "verifications" / f"equivalence-{timestamp}"
    )
    print(
        f"output={output}; per-phase RSS <= {args.max_rss_mib} MiB; "
        f"system available >= {args.min_available_mib} MiB"
    )
    run_equivalence(
        baseline_ref=args.baseline_ref,
        source_parquet=args.source_parquet.resolve(),
        output=output.resolve(),
        limits=SubsetLimits(args.subjects, args.people, args.characters),
        max_rss_mib=args.max_rss_mib,
        min_available_mib=args.min_available_mib,
        timeout_seconds=args.timeout_seconds,
        nice=args.nice,
        coordinate_atol=args.coordinate_atol,
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "_phase":
        raise SystemExit(_phase_main(sys.argv[2:]))
    raise SystemExit(main())
