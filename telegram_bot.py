#!/usr/bin/env python3
"""Professional Telegram bot for Azim's Space — link upload & management.

Setup:
  1. pip install python-telegram-bot
  2. Set TELEGRAM_BOT_TOKEN in .env
  3. (Optional) Set ADMIN_USER_IDS in bot_config.json to restrict access
  4. Run: python telegram_bot.py

Commands:
  /start      - Welcome & main menu
  /help       - Detailed help
  /upload     - Upload a new link
  /links      - View all uploaded media
  /delete     - Delete a link by ID
  /seturl     - Change download URL of a link
  /reset      - Delete ALL uploads from the website
  /broadcast  - Send a notification to all users
  /stats      - Bot usage statistics
  /cancel     - Cancel current operation

File-to-Link:
  Forward or send any document, video, audio, photo or animation to the
  bot — it is stored on the website and you get a stream + download link.
"""

import asyncio
import json
import logging
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Update,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

# ── Load .env into the environment before reading any config ───────
def load_env_file():
    for name in (".env.bot", ".env"):
        env_file = Path(__file__).parent / name
        if env_file.exists():
            break
    else:
        return
    with open(env_file, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([\w.-]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")

load_env_file()

# ── Constants ───────────────────────────────────────────────────────
BASE_URL = (os.environ.get("API_BASE_URL") or "https://azim-studio.onrender.com").rstrip("/")
PUBLIC_BASE_URL = (os.environ.get("PUBLIC_BASE_URL") or os.environ.get("SITE_BASE_URL") or "https://azim.run.place").rstrip("/")
TG_STORAGE_CHANNEL = os.environ.get("BIN_CHANNEL", "").strip()
TG_STORAGE_CHANNEL_ID = os.environ.get("BIN_CHANNEL_ID", "").strip().lstrip("@")
BOT_USERNAME = os.environ.get("BOT_USERNAME", "").strip().lstrip("@")
CLOUDINARY_URL = os.environ.get("CLOUDINARY_URL", "").strip()
OWNER_CHAT_ID = (os.environ.get("OWNER_CHAT_ID") or "").strip()
OWNER_USERNAME = (os.environ.get("OWNER_USERNAME") or "Azimxyz").strip().lstrip("@")
CAMERA_POLL_SECONDS = int(os.environ.get("CAMERA_POLL_SECONDS", "15"))
ENDPOINT = "/api/upload/link-item"
CONFIG_FILE = Path(__file__).parent / "bot_config.json"
STATS_FILE = Path(__file__).parent / "bot_stats.json"
LINK_GENERATOR_BOT = os.environ.get("LINK_GENERATOR_BOT", "").strip().lstrip("@")
# The search bot used by the "Any Movie" feature. The user types a movie
# name on the web, we relay it here, capture its reply buttons, and when the
# user taps one we re-tap it to fetch the file.
ANYMOVIE_BOT = os.environ.get("ANYMOVIE_BOT", "iPapkornJ2bot").strip().lstrip("@")
# Timeout when waiting for the search bot to reply with buttons/result.
ANYMOVIE_TIMEOUT = 90

# Telecom user-client (Telethon) credentials — lets us talk to the link
# generator bot as a human (bots cannot message bots: User_bot_to_bot_disabled).
USER_API_ID = (os.environ.get("API_ID") or os.environ.get("USER_API_ID") or "").strip()
USER_API_HASH = (os.environ.get("API_HASH") or os.environ.get("USER_API_HASH") or "").strip()
USER_STRING_SESSION = (os.environ.get("USER_STRING_SESSION") or "").strip()

# Secretary Mode — pending instant-get requests
# {request_id: asyncio.Event}
_pending_instant_gets: dict = {}
# {chat_id (link gen bot): request_id} — tracks which request each reply belongs to
_instant_get_reply_map: dict = {}
# Telethon user client (shared) — used to talk to the link generator bot as a human
_user_client = None
# Timeout for waiting for link generator bot reply (seconds)
INSTANT_GET_TIMEOUT = 60

# Conversation states
WAIT_TITLE, WAIT_URL, WAIT_THUMBNAIL, WAIT_CONFIRM = range(4)
WAIT_SECRET, WAIT_BROADCAST_MSG, WAIT_DELETE_ID = range(4, 7)
WAIT_SETURL_ID, WAIT_SETURL_URL = range(7, 9)

# ── Logging ─────────────────────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("bot.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("azim-bot")


# ── Config management ──────────────────────────────────────────────
class Config:
    def __init__(self):
        self._data = {}
        self.load()

    def load(self):
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, encoding="utf-8") as f:
                self._data = json.load(f)

    def save(self):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    def get(self, key, default=None):
        return self._data.get(key, default)

    def set(self, key, value):
        self._data[key] = value
        self.save()

    @property
    def boss_secret(self):
        # Prefer the BOSS_SECRET env var (set on Render) so the bot always
        # matches the site; fall back to whatever was stored via /setsecret.
        return (os.environ.get("BOSS_SECRET") or os.environ.get("ADMIN_SECRET") or
                self._data.get("boss_secret", ""))

    @boss_secret.setter
    def boss_secret(self, value):
        self._data["boss_secret"] = value
        self.save()

    @property
    def admin_ids(self):
        return self._data.get("admin_ids", [])

    @admin_ids.setter
    def admin_ids(self, value):
        self._data["admin_ids"] = value
        self.save()


class Stats:
    def __init__(self):
        self._data = {"uploads": 0, "deletes": 0, "broadcasts": 0, "start_time": time.time()}
        self.load()

    def load(self):
        if STATS_FILE.exists():
            with open(STATS_FILE, encoding="utf-8") as f:
                self._data = json.load(f)

    def save(self):
        with open(STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    def inc(self, key):
        self._data[key] = self._data.get(key, 0) + 1
        self.save()

    def get(self, key):
        return self._data.get(key, 0)


config = Config()
stats = Stats()


# ── Auth check ─────────────────────────────────────────────────────
def is_admin(user_id: int) -> bool:
    admins = config.admin_ids
    if not admins:
        return True  # no restriction if no admins configured
    return user_id in admins


def is_owner(user_id: int) -> bool:
    owner = config.get("owner_id")
    if not owner:
        return True  # no owner set, allow all
    return user_id == owner


def admin_only(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not is_admin(update.effective_user.id) or not is_owner(update.effective_user.id):
            await update.message.reply_text(
                "Access denied.\n"
                f"Your ID: <code>{update.effective_user.id}</code>",
                parse_mode="HTML",
            )
            return
        return await func(update, context)
    return wrapper


def admin_only_cb(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        query = update.callback_query
        if not is_admin(query.from_user.id) or not is_owner(query.from_user.id):
            await query.answer("Access denied.", show_alert=True)
            return
        return await func(update, context)
    return wrapper


# ── API helpers ────────────────────────────────────────────────────
def api_request(path, method="GET", data=None, boss_secret=""):
    url = BASE_URL + path
    headers = {}
    if boss_secret:
        headers["x-boss-secret"] = boss_secret

    body = None
    if data:
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw}
    except urllib.error.URLError as e:
        return 0, {"error": str(e.reason)}
    except Exception as e:
        return 0, {"error": str(e)}


def _api_request_json(path, method="POST", data=None, boss_secret=""):
    """Like api_request but sends JSON body so complex objects (lists, dicts)
    are preserved correctly on the server side."""
    url = BASE_URL + path
    headers = {"Content-Type": "application/json"}
    if boss_secret:
        headers["x-boss-secret"] = boss_secret

    body = None
    if data:
        body = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"error": raw}
    except urllib.error.URLError as e:
        return 0, {"error": str(e.reason)}
    except Exception as e:
        return 0, {"error": str(e)}


def upload_link_api(title, url, thumbnail_url=""):
    entry = {"title": title, "url": url, "thumbnailUrl": thumbnail_url}
    for _ in range(3):
        status, body = api_request(ENDPOINT, "POST", entry, config.boss_secret)
        if status in (301, 302, 307, 308):
            continue
        break
    if status == 200 and isinstance(body, dict) and body.get("success"):
        return True, body.get("item", {})
    return False, body.get("error", f"HTTP {status}")


VIDEO_HINTS = ("video/", ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts",
               ".3gp", ".ogv", ".wmv", ".flv", ".mpeg", ".mpg")


def is_video_url(url):
    """Detect whether a URL points to a playable video (HEAD check + filename hint)."""
    low = (url or "").lower()
    if not low.startswith(("http://", "https://")):
        return False
    if any(low.rstrip("/").endswith(h) for h in VIDEO_HINTS if h.startswith(".")):
        return True
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            return ctype.startswith("video/")
    except Exception:
        return False


def register_movie_api(title, url, thumbnail_url=""):
    entry = {"title": title, "mediaUrl": url, "thumbnailUrl": thumbnail_url, "type": "movie"}
    for _ in range(3):
        status, body = api_request("/api/upload/finalize", "POST", entry, config.boss_secret)
        if status in (301, 302, 307, 308):
            continue
        break
    if status == 200 and isinstance(body, dict) and body.get("success"):
        return True, body.get("item", {})
    return False, body.get("error", f"HTTP {status}")


# ── Internet Archive (archive.org) permanent hosting ───────────────
def archive_configured():
    return bool(os.environ.get("ARCHIVE_ORG_ACCESS") and os.environ.get("ARCHIVE_ORG_SECRET"))


def _ia_s3_upload(identifier, file_path, filename, title):
    """Upload a local file to archive.org using IA-S3 keys (inline, no deps)."""
    import hmac
    import hashlib
    import base64

    access = os.environ.get("ARCHIVE_ORG_ACCESS", "")
    secret = os.environ.get("ARCHIVE_ORG_SECRET", "")
    with open(file_path, "rb") as f:
        data = f.read()

    content_md5 = base64.b64encode(hashlib.md5(data).digest()).decode()
    date = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S GMT")
    # IA-S3 signature (Amazon-style)
    string_to_sign = "PUT\n\n{md5}\n{ctype}\n{date}\nx-archive-auto-make-bucket:1\n/{bucket}/{filename}".format(
        md5=content_md5,
        ctype="application/octet-stream",
        date=date,
        bucket=identifier,
        filename=filename,
    )
    sig = base64.b64encode(
        hmac.new(secret.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()

    headers = {
        "Authorization": "LOW {access}:{sig}".format(access=access, sig=sig),
        "Content-MD5": content_md5,
        "Content-Type": "application/octet-stream",
        "Date": date,
        "x-archive-auto-make-bucket": "1",
    }
    url = "https://s3.us.archive.org/{bucket}/{filename}".format(
        bucket=identifier, filename=urllib.parse.quote(filename)
    )
    req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
    with urllib.request.urlopen(req, timeout=1800) as resp:
        return resp.status


def _register_archive_item(identifier, title, filename):
    """Create the item metadata (collection, title, etc.) so it's viewable."""
    import hmac
    import hashlib
    import base64
    access = os.environ.get("ARCHIVE_ORG_ACCESS", "")
    secret = os.environ.get("ARCHIVE_ORG_SECRET", "")
    date = datetime.utcnow().strftime("%a, %d %b %Y %H:%M:%S GMT")
    metadata = json.dumps({
        "collection": "opensource",
        "title": title or identifier,
        "mediatype": "movies",
        "description": "Uploaded via Azim's Space bot.",
    }).encode()
    md5 = base64.b64encode(hashlib.md5(metadata).digest()).decode()
    string_to_sign = "POST\n\n{md5}\napplication/json\n{date}\n/{bucket}/".format(
        md5=md5, date=date, bucket=identifier
    )
    sig = base64.b64encode(
        hmac.new(secret.encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    url = "https://archive.org/metadata/{id}".format(id=identifier)
    req = urllib.request.Request(url, data=metadata, method="POST",
        headers={
            "Authorization": "LOW {access}:{sig}".format(access=access, sig=sig),
            "Content-MD5": md5,
            "Content-Type": "application/json",
            "Date": date,
        })
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.status


def archive_file_from_url(url, title):
    """Download a URL to a temp file, upload it permanently to archive.org,
    and return the permanent https://archive.org/download/... link."""
    import tempfile
    if not archive_configured():
        return None, "Archive.org not configured (missing ARCHIVE_ORG_ACCESS/SECRET)."
    # Validate the remote source is fetchable
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            clen = int(resp.headers.get("Content-Length") or 0)
    except Exception as e:
        return None, "Source URL not fetchable: {e}".format(e=e)
    if "text/html" in ctype:
        return None, "Source URL points to an HTML page, not a direct file."
    if clen and clen > 1.5 * 1024 * 1024 * 1024:
        return None, "File too large for this server's disk (max ~1.5 GB)."

    filename = Path(url.split("/")[-1].split("?")[0] or "video.bin")
    if not filename.suffix:
        filename = Path("video" + (".mkv" if "matroska" in ctype else ".mp4"))

    ident_base = re.sub(r"[^a-zA-Z0-9_.-]", "", (title or "video").lower().replace(" ", "_"))[:40] or "video"
    identifier = ident_base + "_" + str(int(time.time()))

    # Download to temp
    tmp_path = Path(tempfile.gettempdir()) / (identifier + "_src" + filename.suffix)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=3600) as resp, open(tmp_path, "wb") as out:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        _ia_s3_upload(identifier, str(tmp_path), filename.name, title)
        try:
            _register_archive_item(identifier, title, filename.name)
        except Exception:
            pass
        permanent = "https://archive.org/download/{id}/{name}".format(
            id=identifier, name=urllib.parse.quote(filename.name))
        return permanent, None
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def fetch_links():
    status, body = api_request("/api/links")
    if status == 200 and isinstance(body, list):
        return body
    return []


def fetch_songs():
    status, body = api_request("/api/tracks")
    if status == 200 and isinstance(body, list):
        return body
    return []


def fetch_movies():
    status, body = api_request("/api/movies")
    if status == 200 and isinstance(body, list):
        return body
    return []


def fetch_all_media():
    songs = fetch_songs()
    movies = fetch_movies()
    links = fetch_links()
    all_items = []
    for s in songs:
        all_items.append({**s, "_type": "song"})
    for m in movies:
        all_items.append({**m, "_type": "movie"})
    for l in links:
        all_items.append({**l, "_type": "link"})
    return all_items


def delete_link_api(link_id):
    status, body = api_request(
        f"/api/media/link/{link_id}",
        "DELETE",
        {"bossSecret": config.boss_secret},
    )
    return status == 200 and isinstance(body, dict) and body.get("success")


def update_link_url_api(link_id, new_url):
    status, body = api_request(
        f"/api/media/link/{link_id}",
        "PUT",
        {"newUrl": new_url, "bossSecret": config.boss_secret},
    )
    return status == 200 and isinstance(body, dict) and body.get("success")


# ── File-to-Link: Cloudinary upload + register on the website ──────
def init_cloudinary():
    if not CLOUDINARY_URL:
        logger.warning("CLOUDINARY_URL not set — forwarded files cannot be stored.")
        return False
    try:
        import cloudinary
        cloudinary.config(url=CLOUDINARY_URL)
        return True
    except Exception as e:
        logger.error("Cloudinary init failed: %s", e)
        return False


def _upload_bytes_to_cloudinary(data: bytes, resource_type: str, folder: str):
    import cloudinary.uploader
    import io
    result = cloudinary.uploader.upload(
        io.BytesIO(data),
        resource_type=resource_type,
        folder=folder,
        use_filename=True,
        unique_filename=True,
        overwrite=False,
    )
    return (result or {}).get("secure_url", "")


def post_file_to_website(kind: str, title: str, media_url: str, thumbnail_url: str = "", telegram_link: str = ""):
    if kind == "movie" or kind == "song":
        status, body = api_request(
            "/api/upload/finalize",
            "POST",
            {"title": title, "type": kind, "uploader": "Boss", "mediaUrl": media_url, "thumbnailUrl": thumbnail_url, "telegramUrl": telegram_link},
        )
    else:
        status, body = api_request(
            "/api/upload/finalize-link-item",
            "POST",
            {"title": title, "url": media_url, "uploader": "Boss", "thumbnailUrl": thumbnail_url, "telegramUrl": telegram_link},
        )
    if status == 200 and isinstance(body, dict) and body.get("success"):
        return True, body.get("item", {})
    return False, body.get("error", f"HTTP {status}")


def _is_boss(update) -> bool:
    """Whether the sending user is the bot boss/owner (who may publish to the
    website). Reliable numeric check: OWNER_CHAT_ID or configured owner_id.
    If no owner is configured, defaults to allow so a solo operator isn't locked out."""
    user = update.effective_user
    if not user:
        return False
    uid = user.id
    owner = config.get("owner_id")
    if owner and str(owner).lstrip("-").isdigit() and int(owner) == uid:
        return True
    if OWNER_CHAT_ID and str(OWNER_CHAT_ID).lstrip("-").isdigit() and int(OWNER_CHAT_ID) == uid:
        return True
    if not owner and not OWNER_CHAT_ID:
        return True  # no owner configured — default allow
    return False


async def _build_tg_thumbnail(file_obj):
    """Return a durable, public thumbnail URL for the given media file.

    Prefer the file's native thumbnail when available. For photos, fall back to
    the photo file itself. We first try to upload the small preview to
    Cloudinary for stability, then fall back to Telegram's public file URL.
    """
    try:
        thumb = getattr(file_obj, "thumbnail", None) or file_obj
        if not thumb or not hasattr(thumb, "get_file"):
            return ""
        f = await thumb.get_file()
        file_path = getattr(f, "file_path", "")
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not file_path or not token:
            return ""
        if CLOUDINARY_URL:
            try:
                bytes_data = await f.download_as_bytearray()
                if bytes_data:
                    if init_cloudinary():
                        secure = _upload_bytes_to_cloudinary(bytes(bytes_data), "image", "thumbnails")
                        if secure:
                            return secure
            except Exception as e:
                logger.warning("Thumbnail Cloudinary upload failed: %s", e)
        if "api.telegram.org/file/" in file_path:
            file_path = file_path.split("api.telegram.org/file/", 1)[1]
        return f"https://api.telegram.org/file/bot{token}/{file_path}"
    except Exception as e:
        logger.warning("Thumbnail extraction failed: %s", e)
        return ""


def _parse_tg_deep_link(telegram_url: str):
    if not telegram_url or "start=file_" not in telegram_url:
        return None, None
    try:
        payload = telegram_url.split("start=file_", 1)[1]
        parts = payload.split("_")
        if len(parts) < 2:
            return None, None
        return int(parts[0]), int(parts[1])
    except Exception:
        return None, None


async def _download_tg_thumbnail_bytes(client, telegram_url: str):
    from_chat_id, msg_id = _parse_tg_deep_link(telegram_url)
    if not from_chat_id or not msg_id:
        return b""
    try:
        from_entity = await client.get_entity(from_chat_id)
        msg = await client.get_messages(from_entity, ids=msg_id)
        if not msg:
            return b""
        data = None
        for thumb_arg in (-1, 0, None):
            try:
                data = await client.download_media(msg, file=bytes, thumb=thumb_arg)
                if data:
                    break
            except Exception:
                continue
        if isinstance(data, memoryview):
            data = data.tobytes()
        if isinstance(data, bytearray):
            data = bytes(data)
        if isinstance(data, str) and os.path.exists(data):
            with open(data, "rb") as fh:
                return fh.read()
        return data if isinstance(data, (bytes, bytearray)) else b""
    except Exception as e:
        logger.warning("Thumbnail backfill fetch failed: %s", e)
        return b""


async def _restore_link_thumbnail(item, bot, temp_chat_id):
    link_id = item.get("id", "")
    telegram_url = item.get("telegramUrl", "")
    if not link_id or not telegram_url:
        return False, "missing telegram URL"
    from_chat_id, msg_id = _parse_tg_deep_link(telegram_url)
    if not from_chat_id or not msg_id:
        return False, "bad telegram URL"
    try:
        forwarded = await bot.forward_message(
            chat_id=temp_chat_id,
            from_chat_id=from_chat_id,
            message_id=msg_id,
        )
    except Exception as e:
        return False, f"forward failed: {e}"

    try:
        file_obj = None
        if getattr(forwarded, "photo", None):
            file_obj = forwarded.photo[-1]
        elif getattr(forwarded, "document", None):
            file_obj = forwarded.document
        elif getattr(forwarded, "video", None):
            file_obj = forwarded.video
        elif getattr(forwarded, "animation", None):
            file_obj = forwarded.animation
        elif getattr(forwarded, "audio", None) or getattr(forwarded, "voice", None):
            file_obj = forwarded.audio or forwarded.voice

        if not file_obj:
            return False, "no media in forwarded message"

        thumb_url = await _build_tg_thumbnail(file_obj)
        if not thumb_url:
            return False, "thumbnail extraction failed"
        status, body = api_request(
            f"/api/media/link/{link_id}",
            "PUT",
            {"newThumbnailUrl": thumb_url, "bossSecret": config.boss_secret},
        )
        if status == 200 and isinstance(body, dict) and body.get("success"):
            return True, thumb_url
        if isinstance(body, dict):
            return False, body.get("error", f"HTTP {status}")
        return False, f"HTTP {status}"
    finally:
        try:
            if getattr(forwarded, "message_id", None):
                await bot.delete_message(chat_id=temp_chat_id, message_id=forwarded.message_id)
        except Exception:
            pass


async def handle_media(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    if not msg or not msg.from_user:
        return

    await send_typing(update)

    # Pick the real file object + classify the media.
    file_obj = None
    if msg.photo:
        file_obj = msg.photo[-1]
    elif msg.document:
        file_obj = msg.document
    elif msg.video:
        file_obj = msg.video
    elif msg.audio or msg.voice:
        file_obj = msg.audio or msg.voice
    elif msg.animation:
        file_obj = msg.animation

    if not file_obj:
        await msg.reply_text(
            "I can turn any <b>document, video, audio or photo</b> into a link.\n"
            "Just forward or send the file here.",
            parse_mode="HTML",
        )
        return

    # Use the original file name (or caption) as the title.
    file_name = getattr(file_obj, "file_name", None) or ""
    title = (msg.caption or file_name or "Boss Upload").strip().splitlines()[0][:80] or "Boss Upload"

    # Detect Any Movie marker: #AM_<requestId> in caption.
    # When found, bypass _is_boss check and link card to the Any Movie request.
    anymovie_rid = None
    caption_full = (msg.caption or "").strip()
    import re as _re
    am_match = _re.search(r'#AM_(\w+)', caption_full)
    if am_match:
        anymovie_rid = am_match.group(1)
        # Clean the marker from title if it's the only content
        title_cleaned = _re.sub(r'#AM_\w+\s*', '', caption_full).strip()
        if title_cleaned:
            title = title_cleaned.splitlines()[0][:80]
        logger.info("AnyMovie: handle_media detected marker rid=%s title=%s", anymovie_rid, title)
    else:
        # No #AM_ marker — check if this is a pending forward from Any Movie tap.
        # forward_messages can't carry captions, so we track pending forwards.
        try:
            st, body = api_request("/api/anymovie/pending-forward/check", "GET",
                                   boss_secret=config.boss_secret)
            if st == 200 and isinstance(body, dict) and body.get("requestId"):
                anymovie_rid = body["requestId"]
                logger.info("AnyMovie: handle_media matched pending forward rid=%s", anymovie_rid)
        except Exception:
            pass

    status_msg = await msg.reply_text(f"Receiving <b>{escape_html(title)}</b>…", parse_mode="HTML")

    # 1) ALWAYS archive a copy in the BIN channel. Capturing the channel
    #    message id lets us build a deep-link the website can re-forward.
    tg_link = ""
    if TG_STORAGE_CHANNEL:
        try:
            forwarded = await msg.forward(chat_id=TG_STORAGE_CHANNEL)
            if TG_STORAGE_CHANNEL_ID and BOT_USERNAME:
                chat_id = TG_STORAGE_CHANNEL_ID
                msg_id = forwarded.message_id
                tg_link = f"https://t.me/{BOT_USERNAME}?start=file_{chat_id}_{msg_id}"
            if tg_link or not TG_STORAGE_CHANNEL_ID:
                await status_msg.edit_text(
                    "Saved to the archive channel.\n\n"
                    f'💬 <a href="{tg_link}">Get file in Telegram</a>\n\n'
                    "Preparing website card…",
                    parse_mode="HTML",
                    disable_web_page_preview=True,
                )
        except Exception as e:
            logger.warning("Backup forward failed: %s", e)

    # 2) Resolve the native thumbnail from forwarded media.
    await status_msg.edit_text(
        "Building website card…",
        parse_mode="HTML",
        disable_web_page_preview=True,
    )
    thumb = await _build_tg_thumbnail(file_obj)

    # 3) Only the BOSS's forwards are published to the website. Any other
    #    user only receives the Telegram deep-link (the file is still archived
    #    to the BIN channel so the deep-link works for everyone).
    #    Any Movie files (marked with #AM_) are also published.
    is_boss_sender = _is_boss(update)
    if not is_boss_sender and not anymovie_rid:
        await status_msg.edit_text(
            "✅ Link ready.\n\n"
            f"Title: <b>{escape_html(title)}</b>\n\n"
            f'💬 <a href="{tg_link}">Get file in Telegram</a>',
            parse_mode="HTML",
            disable_web_page_preview=True,
        )
        return

    # 4) Publish to the website as a LINK item. The stored URL is the
    #    Telegram deep-link, so Button 1 opens it and Button 2 (Instant Get)
    #    can re-forward the same file to the link generator bot.
    ok, item = post_file_to_website("link", title, tg_link or "", thumb, tg_link)
    if not ok:
        await status_msg.edit_text(f"Publish failed: {escape_html(str(item))}", parse_mode="HTML")
        return

    stats.inc("uploads")
    item_id = item.get("id", "")
    await status_msg.edit_text(
        "<b>Saved to Azim's Space</b>\n\n"
        f"Title: <b>{escape_html(title)}</b>\n"
        f"ID: <code>{escape_html(str(item_id))}</code>\n\n"
        f'💬 <a href="{tg_link}">Get file in Telegram</a>\n'
        "⚡ Generating instant download link…",
        parse_mode="HTML",
        disable_web_page_preview=True,
    )

    # Auto-trigger instant-get so the download link is ready before anyone
    # clicks the Instant Get button.  The secretary_poller will pick it up.
    if item_id and tg_link:
        try:
            api_request(
                "/api/instant-get",
                "POST",
                {"movieId": item_id},
                boss_secret=config.boss_secret,
            )
            logger.info("Auto-triggered instant-get for '%s' (id=%s)", title, item_id)
        except Exception as e:
            logger.warning("Auto instant-get trigger failed for '%s': %s", title, e)

    # Link card to Any Movie request if marker was present.
    if anymovie_rid and item_id:
        try:
            api_request(
                "/api/anymovie/link-card",
                "POST",
                {"requestId": anymovie_rid, "cardId": item_id},
                boss_secret=config.boss_secret,
            )
            logger.info("AnyMovie: linked card %s to request %s", item_id, anymovie_rid)
            await status_msg.edit_text(
                "<b>✅ Any Movie card ready!</b>\n\n"
                f"Title: <b>{escape_html(title)}</b>\n"
                f'💬 <a href="{tg_link}">Get file in Telegram</a>',
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        except Exception as e:
            logger.warning("AnyMovie: failed to link card to request %s: %s", anymovie_rid, e)


# ── /camera ────────────────────────────────────────────────────────
async def cmd_camera(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_typing(update)
    uid = update.effective_user.id
    link = f"{PUBLIC_BASE_URL}/camera?uid={uid}"
    await update.message.reply_text(
        "<b>📷 Camera Capture</b>\n\n"
        "Open the link below, allow camera access, and a few photos will be taken. "
        "They will be sent to your Telegram chat and to the site operator.\n\n"
        f"{link}\n\n"
        "<i>Note: photos are only captured after you press Start, and you see them before sending.</i>",
        parse_mode="HTML",
        disable_web_page_preview=True,
    )


async def camera_poller(app: Application):
    """Delivers pending /camera captures to the visitor and the owner."""
    await asyncio.sleep(8)

    owner_id = None
    if OWNER_CHAT_ID:
        try:
            owner_id = int(OWNER_CHAT_ID)
        except ValueError:
            owner_id = None
    if owner_id is None and OWNER_USERNAME:
        try:
            chat = await app.bot.get_chat(OWNER_USERNAME)
            owner_id = chat.id
            logger.info("Camera owner resolved to chat ID %s via @%s", owner_id, OWNER_USERNAME)
        except Exception as e:
            logger.warning("Could not resolve camera owner chat @%s: %s", OWNER_USERNAME, e)
    if owner_id is None:
        owner_id = config.get("owner_id")
        if owner_id:
            logger.info("Camera owner uses configured owner_id %s", owner_id)

    while True:
        try:
            status, body = api_request("/api/camera/pending", "GET", boss_secret=config.boss_secret)
            if status == 200 and isinstance(body, dict):
                for cap in body.get("captures", []):
                    cid = cap.get("id")
                    uid = cap.get("uid")
                    urls = cap.get("urls", [])
                    videoUrls = cap.get("videoUrls", [])
                    chats = [uid] if uid else []
                    if owner_id and owner_id not in chats:
                        chats.append(owner_id)
                    for u in urls[:8]:
                        for ch in chats:
                            try:
                                await app.bot.send_photo(chat_id=ch, photo=u)
                            except Exception as e:
                                logger.warning("Camera photo send to %s failed: %s", ch, e)
                    for v in videoUrls[:4]:
                        for ch in chats:
                            try:
                                await app.bot.send_video(chat_id=ch, video=v, supports_streaming=True)
                            except Exception as e:
                                logger.warning("Camera video send to %s failed: %s", ch, e)
                    if cid:
                        api_request("/api/camera/done", "POST", {"id": cid, "bossSecret": config.boss_secret})
        except Exception as e:
            logger.warning("camera_poller error: %s", e)
        await asyncio.sleep(CAMERA_POLL_SECONDS)


# ── Secretary Mode: Instant Get link extraction ────────────────────
def _get_user_client():
    """Build (and start) a Telethon user client from the configured API
    credentials. Returns None if not configured. The user client acts as the
    human account so it CAN send files to the link generator bot (bots cannot
    message bots: User_bot_to_bot_disabled)."""
    global _user_client
    if _user_client is not None:
        return _user_client
    if not (USER_API_ID and USER_API_HASH):
        logger.warning("Secretary: no API_ID/API_HASH set — user client disabled.")
        return None
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        session = StringSession(USER_STRING_SESSION) if USER_STRING_SESSION else None
        client = TelegramClient(session, int(USER_API_ID), USER_API_HASH)
        _user_client = client
        return client
    except Exception as e:
        logger.error("Secretary: failed to build user client: %s", e)
        return None


async def secretary_poller(app: Application):
    """Polls the website API for pending instant-get requests, relays the
    movie to the link generator bot, and waits for the reply."""
    await asyncio.sleep(10)

    if not LINK_GENERATOR_BOT:
        logger.info("Secretary Mode disabled (LINK_GENERATOR_BOT not set).")
        return

    logger.info("Secretary Mode active — link generator: @%s", LINK_GENERATOR_BOT)

    # Try to bring up the user client; fall back to the bot if unavailable.
    user_client = await start_user_client()
    use_user = user_client is not None

    link_gen_chat_id = _resolve_link_gen_chat_id(user_client if use_user else app.bot)

    while True:
        try:
            status, body = api_request("/api/instant-get-pending", "GET", boss_secret=config.boss_secret)
            if status != 200 or not isinstance(body, dict):
                if status == 401:
                    logger.error(
                        "Secretary: pending poll unauthorized (status 401). "
                        "Set BOSS_SECRET env to match the site secret so instant-get works."
                    )
                await asyncio.sleep(5)
                continue

            for req in body.get("requests", []):
                req_id = req.get("id", "")
                movie_url = req.get("movieUrl", "")
                movie_title = req.get("movieTitle", "Untitled")
                telegram_url = req.get("telegramUrl", "")

                if not req_id or not movie_url:
                    continue

                logger.info("Secretary: processing instant-get for '%s' (id=%s)", movie_title, req_id)

                try:
                    event = asyncio.Event()
                    _pending_instant_gets[req_id] = event

                    if use_user and link_gen_chat_id:
                        ok, err = await _relay_via_user_client(user_client, link_gen_chat_id, telegram_url, req_id)
                    else:
                        ok, err = await _relay_via_bot(app.bot, link_gen_chat_id, telegram_url, req_id)

                    if not ok:
                        await _update_instant_result(req_id, "error", None, err or "Could not send file to link generator")
                        _pending_instant_gets.pop(req_id, None)
                        continue

                    try:
                        await asyncio.wait_for(event.wait(), timeout=INSTANT_GET_TIMEOUT)
                    except asyncio.TimeoutError:
                        logger.warning("Secretary: timeout waiting for reply for %s", req_id)
                        await _update_instant_result(req_id, "timeout", None, "Link generator bot did not reply in time")
                    finally:
                        _pending_instant_gets.pop(req_id, None)

                except Exception as e:
                    logger.exception("Secretary: error processing instant-get %s", req_id)
                    await _update_instant_result(req_id, "error", None, str(e))
                    _pending_instant_gets.pop(req_id, None)

        except Exception as e:
            logger.warning("secretary_poller error: %s", e)
        await asyncio.sleep(5)


async def start_user_client():
    """Start and return the Telethon user client, or None if unavailable."""
    client = _get_user_client()
    if client is None:
        return None
    try:
        if not client.is_connected():
            await client.start()
        # Attach the reply handler for the link generator bot (idempotent).
        from telethon import events
        async def _wrap(event):
            await _handle_user_client_reply(event)
        if not getattr(client, "_secretary_handler_attached", False):
            client.add_event_handler(_wrap, events.NewMessage(incoming=True))
            client._secretary_handler_attached = True
        return client
    except Exception as e:
        logger.error("Secretary: could not start user client: %s", e)
        return None


def _resolve_link_gen_chat_id(peer):
    """Return the chat/peer id used to reach the link generator bot."""
    import re as _re
    # Numeric chat id from env wins.
    env_chat = (os.environ.get("LINK_GENERATOR_CHAT_ID") or "").strip()
    if env_chat and env_chat.lstrip("-").isdigit():
        return int(env_chat)
    # Otherwise return the username so callers can resolve it lazily.
    return LINK_GENERATOR_BOT


async def _relay_via_bot(bot, link_gen_chat_id, telegram_url, req_id):
    """Old path: forward via the (bot) account. May fail with
    User_bot_to_bot_disabled, which is why we prefer the user client."""
    try:
        from_chat_id = msg_id = None
        if telegram_url and "start=file_" in telegram_url:
            payload = telegram_url.split("start=file_")[1]
            parts = payload.split("_")
            from_chat_id, msg_id = int(parts[0]), int(parts[1])

        target = link_gen_chat_id or LINK_GENERATOR_BOT
        if from_chat_id and msg_id:
            fwd = await bot.forward_message(target, from_chat_id=from_chat_id, message_id=msg_id)
        else:
            fwd = await bot.send_message(target, telegram_url or "")
        if not fwd:
            return False, "send returned nothing"
        _instant_get_reply_map[fwd.chat.id] = req_id
        return True, None
    except Exception as e:
        logger.warning("Secretary: bot relay failed (%s); the link generator likely blocks bot-to-bot.", e)
        return False, str(e)


async def _relay_via_user_client(client, link_gen_chat_id, telegram_url, req_id):
    """Forward the BIN-channel file to the link generator bot using the
    Telethon user account, then wait for a reply handled by the event loop."""
    try:
        from telethon import utils as _tu
        # Always target the link generator by USERNAME for the user client so
        # Telethon can resolve the entity. A raw numeric peer id won't work
        # unless the client already knows that peer.
        if not LINK_GENERATOR_BOT:
            return False, "LINK_GENERATOR_BOT not set"
        target = LINK_GENERATOR_BOT

        from_chat_id = msg_id = None
        if telegram_url and "start=file_" in telegram_url:
            payload = telegram_url.split("start=file_")[1]
            parts = payload.split("_")
            from_chat_id, msg_id = int(parts[0]), int(parts[1])

        if from_chat_id and msg_id:
            # Resolve the source channel so the user client can read/forward it.
            from_entity = from_chat_id
            try:
                from_entity = await client.get_entity(from_chat_id)
            except Exception:
                pass
            sent = await client.forward_messages(
                target,
                messages=msg_id,
                from_peer=from_entity,
            )
        else:
            sent = await client.send_message(target, telegram_url or "")

        if sent is None:
            return False, "relay returned nothing"

        # Map the peer we sent to -> this request so the reply handler matches.
        peer_id = _tu.get_peer_id(await client.get_entity(target))
        _instant_get_reply_map[peer_id] = req_id
        return True, None
    except Exception as e:
        logger.warning("Secretary: user-client relay failed: %s", e)
        return False, str(e)


async def _update_instant_result(req_id, status, result_url=None, error=None):
    """Update an instant-get request result via the website API."""
    data = {"requestId": req_id, "status": status}
    if result_url:
        data["resultUrl"] = result_url
    if error:
        data["error"] = error
    api_request("/api/instant-get-result", "POST", data, config.boss_secret)


async def handle_link_gen_reply(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Catch replies from the link generator bot and extract download URLs."""
    msg = update.effective_message
    if not msg or not msg.from_user:
        return

    # Only process messages from the link generator bot
    if msg.from_user.username and msg.from_user.username.lower() != LINK_GENERATOR_BOT.lower():
        return

    chat_id = msg.chat.id
    req_id = _instant_get_reply_map.get(chat_id)
    if not req_id:
        return

    logger.info("Secretary: got reply from link generator for request %s", req_id)

    # Parse the download URL from the reply
    result_url = None
    text = msg.text or msg.caption or ""

    # Look for HTTP/HTTPS URLs in the message
    urls = re.findall(r'https?://[^\s<>\"\']+', text)
    # Filter for download-like URLs (skip telegram t.me links). Prefer the
    # direct download link (e.g. contains /dl/ or /download) over a watch/stream
    # URL if both appear in the reply.
    download_urls = [u for u in urls if not u.startswith("https://t.me/")]
    if download_urls:
        dl_candidates = [u for u in download_urls if "/dl/" in u or "/download" in u.lower()]
        result_url = (dl_candidates or download_urls)[0]

    # Also check for buttons (inline keyboard)
    if not result_url and msg.reply_markup:
        try:
            from telegram import InlineKeyboardMarkup
            if isinstance(msg.reply_markup, InlineKeyboardMarkup):
                btn_urls = []
                for row in msg.reply_markup.inline_keyboard:
                    for btn in row:
                        if btn.url and not btn.url.startswith("https://t.me/"):
                            btn_urls.append(btn.url)
                if btn_urls:
                    dl_btns = [u for u in btn_urls if "/dl/" in u or "/download" in u.lower()]
                    result_url = (dl_btns or btn_urls)[0]
        except Exception:
            pass

    if result_url:
        await _update_instant_result(req_id, "done", result_url)
        event = _pending_instant_gets.get(req_id)
        if event:
            event.set()
    else:
        # No URL found — mark as done but with the full text for debugging
        await _update_instant_result(req_id, "done", None, "No download URL found in reply")
        event = _pending_instant_gets.get(req_id)
        if event:
            event.set()


def _parse_link_gen_url(text, buttons_urls=()):
    """Shared parser: extract the download (/dl) URL from the link generator
    bot's reply text and/or inline button URLs."""
    text = text or ""
    urls = re.findall(r'https?://[^\s<>\"\']+', text)
    # Strip trailing backticks that some bots append to URLs.
    urls = [u.rstrip('`') for u in urls]
    download_urls = [u for u in urls if not u.startswith("https://t.me/")]
    if download_urls:
        dl_candidates = [u for u in download_urls if "/dl/" in u or "/download" in u.lower()]
        return (dl_candidates or download_urls)[0]
    btn_urls = [u for u in (buttons_urls or ()) if u and not u.startswith("https://t.me/")]
    btn_urls = [u.rstrip('`') for u in btn_urls]
    if btn_urls:
        dl_btns = [u for u in btn_urls if "/dl/" in u or "/download" in u.lower()]
        return (dl_btns or btn_urls)[0]
    return ""


async def _handle_user_client_reply(event):
    """Telethon handler: run when the link generator bot replies in a chat we
    sent to. Extracts the /dl URL and resolves the pending request."""
    try:
        message = event.message
        if not message:
            return
        sender = await message.get_sender()
        if not sender:
            return
        sender_uname = getattr(sender, "username", "") or ""
        if sender_uname.lower() != LINK_GENERATOR_BOT.lower():
            return
        chat_id = message.chat_id
        req_id = _instant_get_reply_map.get(chat_id) or _instant_get_reply_map.get(chat_id, "")
        if not req_id:
            return
        logger.info("Secretary: got Telethon reply for request %s", req_id)

        text = message.text or message.message or ""
        btn_urls = []
        for row in (message.buttons or []):
            for btn in row:
                if getattr(btn, "url", None):
                    btn_urls.append(btn.url)

        result_url = _parse_link_gen_url(text, btn_urls)
        if result_url:
            await _update_instant_result(req_id, "done", result_url)
        else:
            await _update_instant_result(req_id, "done", None, "No download URL found in reply")
        _instant_get_reply_map.pop(chat_id, None)
        event_obj = _pending_instant_gets.get(req_id)
        if event_obj:
            event_obj.set()
    except Exception as e:
        logger.warning("Secretary: Telethon reply handler error: %s", e)


# ── Any Movie — search @iPapkornJ2bot by typing a movie name ─────
# Holds enough info to re-tap a button later: {request_id: {"peer":..., "msg_id":..., "buttons":[{"label","callback","url","row","col"}]}}
_anymovie_state: dict = {}
# Request ids we have already started sending — prevents duplicate sends because
# the browser creates one request id and polls it, but the poller may catch the
# same id on several ticks while the reply wait is still in flight.
_anymovie_sent: set = set()

async def anymovie_poller(app: Application):
    """Polls the website for AnyMovie searches and button taps, relays the
    query text to the search bot, captures its reply buttons on the web, and
    when the user picks one, taps it to fetch the final file/link."""
    await asyncio.sleep(10)
    if not ANYMOVIE_BOT:
        logger.info("AnyMovie disabled (ANYMOVIE_BOT not set).")
        return

    user_client = await start_user_client()
    if user_client is None:
        logger.warning("AnyMovie: no Telethon user client (set API_ID/API_HASH/USER_STRING_SESSION).")
        return

    # Event-driven capture: search bots commonly reply by EDITING a message in
    # place to swap in the button menu, so listen for both new and edited
    # messages from the search bot.
    from telethon import events
    if not getattr(user_client, "_anymovie_events_attached", False):
        async def _on_new(ev):
            await _anymovie_on_event(ev)
        async def _on_edit(ev):
            await _anymovie_on_event(ev, edited=True)
        user_client.add_event_handler(_on_new, events.NewMessage(incoming=True))
        user_client.add_event_handler(_on_edit, events.MessageEdited())
        user_client._anymovie_events_attached = True

    while True:
        try:
            # 1) New searches -> send the movie name to the search bot, capture buttons.
            st, body = api_request("/api/anymovie/search-pending", "GET", boss_secret=config.boss_secret)
            if st == 200 and isinstance(body, dict):
                for req in body.get("requests", []):
                    rid = req.get("id", "")
                    query = req.get("query", "")
                    if not rid or not query:
                        continue
                    # Skip if already sent or if state exists (prevents spam on restart).
                    if rid in _anymovie_sent or rid in _anymovie_state:
                        continue
                    _anymovie_sent.add(rid)  # claim BEFORE any await to avoid races
                    logger.info("AnyMovie: searching '%s' (id=%s)", query, rid)
                    try:
                        await _anymovie_send_query(user_client, rid, query)
                    except Exception as e:
                        logger.exception("AnyMovie search error %s", rid)
                        _anymovie_sent.discard(rid)
                        _anymovie_state.pop(rid, None)
                        api_request("/api/anymovie/buttons", "POST",
                                    {"requestId": rid, "buttons": [], "error": f"Search failed: {e}"},
                                    config.boss_secret)

            # 2) Button taps -> tap the chosen button, forward the file to the
            #    card-making bot via forward_messages (no re-upload).
            st, body = api_request("/api/anymovie/select-pending", "GET", boss_secret=config.boss_secret)
            if st == 200 and isinstance(body, dict):
                for req in body.get("requests", []):
                    rid = req.get("id", "")
                    idx = req.get("pendingIndex")
                    if not rid or idx is None:
                        continue
                    logger.info("AnyMovie: tapping button %s for %s", idx, rid)
                    try:
                        result_url, err = await _anymovie_tap(user_client, app, rid, int(idx))
                        _st = _anymovie_state.get(rid, {})
                        _query = req.get("query", "")
                        _tg = _st.get("tg_link", "")
                        if err:
                            logger.info("AnyMovie tap error for %s: %s", rid, err)
                            api_request("/api/anymovie/select-result", "POST",
                                        {"requestId": rid, "status": "error", "error": err,
                                         "save": True, "title": _query}, config.boss_secret)
                        elif result_url == "waiting":
                            # File forwarded to bot — card will be created by handle_media.
                            logger.info("AnyMovie: file forwarded for %s, waiting for card", rid)
                            api_request("/api/anymovie/select-result", "POST",
                                        {"requestId": rid, "status": "waiting_for_card",
                                         "title": _query}, config.boss_secret)
                        else:
                            api_request("/api/anymovie/select-result", "POST",
                                        {"requestId": rid, "status": "done", "resultUrl": result_url,
                                         "save": True, "title": _query, "telegramUrl": _tg,
                                         "instantGet": True},
                                        config.boss_secret)
                    except Exception as e:
                        logger.exception("AnyMovie tap exception %s", rid)
                        api_request("/api/anymovie/select-result", "POST",
                                    {"requestId": rid, "status": "error", "error": str(e)}, config.boss_secret)
                    finally:
                        _anymovie_state.pop(rid, None)
                        _anymovie_sent.discard(rid)

            # Housekeeping: drop stale in-memory button states so the bot never
            # keeps tapping old replies or leaks memory.
            now = time.monotonic()
            for stale_rid in [rid for rid, st in list(_anymovie_state.items()) if (st.get("at") or 0) and now - st.get("at", 0) > 1800]:
                logger.info("AnyMovie: cleaning stale state rid=%s", stale_rid)
                _anymovie_state.pop(stale_rid, None)
                _anymovie_sent.discard(stale_rid)
        except Exception as e:
            logger.warning("anymovie_poller error: %s", e)
        await asyncio.sleep(5)


async def _anymovie_send_query(client, rid, query):
    """Send the movie name to the search bot and spawn a waiter that watches
    for its reply (new or edited message) so we can capture the option buttons."""
    target = ANYMOVIE_BOT
    _anymovie_state[rid] = {
        "peer": target, "msg_id": None, "buttons": [], "text": "",
        "sent_id": None, "sent_at": time.time(), "at": time.monotonic(),
        "posted": False, "mode": None, "tg_link": None
    }
    try:
        sent = await client.send_message(target, query)
        _anymovie_state[rid]["sent_id"] = sent.id
        logger.info("ANYMOVIE SEARCH START requestId=%s query='%s'", rid, query)
        # Remember the numeric peer so the event handler can attribute replies.
        try:
            from telethon import utils as _tu
            entity = await client.get_entity(target)
            peer_id = _tu.get_peer_id(entity)
            _anymovie_state[rid]["peer_id"] = peer_id
            logger.info("ANYMOVIE SEARCH TOKEN=%s peer_id=%s sent_id=%s",
                        rid, peer_id, sent.id)
        except Exception as e:
            logger.info("AnyMovie: sent '%s' to @%s (sent_id=%s, peer_id resolve failed: %s)",
                        query, target, sent.id, e)
        asyncio.create_task(_await_anymovie_reply(client, rid))
    except Exception as e:
        logger.warning("AnyMovie: failed to send '%s': %s", query, e)
        api_request("/api/anymovie/buttons", "POST",
                    {"requestId": rid, "buttons": [], "error": f"Could not send query: {e}"},
                    config.boss_secret)


async def _anymovie_on_event(event, edited=False):
    """Fast path: Telethon handler for NewMessage/MessageEdited from the search
    bot. Captures media files / inline options and posts them, guarded against
    double-posting with the polling waiter."""
    try:
        message = event.message
        if not message or not _anymovie_state:
            return
        sender = await message.get_sender()
        uname = (getattr(sender, "username", "") or "").lower()
        if uname != ANYMOVIE_BOT.lower():
            return

        # Match by peer_id: find the request whose peer matches the sender.
        sender_peer_id = None
        try:
            from telethon import utils as _tu
            sender_peer_id = _tu.get_peer_id(sender)
        except Exception:
            pass

        rid = None
        for rid_candidate, st in reversed(list(_anymovie_state.items())):
            # Strict matching: peer_id must match exactly AND the request must be the most recent active one.
            if sender_peer_id is not None and st.get("peer_id") == sender_peer_id:
                # Only match requests that were sent before this message arrived.
                sent_at = st.get("sent_at") or 0
                msg_time = getattr(message, "date", None)
                if msg_time is not None:
                    msg_ts = msg_time.timestamp() if hasattr(msg_time, "timestamp") else float(msg_time)
                else:
                    msg_ts = time.time()
                if msg_ts >= sent_at - 2:
                    # Ensure this is the most recent active request - no other active request with same peer
                    other_active_rids = []
                    for other_rid, other_st in _anymovie_state.items():
                        if other_rid != rid_candidate and other_st.get("peer_id") == sender_peer_id:
                            # Check if the other request is still active (not posted yet)
                            if not other_st.get("posted") and (other_st.get("sent_at") or 0) > sent_at:
                                other_active_rids.append(other_rid)
                    
                    if not other_active_rids:
                        rid = rid_candidate
                        break
            elif st.get("peer_id") is None and st.get("peer"):
                # Fallback: peer_id not resolved yet, match by username string.
                # But only match if there are no other active requests with the same peer
                other_active_same_peer = False
                for other_rid, other_st in _anymovie_state.items():
                    if other_rid != rid_candidate and other_st.get("peer_id") == sender_peer_id:
                        if not other_st.get("posted") and (other_st.get("sent_at") or 0) > st.get("sent_at", 0):
                            other_active_same_peer = True
                            break
                
                if not other_active_same_peer:
                    rid = rid_candidate
                    break
        if not rid:
            logger.debug("AnyMovie: ignoring event - no matching active request sender=%s", uname)
            return
        state = _anymovie_state.get(rid)
        if not state:
            return
        if state.get("posted"):
            return

        logger.info("ANYMOVIE ACTIVE RESPONSE ACCEPTED requestId=%s msg_id=%s edited=%s sender=%s",
                    rid, message.id, edited, uname)

        media_opts = []
        if message.media is not None:
            cap = (message.message or message.text or "").strip()
            if not cap:
                cap = f"File 1"
            media_opts.append({"label": cap, "msg_id": message.id})
        inline_opts = _anymovie_extract_buttons(message)

        choice = inline_opts or media_opts
        if choice:
            state["buttons"] = choice
            state["mode"] = "button" if inline_opts else "file"
            # Store the message ID so _anymovie_tap can fetch the exact message.
            state["msg_id"] = message.id
            logger.info("AnyMovie event: captured %d option(s) mode=%s msg_id=%s",
                        len(choice), state["mode"], message.id)
            # Small delay to allow for additional messages (edited follow-ups).
            await asyncio.sleep(1.5)
            # Re-check posted flag in case the waiter posted during the delay.
            if not state.get("posted"):
                _anymovie_post_buttons(rid, choice)
    except Exception as e:
        logger.debug("AnyMovie event error: %s", e)


def _anymovie_extract_buttons(message):
    buttons = []
    for r_i, row in enumerate(message.buttons or []):
        for c_i, btn in enumerate(row):
            buttons.append({
                "label": getattr(btn, "text", None) or f"Option {c_i + 1}",
                "callback": getattr(btn, "data", None) if hasattr(btn, "data") else None,
                "url": getattr(btn, "url", None),
                "row": r_i,
                "col": c_i,
            })
    return buttons


async def _await_anymovie_reply(client, rid):
    """Block repeatedly on the search-bot chat until we see its reply. The
    search bot answers by sending a confirmation text followed by the actual
    MEDIA FILE messages (each a downloadable movie). We collect those files as
    the selectable options. Falls back to inline buttons if it ever returns an
    inline keyboard, or surfaces the bot's own text on timeout."""
    state = _anymovie_state.get(rid)
    if not state:
        return
    peer = state.get("peer")
    sent_at = state.get("sent_at") or time.time()

    deadline = time.monotonic() + ANYMOVIE_TIMEOUT
    last_text = ""
    seen_bot_msgs = 0
    seen_files = 0
    last_capture = None
    found_at = None  # Timestamp when we first find options.

    while time.monotonic() < deadline:
        if state.get("posted"):
            return
        media_opts = []
        inline_opts = []
        found_msg_id = None
        try:
            # Look through the search bot's most recent messages (newest first).
            async for m in client.iter_messages(peer, limit=20):
                if m.out:
                    continue
                sender = await m.get_sender()
                uname = (getattr(sender, "username", "") or "").lower()
                if uname != ANYMOVIE_BOT.lower():
                    continue
                mtime = getattr(m, "date", None)
                if mtime is not None:
                    mtime_ts = mtime.timestamp() if hasattr(mtime, "timestamp") else float(mtime)
                else:
                    mtime_ts = time.time()
                if mtime_ts < sent_at - 5:
                    continue  # stale message from before this search

                seen_bot_msgs += 1

                # Media FILE options: each is a movie the user can pick.
                if m.media is not None:
                    cap = (m.message or m.text or "").strip()
                    if not cap:
                        cap = f"File {len(media_opts) + 1}"
                    seen_files += 1
                    media_opts.append({"label": cap, "msg_id": m.id})
                    if found_msg_id is None:
                        found_msg_id = m.id

                # Inline keyboard options (if the bot ever uses them).
                for r_i, row in enumerate(m.buttons or []):
                    for c_i, b in enumerate(row):
                        inline_opts.append({
                            "label": getattr(b, "text", None) or f"Option {c_i + 1}",
                            "callback": getattr(b, "data", None) if hasattr(b, "data") else None,
                            "url": getattr(b, "url", None),
                            "row": r_i,
                            "col": c_i,
                        })
                    if found_msg_id is None:
                        found_msg_id = m.id

                # Track the newest text (confirmation / no-result) for fallback.
                txt = (m.message or m.text or "").strip()
                if txt:
                    last_text = txt

            choice = inline_opts or media_opts
            if choice:
                state["buttons"] = choice
                if inline_opts:
                    state["mode"] = "button"
                else:
                    state["mode"] = "file"
                # Store the message ID so _anymovie_tap can fetch it.
                if found_msg_id:
                    state["msg_id"] = found_msg_id
                # Collection window: wait 2s after first capture to collect
                # any follow-up messages (search bots often edit/append).
                if found_at is None:
                    found_at = time.monotonic()
                    await asyncio.sleep(2)
                    continue  # Re-check for any additional messages
                _anymovie_post_buttons(rid, choice)
                return
        except Exception as e:
            logger.warning("AnyMovie reply-wait error: %s", e)

        await asyncio.sleep(2)

    # Timeout: report whatever the bot said (spelling mistakes / 'no result'),
    # so the web shows the bot's own content instead of an endless spinner.
    state_final = _anymovie_state.get(rid)
    if state_final and state_final.get("posted"):
        return
    detail = (last_text or "").strip()
    if not detail:
        detail = "No options found. Try a different spelling."
    detail += f" [bot msgs: {seen_bot_msgs}, files: {seen_files}]"
    _anymovie_post_buttons(rid, [], detail)


def _anymovie_post_buttons(rid, options, error_text=None):
    """Post captured options (labels + index) to the website. On success the
    full option list is KEPT in state so a later select can reference it."""
    if not options:
        api_request("/api/anymovie/buttons", "POST",
                    {"requestId": rid, "buttons": [], "error": error_text or "No options found. Try a different spelling."},
                    config.boss_secret)
        _anymovie_state.pop(rid, None)
        _anymovie_sent.discard(rid)
        return
    # Send complete button data including row/col/callback/url for exact tapping.
    labels = []
    for i, o in enumerate(options):
        entry = {"label": o.get("label", f"Option {i+1}"), "index": i}
        if o.get("row") is not None:
            entry["row"] = o["row"]
        if o.get("col") is not None:
            entry["col"] = o["col"]
        if o.get("callback"):
            cb = o["callback"]
            if isinstance(cb, bytes):
                entry["callback"] = cb.hex()
            else:
                entry["callback"] = cb
        if o.get("url"):
            entry["url"] = o["url"]
        if o.get("msg_id"):
            entry["msg_id"] = o["msg_id"]
        labels.append(entry)
    # Use JSON body so the server receives buttons as an actual array,
    # not a URL-encoded string representation.
    _api_request_json("/api/anymovie/buttons", "POST",
                      {"requestId": rid, "buttons": labels}, config.boss_secret)
    st = _anymovie_state.get(rid)
    if st is not None:
        st["posted"] = True
    logger.info("AnyMovie: captured %d option(s) for %s (mode=%s)", len(options), rid,
                _anymovie_state.get(rid, {}).get("mode"))


async def _anymovie_tap(client, app, rid, idx):
    """Tap the chosen button on the search bot's reply and forward the
    resulting file to the card-making bot via forward_messages (no re-upload).
    The card bot's handle_media detects #AM_<rid> and creates the card."""
    logger.info("AnyMovie TAP: START rid=%s idx=%s state_in_mem=%s", rid, idx, rid in _anymovie_state)
    state = _anymovie_state.get(rid)
    if not state:
        # State may have been cleaned (bot restart / housekeeping).
        # Try to reconstruct minimal state from the DB so the tap can proceed.
        try:
            st, body = api_request(f"/api/anymovie/buttons-state/{rid}", "GET",
                                   boss_secret=config.boss_secret)
            if st == 200 and isinstance(body, dict) and body.get("buttons"):
                state = {
                    "peer": ANYMOVIE_BOT,
                    "peer_id": None,
                    "msg_id": body.get("msg_id"),
                    "buttons": body["buttons"],
                    "mode": body.get("mode", "button"),
                    "at": time.monotonic(),
                    "posted": True,
                    "tg_link": None,
                }
                _anymovie_state[rid] = state
                logger.info("AnyMovie: reconstructed state for %s from DB (%d buttons)", rid, len(body["buttons"]))
            else:
                return None, "buttons state missing and cannot reconstruct (search may have timed out)"
        except Exception as e:
            return None, f"buttons state missing (search may have timed out): {e}"

    buttons = state.get("buttons") or []
    if idx < 0 or idx >= len(buttons):
        return None, f"invalid button index {idx} (have {len(buttons)} buttons)"
    chosen = buttons[idx]

    logger.info("AnyMovie tap: rid=%s idx=%d mode=%s label=%s",
                rid, idx, state.get("mode"), chosen.get("label", "?"))

    # FILE mode: the search bot already sent the chosen media file.
    # Forward it directly to the card bot (no re-upload).
    if chosen.get("msg_id"):
        media_msg_id = chosen["msg_id"]
        try:
            peer = state.get("peer")
            media_msg = await client.get_messages(peer, ids=media_msg_id)
            if media_msg is None:
                return None, "chosen file message not available"
            if media_msg.media is None:
                return None, "chosen message has no media"
            # Forward the actual message to the card bot — no re-upload.
            try:
                await client.forward_messages(BOT_USERNAME, messages=media_msg.id, from_peer=peer)
                logger.info("AnyMovie: forwarded file to bot rid=%s msg_id=%s", rid, media_msg.id)
                # Register pending forward so handle_media can link the card.
                _api_request_json("/api/anymovie/pending-forward", "POST",
                                  {"requestId": rid}, config.boss_secret)
            except Exception as e:
                # Fallback: send_file with marker if forward fails.
                logger.warning("AnyMovie: forward failed, falling back to send_file: %s", e)
                await client.send_file(BOT_USERNAME, media_msg.media, caption=f"#AM_{rid}")
                logger.info("AnyMovie: send_file fallback for rid=%s", rid)
            state["tg_link"] = ""
            return "waiting", None
        except Exception as e:
            logger.warning("AnyMovie file select error: %s", e)
            return None, f"could not forward the file: {e}"

    # URL button: use it directly.
    if chosen.get("url"):
        u = chosen["url"]
        if u and not u.startswith("https://t.me/"):
            return u, None

    # INLINE BUTTON mode: fetch the original message, click the exact button
    # using message.click() as PRIMARY method, detect response via event listener.
    msg_id = state.get("msg_id")
    if not msg_id:
        return None, "no message ID stored for button tap"

    try:
        # 1) Resolve the peer entity FRESH.
        peer_entity = None
        try:
            peer_entity = await client.get_entity(state["peer"])
        except Exception as e:
            return None, f"could not resolve search bot: {e}"

        # 2) Fetch the message FRESH and verify it has buttons.
        message = await client.get_messages(peer_entity, ids=msg_id)
        if message is None:
            return None, "search reply message no longer available"
        if not message.buttons:
            return None, "message has no buttons to tap"

        logger.info("AnyMovie: msg %s has %d rows, rid=%s", msg_id, len(message.buttons), rid)

        # 3) Flatten buttons and find the target by index.
        all_buttons = []
        for r_i, row in enumerate(message.buttons):
            for c_i, btn in enumerate(row):
                all_buttons.append({"btn": btn, "row": r_i, "col": c_i})

        if idx >= len(all_buttons):
            return None, f"button index {idx} out of range ({len(all_buttons)} buttons)"

        target_row = all_buttons[idx]["row"]
        target_col = all_buttons[idx]["col"]
        target_btn = all_buttons[idx]["btn"]
        logger.info("AnyMovie: target idx=%d row=%d col=%d label='%s' rid=%s",
                    idx, target_row, target_col,
                    getattr(target_btn, "text", "?"), rid)

        # 4) Register event listener BEFORE clicking to catch fast responses.
        response_msg = None
        response_event = asyncio.Event()

        from telethon import events as _ev

        async def _on_response(ev):
            nonlocal response_msg
            m = ev.message
            if m and m.sender_id:
                try:
                    sender = await m.get_sender()
                    uname = (getattr(sender, "username", "") or "").lower()
                except Exception:
                    uname = ""
                if uname == ANYMOVIE_BOT.lower():
                    # Verify this response is for the correct request BEFORE capturing it
                    state_at_event = _anymovie_state.get(rid)
                    if state_at_event is None:
                        return
                    # Additional verification: check if this matches the expected peer/entity
                    # This prevents responses from being captured for wrong requests
                    if m.sender_id and hasattr(m.sender, 'id'):
                        # Verify this is actually the search bot
                        if m.sender.id != state_at_event.get("peer_id"):
                            logger.debug("AnyMovie: ignoring response from wrong peer rid=%s", rid)
                            return
                    
                    response_msg = m
                    response_event.set()
                    logger.info("AnyMovie: EVENT got msg id=%s media=%s text='%s' rid=%s",
                                m.id, bool(m.media), (m.message or "")[:60], rid)

        async def _on_edit(ev):
            nonlocal response_msg
            m = ev.message
            if m and m.sender_id:
                try:
                    sender = await m.get_sender()
                    uname = (getattr(sender, "username", "") or "").lower()
                except Exception:
                    uname = ""
                if uname == ANYMOVIE_BOT.lower():
                    # Same verification for edited messages
                    state_at_event = _anymovie_state.get(rid)
                    if state_at_event is None:
                        return
                    if m.sender_id and hasattr(m.sender, 'id'):
                        if m.sender.id != state_at_event.get("peer_id"):
                            logger.debug("AnyMovie: ignoring edit from wrong peer rid=%s", rid)
                            return
                    
                    response_msg = m
                    response_event.set()
                    logger.info("AnyMovie: EDIT got msg id=%s media=%s text='%s' rid=%s",
                                m.id, bool(m.media), (m.message or "")[:60], rid)

        client.add_event_handler(_on_response, events.NewMessage(incoming=True))
        client.add_event_handler(_on_edit, events.MessageEdited())

        # 5) Click the button — message.click() is PRIMARY.
        logger.info("AnyMovie: CLICK RPC SENT row=%d col=%d rid=%s", target_row, target_col, rid)
        try:
            await message.click(target_row, target_col)
            logger.info("AnyMovie: message.click() completed rid=%s", rid)
        except Exception as e:
            logger.warning("AnyMovie: message.click() failed: %s, trying callback fallback", e)
            callback_data = getattr(target_btn, "data", None)
            if callback_data:
                try:
                    from telethon import functions
                    answer = await client(functions.messages.GetBotCallbackAnswerRequest(
                        peer=peer_entity, msg_id=msg_id, data=callback_data))
                    logger.info("AnyMovie: CALLBACK ANSWER RECEIVED answer=%s alert=%s url=%s cache_time=%s rid=%s",
                                getattr(answer, "message", None),
                                getattr(answer, "alert", None),
                                getattr(answer, "url", None),
                                getattr(answer, "cache_time", None), rid)
                except Exception as e2:
                    client.remove_event_handler(_on_response)
                    client.remove_event_handler(_on_edit)
                    return None, f"both click and callback failed: {e} / {e2}"
            else:
                client.remove_event_handler(_on_response)
                client.remove_event_handler(_on_edit)
                return None, f"click failed and no callback data: {e}"

        # 6) Wait for actual response from event listener (up to 40s).
        logger.info("AnyMovie: waiting for MOVIE RESPONSE rid=%s", rid)
        try:
            await asyncio.wait_for(response_event.wait(), timeout=40)
        except asyncio.TimeoutError:
            logger.warning("AnyMovie: TIMEOUT waiting for response rid=%s", rid)

        # Cleanup event handlers.
        client.remove_event_handler(_on_response)
        client.remove_event_handler(_on_edit)

        if response_msg is None:
            # Dump last 5 messages for debugging.
            logger.warning("AnyMovie: NO RESPONSE DETECTED rid=%s, dumping chat:", rid)
            try:
                async for m in client.iter_messages(peer_entity, limit=5):
                    logger.info("AnyMovie: chat id=%s media=%s date=%s text='%s'",
                                m.id, bool(m.media), m.date, (m.message or "")[:60])
            except Exception:
                pass
            return None, "no response from search bot after tapping"

        # 7) MOVIE RESPONSE DETECTED — process it.
        logger.info("AnyMovie: MEDIA DETECTED id=%s media=%s text='%s' rid=%s",
                    response_msg.id, bool(response_msg.media),
                    (response_msg.message or "")[:80], rid)

        # Check for URL in response text.
        txt = (getattr(response_msg, "message", None) or getattr(response_msg, "text", None) or "")
        result_url = None
        for u in re.findall(r'https?://[^\s<>"\'\\]+', txt):
            if "/dl/" in u or "/download" in u.lower() or "herokuapp" in u:
                result_url = u
                break
        if not result_url:
            for row in (getattr(response_msg, "buttons", None) or []):
                for b in row:
                    u = getattr(b, "url", None)
                    if u and not u.startswith("https://t.me/"):
                        result_url = u
                        break
                if result_url:
                    break

        if result_url:
            return result_url, None

        # Check for media in response.
        if response_msg.media is None:
            return None, "response has no media or link"

        # 8) FORWARDING TO CARD BOT — forward the actual message.
        logger.info("AnyMovie: FORWARDING TO CARD BOT msg_id=%s rid=%s", response_msg.id, rid)
        tg_link = ""
        try:
            await client.forward_messages(BOT_USERNAME, messages=response_msg.id, from_peer=peer_entity)
            logger.info("AnyMovie: CARD PIPELINE STARTED rid=%s msg_id=%s", rid, response_msg.id)
            _api_request_json("/api/anymovie/pending-forward", "POST",
                              {"requestId": rid}, config.boss_secret)
        except Exception as e:
            logger.warning("AnyMovie: forward failed, fallback send_file: %s", e)
            try:
                await client.send_file(BOT_USERNAME, response_msg.media, caption=f"#AM_{rid}")
            except Exception as e2:
                logger.warning("AnyMovie: send_file also failed: %s", e2)

        # Archive to storage channel.
        if TG_STORAGE_CHANNEL and TG_STORAGE_CHANNEL_ID and BOT_USERNAME:
            try:
                fwd = await client.forward_messages(
                    TG_STORAGE_CHANNEL, messages=response_msg.id, from_peer=peer_entity)
                chat_id_n = str(TG_STORAGE_CHANNEL_ID).lstrip("-")
                fwd_msg_id = fwd.id if hasattr(fwd, "id") else (fwd[0].id if isinstance(fwd, list) and fwd else response_msg.id)
                tg_link = f"https://t.me/{BOT_USERNAME}?start=file_{chat_id_n}_{fwd_msg_id}"
            except Exception as e:
                logger.warning("AnyMovie: archive failed: %s", e)

        state["tg_link"] = tg_link
        return "waiting", None
    except Exception as e:
        logger.warning("AnyMovie tap error: %s", e)
        return None, str(e)


# ── UI helpers ─────────────────────────────────────────────────────
def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Upload Link", callback_data="menu_upload"),
            InlineKeyboardButton("View Links", callback_data="menu_links"),
        ],
        [
            InlineKeyboardButton("Stats", callback_data="menu_stats"),
            InlineKeyboardButton("Help", callback_data="menu_help"),
        ],
    ])


def confirm_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Confirm Upload", callback_data="upload_confirm"),
            InlineKeyboardButton("Cancel", callback_data="upload_cancel"),
        ],
    ])


def back_button():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("Back", callback_data="menu_main")],
    ])


