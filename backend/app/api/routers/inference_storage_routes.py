"""
Inference storage API — syncs system-prompt profiles and chat sessions across devices.

Endpoints:
  GET    /api/inference/profiles              - List all system prompt profiles
  PUT    /api/inference/profiles/:id          - Upsert a profile (create or update)
  DELETE /api/inference/profiles/:id          - Delete a profile

  GET    /api/inference/sessions              - List all chat sessions (messages omitted by default)
  GET    /api/inference/sessions/:id          - Get a single session with messages
  PUT    /api/inference/sessions/:id          - Upsert a session
  DELETE /api/inference/sessions/:id          - Delete a session
"""
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.app.database import get_db
from backend.app.models import ChatSession, SystemPromptProfile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/inference", tags=["inference-storage"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ProfilePayload(BaseModel):
    id: str
    name: str
    content: str


class ProfileResponse(BaseModel):
    id: str
    name: str
    content: str
    created_at: str
    updated_at: str


class ChatMessageItem(BaseModel):
    role: str
    content: str


class SessionPayload(BaseModel):
    id: str
    title: str = "New Chat"
    model: str = ""
    messages: list[dict] = []


class SessionSummary(BaseModel):
    id: str
    title: str
    model: str
    message_count: int
    created_at: str
    updated_at: str


class SessionDetail(BaseModel):
    id: str
    title: str
    model: str
    messages: list[dict]
    created_at: str
    updated_at: str


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------

@router.get("/profiles", response_model=list[ProfileResponse])
def list_profiles(db: Session = Depends(get_db)):
    rows = db.query(SystemPromptProfile).order_by(SystemPromptProfile.created_at).all()
    return [
        ProfileResponse(
            id=r.id, name=r.name, content=r.content,
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat(),
        )
        for r in rows
    ]


@router.put("/profiles/{profile_id}", response_model=ProfileResponse)
def upsert_profile(profile_id: str, payload: ProfilePayload, db: Session = Depends(get_db)):
    if profile_id != payload.id:
        raise HTTPException(status_code=422, detail="URL id must match payload id")
    if not payload.name.strip():
        raise HTTPException(status_code=422, detail="name is required")

    existing = db.query(SystemPromptProfile).filter(SystemPromptProfile.id == profile_id).first()
    if existing:
        existing.name = payload.name
        existing.content = payload.content
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        row = existing
    else:
        row = SystemPromptProfile(id=profile_id, name=payload.name, content=payload.content)
        db.add(row)
        db.commit()
        db.refresh(row)

    return ProfileResponse(
        id=row.id, name=row.name, content=row.content,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str, db: Session = Depends(get_db)):
    row = db.query(SystemPromptProfile).filter(SystemPromptProfile.id == profile_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    db.delete(row)
    db.commit()
    return {"deleted": profile_id}


# ---------------------------------------------------------------------------
# Chat sessions
# ---------------------------------------------------------------------------

@router.get("/sessions", response_model=list[SessionSummary])
def list_sessions(db: Session = Depends(get_db)):
    rows = db.query(ChatSession).order_by(ChatSession.updated_at.desc()).all()
    result = []
    for r in rows:
        try:
            msgs = json.loads(r.messages_json or "[]")
        except Exception:
            msgs = []
        result.append(SessionSummary(
            id=r.id, title=r.title, model=r.model,
            message_count=len(msgs),
            created_at=r.created_at.isoformat(),
            updated_at=r.updated_at.isoformat(),
        ))
    return result


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: str, db: Session = Depends(get_db)):
    row = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        messages = json.loads(row.messages_json or "[]")
    except Exception:
        messages = []
    return SessionDetail(
        id=row.id, title=row.title, model=row.model, messages=messages,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.put("/sessions/{session_id}", response_model=SessionSummary)
def upsert_session(session_id: str, payload: SessionPayload, db: Session = Depends(get_db)):
    if session_id != payload.id:
        raise HTTPException(status_code=422, detail="URL id must match payload id")

    messages_json = json.dumps(payload.messages)
    now = datetime.now(timezone.utc)

    existing = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if existing:
        existing.title = payload.title
        existing.model = payload.model
        existing.messages_json = messages_json
        existing.updated_at = now
        db.commit()
        db.refresh(existing)
        row = existing
    else:
        row = ChatSession(
            id=session_id, title=payload.title, model=payload.model,
            messages_json=messages_json,
        )
        db.add(row)
        db.commit()
        db.refresh(row)

    return SessionSummary(
        id=row.id, title=row.title, model=row.model,
        message_count=len(payload.messages),
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)):
    row = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(row)
    db.commit()
    return {"deleted": session_id}
