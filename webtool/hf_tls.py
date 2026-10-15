"""Hugging-Face-HTTP unter Windows gegen den Zertifikatsspeicher des Systems prüfen."""

import ssl
import sys
import threading

_lock = threading.Lock()
_configured = False


def configure() -> None:
    """Den synchronen Hub-Client einmalig konfigurieren, bevor Modelle geladen werden."""
    global _configured

    if sys.platform != "win32" or _configured:
        return

    with _lock:
        if _configured:
            return

        from huggingface_hub import get_session, set_client_factory

        # Die Factory ersetzt den Hub-Client. Dessen Hook erzwingt u.a. den Offline-Modus;
        # auch Redirects und Timeout müssen beim Austausch erhalten bleiben.
        original = get_session()
        hooks = {kind: list(callbacks) for kind, callbacks in original.event_hooks.items()}
        follow_redirects = original.follow_redirects
        timeout = original.timeout

        # Die Klasse kommt aus der Hub-Sitzung: hub 1 nutzt httpx, hub 2 httpx2. Ein fest
        # verdrahtetes httpx.Client bekommt unter hub 2 dessen Timeout und bricht (#679).
        client_class = type(original)

        def client_factory():
            return client_class(
                verify=ssl.create_default_context(),
                event_hooks=hooks,
                follow_redirects=follow_redirects,
                timeout=timeout,
            )

        set_client_factory(client_factory)
        _configured = True