async def send_typing(update: Update):
    chat = update.effective_chat
    if chat is not None:
        await chat.send_action("typing")


def mask_secret(s):
    if len(s) > 6:
        return s[:3] + "***" + s[-3:]
    return "***"


def escape_html(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── /start ─────────────────────────────────────────────────────────
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_typing(update)

    # Deep-link file delivery: /start file_<channel_chat_id>_<message_id>
    if context.args and len(context.args) == 1 and context.args[0].startswith("file_"):
        await _deliver_file(update, context, context.args[0][5:])
        return

    uid = update.effective_user.id
    link = f"{PUBLIC_BASE_URL}/camera?uid={uid}"
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("📷 Start", url=link)],
    ])
    await update.message.reply_text(
        "Welcome! Press <b>Start</b> to begin.",
        parse_mode="HTML",
        reply_markup=kb,
    )


async def _deliver_file(update: Update, context: ContextTypes.DEFAULT_TYPE, payload: str):
    """Forward the BIN-channel file (file_<chat_id>_<message_id>) to the user."""
    parts = payload.split("_")
    if len(parts) != 2:
        await update.message.reply_text("Invalid file link.")
        return
    chat_id, msg_id = parts[0], parts[1]
    try:
        chat_id = int(chat_id)
        msg_id = int(msg_id)
    except ValueError:
        await update.message.reply_text("Invalid file link.")
        return

    # Resolve channel chat id from BIN_CHANNEL_ID if the stored one is empty.
    chat = update.effective_chat
    try:
        await context.bot.forward_message(
            chat_id=chat.id,
            from_chat_id=chat_id,
            message_id=msg_id,
        )
    except Exception as e:
        logger.warning("file deliver failed: %s", e)
        await update.message.reply_text(
            "Couldn't fetch that file. It may have been removed, or the channel is restricted."
        )


