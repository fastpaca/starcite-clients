class StarciteError(Exception):
    """Base error type for SDK-level failures."""


class StarciteApiError(StarciteError):
    """Raised when the Starcite API returns a non-2xx response."""

    def __init__(
        self,
        message: str,
        status: int,
        code: str,
        payload: dict[str, object] | None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.payload = payload


class StarciteConnectionError(StarciteError):
    """Raised for connectivity failures and invalid transport payloads."""


class StarciteTailError(StarciteError):
    """Raised for tail-stream failures."""

    def __init__(
        self,
        message: str,
        *,
        session_id: str,
        stage: str,
        attempts: int = 0,
        close_code: int | None = None,
        close_reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.session_id = session_id
        self.stage = stage
        self.attempts = attempts
        self.close_code = close_code
        self.close_reason = close_reason


class StarciteTokenExpiredError(StarciteTailError):
    """Raised when a tail token expires and should be re-issued."""

    def __init__(
        self,
        message: str,
        *,
        session_id: str,
        attempts: int = 0,
        close_code: int | None = None,
        close_reason: str | None = None,
    ) -> None:
        super().__init__(
            message,
            session_id=session_id,
            stage="stream",
            attempts=attempts,
            close_code=close_code,
            close_reason=close_reason,
        )
