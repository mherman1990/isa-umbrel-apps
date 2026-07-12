from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field as PField
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import auth, llm
from ...db import get_session
from ...models import AppUser, FarmProfile
from ...services import assistant

router = APIRouter(prefix="/assistant", tags=["assistant"])


class ChatIn(BaseModel):
    question: str = PField(min_length=1, max_length=2000)
    history: list[dict] = []  # [{role: user|assistant, content}], client-held


@router.post("/chat")
def chat(body: ChatIn, session: Session = Depends(get_session), user: AppUser = Depends(auth.current_user)):
    profile = session.scalars(select(FarmProfile)).first()
    cap = float(profile.monthly_spend_cap_usd) if profile else 20.0
    try:
        return assistant.chat(session, body.question, body.history, cap_usd=cap)
    except llm.SpendCapExceeded:
        raise HTTPException(status_code=402, detail="monthly AI spend cap reached — raise it in Settings")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))  # e.g. no API key configured
