#!/usr/bin/env bash
set -euo pipefail

cd /opt/Workspace/CRX/enterprice_knowledge_agent
exec /opt/miniconda3/envs/deepagent/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 1752

export GIT_DIR=.git-local
export GIT_WORK_TREE=.