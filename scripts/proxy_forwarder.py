"""Local no-auth SOCKS5 proxy that forwards to an authenticated upstream SOCKS5.

Browsers (Chrome/Chromium) cannot do SOCKS5 username/password auth themselves.
This listens locally without auth and relays through the upstream residential
proxy (which requires auth), so a browser can use the residential exit IP.

Run: GEMINI_PROXY="socks5h://user:pass@host:port" uv run python scripts/proxy_forwarder.py
Then point the browser at socks5://127.0.0.1:10800 (LOCAL_PROXY_PORT).
"""

import asyncio
import os
import socket
import struct
import sys
from urllib.parse import urlparse

UP = urlparse(os.environ.get("GEMINI_PROXY", ""))
if not UP.hostname:
    print("Set GEMINI_PROXY=socks5h://user:pass@host:port")
    sys.exit(1)
UP_HOST, UP_PORT = UP.hostname, UP.port or 1080
UP_USER, UP_PASS = UP.username or "", UP.password or ""
LISTEN_PORT = int(os.environ.get("LOCAL_PROXY_PORT", "10800"))


async def pipe(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data:
                break
            w.write(data)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass


async def read_addr(r, atyp):
    if atyp == 1:
        return socket.inet_ntoa(await r.readexactly(4))
    if atyp == 3:
        ln = (await r.readexactly(1))[0]
        return (await r.readexactly(ln)).decode()
    if atyp == 4:
        return socket.inet_ntop(socket.AF_INET6, await r.readexactly(16))
    raise ValueError(f"bad atyp {atyp}")


async def handle(cr, cw):
    try:
        hdr = await cr.readexactly(2)
        await cr.readexactly(hdr[1])  # client methods
        cw.write(b"\x05\x00")  # no auth
        await cw.drain()
        req = await cr.readexactly(4)
        if req[1] != 1:  # only CONNECT
            cw.write(b"\x05\x07\x00\x01" + b"\x00" * 6)
            await cw.drain()
            cw.close()
            return
        addr = await read_addr(cr, req[3])
        port = struct.unpack("!H", await cr.readexactly(2))[0]

        ur, uw = await asyncio.open_connection(UP_HOST, UP_PORT)
        uw.write(b"\x05\x02\x00\x02")  # offer no-auth + user/pass
        await uw.drain()
        method = (await ur.readexactly(2))[1]
        if method == 2:
            uw.write(
                b"\x01"
                + bytes([len(UP_USER)]) + UP_USER.encode()
                + bytes([len(UP_PASS)]) + UP_PASS.encode()
            )
            await uw.drain()
            if (await ur.readexactly(2))[1] != 0:
                raise ConnectionError("upstream auth failed")
        elif method != 0:
            raise ConnectionError("upstream no acceptable auth method")

        uw.write(b"\x05\x01\x00\x03" + bytes([len(addr)]) + addr.encode() + struct.pack("!H", port))
        await uw.drain()
        rep = await ur.readexactly(4)
        if rep[1] != 0:
            raise ConnectionError(f"upstream connect failed rep={rep[1]}")
        await read_addr(ur, rep[3])
        await ur.readexactly(2)  # bound port

        cw.write(b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x00" * 2)
        await cw.drain()
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    except Exception as e:
        try:
            cw.write(b"\x05\x01\x00\x01" + b"\x00" * 6)
            await cw.drain()
            cw.close()
        except Exception:
            pass


async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", LISTEN_PORT)
    print(f"local SOCKS5 127.0.0.1:{LISTEN_PORT} -> {UP_HOST}:{UP_PORT} (auth)", flush=True)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())