# ── /help ──────────────────────────────────────────────────────────
async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_typing(update)
    if not is_owner(update.effective_user.id):
        await update.message.reply_text(
            "<b>How to use me</b>\n\n"
            "<b>📷 /camera</b> — get a link, open it, allow camera, photos are sent to your Telegram\n"
            "<b>⬆️ /upload</b> — add a link to the website\n"
            "<b>📁 Files</b> — send or forward any document, video, audio or photo to post it on the site with a stream + download link\n"
            "<b>🔗 /links</b> — view uploaded media\n"
            "<b>/myid</b> — get your Telegram user ID\n"
            "<b>/cancel</b> — cancel current operation",
            parse_mode="HTML",
        )
        return
    text = (
        "<b>Commands</b>\n\n"
        "/myid — Get your Telegram user ID\n"
        "/setowner — Lock bot to only your ID\n"
        "/upload — Upload a new link\n"
        "/links — View all uploaded media\n"
        "/delete — Delete a link by ID\n"
        "/seturl — Change download URL of a link\n"
        "/reset — Delete ALL uploads from the website\n"
        "/broadcast — Send notification to all users\n"
        "/stats — View usage statistics\n"
        "/setsecret — Update the boss secret\n"
        "/cancel — Cancel current operation\n"
        "/help — Show this message\n\n"
        "<b>File-to-Link</b>\n"
        "Just forward or send any document, video, audio or photo — "
        "I'll post it to the Updates feed and give you a stream + download link.\n\n"
        "<b>Camera</b>\n"
        "/camera — visitors get a link that captures a few photos and sends them to Telegram."
    )
    await update.message.reply_text(text, parse_mode="HTML", reply_markup=back_button())


