"""Exit 0 when a run folder's prompt-N.txt files match the suite file's prompts."""
import pathlib
import sys

suite, run = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
want = [p.strip() for p in suite.read_text().split("\n---\n")]
have = [p.read_text().strip() for p in sorted(run.glob("prompt-*.txt"), key=lambda p: int(p.stem.split("-")[1]))]
sys.exit(0 if want == have else 1)
