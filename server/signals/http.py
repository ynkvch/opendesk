"""Small HTTP helper: retries with backoff, per-host pacing, no third-party dependencies."""
import http.client
import json
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

try:
    import certifi  # python.org builds on macOS ship without a CA bundle linked
    _CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _CTX = ssl.create_default_context()

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"
              " Chrome/130.0 Safari/537.36")

# minimum seconds between requests to the same host; anything not listed waits 0.3 s
PACE = {"api.stlouisfed.org": 0.5, "query1.finance.yahoo.com": 0.5}
_last: dict[str, float] = {}


class FetchError(Exception):
    pass


def _where(url: str) -> str:
    """the url without its query string, for error messages: query strings carry api keys (fred's api_key), and
    errors end up in logs and on the page."""
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}{u.path}"


def fetch(url: str, *, ua: str = BROWSER_UA, data: dict | None = None, timeout: int = 45,
          retries: int = 3, headers: dict | None = None) -> bytes:
    host = urlparse(url).netloc
    body = json.dumps(data).encode() if data is not None else None
    headers = {"User-Agent": ua, "Accept-Encoding": "identity", "Accept": "text/html,application/xhtml+xml,*/*",
               "Accept-Language": "en-US,en;q=0.9", **(headers or {})}
    if body is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(retries + 1):
        wait = PACE.get(host, 0.3) - (time.monotonic() - _last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.monotonic()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers),
                                        timeout=timeout, context=_CTX) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** attempt * 3)
                continue
            raise FetchError(f"{e.code} {e.reason} for {_where(url)}") from e
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            if attempt < retries:
                time.sleep(2 ** attempt * 3)
                continue
            raise FetchError(f"{e} for {_where(url)}") from None  # from None: the original error repeats the url
    raise FetchError(f"gave up on {_where(url)}")


def fetch_json(url: str, **kw) -> dict | list:
    return json.loads(fetch(url, **kw))