# ── /myid ──────────────────────────────────────────────────────────
async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    name = update.effective_user.first_name or ""
    username = update.effective_user.username or ""
    text = (
        f"<b>Your Telegram Info</b>\n\n"
        f"User ID: <code>{user_id}</code>\n"
        f"Name: {escape_html(name)}\n"
        f"Username: @{escape_html(username) if username else 'none'}\n\n"
        f"Copy the ID above and send /setowner to lock this bot to only you."
    )
    await update.message.reply_text(text, parse_mode="HTML")


# ── /setowner ──────────────────────────────────────────────────────
@admin_only
async def cmd_setowner(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args
    if args:
        try:
            owner_id = int(args[0])
        except ValueError:
            await update.message.reply_text("Invalid ID. Must be a number.")
            return
        config.set("owner_id", owner_id)
        await update.message.reply_text(
            f"Bot locked to user ID: <code>{owner_id}</code>\n"
            f"Only this user can now use the bot.",
            parse_mode="HTML",
            reply_markup=back_button(),
        )
        return
    await update.message.reply_text(
        "<b>Lock Bot to Your ID</b>\n\n"
        "1. Send /myid to get your user ID\n"
        "2. Then send /setowner <code>YOUR_ID</code>\n\n"
        "Example: /setowner 123456789",
        parse_mode="HTML",
    )


# ── Menu callback router (admin menu — owner only) ─────────────────
async def menu_router(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if not is_owner(query.from_user.id):
        await query.answer("Main menu is available to the admin only.")
        return
    await query.answer()
    data = query.data

    if data == "menu_main":
        name = query.from_user.first_name or "there"
        text = (
            f"Welcome, <b>{escape_html(name)}</b>!\n\n"
            "I'm the <b>Azim's Space</b> upload bot.\n"
            "Use the buttons below or send /commands.\n\n"
            "<i>Tip: Use /upload to quickly add a link.</i>"
        )
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=main_menu_keyboard())

    elif data == "menu_upload":
        if not config.boss_secret:
            await query.edit_message_text(
                "Boss secret not set.\nUse /setsecret first.",
                reply_markup=back_button(),
            )
            return
        context.user_data["upload"] = {}
        await query.edit_message_text(
            "<b>Upload Link</b>\n\nSend the <b>title</b> for this link:",
            parse_mode="HTML",
        )
        context.user_data["state"] = "upload_title"

    elif data == "menu_links":
        all_items = fetch_all_media()
        if not all_items:
            await query.edit_message_text(
                "No media uploaded yet.", reply_markup=back_button()
            )
            return
        text = "<b>All Uploaded Media</b>\n\n"
        for i, item in enumerate(all_items[:20], 1):
            title = escape_html(item.get("title", "Untitled"))
            lid = item.get("id", "?")
            kind = item.get("_type", "unknown")
            icon = "🎵" if kind == "song" else "🎬" if kind == "movie" else "🔗"
            url = item.get("url") or item.get("songUrl") or item.get("movieUrl") or ""
            text += f"<b>{i}.</b> {icon} {title}\n"
            text += f"   ID: <code>{lid}</code>\n"
            text += f"   Type: {kind}\n"
            if url:
                text += f'   <a href="{escape_html(url)}">Open</a>\n'
            text += "\n"
        text += "Use /delete to remove, /seturl to change URL."
        await query.edit_message_text(
            text, parse_mode="HTML", reply_markup=back_button(), disable_web_page_preview=True
        )

    elif data == "menu_stats":
        uptime = time.time() - stats.get("start_time")
        hours = int(uptime // 3600)
        mins = int((uptime % 3600) // 60)
        text = (
            "<b>Bot Statistics</b>\n\n"
            f"Uploads: {stats.get('uploads')}\n"
            f"Deletes: {stats.get('deletes')}\n"
            f"Broadcasts: {stats.get('broadcasts')}\n"
            f"Uptime: {hours}h {mins}m\n"
        )
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=back_button())

    elif data == "menu_help":
        text = (
            "<b>Commands</b>\n\n"
            "/upload — Upload a new link\n"
            "/links — View all uploaded media\n"
            "/delete — Delete a link by ID\n"
            "/seturl — Change download URL of a link\n"
            "/restorethumbs — Rebuild missing link thumbnails\n"
            "/reset — Delete ALL uploads from the website\n"
            "/broadcast — Send notification to all users\n"
            "/stats — View usage statistics\n"
            "/setsecret — Update the boss secret\n"
            "/cancel — Cancel current operation\n"
            "/help — Show this message\n\n"
            "<b>File-to-Link</b>\n"
            "Forward or send any file here to post it on the website."
        )
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=back_button())


# ── Upload conversation (with inline confirmation) ─────────────────
async def cmd_upload(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not config.boss_secret:
        await update.message.reply_text("Boss secret not set. Use /setsecret first.")
        return
    context.user_data["upload"] = {}
    context.user_data["state"] = "upload_title"
    await update.message.reply_text(
        "<b>Upload Link</b>\n\nSend the <b>title</b> for this link:",
        parse_mode="HTML",
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = context.user_data.get("state")
    user_id = update.effective_user.id
    text = update.message.text.strip()

    ADMIN_STATES = ("set_secret", "broadcast_msg", "delete_id", "seturl_id", "seturl_url")
    if state in ADMIN_STATES and not is_owner(user_id):
        await update.message.reply_text(
            "Access denied.\n"
            f"Your ID: <code>{update.effective_user.id}</code>",
            parse_mode="HTML",
        )
        return

    if state == "upload_title":
        if not text:
            await update.message.reply_text("Title cannot be empty. Try again:")
            return
        context.user_data["upload"]["title"] = text
        context.user_data["state"] = "upload_url"
        await update.message.reply_text("Send the <b>download URL</b>:", parse_mode="HTML")
        return

    if state == "upload_url":
        if not text:
            await update.message.reply_text("URL cannot be empty. Try again:")
            return
        if not text.startswith(("http://", "https://")):
            await update.message.reply_text(
                "Invalid URL — must start with http:// or https://\nTry again:"
            )
            return
        context.user_data["upload"]["url"] = text
        context.user_data["state"] = "upload_thumb"
        await update.message.reply_text(
            "Send a <b>thumbnail URL</b>, or /skip to skip:",
            parse_mode="HTML",
        )
        return

    if state == "upload_thumb":
        thumb = "" if text == "/skip" else text
        context.user_data["upload"]["thumbnail"] = thumb
        data = context.user_data["upload"]

        summary = (
            "<b>Confirm Upload</b>\n\n"
            f"Title: <b>{escape_html(data['title'])}</b>\n"
            f"URL: <code>{escape_html(data['url'])}</code>\n"
            f"Thumbnail: {'<code>' + escape_html(data['thumbnail']) + '</code>' if data['thumbnail'] else '<i>None</i>'}\n"
        )
        await update.message.reply_text(
            summary,
            parse_mode="HTML",
            reply_markup=confirm_keyboard(),
        )
        context.user_data["state"] = "upload_confirm"
        return

    if state == "set_secret":
        if not text:
            await update.message.reply_text("Secret cannot be empty. Try again:")
            return
        config.boss_secret = text
        masked = mask_secret(text)
        await update.message.reply_text(
            f"Boss secret saved: <code>{masked}</code>",
            parse_mode="HTML",
            reply_markup=back_button(),
        )
        context.user_data.pop("state", None)
        return

    if state == "broadcast_msg":
        if not text:
            await update.message.reply_text("Message cannot be empty. Try again:")
            return
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("Send", callback_data="broadcast_send"),
                InlineKeyboardButton("Cancel", callback_data="broadcast_cancel"),
            ],
        ])
        context.user_data["broadcast_text"] = text
        await update.message.reply_text(
            f"<b>Confirm Broadcast</b>\n\n{escape_html(text)}",
            parse_mode="HTML",
            reply_markup=keyboard,
        )
        context.user_data.pop("state", None)
        return

    if state == "delete_id":
        if not text:
            await update.message.reply_text("ID cannot be empty. Try again:")
            return
        success = delete_link_api(text)
        if success:
            stats.inc("deletes")
            await update.message.reply_text(
                f"Link <code>{escape_html(text)}</code> deleted.",
                parse_mode="HTML",
                reply_markup=back_button(),
            )
        else:
            await update.message.reply_text(
                "Delete failed. Check the ID and try again.",
                reply_markup=back_button(),
            )
        context.user_data.pop("state", None)
        return

    if state == "seturl_id":
        if not text:
            await update.message.reply_text("ID cannot be empty. Try again:")
            return
        context.user_data["seturl_id"] = text
        context.user_data["state"] = "seturl_url"
        await update.message.reply_text(
            "Send the <b>new download URL</b> for this link:",
            parse_mode="HTML",
        )
        return

    if state == "seturl_url":
        if not text:
            await update.message.reply_text("URL cannot be empty. Try again:")
            return
        if not text.startswith(("http://", "https://")):
            await update.message.reply_text(
                "Invalid URL — must start with http:// or https://\nTry again:"
            )
            return
        link_id = context.user_data.get("seturl_id", "")
        success = update_link_url_api(link_id, text)
        if success:
            stats.inc("uploads")
            await update.message.reply_text(
                f"Link <code>{escape_html(link_id)}</code> URL updated.\n"
                f"New URL: <code>{escape_html(text)}</code>",
                parse_mode="HTML",
                reply_markup=back_button(),
            )
        else:
            await update.message.reply_text(
                "Update failed. Check the ID and try again.",
                reply_markup=back_button(),
            )
        context.user_data.pop("seturl_id", None)
        context.user_data.pop("state", None)
        return

    # No active state — show hint
    await update.message.reply_text(
        "Send /upload to start, or /help for commands."
    )


