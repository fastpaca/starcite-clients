from __future__ import annotations

import asyncio
import logging
import re
from contextlib import suppress
from dataclasses import dataclass
from typing import Final

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from starcite_sdk import Starcite, StarciteSession

LOGGER = logging.getLogger(__name__)

DEMO_USER_ID: Final = "demo-user"
COORDINATOR_ID: Final = "coordinator"
COORDINATOR_NAME: Final = "Coordinator"
DEFAULT_TITLE: Final = "LangChain Research Swarm"
RUNTIME_NAME: Final = "langchain-fastapi-multi-agent"
RUNTIME_PROTOCOL: Final = "starcite-swarm-v1"
RUNTIME_METADATA: Final = {
    "runtime": RUNTIME_NAME,
    "protocol": RUNTIME_PROTOCOL,
}

PLANNER_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            (
                "You are a research coordinator. Break the user's question into"
                " 2 to 4 specialist investigations. Each specialist should own one"
                " distinct angle. Keep names short and prompts concrete."
            ),
        ),
        ("human", "Question: {question}"),
    ]
)

WORKER_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            (
                "You are {name}. Investigate your assigned angle only."
                " Be concise, concrete, and useful."
            ),
        ),
        (
            "human",
            (
                "User question: {question}\n\n"
                "Your investigation brief:\n{assignment}\n\n"
                "Return direct findings, not planning chatter."
            ),
        ),
    ]
)

SUMMARY_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            (
                "You are a research coordinator. Synthesize the specialist findings"
                " into one direct answer. Be decisive, concise, and do not ask"
                " follow-up questions."
            ),
        ),
        (
            "human",
            (
                "User question: {question}\n\n"
                "Specialist findings:\n{findings}"
            ),
        ),
    ]
)


