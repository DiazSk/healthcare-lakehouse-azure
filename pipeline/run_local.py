#!/usr/bin/env python
"""Run the medallion notebooks locally, without Azure.

Usage:
    python pipeline/run_local.py                 # full chain: 01 -> 02 -> 03 -> 04 -> 99
    python pipeline/run_local.py --sample        # same chain on 1,000 Bronze rows
    python pipeline/run_local.py 01 99           # just these, by numeric prefix

Executes each notebook's code cells in a fresh namespace rather than going through
a Jupyter kernel. That avoids four new dependencies (nbclient, nbformat, ipykernel,
jupyter_client) plus a kernelspec registration step -- notebooks 02/03/04/99 carry
no `metadata.kernelspec` at all -- and it keeps every notebook in ONE JVM, so the
Delta jars resolve once and notebook 04's cached fact table is still warm for 99.

The trade-off is that cell outputs are not written back into the .ipynb files, so
stdout is teed to pipeline/RUN_LOG.md as the run record instead.

100_register_tables.ipynb is intentionally excluded: it registers Delta paths into
the Databricks Hive metastore, which has no local equivalent.
"""

import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NOTEBOOKS = REPO / "notebooks"
CHAIN = ["01", "02", "03", "04", "99"]
LOG = REPO / "pipeline" / "RUN_LOG.md"


class Tee:
    """Mirror stdout to the log file so the run is reproducible evidence."""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for s in self.streams:
            s.write(data)
            s.flush()
        return len(data)

    def flush(self):
        for s in self.streams:
            s.flush()


def code_cells(path: Path):
    nb = json.loads(path.read_text())
    for i, cell in enumerate(nb["cells"]):
        if cell["cell_type"] != "code":
            continue
        src = "".join(cell["source"])
        if src.strip():
            yield i, src


def run_notebook(path: Path) -> None:
    print(f"\n{'=' * 72}\n>>> {path.name}\n{'=' * 72}")
    # Fresh namespace per notebook, but the SparkSession is process-global, so
    # getOrCreate() hands each notebook the same warm session.
    ns = {"__name__": "__main__", "__file__": str(path)}
    for idx, src in code_cells(path):
        try:
            exec(compile(src, f"{path.name}[cell {idx}]", "exec"), ns)
        except Exception:
            print(f"\n!!! FAILED in {path.name} cell {idx}", file=sys.stderr)
            raise


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sample = "--sample" in sys.argv

    os.environ.setdefault("LAKEHOUSE_LOCAL_ROOT", str(REPO / "data"))
    # Only the Homebrew JDK 11 is registered today, but unregistered 21/25 cellars
    # exist -- if either is ever linked, the bare `java` stub would silently switch
    # and Spark 3.5 would break. Pin it.
    jdk11 = Path("/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home")
    if jdk11.is_dir():
        os.environ.setdefault("JAVA_HOME", str(jdk11))
    os.environ["SAMPLE_MODE"] = "true" if sample else "false"

    sys.path.insert(0, str(NOTEBOOKS))
    os.chdir(NOTEBOOKS)

    wanted = args or CHAIN
    targets = []
    for prefix in wanted:
        matches = sorted(NOTEBOOKS.glob(f"{prefix}_*.ipynb"))
        if not matches:
            print(f"no notebook matching {prefix}_*.ipynb", file=sys.stderr)
            return 2
        targets.extend(matches)

    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as fh:
        real_stdout = sys.stdout
        sys.stdout = Tee(real_stdout, fh)
        started = time.time()
        try:
            print(f"\n\n# Local run — {time.strftime('%Y-%m-%d %H:%M:%S')}"
                  f" (sample_mode={sample})\n\n```")
            print(f"LAKEHOUSE_LOCAL_ROOT={os.environ['LAKEHOUSE_LOCAL_ROOT']}")
            for nb in targets:
                t0 = time.time()
                run_notebook(nb)
                print(f"<<< {nb.name} completed in {time.time() - t0:.1f}s")
            print(f"\nTOTAL: {time.time() - started:.1f}s")
            return 0
        except Exception as exc:
            print(f"\nRUN FAILED after {time.time() - started:.1f}s: "
                  f"{type(exc).__name__}: {exc}")
            raise
        finally:
            print("```")
            sys.stdout = real_stdout


if __name__ == "__main__":
    sys.exit(main())
