from fastapi import APIRouter

from . import auth_routes, captures, fields, inbox, programs, records, sync, system

router = APIRouter(prefix="/api/v1")
router.include_router(auth_routes.router)
router.include_router(fields.router)
router.include_router(records.router)
router.include_router(captures.router)
router.include_router(sync.router)
router.include_router(inbox.router)
router.include_router(programs.router)
router.include_router(system.router)
