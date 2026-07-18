#!/usr/bin/env bash

set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if [[ -n "${PYTHON_BIN:-}" ]]; then
  python_command="$PYTHON_BIN"
elif command -v python3 >/dev/null 2>&1; then
  python_command="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  python_command="$(command -v python)"
else
  echo "Error: Python 3 was not found. Install Python 3.10 or newer and try again." >&2
  exit 1
fi

venv_dir="${VENV_DIR:-.venv}"

if [[ ! -d "$venv_dir" ]]; then
  echo "Creating Python environment in $venv_dir..."
  "$python_command" -m venv "$venv_dir"
fi

if [[ -x "$venv_dir/bin/python" ]]; then
  venv_python="$venv_dir/bin/python"
elif [[ -f "$venv_dir/Scripts/python.exe" ]]; then
  venv_python="$venv_dir/Scripts/python.exe"
else
  echo "Error: $venv_dir exists but does not contain a usable Python interpreter." >&2
  echo "Remove or rename that directory, then run this script again." >&2
  exit 1
fi

echo "Updating pip..."
"$venv_python" -m pip install --upgrade pip

echo "Installing realtime sensing dependencies..."
"$venv_python" -m pip install -r "$project_dir/requirements.txt"

echo "Starting WebAgent realtime deployment on port ${PORT:-8000}..."
exec "$venv_python" "$project_dir/realtime.py"
