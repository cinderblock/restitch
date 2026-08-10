#!/usr/bin/env python3
"""Dumb TCP relay so a test stitchd's input can be killed on demand.

Listens on LISTEN_PORT, forwards to production stitchd's RTSP port. RTSP over
TCP puts control and interleaved media on the one connection, so a plain byte
pump is enough. Killing this process drops the input exactly as a camera going
away would, without touching production.
"""
import socket, sys, threading

listen_port = int(sys.argv[1])
dst = (sys.argv[2], int(sys.argv[3]))


def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def serve(c):
    try:
        u = socket.create_connection(dst)
    except OSError:
        c.close()
        return
    threading.Thread(target=pump, args=(c, u), daemon=True).start()
    threading.Thread(target=pump, args=(u, c), daemon=True).start()


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", listen_port))
srv.listen(8)
print(f"relay :{listen_port} -> {dst[0]}:{dst[1]}", flush=True)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