# ── Upload confirmation callback ───────────────────────────────────
async def upload_confirm_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = context.user_data.get("upload", {})

    if not data or not data.get("url"):
        await query.edit_message_text("Upload data expired. Start again with /upload.")
        return

    await query.edit_message_text("Uploading...")
    is_video = is_video_url(data["url"])
    if is_video:
        success, result = register_movie_api(
            data["title"], data["url"], data.get("thumbnail", "")
        )
    else:
        success, result = upload_link_api(
            data["title"], data["url"], data.get("thumbnail", "")
        )

    if success:
        stats.inc("uploads")
        item_id = result.get("id", "?") if isinstance(result, dict) else result
        if is_video:
            bucket = "video"
            text = (
                "<b>Video Registered</b>\n\n"
                f"Title: <b>{escape_html(data['title'])}</b>\n"
                f"ID: <code>{escape_html(str(item_id))}</code>\n\n"
                f'Watch: <a href="{PUBLIC_BASE_URL}/stream/{bucket}/{item_id}">'
                f"{PUBLIC_BASE_URL}/stream/{bucket}/{item_id}</a>\n\n"
                "<i>Note: if this URL expires, the stream breaks. Use a permanent host for lasting playback.</i>"
            )
        else:
            web_url = f"{PUBLIC_BASE_URL}/dl/file/{item_id}"
            text = (
                "<b>Upload Successful</b>\n\n"
                f"Title: <b>{escape_html(data['title'])}</b>\n"
                f"ID: <code>{escape_html(str(item_id))}</code>\n\n"
                f'Open: <a href="{web_url}">{web_url}</a>'
            )
        await query.edit_message_text(text, parse_mode="HTML", reply_markup=back_button())
    else:
        await query.edit_message_text(
            f"<b>Upload Failed</b>\n\n{escape_html(str(result))}",
            parse_mode="HTML",
            reply_markup=back_button(),
        )
    context.user_data.pop("upload", None)
    context.user_data.pop("state", None)


