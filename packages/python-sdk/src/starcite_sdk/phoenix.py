from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from phoenix_channels_python_client import PHXChannelsClient
from phoenix_channels_python_client.client_types import ClientState
from phoenix_channels_python_client.exceptions import (
    PHXConnectionError,
    PHXTopicError,
)
from phoenix_channels_python_client.phx_messages import ChannelMessage, PHXEvent
from phoenix_channels_python_client.topic_subscription import TopicSubscription
from phoenix_channels_python_client.utils import make_message


def _replace_query_param(url: str, *, old: str, new: str) -> str:
    split = urlsplit(url)
    query = [
        (new if key == old else key, value)
        for key, value in parse_qsl(split.query, keep_blank_values=True)
    ]
    return urlunsplit(
        (split.scheme, split.netloc, split.path, urlencode(query), split.fragment)
    )


class StarcitePhoenixClient(PHXChannelsClient):
    """Starcite-specific Phoenix client adapter.

    The upstream client handles reconnection and message routing well, but it
    assumes `api_key` auth and an empty join payload. Starcite needs `token`
    auth and a `cursor` join payload for tail recovery, so this adapter keeps
    those values attached to each topic subscription.
    """

    def __init__(self, websocket_url: str, token: str, **kwargs: object) -> None:
        super().__init__(websocket_url=websocket_url, api_key=token, **kwargs)
        self.channel_socket_url = _replace_query_param(
            self.channel_socket_url,
            old="api_key",
            new="token",
        )
        self.channel_socket_url_redacted = _replace_query_param(
            self.channel_socket_url_redacted,
            old="api_key",
            new="token",
        )

    async def subscribe_to_topic(
        self,
        topic: str,
        *,
        join_payload: dict[str, Any] | None = None,
        async_callback: Callable[[ChannelMessage], Awaitable[None]] | None = None,
    ) -> None:
        self._ensure_can_send("subscribe")

        topic_queue: asyncio.Queue[ChannelMessage] = asyncio.Queue(
            maxsize=self.max_topic_queue_size
        )
        join_ref = self._generate_ref()
        payload = dict(join_payload or {})

        topic_subscription = TopicSubscription(
            name=topic,
            async_callback=async_callback,
            queue=topic_queue,
            join_ref=join_ref,
            process_topic_messages_task=None,
            conn_generation=self._conn_generation,
        )
        setattr(topic_subscription, "join_payload", payload)

        async with self._topics_lock:
            if topic in self._topic_subscriptions:
                raise PHXTopicError(f"Topic {topic} already subscribed")
            self._topic_subscriptions[topic] = topic_subscription

        topic_subscription.process_topic_messages_task = asyncio.create_task(
            self._process_topic_messages(topic)
        )

        topic_join_message = make_message(
            topic=topic,
            event=PHXEvent.join,
            payload=payload,
            ref=join_ref,
            join_ref=join_ref,
        )

        try:
            connection = self.connection
            if connection is None:
                raise PHXConnectionError("Connection lost before join could be sent")
            await self._protocol_handler.send_message(connection, topic_join_message)
            await asyncio.wait_for(
                topic_subscription.current_join_ready, timeout=self.join_timeout_s
            )
        except asyncio.TimeoutError as exc:
            await self._unregister_topic(
                topic,
                error=PHXTopicError(f"Timed out waiting to subscribe to {topic}"),
            )
            raise PHXTopicError(f"Timed out waiting to subscribe to {topic}") from exc
        except Exception:
            await self._unregister_topic(topic)
            raise

    def set_topic_join_payload(self, topic: str, join_payload: dict[str, Any]) -> None:
        topic_subscription = self._topic_subscriptions.get(topic)
        if topic_subscription is None:
            raise PHXTopicError(f"Topic {topic} not subscribed")
        setattr(topic_subscription, "join_payload", dict(join_payload))

    async def _rejoin_topics(self, generation: int) -> None:
        async with self._topics_lock:
            subscriptions = list(self._topic_subscriptions.items())

        loop = asyncio.get_running_loop()

        for topic_name, topic_subscription in subscriptions:
            if topic_subscription.leave_requested.is_set():
                continue

            previous_task = topic_subscription.process_topic_messages_task
            callback_task = topic_subscription.current_callback_task
            if callback_task and not callback_task.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(callback_task),
                        timeout=self.callback_drain_timeout_s,
                    )
                except asyncio.TimeoutError:
                    self.logger.warning(
                        "Callback for topic %s did not finish before reconnect; cancelling",
                        topic_name,
                    )
                    callback_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await callback_task

            if previous_task and not previous_task.done():
                previous_task.cancel()
                with suppress(asyncio.CancelledError):
                    await previous_task

            topic_subscription.conn_generation = generation
            topic_subscription.join_ref = self._generate_ref()
            topic_subscription.current_join_ready = loop.create_future()
            self._drain_topic_queue(topic_subscription)
            topic_subscription.process_topic_messages_task = asyncio.create_task(
                self._process_topic_messages(topic_name)
            )

            join_payload = dict(getattr(topic_subscription, "join_payload", {}))
            join_message = make_message(
                topic=topic_subscription.name,
                event=PHXEvent.join,
                payload=join_payload,
                ref=topic_subscription.join_ref,
                join_ref=topic_subscription.join_ref,
            )

            try:
                if self.connection is None:
                    raise PHXConnectionError(
                        "Connection unavailable while rejoining topics"
                    )

                await self._protocol_handler.send_message(self.connection, join_message)
                await asyncio.wait_for(
                    topic_subscription.current_join_ready,
                    timeout=self.join_timeout_s,
                )
            except Exception as exc:
                if self._shutdown_event.is_set() or self._state == ClientState.SHUTTING_DOWN:
                    self.logger.debug(
                        "Ignoring rejoin failure for topic %s during shutdown: %s",
                        topic_name,
                        exc,
                    )
                    continue
                if isinstance(exc, PHXTopicError):
                    self.logger.error("Failed to rejoin topic %s: %s", topic_name, exc)
                    await self._unregister_topic(
                        topic_name,
                        error=PHXTopicError(
                            f"Failed to rejoin topic {topic_name}: {exc}"
                        ),
                    )
                    continue

                self.logger.warning(
                    "Transient rejoin failure for topic %s, will retry on next reconnect: %s",
                    topic_name,
                    exc,
                )
