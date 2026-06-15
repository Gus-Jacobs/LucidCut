# Epic Video Editor — Backend (prototype)

This folder contains a minimal prototype backend to handle uploads and spawn a Python worker to process videos.

Quick start (macOS / Linux):

```bash
cd backend
# install node deps
npm install

# install python deps (prefer a venv)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# start server
npm start
```

The server exposes:
- `POST /api/upload` — multipart form `video` file plus optional `language`, `impurityDetection`, `actions` fields
- `GET /api/jobs/:id` — job status
- `GET /api/jobs/:id/download` — download output when ready

This is a prototype: replace the in-memory job store and spawn model with a proper queue and worker pool for production.