class WorkerAssignment(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    prompt: str = Field(min_length=1, max_length=600)


class WorkerPlan(BaseModel):
    specialists: list[WorkerAssignment] = Field(min_length=2, max_length=4)


@dataclass(frozen=True)
class WorkerRun:
    agent: str
    name: str
    prompt: str


@dataclass(frozen=True)
class WorkerFinding:
    agent: str
    name: str
    text: str


class RuntimeSessionMismatchError(Exception):
    pass


class ResearchSwarm:
    """LangChain coordinator/worker swarm backed by a shared Starcite session."""

    def __init__(
        self,
        *,
        starcite: Starcite,
        coordinator_model: str,
        worker_model: str,
    ) -> None:
        self._starcite = starcite
        self._coordinator_llm = ChatOpenAI(model=coordinator_model)
        self._worker_llm = ChatOpenAI(model=worker_model)
        self._planner = self._coordinator_llm.with_structured_output(
            WorkerPlan,
            method="json_schema",
        )
        self._run_lock = asyncio.Lock()
        self._active_runs: dict[str, asyncio.Task[None]] = {}

    async def close(self) -> None:
        tasks = list(self._active_runs.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._active_runs.clear()

    async def create_user_session(
        self,
        *,
        session_id: str | None = None,
        title: str = DEFAULT_TITLE,
    ) -> StarciteSession:
        session = await self._starcite.create_session(
            self._starcite.user(DEMO_USER_ID),
            session_id=session_id,
            title=title,
            metadata=RUNTIME_METADATA,
        )
        if session.record is not None:
            return session
        if await self.is_runtime_session(session.id):
            return session
        raise RuntimeSessionMismatchError(
            f"Session '{session.id}' is not available in the {RUNTIME_NAME} runtime."
        )

    async def is_runtime_session(self, session_id: str) -> bool:
        cursor: str | None = None
        while True:
            page = await self._starcite.list_sessions(
                limit=100,
                cursor=cursor,
                metadata=RUNTIME_METADATA,
            )
            if any(session.id == session_id for session in page.sessions):
                return True
            if page.next_cursor is None:
                return False
            cursor = page.next_cursor

    def is_running(self, session_id: str) -> bool:
        task = self._active_runs.get(session_id)
        return task is not None and not task.done()

    async def start_turn(self, session_id: str, text: str) -> bool:
        question = text.strip()
        if not question:
            raise ValueError("Question text must not be empty.")

        async with self._run_lock:
            if self.is_running(session_id):
                return False

            session = await self.create_user_session(session_id=session_id)
            await session.append_event(
                type="message.user",
                source="user",
                payload={"text": question},
            )

            task = asyncio.create_task(self._run_turn(session_id, question))
            self._active_runs[session_id] = task
            task.add_done_callback(
                lambda completed, current_session_id=session_id: self._forget_task(
                    current_session_id,
                    completed,
                )
            )
            return True

    def _forget_task(self, session_id: str, task: asyncio.Task[None]) -> None:
        current = self._active_runs.get(session_id)
        if current is task:
            self._active_runs.pop(session_id, None)
        with suppress(asyncio.CancelledError):
            error = task.exception()
            if error is not None:
                LOGGER.error(
                    "Research swarm run failed for session %s",
                    session_id,
                    exc_info=(type(error), error, error.__traceback__),
                )

    async def _run_turn(self, session_id: str, question: str) -> None:
        coordinator = await self._agent_session(COORDINATOR_ID, session_id)

        try:
            await self._emit_text(
                coordinator,
                agent=COORDINATOR_ID,
                name=COORDINATOR_NAME,
                text="I'm splitting this into a few focused research threads.",
            )

            assignments = await self._plan_assignments(question)
            await coordinator.append_event(
                type="agent.plan",
                source="agent",
                payload={
                    "agent": COORDINATOR_ID,
                    "name": COORDINATOR_NAME,
                    "assignments": [
                        {
                            "agent": assignment.agent,
                            "name": assignment.name,
                            "prompt": assignment.prompt,
                        }
                        for assignment in assignments
                    ],
                },
            )

            findings = await asyncio.gather(
                *(
                    self._run_worker(session_id, assignment, question)
                    for assignment in assignments
                )
            )
            await self._stream_summary(coordinator, question, findings)
        except Exception as exc:
            await coordinator.append_event(
                type="agent.error",
                source="agent",
                payload={
                    "agent": COORDINATOR_ID,
                    "name": COORDINATOR_NAME,
                    "message": str(exc),
                },
            )
            raise

    async def _plan_assignments(self, question: str) -> list[WorkerRun]:
        chain = PLANNER_PROMPT | self._planner
        plan = await chain.ainvoke({"question": question})
        assignments: list[WorkerRun] = []
        seen_agents: set[str] = set()

        for index, assignment in enumerate(plan.specialists, start=1):
            name = assignment.name.strip()
            prompt = assignment.prompt.strip()
            if not name or not prompt:
                continue

            agent = _unique_agent_id(name, index, seen_agents)
            seen_agents.add(agent)
            assignments.append(WorkerRun(agent=agent, name=name, prompt=prompt))

        if len(assignments) < 2:
            raise ValueError("Coordinator must return at least two worker assignments.")

        return assignments

    async def _run_worker(
        self,
        session_id: str,
        assignment: WorkerRun,
        question: str,
    ) -> WorkerFinding:
        session = await self._agent_session(assignment.agent, session_id)
        chain = WORKER_PROMPT | self._worker_llm | StrOutputParser()

        chunks: list[str] = []
        async for delta in chain.astream(
            {
                "name": assignment.name,
                "question": question,
                "assignment": assignment.prompt,
            }
        ):
            if not delta:
                continue
            chunks.append(delta)
            await session.append_event(
                type="agent.streaming.chunk",
                source="agent",
                payload={
                    "agent": assignment.agent,
                    "name": assignment.name,
                    "delta": delta,
                },
            )

        await session.append_event(
            type="agent.done",
            source="agent",
            payload={"agent": assignment.agent, "name": assignment.name},
        )

        return WorkerFinding(
            agent=assignment.agent,
            name=assignment.name,
            text="".join(chunks).strip(),
        )

    async def _stream_summary(
        self,
        session: StarciteSession,
        question: str,
        findings: list[WorkerFinding],
    ) -> None:
        chain = SUMMARY_PROMPT | self._coordinator_llm | StrOutputParser()
        findings_text = "\n\n".join(
            f"{finding.name} ({finding.agent}):\n{finding.text or 'No output.'}"
            for finding in findings
        )

        async for delta in chain.astream(
            {
                "question": question,
                "findings": findings_text,
            }
        ):
            if not delta:
                continue
            await session.append_event(
                type="agent.streaming.chunk",
                source="agent",
                payload={
                    "agent": COORDINATOR_ID,
                    "name": COORDINATOR_NAME,
                    "delta": delta,
                },
            )

        await session.append_event(
            type="agent.done",
            source="agent",
            payload={"agent": COORDINATOR_ID, "name": COORDINATOR_NAME},
        )

    async def _emit_text(
        self,
        session: StarciteSession,
        *,
        agent: str,
        name: str,
        text: str,
    ) -> None:
        await session.append_event(
            type="agent.streaming.chunk",
            source="agent",
            payload={"agent": agent, "name": name, "delta": text},
        )
        await session.append_event(
            type="agent.done",
            source="agent",
            payload={"agent": agent, "name": name},
        )

    async def _agent_session(self, agent_id: str, session_id: str) -> StarciteSession:
        return await self._starcite.create_session(
            self._starcite.agent(agent_id),
            session_id=session_id,
            title=DEFAULT_TITLE,
        )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "agent"


def _unique_agent_id(name: str, index: int, seen: set[str]) -> str:
    base = _slugify(name)
    if base == COORDINATOR_ID:
        base = f"{base}-worker"
    candidate = base
    suffix = index

    while candidate in seen:
        suffix += 1
        candidate = f"{base}-{suffix}"

    return candidate
