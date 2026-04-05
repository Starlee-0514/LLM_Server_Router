"""
Bug / Adjustment report routes.

Reports are persisted as Markdown files under <project_root>/bug_reports/.
"""
import base64
import os
import re
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/reports", tags=["reports"])

REPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "bug_reports")
REPORT_DIR = os.path.abspath(REPORT_DIR)
IMAGE_DIR = os.path.join(REPORT_DIR, "images")


# ── Schemas ──────────────────────────────────────────────────────────────────

class ReportCreate(BaseModel):
    report_type: str  # "bug" | "adjustment"
    title: str
    component: str
    priority: str
    category: str
    description: str
    steps_to_reproduce: Optional[str] = ""
    expected_behavior: Optional[str] = ""
    actual_behavior: Optional[str] = ""
    proposed_adjustment: Optional[str] = ""
    benefits: Optional[str] = ""
    technical_notes: Optional[str] = ""
    effort: Optional[str] = ""
    environment: Optional[str] = ""
    console_errors: Optional[str] = ""
    additional_context: Optional[str] = ""


class ReportSummary(BaseModel):
    filename: str
    title: str
    report_type: str
    created_at: str


class ReportDetail(BaseModel):
    filename: str
    content: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def _safe_filename(title: str) -> str:
    """Sanitise a title into a safe filename."""
    slug = re.sub(r"[^a-zA-Z0-9_\- ]", "", title).strip().replace(" ", "_")
    if not slug:
        slug = "report"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{slug}_{ts}.md"


def _render_bug(data: ReportCreate) -> str:
    lines = [
        f"# Bug Report: {data.title}",
        "",
        f"**Component:** {data.component}  ",
        f"**Severity:** {data.priority}  ",
        f"**Category:** {data.category}  ",
        f"**Created:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "---",
        "",
        "## Description",
        "",
        data.description,
        "",
    ]
    if data.steps_to_reproduce:
        lines += ["## Steps to Reproduce", "", data.steps_to_reproduce, ""]
    if data.expected_behavior:
        lines += ["## Expected Behavior", "", data.expected_behavior, ""]
    if data.actual_behavior:
        lines += ["## Actual Behavior", "", data.actual_behavior, ""]
    if data.environment:
        lines += ["## Environment", "", data.environment, ""]
    if data.console_errors:
        lines += ["## Console Errors", "", "```", data.console_errors, "```", ""]
    if data.technical_notes:
        lines += ["## Technical Notes", "", data.technical_notes, ""]
    if data.additional_context:
        lines += ["## Additional Context", "", data.additional_context, ""]
    return "\n".join(lines)


def _render_adjustment(data: ReportCreate) -> str:
    lines = [
        f"# Adjustment Recommendation: {data.title}",
        "",
        f"**Component:** {data.component}  ",
        f"**Priority:** {data.priority}  ",
        f"**Category:** {data.category}  ",
        f"**Created:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "---",
        "",
        "## Current State",
        "",
        data.description,
        "",
    ]
    if data.proposed_adjustment:
        lines += ["## Proposed Adjustment", "", data.proposed_adjustment, ""]
    if data.benefits:
        lines += ["## Benefits", "", data.benefits, ""]
    if data.technical_notes:
        lines += ["## Technical Considerations", "", data.technical_notes, ""]
    if data.effort:
        lines += [f"## Estimated Effort", "", data.effort, ""]
    if data.additional_context:
        lines += ["## Additional Notes", "", data.additional_context, ""]
    return "\n".join(lines)


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("", response_model=List[ReportSummary])
def list_reports():
    """List all saved reports."""
    os.makedirs(REPORT_DIR, exist_ok=True)
    results: List[ReportSummary] = []
    for fname in sorted(os.listdir(REPORT_DIR), reverse=True):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(REPORT_DIR, fname)
        # Parse first line for title, detect type from heading
        title = fname
        report_type = "unknown"
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                first_line = f.readline().strip()
            if first_line.startswith("# Bug Report:"):
                title = first_line.replace("# Bug Report:", "").strip()
                report_type = "bug"
            elif first_line.startswith("# Adjustment Recommendation:"):
                title = first_line.replace("# Adjustment Recommendation:", "").strip()
                report_type = "adjustment"
            elif first_line.startswith("# "):
                title = first_line[2:].strip()
                report_type = "other"
        except Exception:
            pass
        stat = os.stat(fpath)
        created = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        results.append(ReportSummary(filename=fname, title=title, report_type=report_type, created_at=created))
    return results


@router.get("/{filename}", response_model=ReportDetail)
def get_report(filename: str):
    """Read a single report file."""
    # Prevent path traversal
    safe = os.path.basename(filename)
    fpath = os.path.join(REPORT_DIR, safe)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail="Report not found")
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()
    return ReportDetail(filename=safe, content=content)


@router.post("", response_model=ReportSummary, status_code=201)
def create_report(data: ReportCreate):
    """Create a new report and save to bug_reports/."""
    os.makedirs(REPORT_DIR, exist_ok=True)
    fname = _safe_filename(data.title)

    if data.report_type == "bug":
        content = _render_bug(data)
    else:
        content = _render_adjustment(data)

    fpath = os.path.join(REPORT_DIR, fname)
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(content)

    return ReportSummary(
        filename=fname,
        title=data.title,
        report_type=data.report_type,
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


@router.delete("/{filename}")
def delete_report(filename: str):
    """Delete a report file."""
    safe = os.path.basename(filename)
    fpath = os.path.join(REPORT_DIR, safe)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail="Report not found")
    os.remove(fpath)
    return {"ok": True}


# ── Image upload / serve ─────────────────────────────────────────────────────

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/upload-image")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image (paste from clipboard). Returns the filename."""
    ext = os.path.splitext(file.filename or ".png")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {ext}")

    data = await file.read()
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=400, detail="Image too large (max 10 MB)")

    os.makedirs(IMAGE_DIR, exist_ok=True)
    safe_name = f"{uuid.uuid4().hex[:12]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}{ext}"
    fpath = os.path.join(IMAGE_DIR, safe_name)
    with open(fpath, "wb") as f:
        f.write(data)

    return {"filename": safe_name}


@router.get("/images/{filename}")
def serve_image(filename: str):
    """Serve an uploaded report image."""
    safe = os.path.basename(filename)
    fpath = os.path.join(IMAGE_DIR, safe)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(fpath)