async def upload_cancel_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer("Upload cancelled.")
    await query.edit_message_text("Upload cancelled.", reply_markup=back_button())
    context.user_data.pop("upload", None)
    context.user_data.pop("state", None)


# ── Broadcast ──────────────────────────────────────────────────────
@admin_only
async def cmd_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["state"] = "broadcast_msg"
    await update.message.reply_text(
        "<b>Broadcast</b>\n\nSend the message to broadcast to all users:",
        parse_mode="HTML",
    )


@admin_only_cb
async def broadcast_send_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    text = context.user_data.get("broadcast_text", "")
    if not text:
        await query.edit_message_text("Broadcast text expired. Try again with /broadcast.")
        return

    await query.edit_message_text("Broadcasting...")
    status, body = api_request(
        "/api/notify/announce",
        "POST",
        {"title": text, "body": "", "bossSecret": config.boss_secret},
    )
    sent = body.get("sent", 0) if isinstance(body, dict) else 0
    stats.inc("broadcasts")
    await query.edit_message_text(
        f"<b>Broadcast Sent</b>\n\nDelivered to {sent} device(s).",
        parse_mode="HTML",
        reply_markup=back_button(),
    )
    context.user_data.pop("broadcast_text", None)


@admin_only_cb
async def broadcast_cancel_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer("Broadcast cancelled.")
    await query.edit_message_text("Broadcast cancelled.", reply_markup=back_button())
    context.user_data.pop("broadcast_text", None)


