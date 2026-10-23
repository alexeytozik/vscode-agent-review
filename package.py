#!/usr/bin/env python3
"""Build a standard VSIX using the locally installed packaging tool."""
import json
import pathlib
import subprocess
import sys
root = pathlib.Path(__file__).resolve().parent
package = json.loads((root / 'package.json').read_text())
destination = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else f'/tmp/agent-review-{package["version"]}.vsix')
subprocess.run(['npm', 'run', 'package', '--', '--out', str(destination)], cwd=root, check=True)