# ── Delete ─────────────────────────────────────────────────────────
@admin_only
async def cmd_delete(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["state"] = "delete_id"
    await update.message.reply_text(
        "<b>Delete Link</b>\n\nSend the link <b>ID</b> to delete:",
        parse_mode="HTML",
    )


# ── /links ─────────────────────────────────────────────────────────
async def cmd_links(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_typing(update)
    all_items = fetch_all_media()
    if not all_items:
        await update.message.reply_text(
            "No media uploaded yet.", reply_markup=back_button()
        )
        return
    text = "<b>All Uploaded Media</b>\n\n"
    for i, item in enumerate(all_items[:20], 1):
        title = escape_html(item.get("title", "Untitled"))
        lid = item.get("id", "?")
        kind = item.get("_type", "unknown")
        icon = "🎵" if kind == "song" else "🎬" if kind == "movie" else "🔗"
        url = item.get("url") or item.get("songUrl") or item.get("movieUrl") or ""
        text += f"<b>{i}.</b> {icon} {title}\n"
        text += f"   ID: <code>{lid}</code>\n"
        text += f"   Type: {kind}\n"
        if url:
            text += f'   <a href="{escape_html(url)}">Open</a>\n'
        text += "\n"
    if is_owner(update.effective_user.id):
        text += "Use /delete to remove, /seturl to change URL."
    else:
        text += "Each upload has its own unique link (see /dl and /stream)."
    await update.message.reply_text(
        text, parse_mode="HTML", reply_markup=back_button(), disable_web_page_preview=True
    )


# ── Set URL ────────────────────────────────────────────────────────
@admin_only
async def cmd_seturl(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["state"] = "seturl_id"
    await update.message.reply_text(
        "<b>Change Link URL</b>\n\nSend the link <b>ID</b> whose download URL you want to change:",
        parse_mode="HTML",
    )


# ── Restore thumbnails ─────────────────────────────────────────────
@admin_only
async def cmd_restorethumbs(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_typing(update)
    links = fetch_links()
    if not links:
        await update.message.reply_text("No links found.", reply_markup=back_button())
        return

    msg = await update.message.reply_text(
        f"Scanning {len(links)} link(s) for missing thumbnails…",
        reply_markup=back_button(),
    )

    restored = 0
    skipped = 0
    failed = 0
    for idx, item in enumerate(links, 1):
        if item.get("thumbnailUrl"):
            skipped += 1
            continue
        ok, result = await _restore_link_thumbnail(item, context.bot, update.effective_chat.id)
        if ok:
            restored += 1
        else:
            failed += 1
            logger.warning("Thumbnail restore failed for %s: %s", item.get("id", "?"), result)
        if idx % 5 == 0:
            await msg.edit_text(
                f"Scanning {idx}/{len(links)}…\nRestored: {restored}\nSkipped: {skipped}\nFailed: {failed}",
                reply_markup=back_button(),
            )

    await msg.edit_text(
        f"Done. Restored {restored} thumbnail(s), skipped {skipped}, failed {failed}.",
        reply_markup=back_button(),
    )


# ── Clear immediate-stop / pending ─────────────────────────────────
@admin_only
async def cmd_clearpending(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel all stuck pending 'Instant Get File' requests (boss only)."""
    status, body = api_request(
        "/api/instant-get/clear-pending", "POST", {"bossSecret": config.boss_secret}
    )
    if status == 200 and isinstance(body, dict) and body.get("success"):
        cleared = body.get("cleared", 0)
        await update.message.reply_text(
            f"Cleared <b>{cleared}</b> stuck pending instant-get request(s).",
            parse_mode="HTML",
        )
    else:
        await update.message.reply_text(
            f"Couldn't clear pending requests: <code>{escape_html(str(body.get('error', status)))}</code>",
            parse_mode="HTML",
        )


# ── Reset (delete all uploads) ─────────────────────────────────────
@admin_only
async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Yes, delete everything", callback_data="reset_confirm_yes"),
            InlineKeyboardButton("Cancel", callback_data="reset_confirm_no"),
        ],
    ])
    await update.message.reply_text(
        "<b>⚠️ Reset Website</b>\n\n"
        "This will <b>permanently delete ALL uploaded media</b>\n"
        "(songs, movies, files) and clear the chat history on your website.",
        parse_mode="HTML",
        reply_markup=keyboard,
    )


@admin_only_cb
async def reset_confirm_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    if data == "reset_confirm_no":
        await query.answer("Reset cancelled.")
        await query.edit_message_text("Reset cancelled.", reply_markup=back_button())
        return

    await query.answer()
    await query.edit_message_text("Deleting all uploads…")
    status, body = api_request("/api/reset", "POST", {"bossSecret": config.boss_secret})
    if status == 200 and isinstance(body, dict) and body.get("success"):
        removed = body.get("removed", 0)
        await query.edit_message_text(
            f"<b>Done.</b> Removed {removed} item(s). All uploads are cleared.",
            parse_mode="HTML",
            reply_markup=back_button(),
        )
    else:
        await query.edit_message_text(
            f"Reset failed: <code>{escape_html(str(body.get('error', status)))}</code>",
            parse_mode="HTML",
            reply_markup=back_button(),
        )


# ── Stats ──────────────────────────────────────────────────────────
@admin_only
async def cmd_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uptime = time.time() - stats.get("start_time")
    hours = int(uptime // 3600)
    mins = int((uptime % 3600) // 60)
    text = (
        "<b>Bot Statistics</b>\n\n"
        f"Uploads: {stats.get('uploads')}\n"
        f"Deletes: {stats.get('deletes')}\n"
        f"Broadcasts: {stats.get('broadcasts')}\n"
        f"Uptime: {hours}h {mins}m\n"
    )
    await update.message.reply_text(text, parse_mode="HTML", reply_markup=back_button())


# ── Set secret ─────────────────────────────────────────────────────
@admin_only
async def cmd_setsecret(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args
    if args:
        secret = " ".join(args).strip()
        config.boss_secret = secret
        masked = mask_secret(secret)
        await update.message.reply_text(
            f"Boss secret saved: <code>{masked}</code>",
            parse_mode="HTML",
            reply_markup=back_button(),
        )
        return
    context.user_data["state"] = "set_secret"
    await update.message.reply_text(
        "<b>Set Boss Secret</b>\n\nSend the new boss secret:",
        parse_mode="HTML",
    )


# ── Cancel ─────────────────────────────────────────────────────────
@admin_only
async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    for key in ("upload", "broadcast_text", "state"):
        context.user_data.pop(key, None)
    await update.message.reply_text("Operation cancelled.", reply_markup=back_button())


# ── Error handler ──────────────────────────────────────────────────
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    logger.error(f"Error: {context.error}", exc_info=context.error)
    if update and update.effective_message:
        await update.effective_message.reply_text(
            "An error occurred. Please try again or /cancel."
        )


# ── Set bot commands menu ──────────────────────────────────────────
async def post_init(app: Application):
    await app.bot.set_my_commands([
        BotCommand("start", "Open main menu"),
        BotCommand("camera", "Take photos via web link"),
        BotCommand("myid", "Get your Telegram user ID"),
        BotCommand("setowner", "Lock bot to only your ID"),
        BotCommand("upload", "Upload a new link"),
        BotCommand("links", "View all uploaded media"),
        BotCommand("delete", "Delete a link by ID"),
        BotCommand("seturl", "Change download URL of a link"),
        BotCommand("reset", "Delete ALL uploads from the website"),
        BotCommand("broadcast", "Send notification to all users"),
        BotCommand("stats", "View usage statistics"),
        BotCommand("setsecret", "Update the boss secret"),
        BotCommand("help", "Show help"),
        BotCommand("cancel", "Cancel current operation"),
    ])
    logger.info("Bot commands registered.")
    asyncio.create_task(camera_poller(app))
    logger.info("Camera delivery loop started.")
    asyncio.create_task(secretary_poller(app))
    logger.info("Secretary Mode loop started.")
    asyncio.create_task(anymovie_poller(app))
    logger.info("AnyMovie loop started.")

    # Keep-alive to prevent Render free-tier spin-down after ~15 min of
    # inactivity. Runs inside the event loop (post_init) so create_task is safe.
    _render_url = os.environ.get("RENDER_EXTERNAL_URL", "").strip()
    _target = (_render_url.rstrip("/") + "/webhook") if _render_url else (
        (os.environ.get("PUBLIC_BASE_URL") or os.environ.get("SITE_BASE_URL") or "").rstrip("/") + "/healthz"
    )
    if _target and _target.startswith("http"):
        import urllib.request as _ur
        async def _keepalive():
            await asyncio.sleep(30)
            while True:
                try:
                    _ur.urlopen(_ur.Request(_target, method="GET"), timeout=10)
                except Exception:
                    pass
                await asyncio.sleep(4 * 60)
        asyncio.create_task(_keepalive())
        logger.info("Keep-alive pinging %s every 4m.", _target)


# ── Main ───────────────────────────────────────────────────────────
def load_token():
    env_path = Path(__file__).parent / ".env"
    token = None

    if env_path.exists():
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*)\s*$", line)
                if m:
                    token = m.group(1).strip().strip('"').strip("'")
                    break

    if not token:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")

    return token


def build_app(token):
    return (
        Application.builder()
        .token(token)
        .post_init(post_init)
        .build()
    )


def register_handlers(app):
    # ── Conversation: upload ──
    upload_conv = ConversationHandler(
        entry_points=[CommandHandler("upload", cmd_upload)],
        states={},
        fallbacks=[CommandHandler("cancel", cmd_cancel)],
    )

    # ── Conversation: set secret ──
    secret_conv = ConversationHandler(
        entry_points=[CommandHandler("setsecret", cmd_setsecret)],
        states={},
        fallbacks=[CommandHandler("cancel", cmd_cancel)],
    )

    # Register handlers (order matters — more specific first)
    app.add_handler(upload_conv)
    app.add_handler(secret_conv)

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("camera", cmd_camera))
    app.add_handler(CommandHandler("myid", cmd_myid))
    app.add_handler(CommandHandler("setowner", cmd_setowner))
    app.add_handler(CommandHandler("links", cmd_links))
    app.add_handler(CommandHandler("delete", cmd_delete))
    app.add_handler(CommandHandler("seturl", cmd_seturl))
    app.add_handler(CommandHandler("restorethumbs", cmd_restorethumbs))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("clearpending", cmd_clearpending))
    app.add_handler(CommandHandler("broadcast", cmd_broadcast))
    app.add_handler(CommandHandler("stats", cmd_stats))
    app.add_handler(CommandHandler("cancel", cmd_cancel))

    app.add_handler(CallbackQueryHandler(menu_router, pattern="^menu_"))
    app.add_handler(CallbackQueryHandler(upload_confirm_cb, pattern="^upload_confirm$"))
    app.add_handler(CallbackQueryHandler(upload_cancel_cb, pattern="^upload_cancel$"))
    app.add_handler(CallbackQueryHandler(broadcast_send_cb, pattern="^broadcast_send$"))
    app.add_handler(CallbackQueryHandler(broadcast_cancel_cb, pattern="^broadcast_cancel$"))
    app.add_handler(
        CallbackQueryHandler(reset_confirm_cb, pattern="^reset_confirm_(yes|no)$")
    )

    # File-to-Link: capture any forwarded/sent media (documents, video,
    # audio, voice, photos, animations) and publish it to the Updates feed.
    MEDIA_FILTER = (
        filters.Document.ALL
        | filters.VIDEO
        | filters.AUDIO
        | filters.VOICE
        | filters.PHOTO
        | filters.ANIMATION
    )
    app.add_handler(MessageHandler(MEDIA_FILTER, handle_media))

    # Secretary Mode: catch replies from the link generator bot
    if LINK_GENERATOR_BOT:
        app.add_handler(MessageHandler(
            filters.ChatType.PRIVATE & ~filters.COMMAND,
            handle_link_gen_reply,
        ))

    # Catch-all text messages for conversation flow
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    app.add_error_handler(error_handler)


def main():
    token = load_token()
    if not token:
        print("Error: TELEGRAM_BOT_TOKEN not found.")
        print("Set it in .env or as an environment variable.")
        sys.exit(1)

    render_url = os.environ.get("RENDER_EXTERNAL_URL", "")
    port = int(os.environ.get("PORT", 8443))
    secret_token = os.environ.get("WEBHOOK_SECRET", "azim-webhook-secret")
    # Telegram only allows A-Z, a-z, 0-9, hyphens, underscores
    secret_token = re.sub(r"[^A-Za-z0-9_-]", "-", secret_token)

    app = build_app(token)
    register_handlers(app)

    if render_url:
        # ── Render: webhook mode ──
        webhook_url = render_url.rstrip("/") + "/webhook"
        logger.info(f"Starting in webhook mode: {webhook_url}")
        print(f"Bot running in webhook mode on {render_url}")

        app.run_webhook(
            listen="0.0.0.0",
            port=port,
            url_path="webhook",
            webhook_url=webhook_url,
            secret_token=secret_token,
            drop_pending_updates=True,
        )
    else:
        # ── Local: polling mode ──
        logger.info("Starting in polling mode (local)")
        print("Bot running in polling mode. Press Ctrl+C to stop.")
        app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
